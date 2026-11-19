import { describe, expect, it } from 'vitest';
import { MISSING } from '../../lib/format.js';
import {
  allocationFixture,
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
  allocationsLock,
  breakdownLabel,
  carriedOverNote,
  closingBlockers,
  closingLock,
  conditionsFromText,
  daysInStageLabel,
  dealTypeOptions,
  filterOpportunities,
  gateLines,
  groupByStage,
  groupByVehicle,
  hiddenLinesNote,
  isAging,
  isAmount,
  isCompleteLine,
  isIsoDate,
  linesOf,
  LIVE_STAGES,
  mayUse,
  missingReceivedLines,
  nextStage,
  orderedByVehicle,
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
    expect(agingHint('IC', 15)).toBe('Over the 14-day guide for IC');
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
    diligence: { requiredOpen: 2, ok: false, carriedOver: 0 },
    icDecision: { ok: false },
    closing: { checklistComplete: false, allocationTiedOut: false, confirmed: false, ok: false },
  };
  const clear = {
    diligence: { requiredOpen: 0, ok: true, carriedOver: 0 },
    icDecision: { ok: true },
    closing: { checklistComplete: true, allocationTiedOut: true, confirmed: true, ok: true },
  };

  it('says what each gate waits for in a sentence, and that the closing gates wait for a record', () => {
    const lines = gateLines(blocked, false);
    expect(lines.map((l) => l.key)).toEqual([
      'diligence',
      'ic',
      'checklist',
      'tieOut',
      'confirmed',
    ]);
    expect(lines.map((l) => l.ok)).toEqual([false, false, false, false, false]);
    expect(lines[0]!.text).toBe(
      '2 diligence tasks required for IC are still open; the advance to IC waits for them (an approver may override with a reason).',
    );
    expect(lines[1]!.text).toBe(
      'No approved IC decision is recorded since the deal last entered IC; the advance from IC waits for one.',
    );
    expect(lines[2]!.text).toMatch(/^No closing record yet/);
    expect(lines[3]!.text).toMatch(/starts once the closing record exists/);
    expect(lines[4]!.text).toBe('Operations confirm the closing once the closing record exists.');
    const one = gateLines(
      { ...blocked, diligence: { requiredOpen: 1, ok: false, carriedOver: 0 } },
      true,
    );
    expect(one[0]!.text).toMatch(/^1 diligence task required for IC is still open/);
    expect(one[2]!.text).toBe('A required closing item is still open.');
    expect(one[3]!.text).toBe('The received amounts do not tie to the closing commitment.');
    expect(one[4]!.text).toBe(
      'Operations have not confirmed the closing; the advance to Closed waits for the confirmation.',
    );
    const ok = gateLines(clear, true);
    expect(ok.map((l) => l.ok)).toEqual([true, true, true, true, true]);
    expect(ok.map((l) => l.text)).toEqual([
      'Every diligence task required for IC is done or waived.',
      'An IC decision is recorded.',
      'Every required closing item is received or waived.',
      'The received amounts tie to the closing commitment.',
      'Operations confirmed the closing.',
    ]);
    for (const l of [...lines, ...one, ...ok]) expect(l.text).not.toContain(EM_DASH);
  });

  it('says how many tasks were done before the deal was reopened, where the diligence gate is shown', () => {
    expect(carriedOverNote(0)).toBeNull();
    expect(carriedOverNote(1)).toBe('1 was done or waived before the deal was reopened');
    expect(carriedOverNote(4)).toBe('4 were done or waived before the deal was reopened');
    const reopened = gateLines(
      { ...clear, diligence: { requiredOpen: 0, ok: true, carriedOver: 4 } },
      true,
    );
    expect(reopened[0]!.text).toBe(
      'Every diligence task required for IC is done or waived; 4 were done or waived before the deal was reopened.',
    );
    const stillOpen = gateLines(
      { ...blocked, diligence: { requiredOpen: 1, ok: false, carriedOver: 1 } },
      true,
    );
    expect(stillOpen[0]!.text).toBe(
      '1 diligence task required for IC is still open; the advance to IC waits for them (an approver may override with a reason). 1 was done or waived before the deal was reopened.',
    );
    expect(reopened[0]!.text).not.toContain(EM_DASH);
  });

  it('names the rule that blocks an advance, letting an approver past the diligence gate', () => {
    expect(advanceBlocker('Diligence', blocked, ['deal_team'])).toBe(
      '2 diligence tasks required for IC still open; an approver may override with a reason',
    );
    expect(advanceBlocker('Diligence', blocked, ['approver'])).toBeNull();
    expect(advanceBlocker('IC', blocked, ['approver'])).toBe('An IC decision record is required');
    expect(advanceBlocker('Closing', blocked, ['operations'])).toBe(
      'The closing checklist is incomplete; allocations do not tie to the closing commitment; the closing is not confirmed by operations',
    );
    expect(
      advanceBlocker(
        'Closing',
        {
          ...blocked,
          closing: {
            checklistComplete: true,
            allocationTiedOut: false,
            confirmed: false,
            ok: false,
          },
        },
        ['operations'],
      ),
    ).toBe(
      'Allocations do not tie to the closing commitment; the closing is not confirmed by operations',
    );
    // The checklist is in and the lines tie: the advance to Closed still names the confirmation.
    expect(
      advanceBlocker(
        'Closing',
        {
          ...blocked,
          closing: {
            checklistComplete: true,
            allocationTiedOut: true,
            confirmed: false,
            ok: false,
          },
        },
        ['operations'],
      ),
    ).toBe('The closing is not confirmed by operations');
    expect(advanceBlocker('Closing', clear, ['operations'])).toBeNull();
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
      hiddenLines: 0,
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

  it('turns rows into editable lines, sums the received amounts as the API does and builds the PUT body', () => {
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
        received: '8000000.00',
      },
    ]);
    expect(lines.every(isCompleteLine)).toBe(true);
    expect(allocatedTotal(lines)).toBe('20000000.00');
    expect(missingReceivedLines(lines)).toBe(0);
    expect(allocatedTotal([{ ...lines[0]!, received: '11999999.99' }, lines[1]!])).toBe(
      '19999999.99',
    );
    // The received amounts only: a requested amount never stands in for a received one (M22).
    const requestedOnly = [lines[0]!, { ...lines[1]!, received: ' ' }];
    expect(requestedOnly.every(isCompleteLine)).toBe(true);
    expect(allocatedTotal(requestedOnly)).toBe('12000000.00');
    expect(missingReceivedLines(requestedOnly)).toBe(1);
    expect(allocatedTotal([{ ...lines[0]!, received: '' }])).toBe('0.00');
    expect(allocatedTotal([{ ...lines[0]!, requested: 'abc' }])).toBeNull();
    expect(allocatedTotal([{ ...lines[0]!, vehicleId: '' }])).toBeNull();
    expect(allocationsBody(requestedOnly)).toEqual({
      allocations: [
        { vehicleId: lines[0]!.vehicleId, requested: '12000000.00', received: '12000000.00' },
        { vehicleId: lines[1]!.vehicleId, clientId: lines[1]!.clientId, requested: '8000000.00' },
      ],
    });
  });

  it('locks the lines once operations confirmed the closing, and for good once the deal is closed', () => {
    const open = { state: 'Open' as const };
    const confirmed = { state: 'OpsConfirmed' as const };
    expect(allocationsLock('Approved', null)).toBeNull();
    expect(allocationsLock('Closing', open)).toBeNull();
    expect(allocationsLock('Closing', confirmed)).toBe(
      'The closing is confirmed; change the close date or ask operations to reopen it',
    );
    // A confirmed closing of a deal that was passed and reopened is still what was confirmed.
    expect(allocationsLock('Screening', confirmed)).toBe(
      'The closing is confirmed; change the close date or ask operations to reopen it',
    );
    expect(allocationsLock('Closed', confirmed)).toBe(
      'Allocations are fixed once the deal is closed; raise a change request instead',
    );
  });

  it('accepts digits with an optional decimal point and nothing negative', () => {
    expect(isAmount('1500000.00')).toBe(true);
    expect(isAmount(' 15 ')).toBe(true);
    expect(isAmount('-1')).toBe(false);
    expect(isAmount('1,500')).toBe(false);
    expect(isAmount('')).toBe(false);
  });
});

describe('the lines by vehicle, the client breakdown and the lines not shown (D1-06)', () => {
  const fundI = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Beach Co-Invest Fund I' };
  const credit = { id: '00000000-0000-4000-8000-0000000000a2', name: 'Beach Credit Partners I' };
  const alpha = { id: '00000000-0000-4000-8000-0000000000c1', name: 'Alpha Pension Trust' };
  const beta = { id: '00000000-0000-4000-8000-0000000000c2', name: 'Beta Endowment' };
  const line = (
    id: string,
    vehicle: typeof fundI,
    client: typeof alpha | null,
    requested: string,
    received: string | null,
  ) => allocationFixture({ id, vehicle, client, requested, received });
  // As the API orders them: by vehicle name, the client lines before the vehicle line.
  const rows = [
    line('l1', fundI, beta, '4000000.00', null),
    line('l2', fundI, alpha, '6000000.00', '6000000.00'),
    line('l3', fundI, null, '10000000.00', '10000000.00'),
    line('l4', credit, null, '8000000.00', null),
  ];

  it('groups the lines by vehicle: the vehicle totals first, the client lines under their vehicle by client name', () => {
    const groups = groupByVehicle(rows, 0);
    expect(groups.map((g) => g.vehicle.name)).toEqual([
      'Beach Co-Invest Fund I',
      'Beach Credit Partners I',
    ]);
    expect(groups[0]).toMatchObject({
      requested: '20000000.00',
      // The sum of the received amounts on record: the Beta line has none yet.
      received: '16000000.00',
      vehicleLine: { id: 'l3' },
    });
    expect(groups[0]!.clientLines.map((l) => l.client?.name)).toEqual([
      'Alpha Pension Trust',
      'Beta Endowment',
    ]);
    // A vehicle with its own line alone: the totals are that line's, and nothing received reads as missing.
    expect(groups[1]).toMatchObject({
      requested: '8000000.00',
      received: null,
      vehicleLine: { id: 'l4' },
      clientLines: [],
    });
    expect(groupByVehicle([], 0)).toEqual([]);
  });

  it('states no vehicle total when lines of the deal are not shown: the total would leave them out (rule 10)', () => {
    // Investor relations entitled to Alpha: its line, and two lines not shown.
    const own = groupByVehicle([rows[1]!], 2);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ requested: null, received: null, vehicleLine: null });
    expect(own[0]!.clientLines.map((l) => l.id)).toEqual(['l2']);
    // A viewer shown a vehicle line while client lines are hidden: the line keeps its own amounts.
    const viewer = groupByVehicle([rows[2]!], 2);
    expect(viewer[0]).toMatchObject({
      requested: null,
      received: null,
      vehicleLine: { id: 'l3', requested: '10000000.00' },
      clientLines: [],
    });
  });

  it('orders the editable lines the same way: each vehicle line first, its client lines under it', () => {
    expect(orderedByVehicle(rows).map((r) => r.id)).toEqual(['l3', 'l2', 'l1', 'l4']);
    expect(linesOf(rows).map((l) => [l.vehicleId, l.clientId])).toEqual([
      [fundI.id, ''],
      [fundI.id, alpha.id],
      [fundI.id, beta.id],
      [credit.id, ''],
    ]);
  });

  it('labels the client breakdown with its count, and says how many lines are not shown in plain words', () => {
    expect(breakdownLabel(3)).toBe('Client breakdown (3 lines)');
    expect(breakdownLabel(1)).toBe('Client breakdown (1 line)');
    expect(hiddenLinesNote(0)).toBeNull();
    expect(hiddenLinesNote(1)).toBe(
      '1 client line is not shown. Client-level lines are for operations, the investment team (the deal team and approvers) and auditors, and for readers entitled to the client.',
    );
    expect(hiddenLinesNote(3)).toBe(
      '3 client lines are not shown. Client-level lines are for operations, the investment team (the deal team and approvers) and auditors, and for readers entitled to the client.',
    );
    for (const n of [1, 3]) expect(hiddenLinesNote(n)).not.toContain(EM_DASH);
  });
});

describe('closing words and forms', () => {
  it('lists what blocks the confirmation, in words, and nothing when clear', () => {
    const tied = {
      commitment: '1.00',
      allocated: '1.00',
      difference: '0.00',
      tiedOut: true,
      hiddenLines: 0,
    };
    const received = [{ received: '1.00' }];
    expect(
      closingBlockers({ itemsRequiredOpen: 0, allocationTieOut: tied, allocations: received }),
    ).toEqual([]);
    expect(
      closingBlockers({
        itemsRequiredOpen: 2,
        allocationTieOut: { ...tied, allocated: '0.50', difference: '-0.50', tiedOut: false },
        allocations: [{ received: '0.50' }],
      }),
    ).toEqual([
      '2 required closing items still open: a required closing document is missing',
      'Allocations do not tie to the closing commitment, short by $0.0M',
    ]);
    // A line with no received amount is what the API names in its refusal: count the lines.
    expect(
      closingBlockers({
        itemsRequiredOpen: 0,
        allocationTieOut: { ...tied, allocated: '0.50', difference: '-0.50', tiedOut: false },
        allocations: [{ received: '0.50' }, { received: null }],
      }),
    ).toEqual(['Received amounts are missing on 1 line']);
    // The received amounts reach the commitment and two lines still have none.
    expect(
      closingBlockers({
        itemsRequiredOpen: 0,
        allocationTieOut: { ...tied, tiedOut: false },
        allocations: [{ received: '1.00' }, { received: null }, { received: null }],
      }),
    ).toEqual(['Received amounts are missing on 2 lines']);
    // A reader who is not shown every line cannot count the lines with no received amount: the
    // blocker speaks of the tie-out, which is the deal's, and never of a count of the lines shown.
    expect(
      closingBlockers({
        itemsRequiredOpen: 0,
        allocationTieOut: {
          ...tied,
          allocated: '0.50',
          difference: '-0.50',
          tiedOut: false,
          hiddenLines: 2,
        },
        allocations: [{ received: '0.50' }, { received: null }],
      }),
    ).toEqual(['Allocations do not tie to the closing commitment, short by $0.0M']);
  });

  it('says why a confirmed closing takes no change, and why one with a position takes none at all', () => {
    expect(closingLock({ state: 'Open', investmentId: null })).toEqual({
      items: null,
      move: null,
    });
    expect(closingLock({ state: 'OpsConfirmed', investmentId: null })).toEqual({
      items: 'The closing is confirmed; change the close date or ask operations to reopen it',
      move: null,
    });
    expect(closingLock({ state: 'OpsConfirmed', investmentId: 'x' })).toEqual({
      items: 'The position exists; record the change through a deal change request',
      move: 'The position exists; record the change through a deal change request',
    });
    // A closing that predates the pipeline may still be Open with its position on record.
    expect(closingLock({ state: 'Open', investmentId: 'x' })).toEqual({
      items: null,
      move: 'The position exists; record the change through a deal change request',
    });
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
