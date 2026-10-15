import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildOpenApi } from './openapi.js';
import { ROUTES } from './routes.js';
import {
  asOfQuery,
  auditQuery,
  capitalNoticeListQuery,
  filterText,
  investmentDetail,
  investmentListQuery,
  investmentSummary,
  isCalendarDate,
  isoDate,
  pageQuery,
  plainText,
  problemDetails,
  valuationListQuery,
} from './schemas.js';

interface ObjectSchema {
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
}

/** The JSON schema of a GET route's success response in the generated document. */
function responseSchema(doc: ReturnType<typeof buildOpenApi>, path: string): ObjectSchema {
  const get = doc.paths[path]?.get as
    | { responses: Record<string, { content: Record<string, { schema: ObjectSchema }> }> }
    | undefined;
  const schema = get?.responses['200']?.content['application/json']?.schema;
  if (schema === undefined) throw new Error(`no 200 response schema for GET ${path}`);
  return schema;
}

describe('contracts', () => {
  it('builds a valid-looking OpenAPI 3.1 document for every route', () => {
    const doc = buildOpenApi('0.1.0');
    expect(doc.openapi).toBe('3.1.0');
    const operations = Object.values(doc.paths).flatMap((p) => Object.keys(p));
    expect(operations.length).toBe(ROUTES.length);
    expect(doc.paths['/api/v1/investments/{id}']?.get).toBeDefined();
    const patch = doc.paths['/api/v1/flags/{key}']?.patch as {
      'x-roles': string[];
      requestBody: unknown;
    };
    expect(patch['x-roles']).toEqual(['platform_admin']);
    expect(patch.requestBody).toBeDefined();
    expect(doc.components.schemas.ProblemDetails).toBeDefined();
  });

  it('documents the as-of date of the sponsor 360 like the vehicle detail', () => {
    const doc = buildOpenApi('0.1.0');
    for (const path of ['/api/v1/sponsors/{id}', '/api/v1/vehicles/{id}']) {
      const schema = responseSchema(doc, path);
      expect(schema.required, path).toContain('asOf');
      expect(schema.properties?.asOf, path).toBeDefined();
    }
  });

  it('rejects unknown query fields and caps the page size at 200', () => {
    expect(investmentListQuery.safeParse({ limit: '500' }).success).toBe(false);
    expect(investmentListQuery.safeParse({ limit: '50', extra: 1 }).success).toBe(false);
    expect(investmentListQuery.parse({}).limit).toBe(50);
  });

  it('keeps money as decimal strings and uses null for not calculable', () => {
    const ok = investmentSummary.safeParse({
      id: '30000000-0000-4000-8000-000000000001',
      investmentNumber: 'INV-0001',
      companyName: 'X',
      sponsorId: '30000000-0000-4000-8000-0000000000c1',
      sponsorName: 'Y',
      sponsorFundName: null,
      vehicleId: '30000000-0000-4000-8000-0000000000b1',
      vehicleName: 'V',
      dealType: 'deal_type.co_invest_equity',
      sector: 'sector.software',
      geography: 'geography.north_america',
      vintage: 2022,
      entryDate: '2022-01-01',
      exitDate: null,
      isActive: true,
      holdingPeriodYears: '3.4931506849',
      invested: '1000.00',
      distributions: '0',
      nav: null,
      navDate: null,
      grossMoic: null,
      grossIrr: null,
      irrFlag: 'insufficient_flows',
      calcVersion: '0.1.0',
    });
    expect(ok.success).toBe(true);
    expect(investmentSummary.safeParse({ ...ok.data, invested: 1000 }).success).toBe(false);
  });

  it('gives every position row its vehicle and sponsor ids, which the detail inherits', () => {
    const doc = buildOpenApi('0.1.0');
    const row = (responseSchema(doc, '/api/v1/investments').properties?.items?.items ??
      {}) as ObjectSchema;
    const detail = responseSchema(doc, '/api/v1/investments/{id}');
    for (const schema of [row, detail]) {
      expect(schema.required).toEqual(expect.arrayContaining(['vehicleId', 'sponsorId']));
      expect(schema.properties?.vehicleId?.format).toBe('uuid');
      expect(schema.properties?.sponsorId?.format).toBe('uuid');
    }
    expect(investmentDetail.shape.vehicleId).toBe(investmentSummary.shape.vehicleId);
    expect(investmentDetail.shape.sponsorId).toBe(investmentSummary.shape.sponsorId);
  });

  it('accepts only days that exist on the calendar, leap days included', () => {
    for (const day of ['2025-06-30', '2024-02-29', '2000-02-29', '1999-12-31', '0001-01-01']) {
      expect(isoDate.safeParse(day).success, day).toBe(true);
      expect(isCalendarDate(day), day).toBe(true);
    }
    for (const day of [
      '2025-02-30',
      '2025-02-29',
      '1900-02-29',
      '0000-01-01',
      '2025-04-31',
      '2025-06-31',
      '2025-13-01',
      '2025-00-10',
      '2025-01-00',
      '2025-12-32',
    ]) {
      const result = isoDate.safeParse(day);
      expect(result.success, day).toBe(false);
      expect(isCalendarDate(day), day).toBe(false);
      // One plain message, never the value itself.
      expect(result.error?.issues.map((i) => i.message)).toEqual(['Not a real calendar date']);
    }
  });

  it('refuses a control character in a filter, a reason or a cursor, so none reaches the database', () => {
    const nul = String.fromCharCode(0);
    for (const value of ['deal_type.co_invest_equity', 'Kelpwood Capital', 'a\tb'])
      expect(filterText.safeParse(value).success, value).toBe(true);
    for (const value of ['', `core.investment${nul}`, '\u007f', 'x'.repeat(201)]) {
      const result = filterText.safeParse(value);
      expect(result.success, JSON.stringify(value)).toBe(false);
      expect(result.error?.issues.length, JSON.stringify(value)).toBe(1);
    }
    expect(filterText.safeParse(`a${nul}`).error?.issues[0]?.message).toBe(
      'Control characters are not allowed',
    );
    expect(auditQuery.safeParse({ entity: `core.investment${nul}` }).success).toBe(false);
    expect(auditQuery.safeParse({ action: 'investment.read' }).success).toBe(true);
    expect(investmentListQuery.safeParse({ dealType: nul }).success).toBe(false);
    expect(capitalNoticeListQuery.safeParse({ noticeType: `call${nul}` }).success).toBe(false);
    // A reason keeps its line breaks; the rest of the control range is refused.
    expect(plainText(500).safeParse('line one\nline two').success).toBe(true);
    expect(plainText(500).safeParse(`line one${nul}line two`).success).toBe(false);
    expect(plainText(5).safeParse('123456').success).toBe(false);
    // A cursor is never empty and never longer than a composite key can be.
    expect(pageQuery.safeParse({ cursor: '' }).success).toBe(false);
    expect(pageQuery.safeParse({ cursor: 'x'.repeat(513) }).success).toBe(false);
    expect(pageQuery.safeParse({ cursor: 'SU5WLTAwMTI' }).success).toBe(true);
  });

  it('reports a malformed date once, by its shape, and never runs the calendar on it', () => {
    for (const bad of ['2025-2-3', '20250630', '2025-06-30T00:00:00Z', '', 'today']) {
      const result = isoDate.safeParse(bad);
      expect(result.success, bad).toBe(false);
      expect(result.error?.issues.length, bad).toBe(1);
      expect(result.error?.issues[0]?.code, bad).toBe('invalid_format');
      expect(isCalendarDate(bad), bad).toBe(false);
    }
  });

  it('turns an impossible date in any query into a validation failure naming the field', () => {
    const cases: [z.ZodTypeAny, Record<string, string>, string][] = [
      [asOfQuery, { asOf: '2025-02-30' }, 'asOf'],
      [investmentListQuery, { asOf: '2025-04-31' }, 'asOf'],
      [valuationListQuery, { periodEnd: '2025-02-30' }, 'periodEnd'],
      [capitalNoticeListQuery, { dueFrom: '2025-13-01' }, 'dueFrom'],
      [capitalNoticeListQuery, { dueTo: '2023-02-29' }, 'dueTo'],
    ];
    for (const [schema, query, field] of cases) {
      const result = schema.safeParse(query);
      expect(result.success, field).toBe(false);
      expect(result.error?.issues.map((i) => i.path.join('.'))).toEqual([field]);
    }
  });

  it('documents every date as format date in the OpenAPI document', () => {
    const doc = buildOpenApi('0.1.0');
    const dateParams = Object.values(doc.paths)
      .flatMap((p) => Object.values(p) as { parameters: { name: string; schema: unknown }[] }[])
      .flatMap((op) => op.parameters)
      .filter((p) => ['asOf', 'periodEnd', 'dueFrom', 'dueTo'].includes(p.name));
    // asOf on sixteen routes (the expected documents, the board and its export among them),
    // periodEnd on five (valuations, documents, expected documents, the board and its export),
    // dueFrom and dueTo on one.
    expect(dateParams.length).toBe(23);
    for (const p of dateParams) {
      expect(p.schema, p.name).toEqual({
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        format: 'date',
      });
    }
    const row = (responseSchema(doc, '/api/v1/investments').properties?.items?.items ??
      {}) as ObjectSchema;
    expect(row.properties?.entryDate?.format).toBe('date');
    expect(responseSchema(doc, '/api/v1/sponsors/{id}').properties?.asOf?.format).toBe('date');
  });

  it('problem details never carry a stack', () => {
    expect(
      problemDetails.safeParse({ type: 'https://x/y', title: 't', status: 404, request_id: 'r' })
        .success,
    ).toBe(true);
  });
});
