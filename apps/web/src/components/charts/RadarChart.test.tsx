import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { RadarChart } from './RadarChart.js';
import type { RadarAxis } from './RadarChart.js';
import './charts.css';

const AXES: RadarAxis[] = [
  { key: 'a', label: 'Sponsor tier', value: 70, display: '70', note: 'An Active sponsor.' },
  { key: 'b', label: 'Track record', value: 40, display: '40' },
  { key: 'c', label: 'Size', value: null, display: 'n/a', note: 'No target recorded.' },
  { key: 'd', label: 'Sector room', value: 100, display: '100' },
];

function chart(props: Partial<Parameters<typeof RadarChart>[0]> = {}) {
  return render(
    <RadarChart
      title="Fit by measure"
      axes={AXES}
      summary="Three of four measures have a score."
      valueColumn="Score"
      testId="radar"
      {...props}
    />,
  );
}

describe('RadarChart', () => {
  afterEach(() => cleanup());

  it('draws a spoke and a label for every measure, and a point only where there is a score', () => {
    chart();
    const figure = screen.getByTestId('radar');
    expect(within(figure).getByText('Three of four measures have a score.')).toBeInTheDocument();
    const marks = figure.querySelectorAll('.pb-radar-axis');
    expect(marks).toHaveLength(4);
    expect(figure.querySelectorAll('.pb-radar-point')).toHaveLength(3);
    expect(figure.querySelectorAll('.pb-radar-ring, .pb-radar-rim')).toHaveLength(4);
    const missing = figure.querySelector('[data-axis="c"]');
    expect(missing).toHaveClass('is-missing');
    expect(missing?.querySelector('.pb-radar-point')).toBeNull();
    // The score is printed at the label, the placeholder where there is none.
    expect(missing).toHaveTextContent('Sizen/a');
    expect(figure.querySelector('[data-axis="a"]')).toHaveTextContent('Sponsortier70');
  });

  it('never joins the neighbours of a measure with no score', () => {
    chart();
    const outline = screen.getByTestId('radar').querySelector('.pb-radar-outline');
    // One run, d to a to b (it passes the top): a line that is not closed.
    expect(outline?.getAttribute('d')).toMatch(/^M[^MZ]+$/);
    cleanup();
    chart({ axes: AXES.map((a) => ({ ...a, value: a.value ?? 10 })) });
    expect(
      screen.getByTestId('radar').querySelector('.pb-radar-outline')?.getAttribute('d'),
    ).toMatch(/Z$/);
  });

  it('names each measure for a screen reader, with its score or that it has none', () => {
    chart();
    expect(
      screen.getByRole('img', { name: 'Sponsor tier: 70 of 100. An Active sponsor.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Track record: 40 of 100' })).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'Size: no score. No target recorded.' }),
    ).toBeInTheDocument();
  });

  it('shows the figure behind a measure on focus and hover, and tells the page which one', () => {
    const onActive = vi.fn();
    chart({ onActive });
    const mark = screen.getByRole('img', { name: /^Sponsor tier/ });
    fireEvent.focus(mark);
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Sponsor tier');
    expect(tip).toHaveTextContent('70');
    expect(tip).toHaveTextContent('An Active sponsor.');
    expect(onActive).toHaveBeenLastCalledWith('a');
    fireEvent.blur(mark);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(onActive).toHaveBeenLastCalledWith(null);

    fireEvent.pointerEnter(screen.getByRole('img', { name: /^Size/ }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('no score');
    expect(onActive).toHaveBeenLastCalledWith('c');
  });

  it('brings forward the measure the page points at', () => {
    chart({ activeKey: 'd' });
    const figure = screen.getByTestId('radar');
    expect(figure.querySelector('[data-axis="d"]')).toHaveClass('is-active');
    expect(figure.querySelector('[data-axis="a"]')).not.toHaveClass('is-active');
  });

  it('gives the same rows as a table', () => {
    chart();
    fireEvent.click(screen.getByRole('button', { name: 'Show table' }));
    const table = screen.getByRole('table', { name: 'Fit by measure, as a table' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(5);
    expect(rows[1]).toHaveTextContent('Sponsor tier70');
    expect(rows[3]).toHaveTextContent('Sizen/a');
  });
});
