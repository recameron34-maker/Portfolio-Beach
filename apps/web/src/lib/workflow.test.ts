import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { blockedTitle, isReason, resultSuffix, useActionLog } from './workflow.js';

const env = vi.hoisted(() => ({ previewMode: false }));
vi.mock('../app/env.js', () => env);

describe('workflow action rules (docs/18)', () => {
  afterEach(() => {
    env.previewMode = false;
  });

  it('offers an allowed command in every build and asks for at least three characters of reason', () => {
    expect(blockedTitle({ allowed: true, roles: ['operations'] })).toBeNull();
    expect(isReason('ab ')).toBe(false);
    expect(isReason(' abc ')).toBe(true);
    expect(resultSuffix()).toBe('(audited)');
  });

  it('names the roles a blocked command needs, or the page wording, in every build', () => {
    expect(blockedTitle({ allowed: false, roles: ['approver', 'deal_team'] })).toBe(
      'Needs approver or deal team',
    );
    expect(blockedTitle({ allowed: false, roles: [] }, 'Service accounts only')).toBe(
      'Service accounts only',
    );
    env.previewMode = true;
    expect(blockedTitle({ allowed: true, roles: ['operations'] })).toBeNull();
    expect(blockedTitle({ allowed: false, roles: ['approver'] })).toBe('Needs approver');
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
