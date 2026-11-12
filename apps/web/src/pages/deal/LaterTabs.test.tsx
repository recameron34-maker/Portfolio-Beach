import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { TasksTab } from './LaterTabs.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const EM_DASH = String.fromCharCode(0x2014);

describe('tabs that arrive in later phases', () => {
  afterEach(() => cleanup());

  it.each<[string, () => ReactNode, string, RegExp]>([
    ['Tasks', TasksTab, 'Tasks and approvals for this position', /task tool.*Approvals waiting/],
  ])(
    '%s says it is not built yet and what it will bring, without naming a build phase',
    (title, Tab, summary, says) => {
      render(<Tab />);
      expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
      expect(screen.getByText(summary)).toBeInTheDocument();
      expect(screen.getByText('Not built yet')).toBeInTheDocument();
      expect(screen.getByText(`${title} is planned for a later release.`)).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/Phase \d|\bM\d{1,2}\b/);
      const prose = document.querySelector('.pb-prose');
      expect(prose?.textContent).toMatch(says);
      // Two sentences on what arrives.
      expect(prose?.textContent?.split('. ').length).toBe(2);
      expect(document.body.textContent).not.toContain(EM_DASH);
    },
  );
});
