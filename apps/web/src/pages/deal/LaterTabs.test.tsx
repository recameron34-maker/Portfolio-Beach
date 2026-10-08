import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { ClosingTab, DiligenceTab, DocumentsTab, TasksTab } from './LaterTabs.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const EM_DASH = String.fromCharCode(0x2014);

describe('tabs that arrive in later phases', () => {
  afterEach(() => cleanup());

  it.each<[string, () => ReactNode, string, string, RegExp]>([
    ['Diligence', DiligenceTab, 'Phase 5', 'M7 diligence and IC', /IC memo sections.*AI draft/],
    ['Closing', ClosingTab, 'Phase 3', 'M8 closing', /closing checklist.*Wire instructions/],
    [
      'Documents',
      DocumentsTab,
      'Phase 2',
      'M3 document hub, M4 extraction',
      /AI tagging.*expected-document tracker/,
    ],
    ['Tasks', TasksTab, 'Phase 6', 'M15 tasks and approvals', /task tool.*Approvals waiting/],
  ])(
    '%s says which phase and module bring it, and what they bring',
    (title, Tab, phase, modules, says) => {
      render(<Tab />);
      expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
      expect(screen.getByText(`${phase}: ${modules}`)).toBeInTheDocument();
      expect(screen.getByText(`${title} arrives in ${phase}`)).toBeInTheDocument();
      const prose = document.querySelector('.pb-prose');
      expect(prose?.textContent).toMatch(says);
      // Two sentences on what arrives.
      expect(prose?.textContent?.split('. ').length).toBe(2);
      expect(document.body.textContent).not.toContain(EM_DASH);
    },
  );
});
