import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockResponse } from '../../test/api-mock.js';
import { MISSING } from '../../lib/format.js';
import {
  opportunityDetailFixture,
  opportunityFitFixture,
  PIPE_PATHS,
} from '../../test/fixtures-pipeline.js';
import { renderWithQuery } from '../../test/render.js';
import { DealFitCard } from './DealFit.js';

const env = vi.hoisted(() => ({ previewMode: false }));
vi.mock('../../app/env.js', () => ({
  get previewMode() {
    return env.previewMode;
  },
}));

function open(answer: MockResponse): void {
  const detail = opportunityDetailFixture();
  mockApi({ [PIPE_PATHS.fit(detail.id)]: answer });
  renderWithQuery(<DealFitCard detail={detail} />);
}

describe('portfolio fit card', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    env.previewMode = false;
  });

  it('draws the radar chart and reads every measure beside it', async () => {
    open(ok(opportunityFitFixture()));
    const card = screen.getByTestId('opportunity-fit');
    expect(within(card).getByRole('heading', { level: 2 })).toHaveTextContent(
      'Portfolio fitDraft measures',
    );
    const lead = await within(card).findByTestId('opportunity-fit-lead');
    expect(lead).toHaveTextContent('as of Jun 30, 2025');
    expect(lead).toHaveTextContent(
      'All 7 measures have a score. Strongest: Fund commitment and Deal size (100). Weakest: Sector room (20).',
    );

    const chart = within(card).getByTestId('opportunity-fit-chart');
    expect(chart.querySelectorAll('.pb-radar-axis')).toHaveLength(7);
    expect(chart.querySelectorAll('.pb-radar-point')).toHaveLength(7);

    const rows = within(within(card).getByRole('list', { name: 'Fit measures' })).getAllByRole(
      'listitem',
    );
    expect(rows).toHaveLength(7);
    expect(rows[0]).toHaveTextContent('Sponsor relationship70 of 100');
    expect(rows[0]).toHaveTextContent('Kelpwood Capital Partners is an Active sponsor.');
    expect(rows[1]).toHaveTextContent('pooled gross MOIC of 1.60x');
    expect(rows[3]).toHaveTextContent('Industrials is 20.0% of held NAV.');
    expect(rows[3]).toHaveTextContent('25.0% of held NAV or more scores 0.');
    expect(rows[6]).toHaveTextContent(
      'The target of $15.0M is 1.25x the median held Co invest equity position ($12.0M across 12 positions).',
    );
    // The meter is the score again as a length.
    expect(rows[3]?.querySelector('.pb-fit-meter > span')).toHaveStyle({ width: '20%' });
    expect(card).toHaveTextContent('A draft set of measures');
  });

  it('gives a measure with no recorded figure no score, no point and no meter, and says why', async () => {
    const fit = opportunityFitFixture({
      inputs: { sponsorPositions: 0, sponsorMoic: null, targetCommitment: null, sizeRatio: null },
    });
    fit.measures = fit.measures.map((m) =>
      m.key === 'track_record'
        ? { key: m.key, score: null, missing: 'no_track_record' }
        : m.key === 'size_fit'
          ? { key: m.key, score: null, missing: 'no_target_commitment' }
          : m,
    );
    open(ok(fit));
    const card = screen.getByTestId('opportunity-fit');
    const lead = await within(card).findByTestId('opportunity-fit-lead');
    expect(lead).toHaveTextContent('5 of 7 measures have a score.');
    const chart = within(card).getByTestId('opportunity-fit-chart');
    expect(chart.querySelectorAll('.pb-radar-point')).toHaveLength(5);
    expect(chart.querySelectorAll('.pb-radar-axis.is-missing')).toHaveLength(2);

    const track = card.querySelector('[data-measure="track_record"]');
    expect(track).toHaveTextContent(`${MISSING}No score`);
    expect(track).toHaveTextContent('We have no position with Kelpwood Capital Partners');
    expect(track?.querySelector('.pb-fit-meter > span')).toBeNull();
    expect(card.querySelector('[data-measure="size_fit"]')).toHaveTextContent(
      'No target commitment is recorded on the deal.',
    );
  });

  it('ties the list and the chart together: pointing at one brings the other forward', async () => {
    open(ok(opportunityFitFixture()));
    const card = screen.getByTestId('opportunity-fit');
    await within(card).findByTestId('opportunity-fit-lead');
    const row = card.querySelector('[data-measure="sector_room"]');
    const axis = card.querySelector('[data-axis="sector_room"]');
    if (row === null || axis === null) throw new Error('the measure is not on the card');
    fireEvent.pointerEnter(row);
    expect(axis).toHaveClass('is-active');
    fireEvent.pointerLeave(row);
    expect(axis).not.toHaveClass('is-active');

    fireEvent.focus(axis);
    expect(row).toHaveClass('is-active');
    expect(within(card).getByRole('tooltip')).toHaveTextContent(
      'Industrials is 20.0% of held NAV.',
    );
    fireEvent.blur(axis);
    expect(row).not.toHaveClass('is-active');
  });

  it('says a deal made in the preview has no fit worked out, and keeps the page', async () => {
    env.previewMode = true;
    const detail = opportunityDetailFixture();
    open(failing(501, PIPE_PATHS.fit(detail.id)));
    const empty = await screen.findByTestId('opportunity-fit-unavailable');
    expect(empty).toHaveTextContent('Portfolio fit: not worked out in this preview');
    expect(empty).toHaveTextContent('A deal created in this preview has none.');
    expect(screen.queryByTestId('opportunity-fit-chart')).not.toBeInTheDocument();
  });

  it('shows a failed read as a notice inside the card', async () => {
    const detail = opportunityDetailFixture();
    open(failing(404, PIPE_PATHS.fit(detail.id)));
    const notice = await screen.findByTestId('opportunity-fit-unavailable');
    expect(notice).toHaveTextContent('Portfolio fit could not load');
    expect(screen.getByTestId('opportunity-fit')).toBeInTheDocument();
  });
});
