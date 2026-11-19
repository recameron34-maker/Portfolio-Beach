import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { auditPage, healthReady, wallList } from '@pb/contracts';
import { checkWords } from '../data-display.js';
import { AccessPage, AuditPage, HealthPage } from './Admin.js';
import { ROLE_ROWS } from './roles.js';
import {
  auditPageFixture,
  flagsFixture,
  healthReadyFixture,
  mockApi,
  mockUsersFixture,
  principalFixture,
  wallListFixture,
  withQueries,
} from '../assistants/test-support.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: unknown; to: string }) => (
    <a href={to}>{children as never}</a>
  ),
}));

const EM_DASH = String.fromCharCode(0x2014);

describe('audit trail page', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('parses its fixture with the contract', () => {
    expect(() => auditPage.parse(auditPageFixture())).not.toThrow();
  });

  it('lists events with time, actor, action, entity, truncated id, reason and request id', async () => {
    mockApi({ '/api/v1/audit/events': { body: auditPageFixture() } });
    render(withQueries(<AuditPage />));
    const table = await screen.findByRole('table', { name: 'Audit events' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('Jun 30, 2025 12:00:00 UTC');
    expect(rows[1]).toHaveTextContent('Admin One');
    expect(rows[1]).toHaveTextContent('flag.update');
    expect(rows[1]).toHaveTextContent('Enable the assistant for the demo');
    expect(rows[1]).toHaveTextContent('req-0042');
    expect(rows[2]).toHaveTextContent('system');
    const id = within(rows[2]!).getByTitle('10000000-0000-4000-8000-000000000031');
    expect(id).toHaveTextContent('10000000');
    expect(id.textContent).not.toContain('000000000031');
    expect(screen.getByTestId('audit-note')).toHaveTextContent(
      'The details payload and the before and after hashes are never shown here',
    );
    // The page cites no control number: that is for the build guide, not the reader.
    expect(screen.getByTestId('audit-note').textContent).not.toMatch(/SEC-\d/);
    expect(screen.getByRole('navigation', { name: 'Admin' })).toHaveTextContent('Audit trail');
  });

  it('shows an empty state when there are no events', async () => {
    mockApi({ '/api/v1/audit/events': { body: auditPageFixture({ items: [] }) } });
    render(withQueries(<AuditPage />));
    expect(await screen.findByTestId('audit-empty')).toHaveTextContent('No events yet');
  });

  it('says who can see the trail on 403', async () => {
    mockApi({ '/api/v1/audit/events': { status: 403, title: 'Forbidden' } });
    render(withQueries(<AuditPage />));
    expect(await screen.findByTestId('audit-unavailable')).toHaveTextContent(
      'The audit trail is available to operations, approvers, auditors and platform admins',
    );
  });
});

describe('access and walls page', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('parses its fixture with the contract', () => {
    expect(() => wallList.parse(wallListFixture())).not.toThrow();
  });

  it('renders a card per wall with members, records and the role table', async () => {
    mockApi({
      '/api/v1/walls': { body: wallListFixture() },
      '/api/v1/auth/me': { body: principalFixture() },
      '/api/v1/auth/mock-users': { body: mockUsersFixture() },
    });
    render(withQueries(<AccessPage />));
    const wall = await screen.findByTestId('wall-10000000-0000-4000-8000-000000000081');
    expect(wall).toHaveTextContent('Project Dune');
    expect(wall).toHaveTextContent('Restricted: named members only.');
    expect(within(wall).getByText('Deal Three')).toBeVisible();
    expect(within(wall).getByText('Head One')).toBeVisible();
    expect(within(wall).getByText('Dune Logistics')).toBeVisible();
    // A record the reader may not see is counted, never named or repeated.
    expect(within(wall).getByText(', 1 record you cannot see')).toBeVisible();
    expect(wall).toHaveTextContent('RecordsDune Logistics, 1 record you cannot see');
    // Members and records as plain comma-separated names, not tags.
    expect(wall).toHaveTextContent('MembersDeal Three, Head One');
    expect(wall.querySelector('.pb-badge, .pb-key')).toBeNull();

    const table = screen.getByRole('table', { name: 'What each role sees' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(ROLE_ROWS.length + 1);
    const roleNames = within(table)
      .getAllByRole('rowheader')
      .map((h) => h.textContent ?? '');
    for (const r of ROLE_ROWS) {
      // Each role in words; its code is not shown.
      expect(roleNames.some((name) => name.startsWith(r.label))).toBe(true);
      if (r.role.includes('_')) expect(table).not.toHaveTextContent(r.role);
      expect(r.sees.includes(EM_DASH)).toBe(false);
      expect(r.sees.split(/[.!?]\s/).length).toBeLessThanOrEqual(2);
    }
    const ops = within(table).getByText('Operations').closest('tr')!;
    expect(await within(ops).findByText('Your role')).toBeVisible();
    // The users arrive from their own read, so the names may land a moment after the role.
    await waitFor(() => expect(ops).toHaveTextContent('Prototype users: Ops One, Ops Two'));
    expect(screen.getByTestId('role-source')).toHaveTextContent(
      'every role is tested against every table',
    );
  });

  it('says when no wall is visible', async () => {
    mockApi({
      '/api/v1/walls': { body: wallListFixture({ walls: [] }) },
      '/api/v1/auth/me': { body: principalFixture({ mockIdentity: false }) },
    });
    render(withQueries(<AccessPage />));
    expect(await screen.findByTestId('walls-empty')).toHaveTextContent(
      'No walls are visible to you',
    );
    expect(screen.getByRole('table', { name: 'What each role sees' })).toBeVisible();
  });
});

describe('integration health page', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('parses its fixture with the contract', () => {
    expect(() => healthReady.parse(healthReadyFixture())).not.toThrow();
  });

  it('shows the checks with words, the version and the adapter kill switches', async () => {
    mockApi({
      '/health/ready': { body: healthReadyFixture() },
      '/api/v1/flags': { body: flagsFixture(false) },
    });
    render(withQueries(<HealthPage />));
    const checks = await screen.findByRole('table', { name: 'Readiness checks' });
    expect(within(checks).getAllByText('OK')).toHaveLength(2);
    expect(within(checks).getByText('Degraded')).toBeVisible();
    expect(checks).toHaveTextContent('adapter disabled by kill switch');
    // Each check named in words; the API's codes are not shown, nor is a "no detail" filler.
    const names = within(checks)
      .getAllByRole('rowheader')
      .map((h) => h.textContent);
    expect(names).toEqual(['Database', 'Mail', 'Documents']);
    expect(checks).not.toHaveTextContent('no detail');
    expect(screen.getByText('version 0.1.0')).toBeVisible();
    expect(screen.getAllByText('Degraded').length).toBeGreaterThanOrEqual(2);

    const switches = await screen.findByRole('table', { name: 'Kill switches' });
    const rows = within(switches).getAllByRole('row');
    expect(rows).toHaveLength(4);
    // Each switch by its description; no key, and no AI switch (those are under Flags).
    expect(switches).not.toHaveTextContent('Kill switch for Ask Portfolio Beach');
    expect(switches).not.toHaveTextContent('adapter.');
    expect(rows[1]).toHaveTextContent('Mail and calendar capture adapter');
    expect(within(rows[1]!).getByText('Off')).toBeVisible();
    expect(within(rows[2]!).getByText('On')).toBeVisible();
  });

  it('names every check the API reports in words, and any new one from its code', () => {
    expect(checkWords('identity.mock')).toBe('Sign-in, mock identity');
    expect(checkWords('drop.local_folder.ops_drop')).toBe('Operations workbook drop folder');
    expect(checkWords('ai.mock')).toBe('AI model, mock client');
    expect(checkWords('mail.graph_delegated')).toBe('Mail graph delegated');
  });

  it('shows an empty state when readiness is unavailable', async () => {
    mockApi({
      '/health/ready': { status: 503, title: 'Service unavailable' },
      '/api/v1/flags': { body: flagsFixture(false) },
    });
    render(withQueries(<HealthPage />));
    expect(await screen.findByTestId('health-unavailable')).toHaveTextContent(
      'Readiness is unavailable',
    );
    expect(await screen.findByRole('table', { name: 'Kill switches' })).toBeVisible();
  });
});
