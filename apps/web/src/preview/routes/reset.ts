import { jsonResponse } from '../problems.js';
import { resetPreviewState } from '../state.js';
import { defineSimRoute } from './common.js';

/** POST /api/v1/preview/reset: forgets every simulated change in this page session. */
export const resetRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/preview/reset',
  what: 'reset',
  body: null,
  handle: (_req, ctx) => {
    resetPreviewState(ctx.state);
    return jsonResponse(200, { reset: true }, { simulated: true });
  },
});
