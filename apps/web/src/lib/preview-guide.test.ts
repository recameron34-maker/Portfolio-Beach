import { describe, expect, it } from 'vitest';
import { guidePeople, WALL_MEMBER_ID } from './preview-guide.js';

describe('who the preview walkthroughs name', () => {
  it('takes the first user per role and the seated wall member, in the list order', () => {
    const people = guidePeople([
      { externalId: 'deal.one', displayName: 'Dana Deal', roles: ['deal_team'] },
      { externalId: WALL_MEMBER_ID, displayName: 'Wade Wall', roles: ['deal_team'] },
      { externalId: 'ops.two', displayName: 'Otto Ops', roles: ['operations'] },
      { externalId: 'ops.one', displayName: 'Opal Ops', roles: ['operations'] },
      { externalId: 'viewer.one', displayName: 'Vera Viewer', roles: ['viewer'] },
      { externalId: 'head.one', displayName: 'Ada Approver', roles: ['approver'] },
      { externalId: 'ir.two', displayName: 'Ira Relations', roles: ['investor_relations'] },
      { externalId: 'admin.one', displayName: 'Abe Admin', roles: ['platform_admin'] },
    ]);
    expect(people).toEqual({
      viewer: 'Vera Viewer (viewer)',
      wallMember: 'Wade Wall (deal team)',
      operations: 'Otto Ops (operations)',
      dealTeam: 'Dana Deal (deal team)',
      approver: 'Ada Approver (approver)',
      investorRelations: 'Ira Relations (investor relations)',
      admin: 'Abe Admin (platform admin)',
    });
  });

  it('never names the wall member as the approving deal team user when another exists', () => {
    const people = guidePeople([
      { externalId: WALL_MEMBER_ID, displayName: 'Wade Wall', roles: ['deal_team'] },
      { externalId: 'deal.two', displayName: 'Dee Two', roles: ['deal_team'] },
    ]);
    expect(people.wallMember).toBe('Wade Wall (deal team)');
    expect(people.dealTeam).toBe('Dee Two (deal team)');
  });

  it('describes the role in words while the list is loading or names no one', () => {
    expect(guidePeople([])).toEqual({
      viewer: 'the viewer',
      wallMember: 'the deal team member on the information wall',
      operations: 'an operations user',
      dealTeam: 'a deal team user',
      approver: 'the approver',
      investorRelations: 'an investor relations user',
      admin: 'the platform admin',
    });
  });
});
