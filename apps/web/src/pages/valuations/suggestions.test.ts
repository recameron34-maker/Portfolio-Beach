import { afterEach, describe, expect, it } from 'vitest';
import { NO_SUGGESTION_REASON_CODES } from '@pb/contracts';
import { SUGGESTION_BASES, SUGGESTION_REASONS } from '@pb/calc';
import { SUGGESTIONS_OFF_REFUSAL } from '@pb/workflows';
import { SUGGESTIONS_PATH, VALUATION_TABS } from '../../app/nav.js';
import { clearTaxonomyLabels, registerTaxonomyLabels } from '../../lib/format.js';
import {
  notCalculableFixture,
  reportSuggestionFixture,
  STATEMENT_FILE,
  SUGGESTION_ID,
  suggestionFixture,
} from '../../test/fixtures-suggestions.js';
import {
  acceptSentence,
  applySentence,
  canDecideSuggestions,
  canReadSuggestions,
  contributionsSentence,
  crossCheckSentence,
  currentMarkNote,
  flagBadges,
  flagSentences,
  inputLabel,
  inputSourceText,
  inputValueText,
  markAge,
  NO_SUGGESTION_SENTENCE,
  offerFor,
  parseSuggestionsSearch,
  REASON_SENTENCE,
  restsOnSourceDocument,
  ruleSentence,
  runOutcomeText,
  searchFor,
  SOURCE_LABEL,
  splitSuggestionKeys,
  startedFromSentence,
  suggestionFacts,
  suggestionOnDraft,
  SUGGESTIONS_OFF,
  suggestionsOn,
  suggestionStateWord,
  supersededText,
  tieSentence,
  valuationTabsFor,
} from './suggestions.js';

const ROLES = [
  'viewer',
  'deal_team',
  'operations',
  'approver',
  'investor_relations',
  'platform_admin',
  'auditor',
] as const;

describe('who reads and who decides a suggestion (the route table)', () => {
  it('lets operations, the deal team, approvers and auditors read, and operations alone decide', () => {
    expect(ROLES.filter((r) => canReadSuggestions([r]))).toEqual([
      'deal_team',
      'operations',
      'approver',
      'auditor',
    ]);
    expect(ROLES.filter((r) => canDecideSuggestions([r]))).toEqual(['operations']);
    expect(canReadSuggestions([])).toBe(false);
  });

  it('shows the Suggestions tab to a reader and leaves no gap for anyone else', () => {
    expect(valuationTabsFor(['approver'])).toEqual(VALUATION_TABS);
    for (const role of ['viewer', 'investor_relations', 'platform_admin']) {
      const tabs = valuationTabsFor([role]);
      expect(tabs.map((t) => t.to)).toEqual(['/valuations', '/valuations/changes']);
    }
    expect(VALUATION_TABS.map((t) => t.to)).toContain(SUGGESTIONS_PATH);
  });

  it('reads the switch from the flags, on until they say otherwise', () => {
    const flag = (enabled: boolean) => ({
      flags: [{ key: 'valuation.suggestions', enabled }],
    });
    expect(suggestionsOn(undefined)).toBe(true);
    expect(suggestionsOn({ flags: [] })).toBe(true);
    expect(suggestionsOn(flag(true))).toBe(true);
    expect(suggestionsOn(flag(false))).toBe(false);
    // The page says what the API answers when a command is refused for the switch.
    expect(SUGGESTIONS_OFF).toBe(SUGGESTIONS_OFF_REFUSAL);
  });
});

describe('the words of a suggestion (docs/08 section 12)', () => {
  afterEach(() => clearTaxonomyLabels());

  it('names each source and has a sentence for every reason, none citing a rule number', () => {
    expect(Object.keys(SOURCE_LABEL).sort()).toEqual([...SUGGESTION_BASES].sort());
    expect(SOURCE_LABEL).toEqual({
      capital_account_balance: 'Capital account statement',
      sponsor_equity_value: 'Sponsor report',
      held_multiple: 'Sponsor report, multiple held',
    });
    expect(Object.keys(REASON_SENTENCE).sort()).toEqual([...SUGGESTION_REASONS].sort());
    for (const sentence of Object.values(REASON_SENTENCE)) {
      expect(sentence).toMatch(/^[A-Z].*\.$/);
      expect(sentence).not.toMatch(/\d+\.\d|section/);
    }
    expect(REASON_SENTENCE.no_ending_balance).toBe(
      'No ending balance for our account in US dollars was accepted from the statement.',
    );
    expect(REASON_SENTENCE.flows_since_reference_mark).toBe(
      'Cash has moved since the last Locked mark.',
    );
    expect(REASON_SENTENCE.value_not_positive).toBe('The value works out at zero or less.');
  });

  it('states the rule of each basis, with the share only when the statement gives one', () => {
    expect(ruleSentence(suggestionFixture())).toBe(
      'The ending capital balance on the capital account statement.',
    );
    const withShare = suggestionFixture();
    withShare.workings.inputs.push({
      key: 'investor_share_pct',
      value: '0.25',
      periodEnd: '2025-06-30',
      source: withShare.workings.inputs[0]!.source,
      edited: false,
    });
    expect(ruleSentence(withShare)).toBe(
      'The ending capital balance on the capital account statement, times our share of the vehicle.',
    );
    expect(ruleSentence(reportSuggestionFixture())).toBe(
      'The last Locked mark, scaled by the change in equity value (enterprise value less net debt).',
    );
    expect(ruleSentence(reportSuggestionFixture({ basis: 'held_multiple' }))).toBe(
      "The last Locked mark, scaled by the change in equity value (enterprise value less net debt). Enterprise value is the new EBITDA at the earlier quarter's multiple.",
    );
  });

  it('dates the mark on record and says how old it is', () => {
    expect(markAge(1)).toBe('one quarter old');
    expect(markAge(3)).toBe('3 quarters old');
    expect(currentMarkNote(suggestionFixture().currentMark!)).toBe('Mar 31, 2025, one quarter old');
  });

  it('gives each raised flag a badge and a sentence, in one order', () => {
    const all = {
      variance: true,
      ties: false,
      contributionsDiffer: true,
      sourcesDiffer: true,
      editedByReviewer: true,
    };
    expect(flagBadges(all).map((b) => b.label)).toEqual([
      'Variance',
      'Does not tie',
      'Contributions differ',
      'Sources differ',
      'Typed by reviewer',
    ]);
    expect(flagSentences(all)).toHaveLength(5);
    expect(flagSentences(all)[0]).toBe(
      "The change against the previous quarter's mark is at or above 10.0%.",
    );
    const none = { ...all, variance: false, contributionsDiffer: false, sourcesDiffer: false };
    // Lines that tie, or that could not be added up, carry no badge.
    expect(flagBadges({ ...none, ties: true, editedByReviewer: false })).toEqual([]);
    expect(flagBadges({ ...none, ties: null, editedByReviewer: false })).toEqual([]);
    expect(flagSentences({ ...none, ties: null, editedByReviewer: false })).toEqual([]);
  });

  it('labels each input, writes money in full and a share as a percent, and says where it came from', () => {
    const [mark, , , ev, netDebt] = reportSuggestionFixture().workings.inputs;
    expect(inputLabel('ending_capital_balance')).toBe('Ending capital balance');
    expect(inputLabel('reference_ebitda_ltm')).toBe('EBITDA (LTM), earlier quarter');
    expect(inputLabel('some_new_line')).toBe('Some new line');
    expect(inputValueText({ key: 'reference_mark', value: '7310450.25' })).toBe('$7,310,450.25');
    expect(inputValueText({ key: 'investor_share_pct', value: '0.25' })).toBe('25.00%');
    expect(inputSourceText(suggestionFixture().workings.inputs[0]!)).toBe(
      `From ${STATEMENT_FILE}, page 1`,
    );
    expect(inputSourceText(mark!)).toBe('Locked mark, Mar 28, 2025');
    expect(inputSourceText(ev!)).toMatch(/, page 3$/);
    expect(inputSourceText(netDebt!)).toBe('Typed by the reviewer');
    expect(
      inputSourceText({
        periodEnd: '2025-03-31',
        source: { kind: 'record', id: SUGGESTION_ID.report, page: null, fileName: null },
      }),
    ).toBe('From the record');
  });

  it('says whether the lines add up and by how much they miss', () => {
    expect(tieSentence({ ties: true, tieDifference: '0' })).toBe('The lines add up.');
    // Inside the tolerance of the unit read: the lines tie, whatever the small difference.
    expect(tieSentence({ ties: true, tieDifference: '-20000' })).toBe('The lines add up.');
    expect(tieSentence({ ties: false, tieDifference: '-50000.00' })).toBe(
      'The lines are $50,000 apart.',
    );
    expect(tieSentence({ ties: null, tieDifference: null })).toBe(
      'The lines were not added up: not all five were accepted from the statement.',
    );
  });

  it("sets the statement's contributions beside the record's, or says why not", () => {
    const check = suggestionFixture().checks!.contributionsCheck;
    expect(contributionsSentence({ ...check, statement: '30000000', differs: true })).toBe(
      'Contributions to date: statement $30.00M, record $12.40M.',
    );
    expect(
      contributionsSentence({ ...check, statement: null, notChecked: 'contributions_not_stated' }),
    ).toBe('Contributions not checked: no contributions to date were accepted from the statement.');
    expect(
      contributionsSentence({ ...check, record: '0', notChecked: 'no_recorded_contributions' }),
    ).toBe('Contributions not checked: the record holds no approved contribution.');
  });

  it('sets another source beside the suggested value, never blended', () => {
    const report = {
      basis: 'sponsor_equity_value' as const,
      value: '7831632.54',
      reason: null,
      difference: '21632.54',
      differencePct: '0.0027698515',
      differs: false,
    };
    expect(crossCheckSentence(report, 'capital_account_balance')).toBe(
      'Sponsor report: $7.83M, $21,633 (0.3%) above the statement.',
    );
    expect(
      crossCheckSentence(reportSuggestionFixture().crossChecks[0]!, 'sponsor_equity_value'),
    ).toBe("Capital account statement: $7.81M, $21,633 (0.3%) below the report's indication.");
    expect(
      crossCheckSentence(
        { ...report, difference: '0', differencePct: '0' },
        'capital_account_balance',
      ),
    ).toBe('Sponsor report: $7.83M, the same as the statement.');
    // A difference too small to show at one decimal is never written as 0.0%.
    expect(
      crossCheckSentence(
        { ...report, value: '38135817.31', difference: '-4182.69', differencePct: '-0.0001096668' },
        'capital_account_balance',
      ),
    ).toBe('Sponsor report: $38.14M, $4,183 (under 0.1%) below the statement.');
    expect(
      crossCheckSentence(
        {
          basis: 'capital_account_balance',
          value: null,
          reason: 'no_ending_balance',
          difference: null,
          differencePct: null,
          differs: false,
        },
        'sponsor_equity_value',
      ),
    ).toBe(
      'Capital account statement: no value. No ending balance for our account in US dollars was accepted from the statement.',
    );
    // Beside a suggestion with no value there is nothing to measure the other source against.
    expect(
      crossCheckSentence({ ...report, difference: null, differencePct: null }, 'held_multiple'),
    ).toBe('Sponsor report: $7.83M.');
  });
});

describe('what operations is offered (docs/18 section 14)', () => {
  afterEach(() => clearTaxonomyLabels());
  const draft = {
    valuationId: SUGGESTION_ID.replacement,
    periodEnd: '2025-06-27',
    version: 1,
    state: 'Draft' as const,
    method: 'valuation_method.market_multiple',
    fairValue: '19000000.00',
    rowVersion: 4,
  };

  it('follows the state, the value and the version in progress for the quarter', () => {
    expect(offerFor(suggestionFixture())).toEqual({ kind: 'accept' });
    expect(offerFor(suggestionFixture({ inProgress: draft }))).toEqual({
      kind: 'applyToDraft',
      draft,
    });
    const prepared = { ...draft, state: 'OpsPrepared' as const };
    expect(offerFor(suggestionFixture({ inProgress: prepared }))).toEqual({
      kind: 'blocked',
      version: prepared,
    });
    expect(offerFor(notCalculableFixture())).toEqual({ kind: 'noValue' });
    expect(offerFor(suggestionFixture({ state: 'Dismissed' }))).toEqual({ kind: 'decided' });
  });

  it('words both confirmations with the value, the quarter, the method and the date kept', () => {
    registerTaxonomyLabels([{ code: 'valuation_method.sponsor_mark', label: 'Sponsor mark' }]);
    expect(acceptSentence(suggestionFixture())).toBe(
      'This opens a draft valuation at $20.9M for Jun 30, 2025. It still has to be prepared and approved before it is locked.',
    );
    expect(applySentence(suggestionFixture(), draft)).toBe(
      'This puts $20.9M and the method Sponsor mark on the draft dated Jun 27, 2025. The draft keeps its date.',
    );
  });

  it('says what became of a suggestion the system replaced or closed', () => {
    expect(suggestionStateWord('Superseded')).toBe('Replaced or closed');
    expect(suggestionStateWord('all')).toBe('All states');
    expect(
      supersededText({ supersededReason: 'better_source', supersededById: SUGGESTION_ID.report }),
    ).toBe('Replaced');
    expect(supersededText({ supersededReason: 'mark_locked', supersededById: null })).toBe(
      'Closed: a mark for this quarter is Locked.',
    );
    expect(supersededText({ supersededReason: 'position_closed', supersededById: null })).toBe(
      'Closed: the position is no longer held.',
    );
    expect(supersededText({ supersededReason: 'figures_changed', supersededById: null })).toBe(
      'Closed: the figures behind it changed.',
    );
  });
});

describe('what an approved run did (the run page)', () => {
  it('has a sentence for every reason no mark is suggested', () => {
    expect(Object.keys(NO_SUGGESTION_SENTENCE).sort()).toEqual(
      [...NO_SUGGESTION_REASON_CODES, 'nothing_on_hand'].sort(),
    );
    expect(NO_SUGGESTION_SENTENCE.fund_commitment).toBe(
      'this is our account in a fund commitment, which has no valuation record yet.',
    );
    expect(NO_SUGGESTION_SENTENCE.mark_locked).toBe(
      'a mark for this quarter or a later one is Locked.',
    );
  });

  it('words each outcome and links only to a suggestion that exists', () => {
    const id = SUGGESTION_ID.statement;
    expect(runOutcomeText({ outcome: 'opened', reason: null, suggestionId: id })).toEqual({
      text: 'Valuation suggestion opened',
      linked: true,
    });
    expect(runOutcomeText({ outcome: 'replaced', reason: null, suggestionId: id }).text).toBe(
      'Valuation suggestion replaced',
    );
    expect(runOutcomeText({ outcome: 'unchanged', reason: null, suggestionId: id })).toEqual({
      text: 'The valuation suggestion open for this quarter is unchanged',
      linked: true,
    });
    expect(
      runOutcomeText({ outcome: 'none', reason: 'private_credit', suggestionId: null }),
    ).toEqual({
      text: 'No mark suggested: suggestions are not built for private credit.',
      linked: false,
    });
    expect(runOutcomeText({ outcome: 'none', reason: null, suggestionId: null }).text).toBe(
      'No mark suggested: none was worked out when this run was approved.',
    );
  });
});

describe('a draft started from a suggestion (the version screen)', () => {
  const inputs = {
    basis: 'LTM EBITDA',
    'suggestion.id': SUGGESTION_ID.statement,
    'suggestion.value': '20940000.00',
    'suggestion.basis': 'capital_account_balance',
    'suggestion.documentId': SUGGESTION_ID.report,
    'suggestion.page': '1',
    'suggestion.runId': SUGGESTION_ID.replacement,
    'suggestion.input.ending_capital_balance': '20940000',
  };

  it('reads the suggestion a version names from its inputs, and none from a version made by hand', () => {
    expect(suggestionOnDraft(inputs)).toEqual({
      id: SUGGESTION_ID.statement,
      value: '20940000.00',
      basis: 'capital_account_balance',
      documentId: SUGGESTION_ID.report,
      page: 1,
      runId: SUGGESTION_ID.replacement,
    });
    expect(suggestionOnDraft({ basis: 'LTM EBITDA' })).toBeNull();
    expect(suggestionOnDraft({ 'suggestion.id': 7 })).toBeNull();
    expect(startedFromSentence(suggestionOnDraft(inputs)!)).toBe(
      'Started from a suggestion of $20.9M.',
    );
  });

  it('keeps the keys a suggestion wrote apart from the ones a person edits', () => {
    const { own, kept } = splitSuggestionKeys(inputs);
    expect(own).toEqual({ basis: 'LTM EBITDA' });
    expect(Object.keys(kept)).toHaveLength(7);
    expect(Object.keys(kept).every((name) => name.startsWith('suggestion.'))).toBe(true);
  });

  it('says what the suggestion wrote in words, and leaves the identifiers to the links', () => {
    const facts = suggestionFacts({
      ...inputs,
      'suggestion.periodEnd': '2025-06-30',
      'suggestion.input.investor_share_pct': '0.2500',
      'suggestion.crossCheck.sponsor_equity_value': '7831632.54',
      // A key the page has no word for reads from its name; an empty one says nothing.
      'suggestion.input.some_new_line': '12',
      'suggestion.crossCheck.held_multiple': '',
    });
    expect(facts).toEqual([
      { label: 'Suggested from', value: 'Capital account statement' },
      { label: 'Suggested mark', value: '$20,940,000.00' },
      { label: 'For the quarter', value: 'Jun 30, 2025' },
      { label: 'Ending capital balance', value: '$20,940,000.00' },
      { label: 'Our share of the vehicle', value: '25.00%' },
      { label: 'Some new line', value: '$12.00' },
      { label: 'Sponsor report, beside it', value: '$7,831,632.54' },
    ]);
    // No identifier, no page and no stored key name is among them.
    const text = JSON.stringify(facts);
    expect(text).not.toContain('suggestion.');
    expect(text).not.toContain(SUGGESTION_ID.statement);
    expect(text).not.toContain(SUGGESTION_ID.report);
    expect(suggestionFacts({ basis: 'LTM EBITDA' })).toEqual([]);
  });

  it('names the source document as what a mark was worked out from only when a figure came from it', () => {
    const fromDocument = { source: { kind: 'document' as const } };
    const typed = { source: { kind: 'reviewer' as const } };
    const fromRecord = { source: { kind: 'record' as const } };
    const fromMark = { source: { kind: 'valuation' as const } };
    const row = (basis: 'capital_account_balance' | 'sponsor_equity_value', inputs: object[]) =>
      ({ basis, workings: { inputs } }) as Parameters<typeof restsOnSourceDocument>[0];
    expect(restsOnSourceDocument(row('sponsor_equity_value', [fromMark, fromDocument]))).toBe(true);
    expect(restsOnSourceDocument(row('sponsor_equity_value', [fromMark, typed]))).toBe(true);
    // Raised by a statement with no value: every figure is the record's or the Locked mark.
    expect(restsOnSourceDocument(row('sponsor_equity_value', [fromMark, fromRecord]))).toBe(false);
    // A statement's own suggestion is the statement's, with or without a value.
    expect(restsOnSourceDocument(row('capital_account_balance', []))).toBe(true);
  });
});

describe('the address of the Suggestions tab', () => {
  it('keeps an id and a state it knows and drops anything else', () => {
    const id = SUGGESTION_ID.statement;
    expect(parseSuggestionsSearch({ id, state: 'Dismissed' })).toEqual({ id, state: 'Dismissed' });
    expect(parseSuggestionsSearch({ id: 'not-an-id', state: 'Locked' })).toEqual({});
    // Open is the list's own default.
    expect(parseSuggestionsSearch({ state: 'Open' })).toEqual({});
    expect(parseSuggestionsSearch({ state: 'all' })).toEqual({ state: 'all' });
    expect(searchFor(id, 'Open')).toEqual({ id });
    expect(searchFor(undefined, 'all')).toEqual({ state: 'all' });
  });
});
