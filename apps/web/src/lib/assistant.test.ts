import { describe, expect, it } from 'vitest';
import {
  analyticsSummary,
  capitalNoticePage,
  wallList,
  watchlist,
  weeklyReport,
} from '@pb/contracts';
import {
  analyticsFixture,
  capitalNoticesFixture,
  wallListFixture,
  watchlistFixture,
  weeklyReportFixture,
} from '../pages/assistants/test-support.js';
import {
  answerQuestion,
  matchQuestion,
  MOCK_ASSISTANT_LINE,
  QUESTIONS,
  tokenize,
} from './assistant.js';
import type { AssistantInputs, QuestionId } from './assistant.js';

const EM_DASH = '—';

const inputs = (): AssistantInputs => ({
  analytics: analyticsFixture(),
  watchlist: watchlistFixture(),
  capitalNotices: capitalNoticesFixture(),
  weeklyReport: weeklyReportFixture(),
  walls: wallListFixture(),
});

const empty: AssistantInputs = {
  analytics: null,
  watchlist: null,
  capitalNotices: null,
  weeklyReport: null,
  walls: null,
};

describe('mock assistant fixtures follow the contracts', () => {
  it('parses every fixture with its zod schema', () => {
    expect(() => analyticsSummary.parse(analyticsFixture())).not.toThrow();
    expect(() => watchlist.parse(watchlistFixture())).not.toThrow();
    expect(() => capitalNoticePage.parse(capitalNoticesFixture())).not.toThrow();
    expect(() => weeklyReport.parse(weeklyReportFixture())).not.toThrow();
    expect(() => wallList.parse(wallListFixture())).not.toThrow();
  });
});

describe('matching a typed question onto a fixed one', () => {
  it('tokenizes to stems without stop words', () => {
    expect(tokenize('Which positions need attention?')).toEqual(['position', 'need', 'attention']);
    expect(tokenize('What is the portfolio NAV?')).toEqual(['nav']);
    expect(tokenize('class walls')).toEqual(['class', 'wall']);
  });

  it('maps common phrasings to the expected question', () => {
    const cases: [string, QuestionId][] = [
      ['which deals are stale', 'stale'],
      ['What is the NAV?', 'nav'],
      ['who can see project dune', 'walls'],
      ['what are our biggest holdings', 'largest'],
      ['how much capital is due next week', 'capital'],
      ['exposure to healthcare', 'sector'],
      ['realized multiples', 'realized'],
      ['which positions need attention', 'attention'],
      ['any covenant breaches?', 'attention'],
    ];
    for (const [text, id] of cases) expect(matchQuestion(text)?.question.id, text).toBe(id);
  });

  it('returns null when nothing overlaps and keeps the earlier question on a tie', () => {
    expect(matchQuestion('zzz qqq')).toBeNull();
    expect(matchQuestion('')).toBeNull();
    // "position" alone is shared by three questions; the first in the list wins.
    expect(matchQuestion('positions')?.question.id).toBe('attention');
  });

  it('matches each fixed question text to itself', () => {
    for (const q of QUESTIONS) expect(matchQuestion(q.text)?.question.id).toBe(q.id);
  });
});

describe('answers assembled from the recorded figures', () => {
  it('lists flagged positions, bad flags first, with the counts', () => {
    const a = answerQuestion('attention', inputs());
    expect(a.complete).toBe(true);
    expect(a.paragraphs[0]).toBe(
      'As of Jun 30, 2025, 1 position carries a bad flag, 0 a watch flag and 2 have none.',
    );
    expect(a.paragraphs[1]).toContain(
      'PB-0012 Dune Logistics (Beach Co-Invest Fund I): Locked fair value',
    );
    expect(a.sources.map((s) => s.to)).toEqual(['/portfolio/watchlist', '/portfolio']);
  });

  it('states NAV, the quarter move and the largest movers', () => {
    const a = answerQuestion('nav', inputs());
    expect(a.paragraphs[0]).toContain(
      'Portfolio NAV is $40.0M across 3 active positions as of Jun 30, 2025',
    );
    expect(a.paragraphs[1]).toBe(
      'Locked NAV was $38.0M at Mar 31, 2025 and $40.0M at Jun 30, 2025, a change of 5.3%.',
    );
    expect(a.paragraphs[2]).toBe(
      'The largest Locked fair value moves against the prior quarter are Harbor Analytics (12.0%) and Dune Logistics (-8.0%).',
    );
  });

  it('says the move is not calculable with fewer than two NAV points', () => {
    const a = answerQuestion('nav', {
      ...inputs(),
      analytics: analyticsFixture({ navSeries: [{ periodEnd: '2025-06-30', value: '1' }] }),
    });
    expect(a.paragraphs[1]).toContain('not calculable');
  });

  it('answers capital activity from the notices, and from the weekly report when the notices are unavailable', () => {
    const fromNotices = answerQuestion('capital', inputs());
    expect(fromNotices.paragraphs[0]).toContain(
      '1 capital notice needs attention as of Jun 30, 2025',
    );
    expect(fromNotices.paragraphs[0]).toContain('from the capital notices');
    expect(fromNotices.paragraphs[1]).toBe(
      'Capital call of $2.5M for Harbor Analytics, due Jul 5, 2025.',
    );
    const fallback = answerQuestion('capital', { ...inputs(), capitalNotices: null });
    expect(fallback.complete).toBe(true);
    expect(fallback.paragraphs[0]).toContain("from the weekly report's capital activity section");
    const none = answerQuestion('capital', {
      ...inputs(),
      capitalNotices: null,
      weeklyReport: null,
    });
    expect(none.complete).toBe(false);
    expect(none.paragraphs[0]).toContain('not available');
  });

  it('marks overdue notices and totals several', () => {
    const a = answerQuestion('capital', {
      ...inputs(),
      capitalNotices: capitalNoticesFixture({
        attention: [
          capitalNoticesFixture().items[0]!,
          { ...capitalNoticesFixture().items[1]!, amount: '1000000.00' },
        ],
      }),
    });
    expect(a.paragraphs[1]).toContain('overdue by 20 days');
    expect(a.paragraphs[a.paragraphs.length - 1]).toBe('Together they total $3.5M.');
  });

  it('lists stale valuations with their footnotes', () => {
    const a = answerQuestion('stale', inputs());
    expect(a.paragraphs[0]).toBe(
      '1 active position has no Locked valuation for Jun 30, 2025 as of Jun 30, 2025.',
    );
    expect(a.paragraphs[1]).toContain(
      'PB-0015 Tidewater Foods: Carried at the latest Locked valuation',
    );
    const clean = answerQuestion('stale', {
      ...inputs(),
      weeklyReport: weeklyReportFixture({ staleValuations: [] }),
    });
    expect(clean.paragraphs[0]).toContain('Every active position has a Locked valuation');
  });

  it('ranks sectors by NAV share', () => {
    const a = answerQuestion('sector', inputs());
    expect(a.paragraphs[0]).toBe(
      'By NAV as of Jun 30, 2025, the largest sectors are Healthcare at 75.0% ($30.0M, 2 positions) and Software at 25.0% ($10.0M, 1 position).',
    );
  });

  it('reports realized positions with pooled multiples and NM where the IRR is flagged', () => {
    const a = answerQuestion('realized', inputs());
    expect(a.paragraphs[0]).toContain('1 position is realized as of Jun 30, 2025.');
    expect(a.paragraphs[0]).toContain(
      'the gross MOIC is 1.85x, DPI is 1.85x and the gross IRR is 21.0%',
    );
    const flagged = answerQuestion('realized', {
      ...inputs(),
      analytics: analyticsFixture({
        realized: { ...analyticsFixture().realized, irrFlag: 'multiple_irr' },
      }),
    });
    expect(flagged.paragraphs[0]).toContain('the gross IRR is NM');
  });

  it('numbers the largest positions and sums their shares', () => {
    const a = answerQuestion('largest', inputs());
    expect(a.paragraphs[1]).toBe(
      '1. Harbor Analytics (Beach Co-Invest Fund I): $11.2M, 28.0% of NAV, gross MOIC 1.60x.',
    );
    expect(a.paragraphs[3]).toBe('Together they hold 46.4% of NAV.');
  });

  it('names wall members and never a record label the caller cannot see', () => {
    const a = answerQuestion('walls', inputs());
    expect(a.paragraphs[0]).toBe(
      'Project Dune: 2 members (Deal Three and Head One), covering 2 records: Dune Logistics and a record you cannot see.',
    );
    const none = answerQuestion('walls', { ...inputs(), walls: wallListFixture({ walls: [] }) });
    expect(none.paragraphs[0]).toBe('No wall is visible to you.');
  });

  it('says what is missing when a source did not load, for every question', () => {
    for (const q of QUESTIONS) {
      const a = answerQuestion(q.id, empty);
      expect(a.complete, q.id).toBe(false);
      expect(a.paragraphs[0], q.id).toContain('is not available right now');
      expect(a.sources.length, q.id).toBeGreaterThan(0);
    }
  });

  it('never writes an em dash and never invents a number for a missing input', () => {
    const texts: string[] = [MOCK_ASSISTANT_LINE];
    for (const q of QUESTIONS) {
      texts.push(...answerQuestion(q.id, inputs()).paragraphs);
      texts.push(...answerQuestion(q.id, empty).paragraphs);
    }
    for (const t of texts) expect(t.includes(EM_DASH), t).toBe(false);
    const noNav = answerQuestion('nav', {
      ...inputs(),
      analytics: analyticsFixture({
        active: { ...analyticsFixture().active, nav: null, grossMoic: null },
      }),
    });
    expect(noNav.paragraphs[0]).toContain('Portfolio NAV is - across');
    expect(noNav.paragraphs[0]).toContain('gross MOIC is -');
  });
});
