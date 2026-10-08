import { useState } from 'react';
import type { z } from 'zod';
import type { mockUser } from '@pb/contracts';
import { previewMode } from '../app/env.js';

/*
 * Who the preview walkthroughs name, and whether Home shows them (components/PreviewGuide.tsx).
 * Names always come from the mock user list, never from this file: a step picks a user by role,
 * and the wall member by the sign-in id the synthetic dataset seats on the information wall.
 */

type MockUser = z.infer<typeof mockUser>;
type Role = MockUser['roles'][number];

/** tools/synthetic seats this deal team user on the wall around the walled deal (scenario walled_deal). */
export const WALL_MEMBER_ID = 'deal.three';

/** The role in words, and how a step names someone in it while the list loads or names no one. */
const ROLES: Readonly<Record<Role, { word: string; nobody: string }>> = {
  viewer: { word: 'viewer', nobody: 'the viewer' },
  deal_team: { word: 'deal team', nobody: 'a deal team user' },
  operations: { word: 'operations', nobody: 'an operations user' },
  approver: { word: 'approver', nobody: 'the approver' },
  investor_relations: { word: 'investor relations', nobody: 'an investor relations user' },
  platform_admin: { word: 'platform admin', nobody: 'the platform admin' },
  auditor: { word: 'auditor', nobody: 'the auditor' },
  service: { word: 'service', nobody: 'a service account' },
};

/** "Avery Mbeki (operations)", or "an operations user" while the list loads or names no one. */
function person(user: MockUser | undefined, role: Role): string {
  const { word, nobody } = ROLES[role];
  return user === undefined ? nobody : `${user.displayName} (${word})`;
}

export interface GuidePeople {
  viewer: string;
  wallMember: string;
  operations: string;
  dealTeam: string;
  approver: string;
  investorRelations: string;
  admin: string;
}

/** The people the walkthroughs name: the first user per role in the list's own order. */
export function guidePeople(users: readonly MockUser[]): GuidePeople {
  const first = (role: Role): MockUser | undefined => users.find((u) => u.roles.includes(role));
  const wall = users.find((u) => u.externalId === WALL_MEMBER_ID && u.roles.includes('deal_team'));
  // The approval step names a deal team user who is not the wall member, so each person reads once.
  const approving = users.find((u) => u.roles.includes('deal_team') && u !== wall);
  return {
    viewer: person(first('viewer'), 'viewer'),
    wallMember:
      wall === undefined
        ? 'the deal team member on the information wall'
        : person(wall, 'deal_team'),
    operations: person(first('operations'), 'operations'),
    dealTeam: person(approving ?? first('deal_team'), 'deal_team'),
    approver: person(first('approver'), 'approver'),
    investorRelations: person(first('investor_relations'), 'investor_relations'),
    admin: person(first('platform_admin'), 'platform_admin'),
  };
}

const HIDDEN_KEY = 'pb.previewGuide';

/** Whether this tab hid the guide; false when storage is blocked, so the guide shows. */
function readHidden(): boolean {
  try {
    return globalThis.sessionStorage.getItem(HIDDEN_KEY) === 'hidden';
  } catch {
    return false;
  }
}

function writeHidden(hidden: boolean): void {
  try {
    if (hidden) globalThis.sessionStorage.setItem(HIDDEN_KEY, 'hidden');
    else globalThis.sessionStorage.removeItem(HIDDEN_KEY);
  } catch {
    // Storage blocked: the choice holds in memory until the page reloads.
  }
}

export interface PreviewGuideState {
  /** The guide shows (preview builds only). */
  open: boolean;
  /** The reviewer hid it in this tab; Home then offers to show it again. */
  hidden: boolean;
  /**
   * The control that takes keyboard focus after a hide or a show, so focus is never dropped:
   * the show button once the guide is hidden, the hide button once it is back. Null on arrival.
   */
  focus: 'show' | 'hide' | null;
  hide: () => void;
  show: () => void;
}

/** Home keeps the guide open until the reviewer hides it; the choice lasts for this tab. */
export function usePreviewGuide(): PreviewGuideState {
  const [hidden, setHidden] = useState(readHidden);
  const [focus, setFocus] = useState<'show' | 'hide' | null>(null);
  return {
    open: previewMode && !hidden,
    hidden: previewMode && hidden,
    focus,
    hide: () => {
      writeHidden(true);
      setHidden(true);
      setFocus('show');
    },
    show: () => {
      writeHidden(false);
      setHidden(false);
      setFocus('hide');
    },
  };
}
