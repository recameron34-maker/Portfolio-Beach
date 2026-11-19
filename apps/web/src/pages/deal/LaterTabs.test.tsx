import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TasksTab } from './LaterTabs.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const EM_DASH = String.fromCharCode(0x2014);

describe('tabs that arrive in later phases', () => {
  afterEach(() => cleanup());

  it('Tasks says it is not built yet and what it will bring, in the workspace frame, without naming a build phase', () => {
    render(<TasksTab />);
    // The workspace header is the page's heading: the tab adds no second one.
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(screen.getByText('Not built yet')).toBeInTheDocument();
    expect(
      screen.getByText(
        "This tab will list the position's tasks from the task tool, with owners, due dates and reminders, and the approvals waiting on you.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/is planned for a later release/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Phase \d|\bM\d{1,2}\b/);
    expect(document.body.textContent).not.toContain(EM_DASH);
  });
});
