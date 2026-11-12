import { describe, expect, it } from 'vitest';
import { problemDetails } from './schemas.js';
import { SIMULATED_ROUTES, WORKFLOW_REFUSALS } from './simulated.js';

describe('workflow refusals', () => {
  it('pins the mapping the API workflow controllers and the preview share', () => {
    expect(WORKFLOW_REFUSALS).toEqual({
      role: { status: 403, code: 'forbidden', title: 'Forbidden' },
      forbidden: { status: 409, code: 'workflow-transition', title: 'Conflict' },
      precondition: { status: 422, code: 'workflow-precondition', title: 'Unprocessable' },
    });
  });

  it('keeps 412 free for stale row versions and gives every refusal its own status', () => {
    const statuses = Object.values(WORKFLOW_REFUSALS).map((r) => r.status);
    expect(new Set(statuses).size).toBe(statuses.length);
    expect(statuses).not.toContain(412);
  });

  it('produces valid problem details for every refusal', () => {
    for (const refusal of Object.values(WORKFLOW_REFUSALS)) {
      const body = {
        type: `https://portfolio-beach.example/problems/${refusal.code}`,
        title: refusal.title,
        status: refusal.status,
        detail: 'valuation: lock is not allowed from Draft',
        request_id: 'test',
      };
      expect(problemDetails.safeParse(body).success).toBe(true);
    }
  });

  it('lists every simulated write with a body schema except the reset', () => {
    const withoutBody = SIMULATED_ROUTES.filter((r) => r.body === undefined).map((r) => r.path);
    expect(withoutBody).toEqual(['/api/v1/preview/reset']);
  });
});
