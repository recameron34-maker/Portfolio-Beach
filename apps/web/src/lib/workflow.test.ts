import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { blockedTitle, isReason, PHASE_3_TITLE, resultSuffix, useActionLog } from './workflow.js';

const env = vi.hoisted(() => ({ previewMode: false }));
vi.mock('../app/env.js', () => env);

describe('workflow action rules (docs/18)', () => {
  afterEach(() => {
    env.previewMode = false;
  });

  it('keeps every action disabled outside the preview and asks for at least three characters of reason', () => {
    expect(blockedTitle({ allowed: true, roles: ['operations'] })).toBe(PHASE_3_TITLE);
    expect(blockedTitle({ allowed: false, roles: ['approver'] })).toBe(PHASE_3_TITLE);
    expect(isReason('ab ')).toBe(false);
    expect(isReason(' abc ')).toBe(true);
    expect(resultSuffix()).toBe('(audited)');
  });

  it('in the preview, names the roles a command needs or the page wording, and marks results simulated', () => {
    env.previewMode = true;
    expect(blockedTitle({ allowed: true, roles: ['operations'] })).toBeNull();
    expect(blockedTitle({ allowed: false, roles: ['approver', 'deal_team'] })).toBe(
      'Needs approver or deal team',
    );
    expect(blockedTitle({ allowed: false, roles: [] }, 'Service accounts only')).toBe(
      'Service accounts only',
    );
    expect(resultSuffix()).toBe('(simulated in this preview, not audited)');
  });

  it('keeps the action log newest first with the latest result on top', () => {
    const { result } = renderHook(() => useActionLog());
    expect(result.current.latest).toBeNull();
    act(() => result.current.record('good', 'Prepared'));
    act(() => result.current.record('bad', 'Refused'));
    expect(result.current.entries.map((e) => [e.id, e.tone, e.text])).toEqual([
      [2, 'bad', 'Refused'],
      [1, 'good', 'Prepared'],
    ]);
    expect(result.current.latest?.text).toBe('Refused');
  });
});
