import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from './testing.js';
import type { DbHandle } from './client.js';
import { asSystemActor, withUserContext } from './context.js';
import type { Tx } from './context.js';
import type { AppRole } from './roles.js';
import { SYSTEM_USER_ID } from './roles.js';
import { ids, loadFixture } from './rls/fixture.js';
import { expectDbRejection } from './test-utils.js';

/** Database-level financial controls: locks, immutability, history, segregation of duties, sign discipline. */
describe('database guards', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
    await loadFixture(handle);
  });
  afterAll(async () => {
    await handle.close();
  });

  const asOps = (fn: (tx: Tx) => Promise<unknown>): Promise<void> =>
    withUserContext(
      handle.db,
      { userId: ids.users.operations, roles: ['operations'] },
      async (tx) => {
        await fn(tx);
      },
    );

  describe('Locked valuations (SEC-9.3, M10)', () => {
    it('cannot be updated in place, even by operations', async () => {
      await expectDbRejection(
        asOps((tx) =>
          tx.execute(
            sql`update mon.valuation set fair_value = 1 where id = ${ids.valuationLocked}`,
          ),
        ),
        /Locked and cannot be updated in place/,
      );
    });
    it('cannot be deleted by anyone, including the owner', async () => {
      await expectDbRejection(
        handle.exec(`delete from mon.valuation where id = '${ids.valuationLocked}'`),
        /immutable/,
      );
    });
    it('cannot be reopened without a reason', async () => {
      await expectDbRejection(
        asOps((tx) =>
          tx.execute(
            sql`update mon.valuation set state = 'Reopened' where id = ${ids.valuationLocked}`,
          ),
        ),
        /requires a reason/,
      );
    });
    it('cannot change locked values while reopening', async () => {
      await expectDbRejection(
        asOps((tx) =>
          tx.execute(
            sql`update mon.valuation set state = 'Reopened', reopen_reason = 'restated', fair_value = 1 where id = ${ids.valuationLocked}`,
          ),
        ),
        /keeps its locked values/,
      );
    });
    it('allows only one Locked version per investment and period', async () => {
      await expectDbRejection(
        handle.exec(
          `insert into mon.valuation (investment_id, period_end, version, method, fair_value, state, lock_hash, prepared_by, approved_by)
           values ('${ids.investment1}', '2024-06-30', 2, 'valuation_method.cost', 1, 'Locked', 'h', '${ids.users.operations}', '${ids.users.approver}')`,
        ),
        /valuation_one_locked_idx/,
      );
    });
    it('can be reopened with a reason, after which the row is read-only', async () => {
      await asOps((tx) =>
        tx.execute(
          sql`update mon.valuation set state = 'Reopened', reopen_reason = 'Sponsor restated Q2' where id = ${ids.valuationLocked}`,
        ),
      );
      const rows = await handle.query<{ state: string; fair_value: string }>(
        `select state, fair_value from mon.valuation where id = '${ids.valuationLocked}'`,
      );
      expect(rows[0]).toEqual({ state: 'Reopened', fair_value: '45000000.00' });
      await expectDbRejection(
        asOps((tx) =>
          tx.execute(
            sql`update mon.valuation set fair_value = 2 where id = ${ids.valuationLocked}`,
          ),
        ),
        /read-only/,
      );
    });
  });

  describe('segregation of duties (SEC-5.6)', () => {
    it('rejects a valuation whose preparer is also the final approver', async () => {
      await expectDbRejection(
        handle.exec(
          `insert into mon.valuation (investment_id, period_end, version, method, fair_value, state, lock_hash, prepared_by, approved_by)
           values ('${ids.investment1}', '2024-09-30', 1, 'valuation_method.cost', 1, 'Locked', 'h', '${ids.users.operations}', '${ids.users.operations}')`,
        ),
        /check constraint/,
      );
    });
    it('requires an approver before a valuation can be Locked', async () => {
      await expectDbRejection(
        handle.exec(
          `insert into mon.valuation (investment_id, period_end, version, method, fair_value, state, lock_hash, prepared_by)
           values ('${ids.investment1}', '2024-09-30', 1, 'valuation_method.cost', 1, 'Locked', 'h', '${ids.users.operations}')`,
        ),
        /check constraint/,
      );
    });
  });

  describe('wire instructions and trade tickets (SEC-12.2, SEC-12.3, migration 0013)', () => {
    const wire = (columns: string, values: string) =>
      handle.exec(
        `insert into mon.wire_instruction (investment_id, counterparty_name, version, bank_details_enc, bank_details_masked, proposed_by, ${columns})
         values ('${ids.investment1}', 'Harborlight Fund IV', 9, 'enc', 'Harbor Street Bank ****7788', '${ids.users.operations}', ${values})`,
      );

    it('rejects a callback made by the proposer', async () => {
      await expectDbRejection(
        wire(
          'callback_by, callback_at, callback_number_source, callback_result',
          `'${ids.users.operations}', now(), 'prior_instruction', 'confirmed'`,
        ),
        /check constraint/,
      );
    });
    it('rejects Verified without a confirmed callback by a named person', async () => {
      await expectDbRejection(wire('state', `'Verified'`), /check constraint/);
      await expectDbRejection(
        wire(
          'state, callback_by, callback_at, callback_number_source, callback_result, verified_at',
          `'Verified', '${ids.users.operations2}', now(), 'known_contact', 'not_confirmed', now()`,
        ),
        /check constraint/,
      );
    });
    it('rejects an active version that is not Verified, and a second active version per counterparty', async () => {
      await expectDbRejection(wire('active', 'true'), /check constraint/);
      await expectDbRejection(
        wire(
          'state, callback_by, callback_at, callback_number_source, callback_result, verified_at, active',
          `'Verified', '${ids.users.operations2}', now(), 'prior_instruction', 'confirmed', now(), true`,
        ),
        /wire_instruction_investment_active_idx/,
      );
    });
    it('rejects a counterparty that is both a sponsor fund and an investment, or neither', async () => {
      await expectDbRejection(wire('sponsor_fund_id', `'${ids.sponsorFund}'`), /check constraint/);
      await expectDbRejection(
        handle.exec(
          `insert into mon.wire_instruction (counterparty_name, version, bank_details_enc, bank_details_masked, proposed_by) values ('Nobody', 1, 'enc', 'x ****0000', '${ids.users.operations}')`,
        ),
        /check constraint/,
      );
    });
    it('rejects a Rejected version without a reason', async () => {
      await expectDbRejection(wire('state', `'Rejected'`), /check constraint/);
    });
    it('rejects a ticket approved by its preparer, and Approved without an approver and an instruction', async () => {
      const ticket = (columns: string, values: string) =>
        handle.exec(
          `insert into mon.trade_ticket (capital_notice_id, amount, funding_date, prepared_by, ${columns})
           values ('${ids.capitalNoticeOpenDistribution}', 500000, '2024-10-15', '${ids.users.operations}', ${values})`,
        );
      await expectDbRejection(
        ticket('approved_by, approved_at', `'${ids.users.operations}', now()`),
        /check constraint/,
      );
      await expectDbRejection(ticket('state', `'Approved'`), /check constraint/);
      await expectDbRejection(
        ticket('state, approved_by, approved_at', `'Approved', '${ids.users.approver}', now()`),
        /check constraint/,
      );
      await expectDbRejection(ticket('state', `'Withdrawn'`), /check constraint/);
      await expectDbRejection(
        handle.exec(
          `insert into mon.trade_ticket (capital_notice_id, amount, funding_date, prepared_by) values ('${ids.capitalNoticeOpenDistribution}', 0, '2024-10-15', '${ids.users.operations}')`,
        ),
        /check constraint/,
      );
    });
    it('allows one ticket per notice', async () => {
      await expectDbRejection(
        handle.exec(
          `insert into mon.trade_ticket (capital_notice_id, amount, funding_date, prepared_by) values ('${ids.capitalNoticeOpen}', 1, '2024-09-15', '${ids.users.operations}')`,
        ),
        /unique|duplicate key/,
      );
    });
    it('keeps a full history image of the register and the tickets', async () => {
      await asOps((tx) =>
        tx.execute(
          sql`update mon.wire_instruction set source_note = 'Confirmed again at the AGM' where id = ${ids.wireInstructionProposed}`,
        ),
      );
      const history = await handle.query<{ op: string; row_image: { source_note: string } }>(
        `select op, row_image from mon.wire_instruction_history where row_id = '${ids.wireInstructionProposed}' order by history_id`,
      );
      expect(history.map((h) => h.op)).toEqual(['INSERT', 'UPDATE']);
      expect(history[1]?.row_image.source_note).toBe('Confirmed again at the AGM');
      const tickets = await handle.query<{ n: number }>(
        `select count(*)::int as n from mon.trade_ticket_history where row_id = '${ids.tradeTicketOpen}'`,
      );
      expect(tickets[0]?.n).toBe(1);
    });
  });

  describe('change requests, the pipeline and closings (migration 0013)', () => {
    it('rejects a change request Applied without a period and an applier, Rejected without a reason, Routed without an owner', async () => {
      const request = (columns: string, values: string) =>
        handle.exec(
          `insert into mon.deal_change_request (investment_id, change_type, effective_date, summary, submitted_by, ${columns})
           values ('${ids.investment1}', 'change_type.partial_exit', '2024-09-30', 'Partial exit of the minority stake', '${ids.users.dealTeam}', ${values})`,
        );
      await expectDbRejection(
        request('state, owner_id', `'Applied', '${ids.users.operations}'`),
        /check constraint/,
      );
      await expectDbRejection(
        request(
          'state, owner_id, applied_period',
          `'Applied', '${ids.users.operations}', '2024-09-30'`,
        ),
        /check constraint/,
      );
      await expectDbRejection(request('state', `'Rejected'`), /check constraint/);
      await expectDbRejection(request('state', `'Routed'`), /check constraint/);
      await expectDbRejection(
        handle.exec(
          `insert into mon.deal_change_request (investment_id, change_type, effective_date, summary, submitted_by) values ('${ids.investment1}', 'sector.software', '2024-09-30', 'Wrong domain', '${ids.users.dealTeam}')`,
        ),
        /check constraint/,
      );
    });
    it('rejects a Passed opportunity without a reason code and a Closed one without an investment', async () => {
      const opportunity = (columns: string, values: string) =>
        handle.exec(
          `insert into deal.opportunity (name, company_name, sponsor_id, deal_type, received_date, ${columns})
           values ('Project Reef', 'Reef Analytics', '${ids.sponsor}', 'deal_type.co_invest_equity', '2024-10-01', ${values})`,
        );
      await expectDbRejection(opportunity('stage', `'Passed'`), /check constraint/);
      await expectDbRejection(opportunity('stage', `'Closed'`), /check constraint/);
      await expectDbRejection(
        opportunity('pass_reason_code', `'change_type.other'`),
        /check constraint/,
      );
    });
    it('rejects a closing that is OpsConfirmed without a confirmer, or anchored on nothing', async () => {
      await expectDbRejection(
        handle.exec(
          `insert into deal.closing (investment_id, close_date, commitment_amount, state) values ('${ids.investment1}', '2022-03-15', 30000000, 'OpsConfirmed')`,
        ),
        /check constraint/,
      );
      await expectDbRejection(
        handle.exec(
          `insert into deal.closing (close_date, commitment_amount) values ('2022-03-15', 30000000)`,
        ),
        /check constraint/,
      );
      await expectDbRejection(
        handle.exec(
          `insert into deal.closing (investment_id, close_date, commitment_amount) values ('${ids.investment1}', '2022-03-15', 0)`,
        ),
        /check constraint/,
      );
    });
    it('rejects a received checklist item without a document and a waived one without a reason', async () => {
      await expectDbRejection(
        asOps((tx) =>
          tx.execute(
            sql`update deal.closing_item set status = 'received' where id = ${ids.closingItemOpen}`,
          ),
        ),
        /check constraint/,
      );
      await expectDbRejection(
        asOps((tx) =>
          tx.execute(
            sql`update deal.closing_item set status = 'waived' where id = ${ids.closingItemOpen}`,
          ),
        ),
        /check constraint/,
      );
      // The deal team owns diligence tasks (operations is filtered out by the policy, not refused).
      await expectDbRejection(
        withUserContext(
          handle.db,
          { userId: ids.users.dealTeam, roles: ['deal_team'] },
          async (tx) => {
            await tx.execute(
              sql`update deal.diligence_task set status = 'waived' where id = ${ids.diligenceTaskOpen}`,
            );
          },
        ),
        /check constraint/,
      );
    });
    it('keeps the close date in one place: no other table has a column named close_date', async () => {
      const rows = await handle.query<{ table_schema: string; table_name: string }>(
        `select table_schema, table_name from information_schema.columns where column_name = 'close_date' and table_schema not in ('pg_catalog', 'information_schema')`,
      );
      expect(rows).toEqual([{ table_schema: 'deal', table_name: 'closing' }]);
    });
    it('keeps one allocation line per anchor, vehicle and client', async () => {
      await expectDbRejection(
        handle.exec(
          `insert into deal.allocation (opportunity_id, vehicle_id, requested) values ('${ids.opportunityOpen}', '${ids.vehicle}', 1)`,
        ),
        /unique|duplicate key/,
      );
    });
  });

  describe('reporting packages and their QA findings (migration 0019, SEC-5.6, SEC-9.3, SEC-9.5)', () => {
    const u = ids.users;
    const pkg = (columns: string, values: string): Promise<unknown> =>
      handle.exec(
        `insert into rpt.package (client_id, period_end, as_of, basis, label, prepared_by${columns}) values ('${ids.clientC}', '2024-06-30', '2024-08-09', 'gross', 'final', '${u.investorRelationsA}'${values})`,
      );

    it('rejects a package reviewed by its preparer', async () => {
      await expectDbRejection(
        pkg(', reviewer_id', `, '${u.investorRelationsA}'`),
        /check constraint/,
      );
    });
    it('rejects Approved without a reviewer, a time and a content hash, and Released without who and when', async () => {
      await expectDbRejection(pkg(', state', `, 'Approved'`), /check constraint/);
      await expectDbRejection(
        pkg(', state, reviewer_id, approved_at', `, 'Approved', '${u.approver}', now()`),
        /check constraint/,
      );
      await expectDbRejection(
        pkg(
          ', state, reviewer_id, approved_at, content_hash',
          `, 'Released', '${u.approver}', now(), '${'a'.repeat(64)}'`,
        ),
        /check constraint/,
      );
    });
    it('rejects a period that ends after the as-of date, and a later version with no reason', async () => {
      await expectDbRejection(
        handle.exec(
          `insert into rpt.package (client_id, period_end, as_of, basis, label, prepared_by) values ('${ids.clientC}', '2024-09-30', '2024-08-09', 'gross', 'final', '${u.investorRelationsA}')`,
        ),
        /check constraint/,
      );
      await expectDbRejection(pkg(', version', ', 2'), /check constraint/);
      await expectDbRejection(pkg(', version, correction_reason', `, 2, '  '`), /check constraint/);
    });
    it('keeps one package per client, period, basis and version', async () => {
      await expectDbRejection(
        handle.exec(
          `insert into rpt.package (client_id, period_end, as_of, basis, label, prepared_by) values ('${ids.clientA}', '2024-06-30', '2024-08-09', 'gross', 'final', '${u.investorRelationsA}')`,
        ),
        /unique/,
      );
    });
    it('makes a Released package immutable: no update, no delete, no new finding', async () => {
      await pkg(
        ', id, state, reviewer_id, approved_at, content_hash, released_at, released_by, content',
        `, 'c0000000-0000-4000-8000-0000000000aa', 'Released', '${u.approver}', now(), '${'b'.repeat(64)}', now(), '${u.investorRelationsA}', '{"lines": []}'`,
      );
      await expectDbRejection(
        handle.exec(
          `update rpt.package set label = 'preliminary' where id = 'c0000000-0000-4000-8000-0000000000aa'`,
        ),
        /Released and cannot change/,
      );
      await expectDbRejection(
        handle.exec(`delete from rpt.package where id = 'c0000000-0000-4000-8000-0000000000aa'`),
        /immutable/,
      );
      await expectDbRejection(
        handle.exec(
          `insert into rpt.qa_result (package_id, run_no, rule, entity_ref, passed, detail) values ('c0000000-0000-4000-8000-0000000000aa', 1, 'QA-RF-01', 'INV-0001', true, 'Rolls forward.')`,
        ),
        /Released and cannot change/,
      );
    });
    it('rejects a finding with a malformed rule, a second finding for the same run, rule and entity, and a deleted finding', async () => {
      const finding = (rule: string, extra = '', values = ''): Promise<unknown> =>
        handle.exec(
          `insert into rpt.qa_result (package_id, run_no, rule, entity_ref, passed, detail${extra}) values ('${ids.packageA}', 1, '${rule}', 'INV-0001', false, 'Does not roll forward.'${values})`,
        );
      await expectDbRejection(finding('roll-forward'), /check constraint/);
      await expectDbRejection(finding('QA-RF-01'), /unique/);
      await expectDbRejection(
        handle.exec(`delete from rpt.qa_result where package_id = '${ids.packageA}'`),
        /immutable/,
      );
    });
    it('rejects an override with no approver or no reason, and an override of a finding that passed', async () => {
      const override = (set: string, where: string): Promise<unknown> =>
        handle.exec(`update rpt.qa_result set ${set} where id = '${where}'`);
      await expectDbRejection(
        override(
          `override_reason = 'Timing difference agreed with the client'`,
          ids.qaResultFailedA,
        ),
        /check constraint/,
      );
      await expectDbRejection(
        override(
          `override_reason = ' ', approver_id = '${u.approver}', overridden_at = now()`,
          ids.qaResultFailedA,
        ),
        /check constraint/,
      );
      await expectDbRejection(
        override(
          `override_reason = 'Not needed', approver_id = '${u.approver}', overridden_at = now()`,
          ids.qaResultPassedA,
        ),
        /check constraint/,
      );
      // What the engine found is fixed: only the override may be added to a finding.
      await expectDbRejection(override(`passed = true`, ids.qaResultFailedA), /finding is fixed/);
      await override(
        `override_reason = 'Timing difference agreed with the client', approver_id = '${u.approver}', overridden_at = now()`,
        ids.qaResultFailedA,
      );
    });
    it('keeps the content a package shows: an object once generated, and explanations by position (migration 0020)', async () => {
      // Past Draft a package carries the lines it shows.
      await expectDbRejection(
        handle.exec(
          `insert into rpt.package (client_id, period_end, as_of, basis, label, prepared_by, state) values ('${ids.clientC}', '2024-03-31', '2024-05-10', 'net', 'final', '${u.investorRelationsA}', 'Generated')`,
        ),
        /check constraint/,
      );
      await expectDbRejection(
        handle.exec(`update rpt.package set content = '[]'::jsonb where id = '${ids.packageA}'`),
        /check constraint/,
      );
      await expectDbRejection(
        handle.exec(
          `update rpt.package set tie_out_explanations = '"restated"'::jsonb where id = '${ids.packageA}'`,
        ),
        /check constraint/,
      );
      await handle.exec(
        `update rpt.package set tie_out_explanations = '{"INV-0001": "Sponsor restated the March mark."}'::jsonb where id = '${ids.packageA}'`,
      );
    });
    it('names who submitted a package, and rejects a reviewer who submitted it or ran one of its generations (migration 0024, SEC-5.6)', async () => {
      const row = (columns: string, values: string): Promise<unknown> =>
        handle.exec(
          `insert into rpt.package (client_id, period_end, as_of, basis, label, prepared_by${columns}) values ('${ids.clientC}', '2023-12-31', '2024-02-09', 'net', 'final', '${u.investorRelationsA}'${values})`,
        );
      // The reviewer is not whoever submitted the package for review.
      await expectDbRejection(
        row(', submitted_by, reviewer_id', `, '${u.approver}', '${u.approver}'`),
        /check constraint/,
      );
      // Nor anyone who ran one of its generations: the change log names them.
      const runs = (...by: string[]): string =>
        `'${JSON.stringify(by.map((id, i) => ({ at: '2024-02-09T10:00:00.000Z', by: id, runNo: i + 1, lines: 0, findings: 0, failed: 0 })))}'::jsonb`;
      await expectDbRejection(
        row(', change_log, reviewer_id', `, ${runs(u.operations, u.approver)}, '${u.approver}'`),
        /check constraint/,
      );
      // Whoever submitted it is a user.
      await expectDbRejection(
        row(', submitted_by', `, '00000000-0000-4000-8000-00000000dead'`),
        /foreign key/,
      );
      // A reviewer who did neither is accepted, with the submitter on the row.
      await row(
        ', change_log, submitted_by, reviewer_id',
        `, ${runs(u.investorRelationsA, u.operations)}, '${u.operations2}', '${u.approver}'`,
      );
      const kept = await handle.query<{ submitted_by: string }>(
        `select submitted_by from rpt.package where client_id = '${ids.clientC}' and period_end = '2023-12-31' and basis = 'net'`,
      );
      expect(kept).toEqual([{ submitted_by: u.operations2 }]);
    });
    it('keeps a full history image of a package', async () => {
      const rows = await handle.query<{ n: number }>(
        `select count(*)::int as n from rpt.package_history where row_id = '${ids.packageA}'`,
      );
      expect(rows[0]?.n).toBeGreaterThanOrEqual(1);
    });
  });

  describe('underwritten base cases (migrations 0021 and 0022, SEC-5.6, SEC-9.1, SEC-9.2, SEC-9.4)', () => {
    const u = ids.users;
    const open = ids.investment1;
    /** A Draft version 2 on the open investment, with any column overridden. Rolled back by the caller or refused. */
    const draft = (overrides: Record<string, string> = {}): string => {
      const row: Record<string, string> = {
        investment_id: `'${open}'`,
        version: '2',
        form: `'equity'`,
        case_date: `'2024-06-30'`,
        planned_exit_date: `'2028-06-30'`,
        exit_multiple: '11.5',
        gross_moic: '2.4',
        gross_irr: '0.19',
        revision_reason: `'Re-underwritten after the add-on acquisition'`,
        entered_by: `'${u.dealTeam}'`,
        ...overrides,
      };
      const columns = Object.keys(row).filter((c) => row[c] !== '');
      return `insert into mon.underwriting_case (${columns.join(', ')}) values (${columns.map((c) => row[c]).join(', ')})`;
    };
    const asDealTeam = (fn: (tx: Tx) => Promise<unknown>): Promise<void> =>
      withUserContext(handle.db, { userId: u.dealTeam, roles: ['deal_team'] }, async (tx) => {
        await fn(tx);
      });
    const asWallMember = (fn: (tx: Tx) => Promise<unknown>): Promise<void> =>
      withUserContext(handle.db, { userId: u.wallMember, roles: ['deal_team'] }, async (tx) => {
        await fn(tx);
      });
    /** Runs the statements as the owner and rolls them back, so each test starts from the fixture. */
    const rolledBack = async (statements: string[]): Promise<void> => {
      await handle.exec('begin');
      try {
        for (const statement of statements) await handle.exec(statement);
      } finally {
        await handle.exec('rollback');
      }
    };

    it('rejects a case whose figures the record cannot hold', async () => {
      for (const overrides of [
        { planned_exit_date: `'2024-06-30'` },
        { planned_exit_date: `'2024-03-31'` },
        { exit_multiple: '0' },
        { exit_multiple: '' },
        { gross_moic: '0' },
        { gross_irr: '-1' },
        { currency: `'EUR'` },
        { form: `'primary'` },
        { version: '0' },
        { source_page: '0' },
        // An equity case has neither a yield nor a loss rate.
        { underwritten_yield: '0.11' },
        { annual_loss_rate: '0.01' },
        // A loan has a yield and no exit multiple, and a loss rate between 0 and 1.
        { form: `'credit'` },
        { form: `'credit'`, exit_multiple: '' },
        {
          form: `'credit'`,
          exit_multiple: '',
          underwritten_yield: '0.11',
          annual_loss_rate: '1.5',
        },
        {
          form: `'credit'`,
          exit_multiple: '',
          underwritten_yield: '0.11',
          annual_loss_rate: '-0.01',
        },
        { form: `'credit'`, exit_multiple: '', underwritten_yield: '-1' },
      ])
        await expectDbRejection(
          handle.exec(draft(overrides)),
          /check constraint|invalid input value/,
        );
      // A loan as the record holds it.
      await rolledBack([
        draft({
          form: `'credit'`,
          exit_multiple: '',
          underwritten_yield: '0.11',
          annual_loss_rate: '0.01',
        }),
      ]);
    });

    it('rejects a later version with no reason, a second version with the same number and a second Draft', async () => {
      await expectDbRejection(handle.exec(draft({ revision_reason: '' })), /check constraint/);
      await expectDbRejection(handle.exec(draft({ revision_reason: `'  '` })), /check constraint/);
      await expectDbRejection(handle.exec(draft({ version: '1' })), /unique/);
      await expectDbRejection(
        rolledBack([draft(), draft({ version: '3' })]),
        /underwriting_case_one_draft_idx/,
      );
    });

    it('starts every case as a Draft, even for the owner', async () => {
      for (const state of ['Confirmed', 'Superseded', 'Withdrawn'])
        await expectDbRejection(
          handle.exec(
            draft({
              state: `'${state}'`,
              source_note: `'Sponsor model'`,
              confirmed_by: `'${u.approver}'`,
              confirmed_at: 'now()',
              ...(state === 'Withdrawn' ? { withdrawn_reason: `'Entered in error'` } : {}),
            }),
          ),
          /starts as a Draft/,
        );
    });

    it('rejects a confirmation by the person who last changed the figures, one with no source and one with no plan', async () => {
      const id = 'd0000000-0000-4000-8000-0000000000a1';
      const points = (last: string): string =>
        `insert into mon.underwriting_case_point (case_id, period_end, ebitda_ltm) values ('${id}', '2024-06-30', 30000000), ('${id}', '${last}', 44000000)`;
      const confirm = (by: string): string =>
        `update mon.underwriting_case set state = 'Confirmed', confirmed_by = '${by}', confirmed_at = now() where id = '${id}'`;
      const withSource = { id: `'${id}'`, source_note: `'Sponsor model, deal team shared drive'` };
      // The last editor (SEC-5.6).
      await expectDbRejection(
        rolledBack([draft(withSource), points('2028-06-30'), confirm(u.dealTeam)]),
        /check constraint/,
      );
      // No source (SEC-9.4): neither a document nor a note, or a note of spaces.
      await expectDbRejection(
        rolledBack([draft({ id: `'${id}'` }), points('2028-06-30'), confirm(u.approver)]),
        /check constraint/,
      );
      await expectDbRejection(
        rolledBack([
          draft({ id: `'${id}'`, source_note: `'  '` }),
          points('2028-06-30'),
          confirm(u.approver),
        ]),
        /check constraint/,
      );
      // Confirmed without a named person, or a person without a time.
      await expectDbRejection(
        rolledBack([
          draft(withSource),
          points('2028-06-30'),
          `update mon.underwriting_case set state = 'Confirmed' where id = '${id}'`,
        ]),
        /check constraint/,
      );
      await expectDbRejection(
        rolledBack([
          draft(withSource),
          points('2028-06-30'),
          `update mon.underwriting_case set state = 'Confirmed', confirmed_by = '${u.approver}' where id = '${id}'`,
        ]),
        /check constraint/,
      );
      // An equity case with no plan, with one point, or whose last point is not the planned exit.
      await expectDbRejection(
        rolledBack([draft(withSource), confirm(u.approver)]),
        /two plan points or more/,
      );
      await expectDbRejection(
        rolledBack([
          draft(withSource),
          `insert into mon.underwriting_case_point (case_id, period_end, ebitda_ltm) values ('${id}', '2028-06-30', 44000000)`,
          confirm(u.approver),
        ]),
        /two plan points or more/,
      );
      await expectDbRejection(
        rolledBack([draft(withSource), points('2027-06-30'), confirm(u.approver)]),
        /the last on its planned exit/,
      );
      // A document of the position is a source too.
      await rolledBack([
        draft({ id: `'${id}'`, source_document_id: `'${ids.documentOpen}'`, source_page: '3' }),
        points('2028-06-30'),
        confirm(u.approver),
      ]);
    });

    it('lets a confirmation change nothing but who confirmed the case and when', async () => {
      const draftId = ids.underwritingCaseWalledDraft;
      for (const extra of [
        'gross_moic = 9',
        `planned_exit_date = '2030-06-30'`,
        `note = 'Changed while confirming'`,
        `source_note = 'Another model'`,
        `entered_by = '${u.operations}'`,
        `entered_at = now()`,
      ])
        await expectDbRejection(
          handle.exec(
            `update mon.underwriting_case set state = 'Confirmed', confirmed_by = '${u.approver}', confirmed_at = now(), ${extra} where id = '${draftId}'`,
          ),
          /changes nothing but who confirmed/,
        );
    });

    it('names the person acting: whoever records or edits a case is entered_by, whoever confirms is confirmed_by', async () => {
      // A case recorded under somebody else's name.
      await expectDbRejection(
        asDealTeam((tx) => tx.execute(sql.raw(draft({ entered_by: `'${u.wallMember}'` })))),
        /names the person who enters it/,
      );
      // An edit that leaves the first author as the last editor: the wall member edits the Draft
      // the deal team entered.
      await expectDbRejection(
        asWallMember((tx) =>
          tx.execute(
            sql.raw(
              `update mon.underwriting_case set gross_moic = 2.1 where id = '${ids.underwritingCaseWalledDraft}'`,
            ),
          ),
        ),
        /names the person who made it/,
      );
      // A confirmation under somebody else's name.
      await expectDbRejection(
        asWallMember((tx) =>
          tx.execute(
            sql.raw(
              `update mon.underwriting_case set state = 'Confirmed', confirmed_by = '${u.approver}', confirmed_at = now() where id = '${ids.underwritingCaseWalledDraft}'`,
            ),
          ),
        ),
        /names the person confirming/,
      );
      // Having edited the Draft, the wall member is its last editor and cannot confirm it.
      await expectDbRejection(
        asWallMember(async (tx) => {
          await tx.execute(
            sql.raw(
              `update mon.underwriting_case set gross_moic = 2.1, entered_by = '${u.wallMember}', entered_at = now() where id = '${ids.underwritingCaseWalledDraft}'`,
            ),
          );
          await tx.execute(
            sql.raw(
              `update mon.underwriting_case set state = 'Confirmed', confirmed_by = '${u.wallMember}', confirmed_at = now() where id = '${ids.underwritingCaseWalledDraft}'`,
            ),
          );
        }),
        /check constraint/,
      );
      const row = await handle.query<{ state: string; gross_moic: string; entered_by: string }>(
        `select state, gross_moic, entered_by from mon.underwriting_case where id = '${ids.underwritingCaseWalledDraft}'`,
      );
      expect(row).toEqual([{ state: 'Draft', gross_moic: '2.000000', entered_by: u.dealTeam }]);
    });

    it('keeps a Confirmed case as it was confirmed: it is superseded or withdrawn, nothing else', async () => {
      const id = ids.underwritingCaseOpen;
      const update = (set: string): Promise<unknown> =>
        handle.exec(`update mon.underwriting_case set ${set} where id = '${id}'`);
      for (const set of [
        'gross_moic = 3',
        'gross_irr = 0.3',
        'exit_multiple = 14',
        `planned_exit_date = '2029-03-15'`,
        `note = 'Rewritten'`,
        `source_note = 'Another model'`,
        `entered_by = '${u.wallMember}'`,
        `confirmed_by = '${u.operations}'`,
        `state = 'Draft', confirmed_by = null, confirmed_at = null`,
        // Even an update that changes nothing is refused: the row version would move.
        'gross_moic = gross_moic',
      ])
        await expectDbRejection(update(set), /Confirmed/);
      // A move may not carry a change of figures with it.
      await expectDbRejection(update(`state = 'Superseded', gross_moic = 3`), /keeps its figures/);
      await expectDbRejection(
        update(`investment_id = '${ids.investmentWalled}', state = 'Superseded'`),
        /keeps its position, version and form/,
      );
      // Withdrawn needs its reason, and only Withdrawn carries one.
      await expectDbRejection(update(`state = 'Withdrawn'`), /check constraint/);
      await expectDbRejection(
        update(`state = 'Withdrawn', withdrawn_reason = ' '`),
        /check constraint/,
      );
      await expectDbRejection(
        update(`state = 'Superseded', withdrawn_reason = 'Replaced'`),
        /check constraint/,
      );
      await expectDbRejection(
        handle.exec(`delete from mon.underwriting_case where id = '${id}'`),
        /immutable/,
      );
    });

    it('makes Superseded and Withdrawn final, and keeps one Confirmed case per position and case date', async () => {
      const id = ids.underwritingCaseOpen;
      const correction = 'd0000000-0000-4000-8000-0000000000a2';
      const corrected = [
        draft({
          id: `'${correction}'`,
          case_date: `'2022-03-15'`,
          planned_exit_date: `'2027-03-15'`,
          revision_reason: `'The exit multiple was typed as 12.5 and the model says 11.5'`,
          source_note: `'Sponsor model, deal team shared drive'`,
        }),
        `insert into mon.underwriting_case_point (case_id, period_end, ebitda_ltm) values ('${correction}', '2022-03-15', 24000000), ('${correction}', '2027-03-15', 44000000)`,
      ];
      const confirm = `update mon.underwriting_case set state = 'Confirmed', confirmed_by = '${u.approver}', confirmed_at = now() where id = '${correction}'`;
      // A correction is confirmed only once the case it corrects is superseded.
      await expectDbRejection(
        rolledBack([...corrected, confirm]),
        /underwriting_case_confirmed_date_idx/,
      );
      for (const [move, final] of [
        [`state = 'Superseded'`, 'Superseded'],
        [
          `state = 'Withdrawn', withdrawn_reason = 'Confirmed against the wrong model'`,
          'Withdrawn',
        ],
      ] as const)
        for (const again of [
          `state = 'Confirmed'`,
          `state = 'Draft', confirmed_by = null, confirmed_at = null, withdrawn_reason = null`,
          `state = 'Withdrawn', withdrawn_reason = 'Another reason'`,
          `note = 'Rewritten'`,
        ])
          await expectDbRejection(
            rolledBack([
              `update mon.underwriting_case set ${move} where id = '${id}'`,
              `update mon.underwriting_case set ${again} where id = '${id}'`,
            ]),
            new RegExp(`is ${final} and cannot change`),
          );
      // Superseded first, then the correction is confirmed, and a re-underwriting on a later
      // date stands beside it.
      await rolledBack([
        ...corrected,
        `update mon.underwriting_case set state = 'Superseded' where id = '${id}'`,
        confirm,
        draft({ version: '3', source_note: `'Sponsor model, deal team shared drive'` }),
      ]);
      // A Draft goes to Confirmed or Withdrawn, never straight to Superseded.
      await expectDbRejection(
        handle.exec(
          `update mon.underwriting_case set state = 'Superseded' where id = '${ids.underwritingCaseWalledDraft}'`,
        ),
        /is confirmed or withdrawn, nothing else/,
      );
      // Withdrawing a Draft changes nothing but the state and the reason.
      await expectDbRejection(
        handle.exec(
          `update mon.underwriting_case set state = 'Withdrawn', withdrawn_reason = 'Entered in error', gross_moic = 9 where id = '${ids.underwritingCaseWalledDraft}'`,
        ),
        /changes nothing but the state and its reason/,
      );
      await rolledBack([
        `update mon.underwriting_case set state = 'Withdrawn', withdrawn_reason = 'Entered in error' where id = '${ids.underwritingCaseWalledDraft}'`,
      ]);
    });

    it('writes plan points only while the case is a Draft, on an equity case, one per date and never empty', async () => {
      const confirmed = ids.underwritingCaseOpen;
      await expectDbRejection(
        handle.exec(
          `insert into mon.underwriting_case_point (case_id, period_end, ebitda_ltm) values ('${confirmed}', '2025-03-15', 36000000)`,
        ),
        /is Confirmed and its plan points cannot change/,
      );
      await expectDbRejection(
        handle.exec(
          `update mon.underwriting_case_point set ebitda_ltm = 50000000 where case_id = '${confirmed}'`,
        ),
        /is Confirmed and its plan points cannot change/,
      );
      await expectDbRejection(
        handle.exec(`delete from mon.underwriting_case_point where case_id = '${confirmed}'`),
        /is Confirmed and its plan points cannot change/,
      );
      const draftId = ids.underwritingCaseWalledDraft;
      // Moving a point of a Draft under a Confirmed case, or to another case at all.
      await expectDbRejection(
        handle.exec(
          `update mon.underwriting_case_point set case_id = '${confirmed}' where id = '${ids.underwritingPointWalledDraftEntry}'`,
        ),
        /stays with its base case/,
      );
      await expectDbRejection(
        handle.exec(
          `insert into mon.underwriting_case_point (case_id, period_end, ebitda_ltm) values ('${draftId}', '2024-06-30', 16000000)`,
        ),
        /unique/,
      );
      await expectDbRejection(
        handle.exec(
          `insert into mon.underwriting_case_point (case_id, period_end) values ('${draftId}', '2026-06-30')`,
        ),
        /check constraint/,
      );
      await expectDbRejection(
        handle.exec(
          `insert into mon.underwriting_case_point (case_id, period_end, ebitda_ltm) values ('d0000000-0000-4000-8000-0000000000ff', '2026-06-30', 1)`,
        ),
        /foreign key/,
      );
      // A figure the sponsor did not give stays missing; a plan in net cash is below zero.
      await rolledBack([
        `insert into mon.underwriting_case_point (case_id, period_end, revenue_ltm, ebitda_ltm, net_debt) values ('${draftId}', '2026-06-30', 95000000, 20000000, null), ('${draftId}', '2027-06-30', null, null, -5000000)`,
        `delete from mon.underwriting_case_point where case_id = '${draftId}'`,
      ]);
      // A loan has no plan points.
      await expectDbRejection(
        rolledBack([
          draft({
            id: `'d0000000-0000-4000-8000-0000000000a3'`,
            form: `'credit'`,
            exit_multiple: '',
            underwritten_yield: '0.11',
          }),
          `insert into mon.underwriting_case_point (case_id, period_end, ebitda_ltm) values ('d0000000-0000-4000-8000-0000000000a3', '2026-06-30', 1)`,
        ]),
        /belong to an equity base case/,
      );
    });

    it('lets only the person a Draft names change its plan points, so whoever rewrites them cannot confirm (migration 0022)', async () => {
      const draftId = ids.underwritingCaseWalledDraft;
      const pointsOnRecord = (): Promise<{ period: string; ebitda: string }[]> =>
        handle.query<{ period: string; ebitda: string }>(
          `select period_end::text as period, ebitda_ltm::text as ebitda from mon.underwriting_case_point where case_id = '${draftId}' order by period_end`,
        );
      const asEntered = await pointsOnRecord();
      expect(asEntered).toHaveLength(2);
      /** Thrown at the end of a block that must leave nothing behind, whatever it managed to write. */
      class Undo extends Error {}
      // The deal team entered this Draft. The wall member, who can open it, has not claimed it:
      // an update and a delete of its points touch no row, and a new point is refused.
      await expect(
        asWallMember(async (tx) => {
          const updated = await tx.execute<{ id: string }>(
            sql.raw(
              `update mon.underwriting_case_point set ebitda_ltm = 999000000 where case_id = '${draftId}' returning id`,
            ),
          );
          expect(updated.rows).toEqual([]);
          const deleted = await tx.execute<{ id: string }>(
            sql.raw(
              `delete from mon.underwriting_case_point where case_id = '${draftId}' returning id`,
            ),
          );
          expect(deleted.rows).toEqual([]);
          throw new Undo();
        }),
      ).rejects.toBeInstanceOf(Undo);
      await expectDbRejection(
        asWallMember((tx) =>
          tx.execute(
            sql.raw(
              `insert into mon.underwriting_case_point (case_id, period_end, ebitda_ltm) values ('${draftId}', '2026-06-30', 999000000)`,
            ),
          ),
        ),
        /row-level security/,
      );
      // So rewriting the points and confirming them is not one person's to do: the points are as
      // they were entered when the wall member confirms.
      await expect(
        asWallMember(async (tx) => {
          await tx.execute(
            sql.raw(
              `update mon.underwriting_case_point set ebitda_ltm = 999000000 where case_id = '${draftId}'`,
            ),
          );
          await tx.execute(
            sql.raw(
              `update mon.underwriting_case set state = 'Confirmed', confirmed_by = '${u.wallMember}', confirmed_at = now() where id = '${draftId}'`,
            ),
          );
          const confirmed = await tx.execute<{ ebitda: string }>(
            sql.raw(
              `select ebitda_ltm::text as ebitda from mon.underwriting_case_point where case_id = '${draftId}' order by period_end`,
            ),
          );
          expect(confirmed.rows.map((r) => r.ebitda)).toEqual(asEntered.map((r) => r.ebitda));
          throw new Undo();
        }),
      ).rejects.toBeInstanceOf(Undo);
      // Having claimed the Draft, as an edit through the API does, the wall member writes its
      // points and is the one person who cannot confirm it.
      await expectDbRejection(
        asWallMember(async (tx) => {
          await tx.execute(
            sql.raw(
              `update mon.underwriting_case set entered_by = '${u.wallMember}', entered_at = now() where id = '${draftId}'`,
            ),
          );
          const updated = await tx.execute<{ id: string }>(
            sql.raw(
              `update mon.underwriting_case_point set ebitda_ltm = 999000000 where case_id = '${draftId}' returning id`,
            ),
          );
          expect(updated.rows).toHaveLength(2);
          await tx.execute(
            sql.raw(
              `insert into mon.underwriting_case_point (case_id, period_end, ebitda_ltm) values ('${draftId}', '2026-06-30', 21000000)`,
            ),
          );
          await tx.execute(
            sql.raw(
              `update mon.underwriting_case set state = 'Confirmed', confirmed_by = '${u.wallMember}', confirmed_at = now() where id = '${draftId}'`,
            ),
          );
        }),
        /check constraint/,
      );
      expect(await pointsOnRecord()).toEqual(asEntered);
      const row = await handle.query<{ state: string; entered_by: string }>(
        `select state, entered_by from mon.underwriting_case where id = '${draftId}'`,
      );
      expect(row).toEqual([{ state: 'Draft', entered_by: u.dealTeam }]);
    });

    it('keeps a full history image of a case and of its points', async () => {
      const cases = await handle.query<{ op: string; state: string }>(
        `select op, row_image ->> 'state' as state from mon.underwriting_case_history where row_id = '${ids.underwritingCaseOpen}' order by history_id`,
      );
      expect(cases).toEqual([
        { op: 'INSERT', state: 'Draft' },
        { op: 'UPDATE', state: 'Confirmed' },
      ]);
      const points = await handle.query<{ n: number }>(
        `select count(*)::int as n from mon.underwriting_case_point_history h where h.row_image ->> 'case_id' = '${ids.underwritingCaseOpen}'`,
      );
      expect(points[0]?.n).toBe(2);
    });
  });

  describe('valuation suggestions (migration 0023, SEC-5.6, SEC-9.1, SEC-9.2, SEC-9.4)', () => {
    const u = ids.users;
    const open = ids.investment1;
    /** A not calculable suggestion for the quarter after the fixture's, with any column overridden. */
    const suggestion = (overrides: Record<string, string> = {}): string => {
      const row: Record<string, string> = {
        investment_id: `'${open}'`,
        period_end: `'2024-12-31'`,
        basis: `'capital_account_balance'`,
        method: `'valuation_method.sponsor_mark'`,
        suggested_value: '',
        reason_code: `'no_ending_balance'`,
        workings: `'{"inputs": []}'`,
        source_document_id: `'${ids.documentOpenStatement}'`,
        extraction_run_id: `'${ids.extractionRunOpenStatement}'`,
        calc_version: `'guards'`,
        ...overrides,
      };
      const columns = Object.keys(row).filter((c) => row[c] !== '');
      return `insert into mon.valuation_suggestion (${columns.join(', ')}) values (${columns.map((c) => row[c]).join(', ')})`;
    };
    const decided = (who: string): string => `decided_by = '${who}', decided_at = now()`;
    const decide = (id: string, set: string): string =>
      `update mon.valuation_suggestion set ${set} where id = '${id}'`;
    /** Runs the statements as the owner and rolls them back, so each test starts from the fixture. */
    const rolledBack = async (statements: string[]): Promise<void> => {
      await handle.exec('begin');
      try {
        for (const statement of statements) await handle.exec(statement);
        // The reference to a replacement is checked at commit: ask for the check now.
        await handle.exec('set constraints all immediate');
      } finally {
        await handle.exec('rollback');
      }
    };
    class Undo extends Error {}
    /** Runs the statement as an actor and rolls it back; answers the rows it touched. */
    const attemptAs = async (
      userId: string,
      roles: AppRole[],
      statement: string,
    ): Promise<number> => {
      let touched = -1;
      await withUserContext(handle.db, { userId, roles }, async (tx) => {
        const result = await tx.execute(sql.raw(statement));
        touched = ('affectedRows' in result ? result.affectedRows : result.rowCount) ?? 0;
        throw new Undo();
      }).catch((error: unknown) => {
        if (!(error instanceof Undo)) throw error;
      });
      return touched;
    };
    const stateOf = async (id: string): Promise<string | undefined> =>
      (
        await handle.query<{ state: string }>(
          `select state from mon.valuation_suggestion where id = '${id}'`,
        )
      )[0]?.state;

    it('rejects a suggestion the record cannot hold', async () => {
      for (const overrides of [
        // A calendar quarter end, nothing else.
        { period_end: `'2024-12-30'` },
        { period_end: `'2024-11-30'` },
        { period_end: `'2025-01-01'` },
        { basis: `'blend'` },
        { method: `'sector.software'` },
        // A value above zero or a reason: exactly one.
        { reason_code: '' },
        { suggested_value: '46500000' },
        { suggested_value: '0', reason_code: '' },
        { suggested_value: '-1', reason_code: '' },
        { reason_code: `'No ending balance'` },
        { workings: `'[]'` },
        { workings: `'{}'` },
        { workings: `'{"inputs": {}}'` },
        { source_page: '0' },
        { calc_version: '' },
        { extraction_run_id: '' },
      ])
        await expectDbRejection(
          handle.exec(suggestion(overrides)),
          /check constraint|not-null constraint/,
        );
      await expectDbRejection(
        handle.exec(suggestion({ method: `'valuation_method.unknown'` })),
        /foreign key/,
      );
      // The same row as the record holds it, with a reason and then with a value.
      await rolledBack([suggestion()]);
      await rolledBack([
        suggestion({ suggested_value: '0.01', reason_code: '', source_page: '1' }),
      ]);
    });

    it('holds a quarter end in every quarter and refuses the day before and after', async () => {
      for (const day of ['2024-03-31', '2024-06-30', '2025-09-30', '2025-12-31', '2024-02-29'])
        if (day === '2024-02-29')
          await expectDbRejection(
            handle.exec(suggestion({ period_end: `'${day}'` })),
            /check constraint/,
          );
        else
          await rolledBack([
            suggestion({
              investment_id: `'${ids.investmentWalled}'`,
              source_document_id: `'${ids.documentWalledStatement}'`,
              extraction_run_id: `'${ids.extractionRunWalledStatement}'`,
              period_end: `'${day}'`,
            }),
          ]);
    });

    it('starts Open, from an approved run of its own position, naming that run and its document', async () => {
      await expectDbRejection(
        handle.exec(
          suggestion({
            state: `'Dismissed'`,
            decision_reason: `'Not ours'`,
            decided_by: `'${u.operations}'`,
            decided_at: 'now()',
          }),
        ),
        /starts Open/,
      );
      // A run of the walled position, with its own document.
      await expectDbRejection(
        handle.exec(
          suggestion({
            source_document_id: `'${ids.documentWalledStatement}'`,
            extraction_run_id: `'${ids.extractionRunWalledStatement}'`,
          }),
        ),
        /approved run of its own position/,
      );
      // The position's own run, and another document or none.
      await expectDbRejection(
        handle.exec(suggestion({ source_document_id: `'${ids.documentOpenReportQ3}'` })),
        /approved run of its own position/,
      );
      await expectDbRejection(
        handle.exec(suggestion({ source_document_id: '' })),
        /approved run of its own position/,
      );
      // A run nobody approved.
      await expectDbRejection(
        handle.exec(
          suggestion({
            source_document_id: `'${ids.documentOpen}'`,
            extraction_run_id: `'${ids.extractionRunOpen}'`,
          }),
        ),
        /approved run of its own position/,
      );
      await expectDbRejection(
        handle.exec(suggestion({ extraction_run_id: `'${ids.documentOpen}'` })),
        /foreign key/,
      );
    });

    it('allows one Open suggestion per position and quarter', async () => {
      await expectDbRejection(
        handle.exec(suggestion({ period_end: `'2024-09-30'` })),
        /valuation_suggestion_one_open_idx/,
      );
      // A second one once the first is decided.
      await rolledBack([
        decide(
          ids.suggestionOpen,
          `state = 'Dismissed', decision_reason = 'Superseded by hand', ${decided(u.operations)}`,
        ),
        suggestion({ period_end: `'2024-09-30'` }),
      ]);
    });

    it('ties each decision column to the state it belongs to', async () => {
      const id = ids.suggestionOpen;
      const who = decided(u.operations);
      const system = decided(SYSTEM_USER_ID);
      for (const set of [
        // A dismissal says why.
        `state = 'Dismissed', ${who}`,
        `state = 'Dismissed', decision_reason = '  ', ${who}`,
        // An acceptance names its valuation and nothing else does.
        `state = 'Accepted', ${who}`,
        `state = 'Dismissed', decision_reason = 'Not ours', valuation_id = '${ids.valuationLocked}', ${who}`,
        `state = 'Accepted', valuation_id = '${ids.valuationLocked}', decision_reason = 'Agreed', ${who}`,
        // A supersession says why, with one of the four reasons, and names a replacement only
        // when another suggestion took its place.
        `state = 'Superseded', ${system}`,
        `state = 'Superseded', superseded_reason = 'withdrawn', ${system}`,
        `state = 'Superseded', superseded_reason = 'better_source', ${system}`,
        `state = 'Superseded', superseded_reason = 'mark_locked', superseded_by_id = '${ids.suggestionOpenReplaced}', ${system}`,
        `state = 'Superseded', superseded_reason = 'position_closed', superseded_by_id = '${ids.suggestionOpenReplaced}', ${system}`,
        `state = 'Superseded', superseded_reason = 'figures_changed', superseded_by_id = '${id}', ${system}`,
        `state = 'Dismissed', decision_reason = 'Not ours', superseded_reason = 'figures_changed', ${who}`,
        // Every decision names who took it and when; an Open suggestion names nobody.
        `state = 'Dismissed', decision_reason = 'Not ours'`,
        `state = 'Dismissed', decision_reason = 'Not ours', decided_by = '${u.operations}'`,
        `state = 'Dismissed', decision_reason = 'Not ours', decided_at = now()`,
        who,
        `decision_reason = 'Not ours'`,
        // An Open suggestion names no replacement.
        `superseded_by_id = '${ids.suggestionOpenReplaced}'`,
      ])
        await expectDbRejection(handle.exec(decide(id, set)), /check constraint/);
      // A suggestion with a reason in place of a value cannot be accepted.
      await expectDbRejection(
        rolledBack([
          suggestion({ id: `'e0000000-0000-4000-8000-0000000000f1'` }),
          decide(
            'e0000000-0000-4000-8000-0000000000f1',
            `state = 'Accepted', valuation_id = '${ids.valuationLocked}', ${who}`,
          ),
        ]),
        /check constraint/,
      );
      expect(await stateOf(id)).toBe('Open');
    });

    it('is accepted onto a valuation of its own position only', async () => {
      await expectDbRejection(
        handle.exec(
          decide(
            ids.suggestionOpen,
            `state = 'Accepted', valuation_id = '${ids.valuationWalledDraft}', ${decided(u.operations)}`,
          ),
        ),
        /valuation of its own position/,
      );
      await rolledBack([
        decide(
          ids.suggestionWalled,
          `state = 'Accepted', valuation_id = '${ids.valuationWalledDraft}', ${decided(u.operations)}`,
        ),
      ]);
    });

    it('keeps its figures and its source, even for the owner', async () => {
      for (const set of [
        'suggested_value = 50000000',
        `suggested_value = null, reason_code = 'no_ending_balance'`,
        `basis = 'held_multiple'`,
        `method = 'valuation_method.cost'`,
        `period_end = '2024-12-31'`,
        `investment_id = '${ids.investmentWalled}'`,
        `workings = '{"inputs": []}'`,
        `source_document_id = '${ids.documentOpenReportQ3}'`,
        `extraction_run_id = '${ids.extractionRunOpenReportQ3}'`,
        'source_page = 2',
        `source_locator = 'Account block'`,
        `source_reviewer_ids = '{}'`,
        `prompt_version = '2'`,
        `model_id = 'another'`,
        `calc_version = 'another'`,
      ])
        await expectDbRejection(
          handle.exec(decide(ids.suggestionOpen, set)),
          /keeps its figures and its source/,
        );
      // Not with the decision either.
      await expectDbRejection(
        handle.exec(
          decide(
            ids.suggestionOpen,
            `state = 'Dismissed', decision_reason = 'Not ours', suggested_value = 1, ${decided(u.operations)}`,
          ),
        ),
        /keeps its figures and its source/,
      );
    });

    it('is final once decided, and is never deleted', async () => {
      // The fixture's Superseded suggestion.
      for (const set of [
        `state = 'Open', superseded_reason = null, superseded_by_id = null, decided_by = null, decided_at = null`,
        `superseded_reason = 'figures_changed'`,
        `state = 'Dismissed', superseded_reason = null, superseded_by_id = null, decision_reason = 'Not ours'`,
      ])
        await expectDbRejection(
          handle.exec(decide(ids.suggestionOpenReplaced, set)),
          /is Superseded and cannot change/,
        );
      // A dismissed and an accepted one, in a transaction that is rolled back.
      await expectDbRejection(
        rolledBack([
          decide(
            ids.suggestionOpen,
            `state = 'Dismissed', decision_reason = 'Not ours', ${decided(u.operations)}`,
          ),
          decide(ids.suggestionOpen, `decision_reason = 'Another reason'`),
        ]),
        /is Dismissed and cannot change/,
      );
      await expectDbRejection(
        rolledBack([
          decide(
            ids.suggestionOpen,
            `state = 'Accepted', valuation_id = '${ids.valuationLocked}', ${decided(u.operations)}`,
          ),
          decide(
            ids.suggestionOpen,
            `state = 'Dismissed', valuation_id = null, decision_reason = 'Changed my mind'`,
          ),
        ]),
        /is Accepted and cannot change/,
      );
      for (const id of [ids.suggestionOpen, ids.suggestionOpenReplaced])
        await expectDbRejection(
          handle.exec(`delete from mon.valuation_suggestion where id = '${id}'`),
          /immutable/,
        );
    });

    it('names whoever decides: operations accept or dismiss, the system actor supersedes, nobody else writes', async () => {
      const id = ids.suggestionOpen;
      const dismiss = (who: string): string =>
        decide(id, `state = 'Dismissed', decision_reason = 'Not ours', ${decided(who)}`);
      const supersede = (who: string): string =>
        decide(id, `state = 'Superseded', superseded_reason = 'mark_locked', ${decided(who)}`);
      // A decision under somebody else's name.
      await expectDbRejection(
        attemptAs(u.operations, ['operations'], dismiss(u.operations2)),
        /names whoever made it/,
      );
      await expectDbRejection(
        attemptAs(SYSTEM_USER_ID, ['service'], supersede(u.operations)),
        /names whoever made it/,
      );
      // Each writer takes its own decision.
      expect(await attemptAs(u.operations, ['operations'], dismiss(u.operations))).toBe(1);
      expect(await attemptAs(SYSTEM_USER_ID, ['service'], supersede(SYSTEM_USER_ID))).toBe(1);
      // And never the other's.
      await expectDbRejection(
        attemptAs(u.operations, ['operations'], supersede(u.operations)),
        /row-level security/,
      );
      await expectDbRejection(
        attemptAs(SYSTEM_USER_ID, ['service'], dismiss(SYSTEM_USER_ID)),
        /row-level security/,
      );
      // The deal team, an approver and an auditor read the suggestion and are shown no row to write.
      for (const [who, role] of [
        [u.dealTeam, 'deal_team'],
        [u.approver, 'approver'],
        [u.auditor, 'auditor'],
      ] as const)
        expect(await attemptAs(who, [role], dismiss(who)), role).toBe(0);
      // Operations outside the wall is shown no row of the walled position.
      expect(
        await attemptAs(
          u.operations,
          ['operations'],
          decide(
            ids.suggestionWalled,
            `state = 'Dismissed', decision_reason = 'Not ours', ${decided(u.operations)}`,
          ),
        ),
      ).toBe(0);
      // Nobody but the system actor writes a suggestion, and the application role sets no figure.
      for (const [who, role] of [
        [u.operations, 'operations'],
        [u.dealTeam, 'deal_team'],
        [u.approver, 'approver'],
      ] as const)
        await expectDbRejection(attemptAs(who, [role], suggestion()), /row-level security/);
      expect(await attemptAs(SYSTEM_USER_ID, ['service'], suggestion())).toBe(1);
      await expectDbRejection(
        attemptAs(SYSTEM_USER_ID, ['service'], decide(id, 'suggested_value = 1')),
        /permission denied/,
      );
      expect(await stateOf(id)).toBe('Open');
    });

    it('is replaced by a suggestion for the same position and quarter, checked when the transaction commits', async () => {
      const replacement = 'e0000000-0000-4000-8000-0000000000f2';
      const supersede = (id: string, by: string): string =>
        decide(
          id,
          `state = 'Superseded', superseded_reason = 'figures_changed', superseded_by_id = '${by}', ${decided(SYSTEM_USER_ID)}`,
        );
      // As the product does it: the Open one is superseded, then its replacement is written.
      await rolledBack([
        supersede(ids.suggestionOpen, replacement),
        suggestion({ id: `'${replacement}'`, period_end: `'2024-09-30'` }),
      ]);
      // A replacement that is never written.
      await expectDbRejection(
        rolledBack([supersede(ids.suggestionOpen, replacement)]),
        /foreign key/,
      );
      // One for another quarter of the position, written after and written before.
      await expectDbRejection(
        rolledBack([
          supersede(ids.suggestionOpen, replacement),
          suggestion({ id: `'${replacement}'` }),
        ]),
        /same position and quarter/,
      );
      await expectDbRejection(
        rolledBack([
          suggestion({ id: `'${replacement}'` }),
          supersede(ids.suggestionOpen, replacement),
        ]),
        /same position and quarter/,
      );
      // One of another position: a link across the wall.
      await expectDbRejection(
        handle.exec(supersede(ids.suggestionOpen, ids.suggestionWalled)),
        /same position and quarter/,
      );
      // Figures that changed with nothing to put in their place: no replacement is named.
      await rolledBack([
        decide(
          ids.suggestionOpen,
          `state = 'Superseded', superseded_reason = 'figures_changed', ${decided(SYSTEM_USER_ID)}`,
        ),
      ]);
      expect(await stateOf(ids.suggestionOpen)).toBe('Open');
    });

    it('keeps a full history image of a suggestion', async () => {
      const images = await handle.query<{ op: string; state: string; by: string | null }>(
        `select op, row_image ->> 'state' as state, row_image ->> 'superseded_by_id' as by from mon.valuation_suggestion_history where row_id = '${ids.suggestionOpenReplaced}' order by history_id`,
      );
      expect(images).toEqual([
        { op: 'INSERT', state: 'Open', by: null },
        { op: 'UPDATE', state: 'Superseded', by: ids.suggestionOpen },
      ]);
    });
  });

  describe('audit trail (SEC-11.1)', () => {
    it('rejects UPDATE and DELETE even for the owner', async () => {
      await expectDbRejection(handle.exec(`update audit.event set action = 'x'`), /immutable/);
      await expectDbRejection(handle.exec(`delete from audit.event`), /immutable/);
    });
    it('rejects UPDATE and DELETE for the application role by grant', async () => {
      await expectDbRejection(
        asOps((tx) => tx.execute(sql`update audit.event set action = 'x'`)),
        /permission denied/,
      );
      await expectDbRejection(
        asOps((tx) => tx.execute(sql`delete from audit.event`)),
        /permission denied/,
      );
    });
  });

  describe('history tables (SEC-9.2)', () => {
    it('record a full row image for insert and update with the acting user', async () => {
      await asOps((tx) =>
        tx.execute(
          sql`update core.investment set exit_date = '2025-01-31', is_active = false where id = ${ids.investment1}`,
        ),
      );
      const history = await handle.query<{
        op: string;
        actor_id: string | null;
        row_image: { exit_date: string | null; row_version: number };
      }>(
        `select op, actor_id, row_image from core.investment_history where row_id = '${ids.investment1}' order by history_id`,
      );
      expect(history.map((h) => h.op)).toEqual(['INSERT', 'UPDATE']);
      expect(history[1]?.actor_id).toBe(ids.users.operations);
      expect(history[1]?.row_image.exit_date).toBe('2025-01-31');
      expect(history[1]?.row_image.row_version).toBe(2);
    });
    it('cannot be written directly by the application role', async () => {
      await expectDbRejection(
        asOps((tx) =>
          tx.execute(
            sql`insert into core.investment_history (row_id, op, row_image) values (${ids.investment1}, 'INSERT', '{}')`,
          ),
        ),
        /permission denied/,
      );
    });
  });

  describe('standard columns', () => {
    it('stamp created_by and bump row_version through the trigger', async () => {
      await asOps((tx) =>
        tx.execute(
          sql`insert into core.sponsor (name, canonical_name, tier) values ('Driftwood Partners', 'driftwood partners', 'sponsor_tier.new')`,
        ),
      );
      const before = await handle.query<{ created_by: string; row_version: number }>(
        `select created_by, row_version from core.sponsor where canonical_name = 'driftwood partners'`,
      );
      expect(before[0]).toEqual({ created_by: ids.users.operations, row_version: 1 });
      await withUserContext(
        handle.db,
        { userId: ids.users.dealTeam, roles: ['deal_team'] },
        async (tx) => {
          await tx.execute(
            sql`update core.sponsor set description = 'Lower mid-market buyout' where canonical_name = 'driftwood partners'`,
          );
        },
      );
      const after = await handle.query<{
        created_by: string;
        updated_by: string;
        row_version: number;
      }>(
        `select created_by, updated_by, row_version from core.sponsor where canonical_name = 'driftwood partners'`,
      );
      expect(after[0]).toEqual({
        created_by: ids.users.operations,
        updated_by: ids.users.dealTeam,
        row_version: 2,
      });
    });
  });

  describe('constraints over code', () => {
    it('rejects a contribution with a positive amount and a distribution with a negative one', async () => {
      await expectDbRejection(
        handle.exec(
          `insert into mon.cash_flow (investment_id, flow_date, flow_type, amount) values ('${ids.investment1}', '2024-01-01', 'flow_type.contribution', 5)`,
        ),
        /check constraint/,
      );
      await expectDbRejection(
        handle.exec(
          `insert into mon.cash_flow (investment_id, flow_date, flow_type, amount) values ('${ids.investment1}', '2024-01-01', 'flow_type.distribution', -5)`,
        ),
        /check constraint/,
      );
    });
    it('rejects a taxonomy code from the wrong domain', async () => {
      await expectDbRejection(
        handle.exec(
          `insert into core.sponsor (name, canonical_name, tier) values ('X', 'x', 'sector.software')`,
        ),
        /check constraint/,
      );
      await expectDbRejection(
        handle.exec(
          `insert into core.taxonomy_term (domain, code, label) values ('sector', 'strategy.oops', 'Oops')`,
        ),
        /check constraint/,
      );
    });
    it('allows at most one entry snapshot per investment', async () => {
      await handle.exec(
        `insert into mon.quarterly_performance (investment_id, period_end, is_entry_snapshot) values ('${ids.investment1}', '2022-03-31', true)`,
      );
      await expectDbRejection(
        handle.exec(
          `insert into mon.quarterly_performance (investment_id, period_end, is_entry_snapshot) values ('${ids.investment1}', '2022-06-30', true)`,
        ),
        /quarterly_performance_entry_idx/,
      );
    });
    it('never deletes cash flows', async () => {
      await expectDbRejection(handle.exec(`delete from mon.cash_flow`), /immutable/);
    });
    it('rejects an ownership percentage above 100%', async () => {
      await expectDbRejection(
        handle.exec(
          `insert into core.lp_commitment (client_id, vehicle_id, amount, commitment_date, ownership_pct) values ('${ids.clientA}', '${ids.vehicle}', 1, '2024-01-01', 1.5)`,
        ),
        /check constraint/,
      );
    });
  });

  describe('user context', () => {
    it('rejects malformed ids before touching the database', async () => {
      await expect(
        withUserContext(handle.db, { userId: 'not-a-uuid', roles: ['viewer'] }, () =>
          Promise.resolve(1),
        ),
      ).rejects.toThrow(/UUID/);
      await expect(
        withUserContext(
          handle.db,
          { userId: ids.users.viewer, roles: ['viewer'], clientIds: ['x'] },
          () => Promise.resolve(1),
        ),
      ).rejects.toThrow(/UUID/);
    });
    it('resets the role when the transaction ends', async () => {
      await withUserContext(
        handle.db,
        { userId: ids.users.viewer, roles: ['viewer'] },
        async (tx) => {
          const r = await tx.execute<{ r: string }>(sql`select current_user as r`);
          expect(r.rows[0]?.r).toBe('pb_app');
        },
      );
      const after = await handle.query<{ r: string }>('select current_user as r');
      expect(after[0]?.r).not.toBe('pb_app');
    });
    it('refuses a role that is not an application role, so a comma-joined string never carries the service role (SEC-5.3)', async () => {
      // The roles setting is one comma-joined string that pb.current_roles() splits again.
      for (const roles of [
        ['viewer,service'],
        ['service,viewer'],
        ['editor'],
        [''],
        ['viewer', 'Service'],
      ]) {
        await expect(
          withUserContext(
            handle.db,
            { userId: ids.users.viewer, roles: roles as unknown as AppRole[] },
            () => Promise.resolve(1),
          ),
        ).rejects.toThrow(/not an application role/);
      }
      // The same string typed as a role would otherwise have been the system actor.
      const n = await withUserContext(
        handle.db,
        { userId: ids.users.viewer, roles: ['viewer'] },
        async (tx) => {
          const r = await tx.execute<{ n: number }>(
            sql`select count(*)::int as n from core.investment`,
          );
          return r.rows[0]?.n;
        },
      );
      expect(n).toBe(1);
    });
  });

  describe('system actor inside a user transaction (migration 0008, SEC-5.3)', () => {
    const identity = async (tx: Tx) => {
      const r = await tx.execute<{
        user_id: string;
        roles: string;
        client_ids: string;
        role: string;
        investments: number;
      }>(
        sql`select current_setting('app.user_id', true) as user_id, current_setting('app.roles', true) as roles, current_setting('app.client_ids', true) as client_ids, current_user as role, (select count(*)::int from core.investment) as investments`,
      );
      return r.rows[0]!;
    };
    const viewer = {
      userId: ids.users.viewer,
      roles: ['viewer'] as AppRole[],
      clientIds: [ids.clientA],
    };

    it('sees every walled record while it runs and gives the caller back their own identity', async () => {
      await withUserContext(handle.db, viewer, async (tx) => {
        expect(await identity(tx)).toMatchObject({
          user_id: ids.users.viewer,
          roles: 'viewer',
          client_ids: ids.clientA,
          investments: 1,
        });
        const inside = await asSystemActor(tx, (stx) => identity(stx));
        expect(inside).toMatchObject({
          user_id: SYSTEM_USER_ID,
          roles: 'service',
          client_ids: '',
          role: 'pb_app',
          investments: 2,
        });
        expect(await identity(tx)).toMatchObject({
          user_id: ids.users.viewer,
          roles: 'viewer',
          client_ids: ids.clientA,
          role: 'pb_app',
          investments: 1,
        });
      });
    });

    it('restores the caller after a failure inside, and the transaction stays usable', async () => {
      await withUserContext(handle.db, viewer, async (tx) => {
        await expect(asSystemActor(tx, () => Promise.reject(new Error('boom')))).rejects.toThrow(
          'boom',
        );
        expect(await identity(tx)).toMatchObject({ user_id: ids.users.viewer, investments: 1 });
        // A failed statement aborts the savepoint only, never the caller's transaction.
        await expectDbRejection(
          asSystemActor(tx, async (stx) => {
            await stx.execute(sql`select 1 / 0`);
          }),
          /division by zero/,
        );
        expect(await identity(tx)).toMatchObject({ user_id: ids.users.viewer, investments: 1 });
      });
    });

    it('runs only inside a user transaction', async () => {
      await expect(
        handle.db.transaction((tx) => asSystemActor(tx, () => Promise.resolve(1))),
      ).rejects.toThrow(/only inside a user transaction/);
    });
  });

  describe('Company headquarters (migration 0018, the co-investment map)', () => {
    const setHq = (assignments: string): Promise<void> =>
      asOps((tx) =>
        tx.execute(
          sql.raw(`update core.portfolio_company set ${assignments} where id = '${ids.company1}'`),
        ),
      );

    it('is recorded whole: city, country and both coordinates', async () => {
      await setHq(
        "hq_city = 'Austin', hq_country = 'US', hq_latitude = 30.26715, hq_longitude = -97.74306",
      );
      const rows = await handle.query<{ hq_city: string; hq_latitude: string }>(
        `select hq_city, hq_latitude::text from core.portfolio_company where id = '${ids.company1}'`,
      );
      expect(rows).toEqual([{ hq_city: 'Austin', hq_latitude: '30.26715' }]);
      // And it can be taken off again, whole.
      await setHq('hq_city = null, hq_country = null, hq_latitude = null, hq_longitude = null');
    });
    it('is refused in part: a city with no coordinates would be a guess on the map', async () => {
      await expectDbRejection(setHq("hq_city = 'Austin'"), /portfolio_company_hq_whole/);
      await expectDbRejection(
        setHq('hq_latitude = 30.26715, hq_longitude = -97.74306'),
        /portfolio_company_hq_whole/,
      );
    });
    it('is refused off the globe or with a country that is not a two-letter code', async () => {
      const whole = (lat: string, lon: string, country: string): Promise<void> =>
        setHq(
          `hq_city = 'Austin', hq_country = '${country}', hq_latitude = ${lat}, hq_longitude = ${lon}`,
        );
      // The constraint's name, which the statement itself does not carry.
      await expectDbRejection(whole('90.5', '0', 'US'), /portfolio_company_hq_latitude_range/);
      await expectDbRejection(whole('0', '180.5', 'US'), /portfolio_company_hq_longitude_range/);
      await expectDbRejection(whole('0', '0', 'us'), /portfolio_company_hq_country_code/);
      await expectDbRejection(
        whole('0', '0', 'US').then(() => setHq("hq_city = ' '")),
        /portfolio_company_hq_city_filled/,
      );
    });
  });
});
