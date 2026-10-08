import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WORKFLOW_REFUSALS, problemDetails } from '@pb/contracts';
import type { WorkflowRefusalCode } from '@pb/contracts';
import { attempt, valuationMachine } from '@pb/workflows';
import { jsonResponse, problem, validationProblem, workflowProblem } from './problems.js';
import type { WorkflowFailure } from './problems.js';

// Compile-time: the shared mapping covers exactly the failure codes attempt() can return.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const covers: Same<WorkflowFailure['code'], WorkflowRefusalCode> = true;

describe('preview problems', () => {
  it('builds RFC 9457 problems with the pinned request id and the API titles', async () => {
    expect(covers).toBe(true);
    const res = problem(404, 'not-found', 'Investment not found', { instance: '/api/v1/x' });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('x-request-id')).toBe('preview');
    expect(res.headers.get('x-pb-simulated')).toBeNull();
    expect(problemDetails.parse(await res.json())).toEqual({
      type: 'https://portfolio-beach.example/problems/not-found',
      title: 'Not found',
      status: 404,
      detail: 'Investment not found',
      instance: '/api/v1/x',
      request_id: 'preview',
    });
    expect(
      problem(412, 'precondition', 'stale', { simulated: true }).headers.get('x-pb-simulated'),
    ).toBe('true');
  });

  it('lists validation errors by path and never echoes the submitted values', async () => {
    const schema = z.object({ fairValue: z.string().regex(/^\d+$/), method: z.string() }).strict();
    const parsed = schema.safeParse({ fairValue: 'VALUE-9931', extra: 'VALUE-1177' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const res = validationProblem(parsed.error, 'valuation');
    const text = await res.text();
    expect(text).not.toContain('VALUE-9931');
    expect(text).not.toContain('VALUE-1177');
    const body = problemDetails.parse(JSON.parse(text));
    expect(body.detail).toBe('Invalid valuation');
    expect(body.errors?.map((e) => e.path).sort()).toEqual(['(root)', 'fairValue', 'method']);
  });

  it('maps every attempt() refusal through WORKFLOW_REFUSALS', async () => {
    const ctx = { actorId: 'a', actorRoles: ['viewer'], record: {} };
    const failures = [
      attempt(valuationMachine, 'Draft', 'lock', ctx),
      attempt(valuationMachine, 'Draft', 'prepare', ctx),
      attempt(valuationMachine, 'Draft', 'prepare', { ...ctx, actorRoles: ['operations'] }),
    ];
    const seen = new Set<string>();
    for (const result of failures) {
      if (result.ok) throw new Error('expected a refusal');
      seen.add(result.code);
      const res = workflowProblem(result, { simulated: true });
      const refusal = WORKFLOW_REFUSALS[result.code];
      const body = problemDetails.parse(await res.json());
      expect(res.status).toBe(refusal.status);
      expect(body).toMatchObject({
        type: `https://portfolio-beach.example/problems/${refusal.code}`,
        title: refusal.title,
        status: refusal.status,
        detail: result.message,
      });
    }
    expect(seen).toEqual(new Set(['forbidden', 'role', 'precondition']));
  });

  it('answers JSON with the row version as an entity tag', async () => {
    const res = jsonResponse(201, { ok: 1 }, { simulated: true, etag: 3 });
    expect(res.headers.get('etag')).toBe('"3"');
    expect(res.headers.get('x-pb-simulated')).toBe('true');
    expect(await res.json()).toEqual({ ok: 1 });
  });
});
