import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@fluentui/react-components';
import type { CommandOption } from '../lib/states.js';
import { ActionLogCard, ActionStatus, CommandButtons, ReasonDialog } from './WorkflowActions.js';

const env = vi.hoisted(() => ({ previewMode: false }));
vi.mock('../app/env.js', () => env);

type Option = CommandOption<string, string>;

const option = (overrides: Partial<Option> = {}): Option => ({
  command: 'dealTeamApprove',
  to: 'DealTeamApproved',
  roles: ['deal_team'],
  allowed: true,
  needsReason: false,
  note: undefined,
  ...overrides,
});

describe('workflow action pieces', () => {
  afterEach(() => {
    cleanup();
    env.previewMode = false;
  });

  it('leaves the cell blank to the eye when the table lists no command, and offers an allowed one in every build', async () => {
    const onIssue = vi.fn();
    const { rerender } = render(<CommandButtons options={[]} busy={false} onIssue={vi.fn()} />);
    expect(screen.getByText('No actions')).toHaveClass('pb-visually-hidden');
    expect(screen.queryByText('None')).toBeNull();
    rerender(
      <CommandButtons
        options={[option()]}
        busy={false}
        context="Meridian Data Partners v1"
        onIssue={onIssue}
      />,
    );
    const button = screen.getByRole('button', {
      name: 'Deal team approve, Meridian Data Partners v1',
    });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute('title');
    await userEvent.click(button);
    expect(onIssue).toHaveBeenCalledWith(expect.objectContaining({ command: 'dealTeamApprove' }));
  });

  it('in the preview too, issues an allowed command and names the roles a blocked one needs', async () => {
    env.previewMode = true;
    const onIssue = vi.fn();
    render(
      <CommandButtons
        options={[
          option(),
          option({ command: 'sendBack', to: 'Draft', roles: ['approver'], allowed: false }),
        ]}
        busy={false}
        onIssue={onIssue}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Deal team approve' }));
    expect(onIssue).toHaveBeenCalledWith(expect.objectContaining({ command: 'dealTeamApprove' }));
    const blocked = screen.getByRole('button', { name: 'Send back' });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAttribute('title', 'Needs approver');
  });

  it('leads with the primary command and, when asked, says under the buttons why one is blocked', () => {
    render(
      <CommandButtons
        options={[
          option(),
          option({ command: 'sendBack', to: 'Draft', roles: ['approver'], allowed: false }),
          option({ command: 'reopen', to: 'Draft', roles: ['approver'], allowed: false }),
        ]}
        busy={false}
        primary="dealTeamApprove"
        showBlockedReason
        notAllowedTitle={(o) =>
          o.command === 'reopen' ? 'Only a Locked version reopens' : undefined
        }
        onIssue={vi.fn()}
      />,
    );
    // Fluent's classes are hashed: the lead command looks exactly as a primary button does.
    render(
      <Button size="small" appearance="primary">
        Reference
      </Button>,
    );
    const approve = screen.getByRole('button', { name: 'Deal team approve' });
    expect(approve.className).toBe(screen.getByRole('button', { name: 'Reference' }).className);
    expect(approve).not.toHaveAttribute('aria-describedby');
    const blocked = screen.getByRole('button', { name: 'Send back' });
    expect(blocked).toHaveAttribute('title', 'Needs approver');
    expect(blocked).toHaveAccessibleDescription('Needs approver');
    expect(screen.getByText('Needs approver')).toBeVisible();
    // Each blocked button points to its own reason, one line each.
    expect(screen.getByRole('button', { name: 'Reopen' })).toHaveAccessibleDescription(
      'Only a Locked version reopens',
    );
    expect(screen.getByText('Only a Locked version reopens')).toBeVisible();
  });

  it('shows no blocked reason unless the page asks for it', () => {
    render(
      <CommandButtons
        options={[option({ allowed: false, roles: ['approver'] })]}
        busy={false}
        onIssue={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Deal team approve' })).not.toHaveAttribute(
      'aria-describedby',
    );
    expect(screen.queryByText('Needs approver')).toBeNull();
  });

  it('asks for a reason of at least three characters before sending it, trimmed', async () => {
    const onSubmit = vi.fn();
    render(
      <ReasonDialog
        title="Reopen"
        subject="Meridian Data Partners, Jun 30, 2025 v1"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Reopen' });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Reason/ }), '  restated  ');
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith('restated');
  });

  it('shows the latest result in the status region and every result newest first', () => {
    const entries = [
      { id: 2, tone: 'bad' as const, text: 'Refused: needs approver' },
      { id: 1, tone: 'good' as const, text: 'Prepared (audited)' },
    ];
    const { rerender } = render(<ActionStatus latest={null} testId="status" />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    rerender(<ActionStatus latest={entries[0] ?? null} testId="status" />);
    expect(screen.getByRole('status')).toHaveTextContent('Refused: needs approver');
    // The sentence alone in a paragraph that carries its tone: the dot is the stylesheet's.
    expect(screen.getByText('Refused: needs approver')).toHaveClass('pb-notice', 'pb-notice-bad');
    rerender(<ActionStatus latest={entries[1] ?? null} testId="status" />);
    expect(screen.getByText('Prepared (audited)')).toHaveClass('pb-notice', 'pb-notice-good');
    rerender(<ActionLogCard entries={entries} />);
    const items = within(screen.getByRole('list', { name: 'Actions this session' })).getAllByRole(
      'listitem',
    );
    expect(items.map((li) => li.textContent)).toEqual([
      'RefusedRefused: needs approver',
      'DonePrepared (audited)',
    ]);
  });

  it('keeps the empty action log to one quiet line under its heading', () => {
    render(<ActionLogCard entries={[]} />);
    const log = screen.getByTestId('action-log');
    expect(within(log).getByRole('heading', { name: 'Actions this session' })).toBeVisible();
    expect(screen.getByText('No actions yet')).toHaveClass('pb-meta');
    expect(log.querySelector('.pb-empty')).toBeNull();
  });
});
