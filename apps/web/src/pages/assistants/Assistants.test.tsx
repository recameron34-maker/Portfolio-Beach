import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MOCK_ASSISTANT_LINE } from '../../lib/assistant.js';
import { AssistantsPage } from './Assistants.js';
import {
  analyticsFixture,
  capitalNoticesFixture,
  flagsFixture,
  mockApi,
  wallListFixture,
  watchlistFixture,
  weeklyReportFixture,
  withQueries,
} from './test-support.js';
import type { Answer } from './test-support.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: unknown; to: string }) => (
    <a href={to}>{children as never}</a>
  ),
}));

const routes = (assistant: boolean, over: Record<string, Answer> = {}): Record<string, Answer> => ({
  '/api/v1/flags': { body: flagsFixture(assistant) },
  '/api/v1/analytics/summary': { body: analyticsFixture() },
  '/api/v1/monitoring/watchlist': { body: watchlistFixture() },
  '/api/v1/capital-notices': { body: capitalNoticesFixture() },
  '/api/v1/reports/weekly': { body: weeklyReportFixture() },
  '/api/v1/walls': { body: wallListFixture() },
  ...over,
});

describe('Ask Portfolio Beach (mock assistant)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('says the flag is off and keeps the questions visible but disabled', async () => {
    mockApi(routes(false));
    render(withQueries(<AssistantsPage />));
    expect(await screen.findByTestId('assistant-disabled')).toHaveTextContent(
      'The ai.assistant flag is off. Platform admins can turn it on under Admin, Flags; in the prototype the assistant answers from the figures on this page, not from a model.',
    );
    const buttons = within(screen.getByTestId('assistant-questions')).getAllByRole('button');
    expect(buttons).toHaveLength(8);
    for (const b of buttons) expect(b).toBeDisabled();
    expect(screen.getByLabelText('Or type a question')).toBeDisabled();
    expect(screen.queryByTestId('assistant-answer')).toBeNull();
  });

  it('answers a fixed question with the badge, sources and the mock line', async () => {
    mockApi(routes(true));
    render(withQueries(<AssistantsPage />));
    await screen.findByText('ai.assistant on');
    await userEvent.click(screen.getByRole('button', { name: 'Which valuations are stale?' }));
    const answer = await screen.findByTestId('assistant-answer');
    expect(await within(answer).findByTestId('assistant-paragraphs')).toHaveTextContent(
      '1 active position has no Locked valuation for Jun 30, 2025',
    );
    expect(answer).toHaveTextContent('PB-0015 Tidewater Foods');
    expect(within(answer).getByText('AI draft')).toBeVisible();
    expect(within(answer).getByTestId('assistant-mock-line')).toHaveTextContent(
      MOCK_ASSISTANT_LINE,
    );
    const sources = within(answer).getByTestId('assistant-sources');
    expect(within(sources).getByRole('link', { name: 'Weekly report' })).toHaveAttribute(
      'href',
      '/reporting',
    );
    expect(within(sources).getByRole('link', { name: 'Valuations' })).toHaveAttribute(
      'href',
      '/valuations',
    );
    expect(screen.queryByTestId('assistant-answered-as')).toBeNull();
  });

  it('maps a typed question to the nearest fixed one and says so', async () => {
    mockApi(routes(true));
    render(withQueries(<AssistantsPage />));
    await screen.findByText('ai.assistant on');
    await userEvent.type(screen.getByLabelText('Or type a question'), 'who can see project dune');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    const answer = await screen.findByTestId('assistant-answer');
    expect(within(answer).getByRole('heading')).toHaveTextContent('Who can see the walled deal?');
    expect(within(answer).getByTestId('assistant-answered-as')).toHaveTextContent(
      'Answered as the fixed question above for: "who can see project dune"',
    );
    expect(await within(answer).findByTestId('assistant-paragraphs')).toHaveTextContent(
      'Project Dune: 2 members visible to you (Deal Three and Head One), covering 2 records: Dune Logistics and a record you cannot see.',
    );
  });

  it('says when no fixed question matches', async () => {
    mockApi(routes(true));
    render(withQueries(<AssistantsPage />));
    await screen.findByText('ai.assistant on');
    await userEvent.type(screen.getByLabelText('Or type a question'), 'zzz qqq');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByTestId('assistant-unmatched')).toHaveTextContent(
      'No fixed question matches "zzz qqq"',
    );
    expect(screen.queryByTestId('assistant-answer')).toBeNull();
  });

  it('falls back to the weekly report when capital notices answer 501, and says what is missing on 403', async () => {
    mockApi(
      routes(true, {
        '/api/v1/capital-notices': { status: 501, title: 'Not implemented' },
        '/api/v1/walls': { status: 403, title: 'Forbidden' },
      }),
    );
    render(withQueries(<AssistantsPage />));
    await screen.findByText('ai.assistant on');
    await userEvent.click(screen.getByRole('button', { name: 'What capital activity is due?' }));
    const answer = await screen.findByTestId('assistant-answer');
    expect(await within(answer).findByTestId('assistant-paragraphs')).toHaveTextContent(
      "from the weekly report's capital activity section",
    );
    await userEvent.click(screen.getByRole('button', { name: 'Who can see the walled deal?' }));
    expect(await screen.findByText(/Wall data is not available right now/)).toBeVisible();
  });
});
