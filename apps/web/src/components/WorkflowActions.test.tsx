import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PHASE_3_TITLE } from '../lib/workflow.js';
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

  it('says None when the table lists no command, and waits for Phase 3 outside the preview', () => {
    const { rerender } = render(<CommandButtons options={[]} busy={false} onIssue={vi.fn()} />);
    expect(screen.getByText('None')).toBeInTheDocument();
    rerender(
      <CommandButtons
        options={[option()]}
        busy={false}
        context="Meridian Data Partners v1"
        onIssue={vi.fn()}
      />,
    );
    const button = screen.getByRole('button', {
      name: 'Deal team approve, Meridian Data Partners v1',
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', PHASE_3_TITLE);
  });

  it('in the preview, issues an allowed command and names the roles a blocked one needs', async () => {
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
    rerender(<ActionLogCard entries={entries} />);
    const items = within(screen.getByRole('list', { name: 'Actions this session' })).getAllByRole(
      'listitem',
    );
    expect(items.map((li) => li.textContent)).toEqual([
      'RefusedRefused: needs approver',
      'DonePrepared (audited)',
    ]);
  });

  it('explains the empty action log', () => {
    render(<ActionLogCard entries={[]} />);
    expect(screen.getByText('No actions yet')).toBeInTheDocument();
  });
});
