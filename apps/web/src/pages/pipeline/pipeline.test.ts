import { describe, expect, it } from 'vitest';
import { MISSING } from '../../lib/format.js';
import {
  allocations,
  opportunityRows,
  OPP_ID,
  taxonomyFixture,
} from '../../test/fixtures-pipeline.js';
import {
  advanceBlocker,
  agingHint,
  agingTone,
  allocatedTotal,
  allocationsBody,
  closingBlockers,
  conditionsFromText,
  daysInStageLabel,
  dealTypeOptions,
  filterOpportunities,
  gateLines,
  groupByStage,
  isAging,
  isAmount,
  isCompleteLine,
  isIsoDate,
  linesOf,
  LIVE_STAGES,
  mayUse,
  nextStage,
  ownerOptions,
  PIPELINE_ROLES,
  STAGE_AGING_DAYS,
  STAGES,
  stageSteps,
  termsOf,
  termValueOf,
  termValueText,
  tieOutLabel,
  tieOutTone,
} from './pipeline.js';

const EM_DASH = String.fromCharCode(0x2014);

describe('stages and aging', () => {
  it('lists the nine stages in docs/18 order with Passed last, and the eight live ones', () => {
    expect(STAGES).toEqual([
      'Sourced',
      'Screening',
      'Prescreen',
      'Diligence',
      'IC',
      'Approved',
      'Closing',
      'Closed',
      'Passed',
    ]);
    expect(LIVE_STAGES).toEqual(STAGES.slice(0, 8));
  });

  it('reads the aging guide from config and never ages a Closed or Passed deal', () => {
    expect(STAGE_AGING_DAYS.Sourced).toBe(30);
    expect(STAGE_AGING_DAYS.Closed).toBeUndefined();
    expect(isAging('Sourced', 30)).toBe(false);
    expect(isAging('Sourced', 31)).toBe(true);
    expect(isAging('Closed', 400)).toBe(false);
    expect(isAging('Passed', 400)).toBe(false);
    expect(agingTone('Diligence', 91)).toBe('watch');
    expect(agingTone('Diligence', 90)).toBe('neutral');
    expect(agingHint('IC', 15)).toBe(
      'Over the 14-day guide for IC (config pipeline.stageAgingDays)',
    );
    expect(agingHint('IC', 14)).toBeNull();
    expect(daysInStageLabel(1)).toBe('1 day in stage');
    expect(daysInStageLabel(40)).toBe('40 days in stage');
  });

  it('marks the live stages before the current one done; a Passed deal sits on none', () => {
    const steps = stageSteps('Diligence');
    expect(steps.map((s) => s.status)).toEqual([
      'done',
      'done',
      'done',
      'current',
      'upcoming',
      'upcoming',
      'upcoming',
      'upcoming',
    ]);
    expect(stageSteps('Passed').every((s) => s.status === 'upcoming')).toBe(true);
    expect(stageSteps('Closed').filter((s) => s.status === 'done')).toHaveLength(7);
  });

  it('knows the next stage of an advance, and that Closed and Passed have none', () => {
    expect(nextStage('Sourced')).toBe('Screening');
    expect(nextStage('Approved')).toBe('Closing');
    expect(nextStage('Closed')).toBeNull();
    expect(nextStage('Passed')).toBeNull();
  });
});

describe('board grouping and filters', () => {
  it('groups every stage, the longest in stage first', () => {
    const columns = groupByStage(opportunityRows());
    expect([...columns.keys()]).toEqual(STAGES);
    expect(columns.get('Sourced')?.map((r) => r.id)).toEqual([OPP_ID.sourced]);
    expect(columns.get('Passed')?.map((r) => r.id)).toEqual([OPP_ID.passed]);
    const two = groupByStage([
      ...opportunityRows().filter((r) => r.stage === 'IC'),
      { ...opportunityRows()[0]!, id: 'x', name: 'Project Aft', stage: 'IC', daysInStage: 9 },
    ]);
    expect(two.get('IC')?.map((r) => r.name)).toEqual(['Project Aft', 'Project Tern']);
  });

  it('filters by owner and by deal type, and offers each once', () => {
    const rows = opportunityRows();
    expect(filterOpportunities(rows, { ownerId: '', dealType: '' })).toHaveLength(rows.length);
    const owned = filterOpportunities(rows, { ownerId: rows[1]!.owner!.id, dealType: '' });
    expect(owned.every((r) => r.owner !== null)).toBe(true);
    expect(owned).toHaveLength(rows.length - 1);
    expect(
      filterOpportunities(rows, { ownerId: '', dealType: 'deal_type.private_credit' }).map(
        (r) => r.id,
      ),
    ).toEqual([OPP_ID.screening]);
    expect(ownerOptions(rows)).toEqual([rows[1]!.owner]);
    expect(dealTypeOptions(rows)).toEqual([
      'deal_type.co_invest_equity',
      'deal_type.cv_single_asset',
      'deal_type.private_credit',
    ]);
  });
});

describe('gates', () => {
  const blocked = {
    diligence: { requiredOpen: 2, ok: false },
    icDecision: { ok: false },
    closing: { checklistComplete: false, allocationTiedOut: false, ok: false },
  };
  const clear = {
    diligence: { requiredOpen: 0, ok: true },
    icDecision: { ok: true },
    closing: { checklistComplete: true, allocationTiedOut: true, ok: true },
  };

  it('says what each gate waits for in a sentence, and that the closing gates wait for a record', () => {
    const lines = gateLines(blocked, false);
    expect(lines.map((l) => l.ok)).toEqual([false, false, false, false]);
    expect(lines[0]!.text).toBe(
      '2 diligence tasks required for IC are still open; the advance to IC waits for them (an approver may override with a reason).',
    );
    expect(lines[1]!.text).toBe('No IC decision is recorded; the advance from IC waits for one.');
    expect(lines[2]!.text).toMatch(/^No closing record yet/);
    expect(lines[3]!.text).toMatch(/starts once the closing record exists/);
    const one = gateLines({ ...blocked, diligence: { requiredOpen: 1, ok: false } }, true);
    expect(one[0]!.text).toMatch(/^1 diligence task required for IC is still open/);
    expect(one[2]!.text).toBe('A required closing item is still open (M8).');
    expect(one[3]!.text).toBe('Allocations do not tie to the closing commitment (M22).');
    const ok = gateLines(clear, true);
    expect(ok.map((l) => l.text)).toEqual([
      'Every diligence task required for IC is done or waived.',
      'An IC decision is recorded.',
      'Every required closing item is received or waived.',
      'Allocations tie to the closing commitment.',
    ]);
    for (const l of [...lines, ...ok]) expect(l.text).not.toContain(EM_DASH);
  });

  it('names the rule that blocks an advance, letting an approver past the diligence gate', () => {
    expect(advanceBlocker('Diligence', blocked, ['deal_team'])).toBe(
      '2 diligence tasks required for IC still open; an approver may override with a reason',
    );
    expect(advanceBlocker('Diligence', blocked, ['approver'])).toBeNull();
    expect(advanceBlocker('IC', blocked, ['approver'])).toBe('An IC decision record is required');
    expect(advanceBlocker('Closing', blocked, ['operations'])).toBe(
      'The closing checklist is incomplete; allocations do not tie to the closing commitment (M22)',
    );
    expect(
      advanceBlocker(
        'Closing',
        { ...blocked, closing: { checklistComplete: true, allocationTiedOut: false, ok: false } },
        ['operations'],
      ),
    ).toBe('Allocations do not tie to the closing commitment (M22)');
    expect(advanceBlocker('Approved', blocked, ['deal_team'])).toBeNull();
    expect(advanceBlocker('Sourced', blocked, ['deal_team'])).toBeNull();
    for (const stage of STAGES) expect(advanceBlocker(stage, clear, [])).toBeNull();
  });
});

describe('allocations and the tie-out', () => {
  it('words the tie-out and tones it', () => {
    const tied = {
      commitment: '20000000.00',
      allocated: '20000000.00',
      difference: '0.00',
      tiedOut: true,
    };
    expect(tieOutLabel(tied)).toBe('Tied out');
    expect(tieOutTone(tied)).toBe('good');
    const short = { ...tied, allocated: '19500000.00', difference: '-500000.00', tiedOut: false };
    expect(tieOutLabel(short)).toBe('Short by $0.5M');
    expect(tieOutTone(short)).toBe('bad');
    expect(
      tieOutLabel({ ...tied, allocated: '21000000.00', difference: '1000000.00', tiedOut: false }),
    ).toBe('Over by $1.0M');
  });

  it('turns rows into editable lines, sums them as the API does and builds the PUT body', () => {
    const lines = linesOf(allocations());
    expect(lines).toEqual([
      {
        vehicleId: allocations()[0]!.vehicle.id,
        clientId: '',
        requested: '12000000.00',
        received: '12000000.00',
      },
      {
        vehicleId: allocations()[1]!.vehicle.id,
        clientId: allocations()[1]!.client!.id,
        requested: '8000000.00',
        received: '',
      },
    ]);
    expect(lines.every(isCompleteLine)).toBe(true);
    // Received when known, otherwise requested: exactly as the API ties out.
    expect(allocatedTotal(lines)).toBe('20000000.00');
    expect(allocatedTotal([{ ...lines[0]!, received: '11999999.99' }, lines[1]!])).toBe(
      '19999999.99',
    );
    expect(allocatedTotal([{ ...lines[0]!, requested: 'abc' }])).toBeNull();
    expect(allocatedTotal([{ ...lines[0]!, vehicleId: '' }])).toBeNull();
    expect(allocationsBody(lines)).toEqual({
      allocations: [
        { vehicleId: lines[0]!.vehicleId, requested: '12000000.00', received: '12000000.00' },
        { vehicleId: lines[1]!.vehicleId, clientId: lines[1]!.clientId, requested: '8000000.00' },
      ],
    });
  });

  it('accepts digits with an optional decimal point and nothing negative', () => {
    expect(isAmount('1500000.00')).toBe(true);
    expect(isAmount(' 15 ')).toBe(true);
    expect(isAmount('-1')).toBe(false);
    expect(isAmount('1,500')).toBe(false);
    expect(isAmount('')).toBe(false);
  });
});

describe('closing words and forms', () => {
  it('lists what blocks the confirmation, in words, and nothing when clear', () => {
    const tied = { commitment: '1.00', allocated: '1.00', difference: '0.00', tiedOut: true };
    expect(closingBlockers({ itemsRequiredOpen: 0, allocationTieOut: tied })).toEqual([]);
    expect(
      closingBlockers({
        itemsRequiredOpen: 2,
        allocationTieOut: { ...tied, allocated: '0.50', difference: '-0.50', tiedOut: false },
      }),
    ).toEqual([
      '2 required closing items still open: a required closing document is missing (M8)',
      'Allocations do not tie to the closing commitment, short by $0.0M (M22)',
    ]);
  });

  it('splits conditions by line and builds a term value from its typed rows', () => {
    expect(conditionsFromText(' Key person confirmed \n\nMFN election\n')).toEqual([
      'Key person confirmed',
      'MFN election',
    ]);
    expect(
      termValueOf([
        { name: ' rate ', value: ' 2% ' },
        { name: '', value: 'dropped' },
      ]),
    ).toEqual({
      rate: '2%',
    });
    expect(termValueText({ rate: '2%', elected: true, years: 3 })).toBe(
      'rate: 2%; elected: true; years: 3',
    );
    expect(termValueText({})).toBe(MISSING);
  });

  it('takes a date as the date input gives it', () => {
    expect(isIsoDate('2025-08-15')).toBe(true);
    expect(isIsoDate('15/08/2025')).toBe(false);
    expect(isIsoDate('')).toBe(false);
  });

  it('reads taxonomy terms by domain in sort order, and roles from the route table', () => {
    expect(termsOf(taxonomyFixture(), 'pass_reason').map((t) => t.label)).toEqual([
      'Valuation',
      'Fund fit',
      'Other',
    ]);
    expect(termsOf(taxonomyFixture(), 'nothing')).toEqual([]);
    expect(termsOf(undefined, 'pass_reason')).toEqual([]);
    expect(PIPELINE_ROLES.createOpportunity).toEqual(['deal_team']);
    expect(PIPELINE_ROLES.icDecision).toEqual(['approver']);
    expect(PIPELINE_ROLES.closingCommand).toEqual(['operations']);
    expect(PIPELINE_ROLES.closingItem).toEqual(['operations', 'deal_team']);
    expect(mayUse(['viewer'], PIPELINE_ROLES.createOpportunity)).toBe(false);
    expect(mayUse(['viewer', 'deal_team'], PIPELINE_ROLES.createOpportunity)).toBe(true);
    expect(mayUse(['viewer'], [])).toBe(true);
  });
});
