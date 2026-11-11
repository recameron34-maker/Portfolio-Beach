import { describe, expect, it } from 'vitest';
import { isIdempotencyKey } from './idempotency.js';
import { buildOpenApi } from './openapi.js';
import { ROUTES } from './routes.js';

interface Parameter {
  name: string;
  in: string;
  required: boolean;
  description?: string;
  schema: { type?: string; pattern?: string; minLength?: number; maxLength?: number };
}

interface ResponseObject {
  description: string;
  headers?: Record<string, { description: string; schema: { type: string; enum?: string[] } }>;
  content?: Record<string, { schema: unknown }>;
}

interface Operation {
  parameters: Parameter[];
  responses: Record<string, ResponseObject>;
}

const doc = buildOpenApi('0.1.0');

function operationOf(method: string, path: string): Operation {
  const operation = doc.paths[path]?.[method.toLowerCase()] as Operation | undefined;
  if (operation === undefined) throw new Error(`no operation for ${method} ${path}`);
  return operation;
}

const headerOf = (operation: Operation, name: string): Parameter | undefined =>
  operation.parameters.find((p) => p.in === 'header' && p.name === name);

const PROBLEM = {
  'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
};

/**
 * The headers of docs/17 section 3 in the OpenAPI document: a route says in the route table
 * whether it takes an Idempotency-Key (`idempotent`) and whether it reads If-Match (`ifMatch`),
 * and the document describes each header, and the problems it can cause, on those routes only.
 */
describe('the OpenAPI document and the request headers', () => {
  it('describes Idempotency-Key, the replay header and the 409 and 422 on every idempotent route, and on no other', () => {
    const idempotent = ROUTES.filter((r) => r.idempotent === true);
    expect(idempotent.length).toBeGreaterThanOrEqual(20);
    for (const route of ROUTES) {
      const what = `${route.method} ${route.path}`;
      const operation = operationOf(route.method, route.path);
      const success = operation.responses[String(route.responseStatus ?? 200)];
      const header = headerOf(operation, 'Idempotency-Key');
      if (route.idempotent !== true) {
        expect(header, what).toBeUndefined();
        expect(success?.headers?.['Idempotency-Replayed'], what).toBeUndefined();
        expect(operation.responses['422'], what).toBeUndefined();
        continue;
      }
      expect(header, what).toMatchObject({
        required: false,
        schema: { type: 'string', minLength: 1, maxLength: 200 },
      });
      expect(header?.description, what).toMatch(/same key and the same body/);
      expect(success?.headers?.['Idempotency-Replayed'], what).toMatchObject({
        schema: { type: 'string', enum: ['true'] },
      });
      expect(operation.responses['409']?.description, what).toContain(
        'idempotency-key-in-progress',
      );
      expect(operation.responses['409']?.content, what).toEqual(PROBLEM);
      expect(operation.responses['422']?.description, what).toContain('idempotency-key-reuse');
      expect(operation.responses['422']?.content, what).toEqual(PROBLEM);
      // The general entry stays: every other refusal is a problem too.
      expect(operation.responses['4XX']?.content, what).toEqual(PROBLEM);
    }
  });

  it('gives the key the shape the API accepts', () => {
    const pattern = headerOf(operationOf('POST', '/api/v1/valuations'), 'Idempotency-Key')?.schema
      .pattern;
    if (pattern === undefined) throw new Error('the key has no pattern');
    const documented = new RegExp(pattern);
    for (const key of [
      '7c0e9c1e-6f0e-4a57-9d0c-2a4f8a5d1b11',
      'k'.repeat(200),
      '',
      'a b',
      'k'.repeat(201),
      'tab\tkey',
    ])
      expect(documented.test(key), JSON.stringify(key)).toBe(isIdempotencyKey(key));
  });

  it('describes If-Match and the 412 on the routes that read it, and on no other', () => {
    const guarded = ROUTES.filter((r) => r.ifMatch !== undefined);
    expect(guarded).toHaveLength(7);
    for (const route of ROUTES) {
      const what = `${route.method} ${route.path}`;
      const operation = operationOf(route.method, route.path);
      const header = headerOf(operation, 'If-Match');
      if (route.ifMatch === undefined) {
        expect(header, what).toBeUndefined();
        expect(operation.responses['412'], what).toBeUndefined();
        continue;
      }
      expect(header, what).toMatchObject({ required: false, schema: { type: 'string' } });
      expect(header?.description, what).toContain(route.ifMatch.replace(/_/g, ' '));
      expect(operation.responses['412']?.description, what).toContain('stale-row-version');
      expect(operation.responses['412']?.content, what).toEqual(PROBLEM);
    }
  });

  it('keeps the path and query parameters, and stays plain JSON', () => {
    const command = operationOf('POST', '/api/v1/valuations/{id}/commands');
    expect(command.parameters.map((p) => `${p.in}:${p.name}`)).toEqual([
      'path:id',
      'header:Idempotency-Key',
      'header:If-Match',
    ]);
    const list = operationOf('GET', '/api/v1/valuations');
    expect(list.parameters.every((p) => p.in === 'query')).toBe(true);
    expect(list.parameters.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
    expect(JSON.stringify(doc)).not.toContain(String.fromCharCode(0x2014));
  });
});
