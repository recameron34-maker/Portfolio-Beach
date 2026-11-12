import { featureFlagList, featureFlagPatch } from '@pb/contracts';
import { jsonResponse, problem } from '../problems.js';
import { defineSimRoute, recordActivity } from './common.js';

/** The API's key rule (apps/api/src/flags/flags.controller.ts). */
const FLAG_KEY = /^[a-z0-9_.]{3,64}$/;

/**
 * PATCH /api/v1/flags/{key}: platform admins only (the contract's role guard), reason required by
 * the body schema. The flag must be one the credential's recorded flag list holds; the new value
 * shows in GET /api/v1/flags for every role until the page reloads or the preview is reset.
 */
export const flagRoute = defineSimRoute({
  method: 'PATCH',
  path: '/api/v1/flags/{key}',
  what: 'flag update',
  body: featureFlagPatch,
  handle: (req, ctx) => {
    const key = req.params.key ?? '';
    const instance = req.url.pathname;
    const flag = FLAG_KEY.test(key)
      ? ctx.recordings
          .read(req.credential, '/api/v1/flags', featureFlagList)
          ?.flags.find((f) => f.key === key)
      : undefined;
    if (flag === undefined)
      return problem(404, 'not-found', 'Unknown flag', { instance, simulated: true });
    const before = ctx.state.flags.get(key) ?? flag.enabled;
    ctx.state.flags.set(key, req.body.enabled);
    recordActivity(ctx, req.actor, {
      action: 'feature_flag.set',
      entity: 'feature_flag',
      entityId: key,
      reason: req.body.reason,
      from: String(before),
      to: String(req.body.enabled),
    });
    return jsonResponse(200, { ...flag, enabled: req.body.enabled }, { simulated: true });
  },
});
