import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.js';
import {
  creditStatusTone,
  humanizeState,
  irrFlagHint,
  noticeStateTone,
  watchFlagLabel,
} from './labels.js';
import { isUnavailable, retryUnlessUnavailable, unavailable } from './unavailable.js';

describe('labels', () => {
  it('names every watch flag and falls back to the code for an unknown one', () => {
    expect(watchFlagLabel('leverage_above_max')).toBe('Leverage above limit');
    expect(watchFlagLabel('no_locked_valuation')).toBe('No Locked valuation');
    expect(watchFlagLabel('something_new')).toBe('Something new');
  });

  it('turns workflow states into words and tones', () => {
    expect(humanizeState('TicketDrafted')).toBe('Ticket drafted');
    expect(humanizeState('Reconciled')).toBe('Reconciled');
    expect(noticeStateTone('Reconciled')).toBe('good');
    expect(noticeStateTone('TicketApproved')).toBe('brand');
    expect(noticeStateTone('Unknown')).toBe('neutral');
  });

  it('tones covenant and payment codes', () => {
    expect(creditStatusTone('covenant_status.compliant')).toBe('good');
    expect(creditStatusTone('payment_status.current')).toBe('good');
    expect(creditStatusTone('covenant_status.breach')).toBe('bad');
    expect(creditStatusTone('covenant_status.waiver')).toBe('watch');
    expect(creditStatusTone(null)).toBe('neutral');
  });

  it('explains an IRR flag in plain words', () => {
    expect(irrFlagHint(null)).toBeUndefined();
    expect(irrFlagHint('short_period')).toBe('Not meaningful: held for less than the minimum period');
    expect(irrFlagHint('no_root')).toBe('Not calculable: no rate fits the cash flows');
    expect(irrFlagHint('other_flag')).toBe('Not calculable: other flag');
  });
});

const apiError = (status: number): ApiError =>
  new ApiError({
    type: 'https://portfolio-beach.example/problems/x',
    title: 'x',
    status,
    request_id: 'test',
  });

describe('unavailable', () => {
  it('explains a 403 and a 501, and treats anything else as a real error', () => {
    expect(unavailable(apiError(403), 'Capital activity')?.title).toBe(
      'Capital activity: not visible to your role',
    );
    expect(unavailable(apiError(501), 'Capital activity')?.title).toBe(
      'Capital activity: not available yet',
    );
    expect(unavailable(apiError(500), 'Capital activity')).toBeNull();
    expect(unavailable(new Error('network'), 'Capital activity')).toBeNull();
  });

  it('never retries a read that cannot change on a retry', () => {
    expect(isUnavailable(apiError(404))).toBe(true);
    expect(retryUnlessUnavailable(0, apiError(501))).toBe(false);
    expect(retryUnlessUnavailable(0, apiError(503))).toBe(true);
    expect(retryUnlessUnavailable(3, apiError(503))).toBe(false);
  });
});
