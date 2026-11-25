import { describe, expect, it } from 'vitest';
import { buildOpenApi } from './openapi.js';
import {
  reportPackageCommandBody,
  reportPackageCreateBody,
  reportPackageDetail,
  reportPackageRun,
} from './reporting.js';
import type { ReportPackageDetail } from './reporting.js';

/*
 * The reporting package detail (docs/04 M14, docs/18 section 5) carries its change log: the
 * generation runs in run order, each by a person a page can name. Every other step of a package
 * is in the audit trail, not here.
 */

const PREPARER = { id: '11111111-1111-4111-8111-111111111111', name: 'Ira One' };

const draft: ReportPackageDetail = {
  id: '22222222-2222-4222-8222-222222222222',
  client: { id: '33333333-3333-4333-8333-333333333333', name: 'Client A' },
  periodEnd: '2025-06-30',
  asOf: '2025-08-09',
  basis: 'gross',
  label: 'preliminary',
  version: 1,
  state: 'Draft',
  preparedBy: PREPARER,
  reviewer: null,
  approvedAt: null,
  releasedAt: null,
  qa: { runNo: null, findings: 0, failed: 0, overridden: 0 },
  rowVersion: 1,
  correctionReason: null,
  contentHash: null,
  releasedBy: null,
  content: null,
  findings: [],
  tieOutExplanations: {},
  changeLog: [],
};

const run = {
  at: '2025-08-09T10:15:00.000Z',
  by: PREPARER,
  runNo: 1,
  lines: 42,
  findings: 126,
  failed: 3,
};

describe('the reporting package detail: its change log', () => {
  it('lists the generation runs, each with when, who by name and what the run counted', () => {
    expect(reportPackageDetail.parse(draft).changeLog).toEqual([]);
    const second = { ...run, at: '2025-08-10T08:00:00.000Z', runNo: 2, failed: 0 };
    const parsed = reportPackageDetail.parse({ ...draft, changeLog: [run, second] });
    expect(parsed.changeLog).toEqual([run, second]);
    expect(reportPackageRun.parse(run)).toEqual(run);
  });

  it('is always there, and never names a person by a bare id', () => {
    const { changeLog: _log, ...without } = draft;
    expect(reportPackageDetail.safeParse(without).success).toBe(false);
    expect(reportPackageRun.safeParse({ ...run, by: PREPARER.id }).success).toBe(false);
    expect(reportPackageRun.safeParse({ ...run, by: { id: PREPARER.id } }).success).toBe(false);
    // The counts are whole numbers: a run never counts part of a line or of a finding.
    for (const key of ['runNo', 'lines', 'findings', 'failed'] as const)
      expect(reportPackageRun.safeParse({ ...run, [key]: 1.5 }).success, key).toBe(false);
  });

  it('is in the OpenAPI document of the read, the start and the command', () => {
    const doc = buildOpenApi('0.1.0');
    const answers = [
      doc.paths['/api/v1/report-packages/{id}']?.get,
      doc.paths['/api/v1/report-packages']?.post,
      doc.paths['/api/v1/report-packages/{id}/commands']?.post,
    ] as (
      | {
          responses: Record<
            string,
            {
              content: Record<
                string,
                { schema: { required?: string[]; properties?: Record<string, unknown> } }
              >;
            }
          >;
        }
      | undefined
    )[];
    for (const [i, operation] of answers.entries()) {
      const status = i === 1 ? '201' : '200';
      const schema = operation?.responses[status]?.content['application/json']?.schema;
      expect(schema?.required, String(i)).toContain('changeLog');
      expect(schema?.properties?.changeLog, String(i)).toMatchObject({
        type: 'array',
        items: { required: ['at', 'by', 'runNo', 'lines', 'findings', 'failed'] },
      });
    }
  });
});

/*
 * What a person writes on a package (a reason for a new version, a reason for an override, an
 * explanation of a tie-out) is measured without the spaces around it and kept that way: text of
 * spaces is no reason, and the record refuses one (migration 0019), so the boundary does first.
 */
describe('reasons and explanations on a package: measured and kept without the spaces around them', () => {
  const start = {
    clientId: '33333333-3333-4333-8333-333333333333',
    periodEnd: '2025-06-30',
    basis: 'gross',
    label: 'final',
  };

  it('refuses a reason for a new version that is spaces, or too short once the spaces are gone', () => {
    for (const correctionReason of ['   ', '    ', ' \n\t ', ' ab ', '  a  '])
      expect(
        reportPackageCreateBody.safeParse({ ...start, correctionReason }).success,
        JSON.stringify(correctionReason),
      ).toBe(false);
    expect(
      reportPackageCreateBody.parse({ ...start, correctionReason: '  Corrected figures  ' })
        .correctionReason,
    ).toBe('Corrected figures');
    // No reason at all is still a body: only a released package asks for one.
    expect(reportPackageCreateBody.parse(start).correctionReason).toBeUndefined();
  });

  it('refuses an override reason that is spaces, and keeps a real one trimmed', () => {
    expect(
      reportPackageCommandBody.safeParse({ command: 'overrideQa', reason: '     ' }).success,
    ).toBe(false);
    expect(
      reportPackageCommandBody.safeParse({ command: 'overrideQa', reason: ' ok ' }).success,
    ).toBe(false);
    expect(
      reportPackageCommandBody.parse({ command: 'overrideQa', reason: '  agreed with ops  ' }),
    ).toEqual({ command: 'overrideQa', reason: 'agreed with ops' });
  });

  it('refuses an explanation that is spaces, and keeps a real one trimmed', () => {
    for (const command of ['generate', 'regenerate'] as const) {
      expect(
        reportPackageCommandBody.safeParse({ command, explanations: { 'INV-0002': '     ' } })
          .success,
        command,
      ).toBe(false);
      expect(
        reportPackageCommandBody.parse({
          command,
          explanations: { 'INV-0002': '  Restated by the sponsor ' },
        }),
      ).toEqual({ command, explanations: { 'INV-0002': 'Restated by the sponsor' } });
    }
  });

  it('still bounds the text at 500 characters and refuses a control character', () => {
    expect(
      reportPackageCommandBody.safeParse({ command: 'overrideQa', reason: 'a'.repeat(500) })
        .success,
    ).toBe(true);
    expect(
      reportPackageCommandBody.safeParse({ command: 'overrideQa', reason: 'a'.repeat(501) })
        .success,
    ).toBe(false);
    expect(
      reportPackageCommandBody.safeParse({ command: 'overrideQa', reason: 'agreed\u0000 with ops' })
        .success,
    ).toBe(false);
  });
});
