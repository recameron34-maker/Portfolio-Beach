import { describe, expect, it } from 'vitest';
import { buildOpenApi } from './openapi.js';
import { ROUTES } from './routes.js';
import {
  dataException,
  dataExceptionCommandBody,
  dataExceptionListQuery,
  intakeFile,
  intakeFileListQuery,
  intakeSource,
  lookthroughDifference,
  lookthroughMapping,
  lookthroughReconcileBody,
  lookthroughReconcileResult,
  lookthroughRow,
  opsDropImportBody,
  opsDropTemplates,
  TEMPLATE_HEADER_SEPARATOR,
  weeklyFileDetail,
  weeklyImportBody,
  weeklyImportResult,
  weeklyRow,
} from './schemas.js';

const ID = '80000000-0000-4000-8000-000000000001';
const INV = '30000000-0000-4000-8000-000000000001';

const file = {
  id: ID,
  source: 'weekly',
  fileName: 'weekly-values-2025-06-27.csv',
  contentHash: 'a'.repeat(64),
  receivedAt: '2025-06-30T09:00:00.000Z',
  receivedBy: 'Operations One',
  rowCount: 1,
  status: 'validated',
  counts: { new: 0, validated: 1, flagged: 0, approved: 0, rejected: 0, promoted: 0 },
  fileFindings: [],
  exceptions: 0,
  rowVersion: 1,
  templateSignature: null,
};

const link = {
  status: 'matched',
  investmentId: INV,
  investmentNumber: 'INV-0001',
  companyName: 'Saltmarsh Holdings',
  candidates: [],
};

const weekly = {
  id: '80000000-0000-4000-8000-000000000002',
  rowNo: 1,
  investmentNumber: 'INV-0001',
  companyName: 'Saltmarsh Holdings',
  reportDate: '2025-06-27',
  reportedValue: '46500000.00',
  priorValue: '45000000.00',
  priorSource: 'locked_mark',
  priorDate: '2025-03-31',
  variancePct: '0.0333333333',
  flag: null,
  link,
  findings: [],
  status: 'validated',
  decision: null,
  decidedBy: null,
  decidedAt: null,
  valuationId: null,
};

describe('intake files from every Phase 1 source', () => {
  it('names the four sources and carries the template signature a workbook matched', () => {
    expect(intakeSource.options).toEqual(['accounting', 'weekly', 'lookthrough', 'ops_drop']);
    for (const source of intakeSource.options)
      expect(intakeFile.safeParse({ ...file, source }).success, source).toBe(true);
    expect(intakeFile.safeParse({ ...file, source: 'email' }).success).toBe(false);
    expect(
      intakeFile.safeParse({ ...file, source: 'ops_drop', templateSignature: 'quarterly-figures' })
        .success,
    ).toBe(true);
    // A producer written before the field existed may leave it out; a reader takes that as null.
    const { templateSignature: _dropped, ...withoutSignature } = file;
    expect(intakeFile.parse(withoutSignature).templateSignature).toBeUndefined();
    expect(intakeFile.safeParse({ ...file, templateSignature: 7 }).success).toBe(false);
  });

  it('filters the file list by source and still refuses unknown query fields', () => {
    expect(intakeFileListQuery.parse({ source: 'ops_drop' }).source).toBe('ops_drop');
    expect(intakeFileListQuery.safeParse({ source: 'mail' }).success).toBe(false);
    expect(intakeFileListQuery.safeParse({ sources: 'weekly' }).success).toBe(false);
  });
});

describe('weekly report values', () => {
  it('keeps the prior, the variance and the flag as the reviewer sees them', () => {
    const row = weeklyRow.parse(weekly);
    expect(row.priorSource).toBe('locked_mark');
    expect(weeklyRow.safeParse({ ...weekly, flag: 'above_threshold' }).success).toBe(true);
    expect(weeklyRow.safeParse({ ...weekly, flag: 'stale' }).success).toBe(false);
    expect(weeklyRow.safeParse({ ...weekly, priorSource: 'guess' }).success).toBe(false);
    // Money travels as decimal text, never as a number.
    expect(weeklyRow.safeParse({ ...weekly, priorValue: 45000000 }).success).toBe(false);
    // The file's own cells may be anything the file wrote, or empty.
    expect(
      weeklyRow.safeParse({
        ...weekly,
        investmentNumber: null,
        reportDate: '27/06/2025',
        reportedValue: 'n/a',
        priorValue: null,
        priorSource: null,
        priorDate: null,
        variancePct: null,
      }).success,
    ).toBe(true);
    expect(weeklyRow.safeParse({ ...weekly, priorDate: '2025-02-30' }).success).toBe(false);
  });

  it('answers the file with its rows and hidden count, and the import with the duplicate flag', () => {
    const detail = { ...file, rows: [weekly], hiddenRows: 1 };
    expect(weeklyFileDetail.safeParse(detail).success).toBe(true);
    expect(weeklyImportResult.safeParse(detail).success).toBe(false);
    expect(weeklyImportResult.safeParse({ ...detail, duplicate: true }).success).toBe(true);
  });

  it('imports either an uploaded CSV or a listed drop, never both or neither', () => {
    expect(weeklyImportBody.safeParse({ fileName: 'w.csv', csv: 'a,b\n1,2\n' }).success).toBe(true);
    expect(weeklyImportBody.safeParse({ dropId: 'weekly-values-2025-06-27.csv' }).success).toBe(
      true,
    );
    expect(weeklyImportBody.safeParse({ fileName: 'w.csv', csv: '' }).success).toBe(false);
    expect(weeklyImportBody.safeParse({ fileName: 'w.csv' }).success).toBe(false);
    expect(weeklyImportBody.safeParse({ dropId: 'x', csv: 'a' }).success).toBe(false);
    expect(weeklyImportBody.safeParse({}).success).toBe(false);
  });
});

describe('look-through reconcile', () => {
  const provider = {
    sector: 'Technology',
    geography: 'North America',
    exposureAtCost: '30000000',
    exposureAtNav: '46000000',
  };
  const row = {
    id: '80000000-0000-4000-8000-000000000003',
    rowNo: 1,
    investmentNumber: 'INV-0001',
    companyName: 'Saltmarsh Holdings',
    asOf: '2025-06-30',
    provider,
    mapped: { sector: 'sector.software', geography: 'geography.north_america' },
    approved: { exposureAtCost: '30000000.00', exposureAtNav: '45000000.00' },
    differences: [{ field: 'exposureAtNav', expected: '45000000.00', actual: '46000000' }],
    link,
    findings: [],
    status: 'flagged',
    exceptions: 1,
  };

  it('keeps the provider texts, what they mapped to, the approved values and each difference', () => {
    expect(lookthroughRow.safeParse(row).success).toBe(true);
    expect(
      lookthroughRow.safeParse({ ...row, mapped: { sector: null, geography: null } }).success,
    ).toBe(true);
    expect(
      lookthroughDifference.safeParse({ field: 'owner', expected: null, actual: null }).success,
    ).toBe(false);
    expect(
      lookthroughRow.safeParse({ ...row, approved: { exposureAtCost: 1, exposureAtNav: null } })
        .success,
    ).toBe(false);
  });

  it('runs for one real calendar date and answers the run with the duplicate flag', () => {
    expect(lookthroughReconcileBody.safeParse({ asOf: '2025-06-30' }).success).toBe(true);
    expect(lookthroughReconcileBody.safeParse({ asOf: '2025-06-31' }).success).toBe(false);
    expect(lookthroughReconcileBody.safeParse({ asOf: '2025-06-30', force: true }).success).toBe(
      false,
    );
    const run = { ...file, source: 'lookthrough', asOf: '2025-06-30', rows: [row], hiddenRows: 0 };
    expect(lookthroughReconcileResult.safeParse(run).success).toBe(false);
    expect(lookthroughReconcileResult.safeParse({ ...run, duplicate: false }).success).toBe(true);
  });
});

describe('ops drop workbooks', () => {
  it('takes an uploaded workbook or a listed drop, with the size limit the API reads from config', () => {
    const shape = opsDropImportBody();
    expect(shape.safeParse({ fileName: 'q.xlsx', workbookBase64: 'UEsDBA==' }).success).toBe(true);
    expect(shape.safeParse({ dropId: 'quarterly-figures-2025-06-30.xlsx' }).success).toBe(true);
    expect(shape.safeParse({ fileName: 'q.xlsx', workbookBase64: '' }).success).toBe(false);
    expect(shape.safeParse({ fileName: 'q.xlsx', workbookBase64: 'x', dropId: 'y' }).success).toBe(
      false,
    );
    const limited = opsDropImportBody(8);
    expect(limited.safeParse({ fileName: 'q.xlsx', workbookBase64: 'UEsDBA==' }).success).toBe(
      true,
    );
    expect(limited.safeParse({ fileName: 'q.xlsx', workbookBase64: 'UEsDBAAA=' }).success).toBe(
      false,
    );
    // The route table documents the shape only: the limit is config, so the document carries none.
    const doc = buildOpenApi('0.1.0');
    const post = doc.paths['/api/v1/intake/ops-drop']?.post as {
      requestBody: {
        content: Record<
          string,
          { schema: { anyOf: { properties: Record<string, Record<string, unknown>> }[] } }
        >;
      };
    };
    const upload = post.requestBody.content['application/json']?.schema.anyOf[0];
    expect(upload?.properties.workbookBase64?.minLength).toBe(1);
    expect(upload?.properties.workbookBase64?.maxLength).toBeUndefined();
  });
});

describe('data exceptions', () => {
  const exception = {
    id: '90000000-0000-4000-8000-000000000001',
    source: 'lookthrough_reconcile',
    entity: 'stg.intake_row',
    entityId: '80000000-0000-4000-8000-000000000003',
    ruleId: 'XREF-05',
    expected: 'sector.software',
    actual: 'Technology',
    severity: 'exception_severity.medium',
    owner: null,
    state: 'open',
    externalTicket: null,
    candidates: [{ reason: 'near miss' }],
    createdAt: '2025-06-30T09:00:00.000Z',
    updatedAt: '2025-06-30T09:00:00.000Z',
    rowVersion: 1,
    context: {
      intakeFileId: ID,
      intakeFileName: 'lookthrough-2025-06-30.json',
      rowNo: 1,
      investmentId: INV,
      investmentNumber: 'INV-0001',
      companyName: 'Saltmarsh Holdings',
    },
  };

  it('carries its state, owner, ticket, candidates by reason and the context the caller may see', () => {
    expect(dataException.safeParse(exception).success).toBe(true);
    expect(dataException.safeParse({ ...exception, state: 'closed' }).success).toBe(false);
    expect(
      dataException.safeParse({ ...exception, candidates: [{ investmentNumber: 'INV-0002' }] })
        .success,
    ).toBe(false);
    const hidden = {
      intakeFileId: null,
      intakeFileName: null,
      rowNo: null,
      investmentId: null,
      investmentNumber: null,
      companyName: null,
    };
    expect(dataException.safeParse({ ...exception, context: hidden }).success).toBe(true);
  });

  it('lists by state, source and severity with the shared page query', () => {
    expect(
      dataExceptionListQuery.parse({ state: 'open', severity: 'exception_severity.high' }),
    ).toMatchObject({ limit: 50, state: 'open' });
    expect(dataExceptionListQuery.safeParse({ state: 'done' }).success).toBe(false);
    expect(dataExceptionListQuery.safeParse({ owner: 'x' }).success).toBe(false);
  });

  it('needs a reason to resolve or close, a ticket to set one, and nothing to acknowledge', () => {
    expect(dataExceptionCommandBody.safeParse({ command: 'acknowledge' }).success).toBe(true);
    for (const command of ['resolve', 'wont_fix']) {
      const missing = dataExceptionCommandBody.safeParse({ command });
      expect(missing.success, command).toBe(false);
      expect(missing.error?.issues.map((i) => i.path.join('.'))).toEqual(['reason']);
      expect(
        dataExceptionCommandBody.safeParse({ command, reason: 'Provider corrected the sector' })
          .success,
        command,
      ).toBe(true);
    }
    const noTicket = dataExceptionCommandBody.safeParse({ command: 'set_ticket' });
    expect(noTicket.success).toBe(false);
    expect(noTicket.error?.issues.map((i) => i.path.join('.'))).toEqual(['externalTicket']);
    expect(
      dataExceptionCommandBody.safeParse({ command: 'set_ticket', externalTicket: 'HD-10452' })
        .success,
    ).toBe(true);
    // A ticket is one short line of plain text.
    expect(
      dataExceptionCommandBody.safeParse({ command: 'set_ticket', externalTicket: '' }).success,
    ).toBe(false);
    expect(
      dataExceptionCommandBody.safeParse({ command: 'set_ticket', externalTicket: 'x'.repeat(65) })
        .success,
    ).toBe(false);
    expect(
      dataExceptionCommandBody.safeParse({
        command: 'set_ticket',
        externalTicket: `HD-1${String.fromCharCode(0)}`,
      }).success,
    ).toBe(false);
    expect(
      dataExceptionCommandBody.safeParse({ command: 'acknowledge', force: true }).success,
    ).toBe(false);
  });
});

describe('config files the intakes read', () => {
  it('maps provider labels onto taxonomy codes of the right domain only', () => {
    expect(
      lookthroughMapping.safeParse({
        sector: { Technology: 'sector.software' },
        geography: { Europe: 'geography.europe' },
      }).success,
    ).toBe(true);
    expect(
      lookthroughMapping.safeParse({
        sector: { Technology: 'geography.europe' },
        geography: {},
      }).success,
    ).toBe(false);
    expect(lookthroughMapping.safeParse({ sector: {}, geography: {}, strategy: {} }).success).toBe(
      false,
    );
  });

  it('describes a workbook template by its sheets, header hash and column mapping', () => {
    const template = {
      name: 'quarterly-figures',
      sheets: ['Figures', 'Notes'],
      headerSheet: 'Figures',
      header: ['Investment number', 'Company'],
      headerHash: 'b'.repeat(64),
      columns: { 'Investment number': 'InvestmentNumber', Company: 'CompanyName' },
    };
    expect(opsDropTemplates.safeParse({ templates: [template] }).success).toBe(true);
    expect(opsDropTemplates.safeParse({ templates: [] }).success).toBe(false);
    expect(
      opsDropTemplates.safeParse({ templates: [{ ...template, headerSheet: 'Summary' }] }).success,
    ).toBe(false);
    expect(
      opsDropTemplates.safeParse({
        templates: [{ ...template, header: ['Investment number', 'EV'] }],
      }).success,
    ).toBe(false);
    expect(
      opsDropTemplates.safeParse({ templates: [{ ...template, headerHash: 'not-a-hash' }] })
        .success,
    ).toBe(false);
    expect(
      opsDropTemplates.safeParse({ templates: [{ ...template, name: 'Quarterly Figures' }] })
        .success,
    ).toBe(false);
    expect(opsDropTemplates.safeParse({ templates: [template, template] }).success).toBe(false);
    expect(TEMPLATE_HEADER_SEPARATOR).toBe('\u001f');
  });
});

describe('the route table', () => {
  const find = (method: string, path: string) =>
    ROUTES.find((r) => r.method === method && r.path === `/api/v1${path}`);

  it('serves the weekly, look-through, ops-drop and data exception routes with their roles', () => {
    const reviewers = ['operations', 'deal_team', 'approver', 'auditor'];
    const expected: [string, string, string[], number | undefined][] = [
      ['GET', '/intake/weekly/drops', ['operations'], undefined],
      ['POST', '/intake/weekly', ['operations'], 201],
      ['GET', '/intake/weekly/files/{id}', reviewers, undefined],
      ['POST', '/intake/weekly/files/{id}/commands', ['operations', 'deal_team'], undefined],
      ['POST', '/intake/lookthrough/reconcile', ['operations'], 201],
      ['GET', '/intake/lookthrough/runs/{id}', reviewers, undefined],
      ['GET', '/intake/ops-drop/drops', ['operations'], undefined],
      ['POST', '/intake/ops-drop', ['operations'], 201],
      ['GET', '/data-exceptions', reviewers, undefined],
      ['GET', '/data-exceptions/{id}', reviewers, undefined],
      ['POST', '/data-exceptions/{id}/commands', ['operations'], undefined],
    ];
    for (const [method, path, roles, status] of expected) {
      const route = find(method, path);
      expect(route, `${method} ${path}`).toBeDefined();
      expect(route?.roles, `${method} ${path}`).toEqual(roles);
      expect(route?.responseStatus, `${method} ${path}`).toBe(status);
      expect(route?.auth, `${method} ${path}`).toBe(true);
      if (method === 'POST') expect(route?.body, `${method} ${path}`).toBeDefined();
    }
    // The ops-drop detail is the existing intake file detail; the Data Health page stays as it was.
    expect(find('GET', '/intake/files/{id}')?.response).toBeDefined();
    expect(find('GET', '/data-health')?.roles).toEqual([]);
    // No two routes share a method and path.
    const keys = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('builds into the OpenAPI document with one operation per route', () => {
    const doc = buildOpenApi('0.1.0');
    const operations = Object.values(doc.paths).flatMap((p) => Object.keys(p));
    expect(operations.length).toBe(ROUTES.length);
    const commands = doc.paths['/api/v1/data-exceptions/{id}/commands']?.post as {
      'x-roles': string[];
    };
    expect(commands['x-roles']).toEqual(['operations']);
  });
});
