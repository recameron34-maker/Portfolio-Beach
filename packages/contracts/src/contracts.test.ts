import { describe, expect, it } from 'vitest';
import { buildOpenApi } from './openapi.js';
import { ROUTES } from './routes.js';
import { investmentListQuery, investmentSummary, problemDetails } from './schemas.js';

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
      sponsorName: 'Y',
      sponsorFundName: null,
      vehicleName: 'V',
      dealType: 'deal_type.co_invest_equity',
      sector: 'sector.software',
      geography: 'geography.north_america',
      vintage: 2022,
      entryDate: '2022-01-01',
      exitDate: null,
      isActive: true,
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

  it('problem details never carry a stack', () => {
    expect(
      problemDetails.safeParse({ type: 'https://x/y', title: 't', status: 404, request_id: 'r' })
        .success,
    ).toBe(true);
  });
});
