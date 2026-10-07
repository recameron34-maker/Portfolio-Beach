import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { investmentDetail, taxonomy, wallList } from '@pb/contracts';
import type { WallList } from '@pb/contracts';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

describe('taxonomy and walls', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('groups every taxonomy term by domain, alphabetically, codes keeping their prefix', async () => {
    const res = await h.http().get('/api/v1/taxonomy').set('authorization', h.as('viewer'));
    expect(res.status).toBe(200);
    const t = taxonomy.parse(res.body);
    const domains = t.domains.map((d) => d.domain);
    expect(domains).toEqual([...domains].sort());
    const counts = await h.runtime.db.query<{ domains: number; terms: number }>(
      'select count(distinct domain)::int as domains, count(*)::int as terms from core.taxonomy_term',
    );
    expect(domains.length).toBe(counts[0]!.domains);
    expect(t.domains.reduce((n, d) => n + d.terms.length, 0)).toBe(counts[0]!.terms);
    for (const d of t.domains) {
      expect(d.terms.length).toBeGreaterThan(0);
      for (const term of d.terms) {
        expect(term.code.startsWith(`${d.domain}.`)).toBe(true);
        expect(term.label.length).toBeGreaterThan(0);
      }
      const keys = d.terms.map((x) => `${String(x.sortOrder).padStart(6, '0')}|${x.code}`);
      expect(keys).toEqual([...keys].sort());
    }
    const dealTypes = t.domains.find((d) => d.domain === 'deal_type')!.terms.map((x) => x.code);
    expect(dealTypes).toContain('deal_type.private_credit');
    expect(dealTypes).toContain('deal_type.co_invest_equity');
    // Reference data: the same for every role.
    const asAuditor = taxonomy.parse(
      (await h.http().get('/api/v1/taxonomy').set('authorization', h.as('auditor')).expect(200))
        .body,
    );
    expect(asAuditor).toEqual(t);
  });

  it('shows walls to approvers, admins and members only, labelling records the caller can see', async () => {
    const seeded = h.dataset.walls[0]!;
    const walledId = h.dataset.scenarios.walled_deal![0]!;
    const get = async (who: string): Promise<WallList> =>
      wallList.parse(
        (await h.http().get('/api/v1/walls').set('authorization', h.as(who)).expect(200)).body,
      );
    const dealThree = h.dataset.users.find((u) => u.externalId === 'deal.three')!;
    const headOne = h.dataset.users.find((u) => u.externalId === 'head.one')!;
    const detail = investmentDetail.parse(
      (
        await h
          .http()
          .get(`/api/v1/investments/${walledId}`)
          .set('authorization', h.as('deal.three'))
          .expect(200)
      ).body,
    );
    const label = `${detail.investmentNumber} ${detail.companyName}`;
    expect(detail.investmentNumber).toBe('INV-0010');

    // Not a member and not an approver or admin: nothing, never a 403.
    expect((await get('viewer.one')).walls).toEqual([]);
    expect((await get('operations')).walls).toEqual([]);
    expect((await get('auditor')).walls).toEqual([]);

    // A member sees the wall and its record with the label; RLS shows a plain member their own membership row only.
    const member = await get('deal.three');
    expect(member.walls.length).toBe(1);
    expect(member.walls[0]!.id).toBe(seeded.id);
    expect(member.walls[0]!.name).toBe('Project Breakwater');
    expect(member.walls[0]!.description).toBe(seeded.description);
    expect(member.walls[0]!.members).toEqual([
      { userId: dealThree.id, displayName: dealThree.displayName },
    ]);
    expect(member.walls[0]!.records).toEqual([{ entity: 'investment', entityId: walledId, label }]);

    // The approver is also a member: every membership row and the label.
    const approver = await get('head.one');
    expect(approver.walls.length).toBe(1);
    expect(approver.walls[0]!.members.map((m) => m.userId).sort()).toEqual(
      [...seeded.memberUserIds].sort(),
    );
    expect(approver.walls[0]!.members.map((m) => m.userId)).toContain(headOne.id);
    expect(approver.walls[0]!.records[0]!.label).toBe(label);

    // The platform admin manages the wall but is not behind it: full roster, record label null.
    const admin = await get('admin.one');
    expect(admin.walls.length).toBe(1);
    expect(admin.walls[0]!.members.map((m) => m.userId).sort()).toEqual(
      [...seeded.memberUserIds].sort(),
    );
    const names = admin.walls[0]!.members.map((m) => m.displayName);
    expect(names).toEqual([...names].sort());
    expect(admin.walls[0]!.records).toEqual([
      { entity: 'investment', entityId: walledId, label: null },
    ]);
  });
});
