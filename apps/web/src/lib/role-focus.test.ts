import { describe, expect, it } from 'vitest';
import { appRole } from '@pb/contracts';
import { DATA_LINKS, NAV_GROUPS } from '../app/nav.js';
import {
  focusOf,
  HOME_SECTIONS,
  KNOWN_PATHS,
  navFor,
  orderByFocus,
  ROLE_FOCUS,
  TAB_ROWS,
  tabsFor,
} from './role-focus.js';

const SIGN_IN_ROLES = appRole.options.filter((role) => role !== 'service');

describe('the role focus configuration (config/role_focus.json)', () => {
  it('gives every sign-in role a focus, and ranks each of them once', () => {
    expect(Object.keys(ROLE_FOCUS.roles).sort()).toEqual([...SIGN_IN_ROLES].sort());
    expect([...ROLE_FOCUS.precedence].sort()).toEqual([...SIGN_IN_ROLES].sort());
  });

  it('names only pages that exist, and never Home, which always comes first', () => {
    const navigable = new Set([...NAV_GROUPS, ...DATA_LINKS].map((item) => item.to));
    for (const [role, focus] of Object.entries(ROLE_FOCUS.roles)) {
      expect(new Set(focus.nav).size, role).toBe(focus.nav.length);
      for (const to of focus.nav) {
        expect(navigable.has(to), `${role} nav ${to}`).toBe(true);
        expect(to, role).not.toBe('/');
      }
      for (const link of focus.work)
        expect(KNOWN_PATHS.has(link.to), `${role} work ${link.to}`).toBe(true);
      expect(new Set(focus.work.map((link) => link.to)).size, role).toBe(focus.work.length);
      for (const [from, to] of Object.entries(focus.landing)) {
        expect(navigable.has(from), `${role} landing ${from}`).toBe(true);
        expect(KNOWN_PATHS.has(to), `${role} landing ${to}`).toBe(true);
      }
    }
  });

  it('orders the tabs of a real tab row, each tab once', () => {
    for (const [role, focus] of Object.entries(ROLE_FOCUS.roles))
      for (const [area, order] of Object.entries(focus.tabs)) {
        const row = TAB_ROWS[area];
        expect(row, `${role} ${area}`).toBeDefined();
        expect(new Set(order).size, `${role} ${area}`).toBe(order.length);
        for (const to of order)
          expect(
            row?.some((tab) => tab.to === to),
            `${role} ${area} ${to}`,
          ).toBe(true);
      }
  });

  it('lists the work first on every home page, and only sections the page has', () => {
    for (const [role, focus] of Object.entries(ROLE_FOCUS.roles)) {
      expect(focus.home[0], role).toBe('work');
      expect(new Set(focus.home).size, role).toBe(focus.home.length);
      for (const section of focus.home) expect(HOME_SECTIONS, role).toContain(section);
    }
  });

  it('says what a role does and what each link is for, in a sentence a person would write', () => {
    for (const [role, focus] of Object.entries(ROLE_FOCUS.roles)) {
      expect(focus.does, role).toMatch(/^[A-Z].*\.$/);
      for (const link of focus.work) {
        expect(link.what.length, `${role} ${link.label}`).toBeGreaterThan(12);
        expect(link.what, `${role} ${link.label}`).not.toMatch(/\.$/);
      }
    }
  });
});

describe('focusOf', () => {
  it('takes the first configured role the user holds, and none for the service account', () => {
    expect(focusOf(['operations'])?.role).toBe('operations');
    expect(focusOf(['viewer', 'approver'])?.role).toBe('approver');
    expect(focusOf(['deal_team', 'operations'])?.role).toBe('operations');
    expect(focusOf(['service'])).toBeNull();
    expect(focusOf([])).toBeNull();
    expect(focusOf(undefined)).toBeNull();
  });
});

describe('navFor', () => {
  const paths = (links: { to: string }[]): string[] => links.map((link) => link.to);

  it('keeps the usual order when there is no focus', () => {
    const nav = navFor(null);
    expect(nav.area).toBeNull();
    expect(paths(nav.focus)).toEqual(NAV_GROUPS.map((g) => g.to));
    expect(nav.more).toEqual([]);
    expect(paths(nav.data)).toEqual(DATA_LINKS.map((g) => g.to));
  });

  it.each(SIGN_IN_ROLES)('puts the areas of %s first and leaves nothing out', (role) => {
    const focus = focusOf([role]);
    if (focus === null) throw new Error(`${role} has a focus`);
    const nav = navFor(focus);
    expect(nav.area).toBe(focus.area);
    expect(paths(nav.focus)).toEqual(['/', ...focus.nav]);
    const all = [...nav.focus, ...nav.more, ...nav.data];
    expect(paths(all).sort()).toEqual([...NAV_GROUPS, ...DATA_LINKS].map((g) => g.to).sort());
    expect(new Set(paths(all)).size).toBe(all.length);
    // The rest keeps the usual order.
    expect(paths(nav.more)).toEqual(
      NAV_GROUPS.map((g) => g.to).filter((to) => to !== '/' && !focus.nav.includes(to)),
    );
  });

  it('brings the Data links a role works in into its own group', () => {
    const nav = navFor(focusOf(['operations']));
    expect(paths(nav.focus)).toContain('/data/intake');
    expect(paths(nav.data)).not.toContain('/data/intake');
    expect(paths(nav.data)).toContain('/data/dictionary');
  });

  it('sends the auditor from the Admin link to the audit trail, under the same name', () => {
    const admin = navFor(focusOf(['auditor'])).focus.find((link) => link.to === '/admin/flags');
    expect(admin).toEqual({ to: '/admin/flags', label: 'Admin', href: '/admin/audit' });
    const other = navFor(focusOf(['platform_admin'])).focus.find(
      (link) => link.to === '/admin/flags',
    );
    expect(other?.href).toBe('/admin/flags');
  });
});

describe('tabsFor and orderByFocus', () => {
  const row = [{ to: '/a' }, { to: '/a/b' }, { to: '/a/c' }, { to: '/a/d' }];

  it('puts the listed items first and keeps the rest in their usual order', () => {
    expect(orderByFocus(row, ['/a/c', '/a']).map((t) => t.to)).toEqual([
      '/a/c',
      '/a',
      '/a/b',
      '/a/d',
    ]);
    expect(orderByFocus(row, ['/nowhere']).map((t) => t.to)).toEqual(row.map((t) => t.to));
  });

  it('orders the row a configured order belongs to, and leaves every other row alone', () => {
    const operations = focusOf(['operations']);
    const capital = TAB_ROWS['/capital-activity'] ?? [];
    expect(tabsFor(capital, operations).map((t) => t.to)).toEqual([
      '/capital-activity',
      '/capital-activity/tickets',
      '/capital-activity/wires',
      '/capital-activity/commitments',
    ]);
    const analytics = TAB_ROWS['/analytics'] ?? [];
    expect(tabsFor(analytics, operations)).toEqual([...analytics]);
    expect(tabsFor(capital, null)).toEqual([...capital]);
    expect(tabsFor(row, operations)).toEqual(row);
  });
});

describe('the client packages in the role focus (decision 0024)', () => {
  const reporting = TAB_ROWS['/reporting'] ?? [];
  const PACKAGES = '/reporting/packages';

  it('opens Reporting on the packages for the two roles that move them through the gate', () => {
    for (const role of ['investor_relations', 'approver'])
      expect(
        tabsFor(reporting, focusOf([role])).map((t) => t.to),
        role,
      ).toEqual([PACKAGES, '/reporting', '/reporting/clients', '/reporting/disclosures']);
    // Every other role keeps the usual order: the weekly report, then the packages.
    for (const role of ['operations', 'deal_team', 'auditor', 'viewer', 'platform_admin'])
      expect(
        tabsFor(reporting, focusOf([role])).map((t) => t.to),
        role,
      ).toEqual(['/reporting', PACKAGES, '/reporting/clients', '/reporting/disclosures']);
  });

  it('lists them first in the work of investor relations, and after the trade tickets for an approver', () => {
    expect(ROLE_FOCUS.roles.investor_relations?.work[0]).toEqual({
      to: PACKAGES,
      label: 'Client packages',
      what: "Start a client's quarterly package, run the checks and release it",
    });
    const approver = ROLE_FOCUS.roles.approver?.work ?? [];
    const at = approver.findIndex((link) => link.to === PACKAGES);
    expect(approver[at - 1]?.to).toBe('/capital-activity/tickets');
    expect(approver[at]).toEqual({
      to: PACKAGES,
      label: 'Client packages',
      what: 'Decide on failed checks and approve the packages in review',
    });
  });

  it('gives the roles that only read packages no work link: they use the Reporting tab', () => {
    for (const role of ['operations', 'auditor', 'deal_team', 'viewer', 'platform_admin'])
      expect(
        ROLE_FOCUS.roles[role]?.work.some((link) => link.to === PACKAGES),
        role,
      ).toBe(false);
    // No landing changes: the Reporting link still opens the weekly report for every role.
    for (const [role, focus] of Object.entries(ROLE_FOCUS.roles))
      expect(focus.landing['/reporting'], role).toBeUndefined();
  });
});
