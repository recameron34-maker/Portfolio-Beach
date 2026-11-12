import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import definitions from '../../../../../config/definitions.json';
import { ApiError } from '../../api/client.js';
import { fetchMonitoringExport, monitoringBoardQuery } from '../../app/queries.js';
import { MISSING } from '../../lib/format.js';
import { retryUnlessUnavailable } from '../../lib/unavailable.js';
import { failing, mockApi } from '../../test/api-mock.js';
import {
  ageLabel,
  APPROVAL_WORDS,
  approvalTone,
  approvedOnText,
  csvRowCount,
  DOCUMENT_STATUS_WORDS,
  downloadText,
  dueLabel,
  everyPage,
  exportFileName,
  exportResult,
  flagsText,
  isAsOfDate,
  LATE_AFTER_DAYS,
  MISSING_AFTER_DAYS,
  MONITORING_META,
  periodOptions,
  quarterEndsBetween,
  quarterLabel,
  thresholdsLine,
} from './monitoring.js';
import { BOARD_CSV, boardRowFixture } from './fixtures.js';

describe('monitoring helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('words each status and tones the approval, beside the shared tones of lib/states', () => {
    expect(DOCUMENT_STATUS_WORDS).toEqual({
      expected: 'Expected',
      received: 'Received',
      late: 'Late',
      missing: 'Missing',
    });
    expect(APPROVAL_WORDS).toEqual({ none: 'None', pending: 'Pending', approved: 'Approved' });
    expect(approvalTone('none')).toBe('neutral');
    expect(approvalTone('pending')).toBe('watch');
    expect(approvalTone('approved')).toBe('good');
  });

  it('describes the age of a report against its due date, and nothing without a due date', () => {
    expect(ageLabel('expected', null)).toBeNull();
    expect(ageLabel('expected', -45)).toBe('due in 45 days');
    expect(ageLabel('expected', -1)).toBe('due in 1 day');
    expect(ageLabel('expected', 0)).toBe('due today');
    expect(ageLabel('expected', 10)).toBe('10 days past due');
    expect(ageLabel('late', 16)).toBe('16 days past due');
    expect(ageLabel('missing', 76)).toBe('76 days past due');
    expect(ageLabel('received', -30)).toBe('received 30 days early');
    expect(ageLabel('received', 0)).toBe('received on the due date');
    expect(ageLabel('received', 1)).toBe('received 1 day late');
    expect(dueLabel('2025-08-14')).toBe('Due Aug 14, 2025');
    expect(dueLabel(null)).toBeNull();
  });

  it('shows the placeholder for flags without a run and for an approval without a time', () => {
    expect(flagsText(boardRowFixture({ runId: null, flagsCount: 0 }))).toBe(MISSING);
    expect(flagsText(boardRowFixture({ flagsCount: 3 }))).toBe('3');
    expect(flagsText(boardRowFixture({ flagsCount: 0 }))).toBe('0');
    expect(approvedOnText(null)).toBe(MISSING);
    expect(approvedOnText('2025-07-20T10:00:00.000Z')).toBe('Jul 20, 2025');
  });

  it('pages a list to its end on its cursor, and refuses a list that never ends', async () => {
    const pages: Record<string, { items: string[]; nextCursor: string | null }> = {
      first: { items: ['a', 'b'], nextCursor: 'p2' },
      p2: { items: ['c'], nextCursor: 'p3' },
      p3: { items: [], nextCursor: null },
    };
    const asked: (string | undefined)[] = [];
    await expect(
      everyPage((cursor) => {
        asked.push(cursor);
        return Promise.resolve(pages[cursor ?? 'first']!);
      }),
    ).resolves.toEqual(['a', 'b', 'c']);
    expect(asked).toEqual([undefined, 'p2', 'p3']);
    // A cursor that comes back again, or a list longer than the page cap, is a fault, not a range.
    await expect(
      everyPage(() => Promise.resolve({ items: ['x'], nextCursor: 'again' })),
    ).rejects.toThrow('did not end');
    let n = 0;
    await expect(
      everyPage(() => {
        n += 1;
        return Promise.resolve({ items: [n], nextCursor: `p${n}` });
      }),
    ).rejects.toThrow('did not end');
  });

  it('lists every quarter end between two dates and offers them newest first', () => {
    expect(quarterEndsBetween('2024-11-15', '2025-06-30')).toEqual([
      '2024-12-31',
      '2025-03-31',
      '2025-06-30',
    ]);
    expect(quarterEndsBetween('2025-06-30', '2025-06-30')).toEqual(['2025-06-30']);
    expect(quarterEndsBetween('2025-07-01', '2025-06-30')).toEqual([]);
    expect(periodOptions(['2025-02-01', '2024-11-15'], '2025-08-30', '2025-06-30')).toEqual([
      '2025-06-30',
      '2025-03-31',
      '2024-12-31',
    ]);
    // The quarter the board answered is always offered, even before the positions have loaded.
    expect(periodOptions([], '2025-06-30', '2025-03-31')).toEqual(['2025-03-31']);
    expect(periodOptions(['2025-05-01'], '2025-06-30', '2024-12-31')).toEqual([
      '2025-06-30',
      '2024-12-31',
    ]);
    expect(quarterLabel('2025-06-30')).toBe('Q2 2025 (Jun 30, 2025)');
  });

  it('accepts a complete calendar day for the as-of control only', () => {
    expect(isAsOfDate('2025-08-30')).toBe(true);
    expect(isAsOfDate(' 2025-08-30 ')).toBe(true);
    expect(isAsOfDate('')).toBe(false);
    expect(isAsOfDate('2025-08')).toBe(false);
    expect(isAsOfDate('2025-02-30')).toBe(false);
  });

  it('counts the rows of a CSV text, quoted line breaks and the trailing one aside', () => {
    expect(csvRowCount(BOARD_CSV)).toBe(2);
    expect(csvRowCount('a,b\n')).toBe(0);
    expect(csvRowCount('')).toBe(0);
    expect(csvRowCount('a,b\r\n1,2\r\n3,4')).toBe(2);
    expect(csvRowCount('a,b\n"line\nbreak",2\n')).toBe(1);
    expect(exportFileName('2025-06-30')).toBe('monitoring-board-2025-06-30.csv');
    expect(exportResult(15, 'monitoring-board-2025-06-30.csv')).toBe(
      'Exported 15 rows to monitoring-board-2025-06-30.csv',
    );
    expect(exportResult(1, 'x.csv')).toBe('Exported 1 row to x.csv');
  });

  it('offers a text as a file through a Blob on a clicked anchor, then releases the URL', () => {
    vi.useFakeTimers();
    const created: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return 'blob:monitoring';
    });
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    const clicked: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ href: this.href, download: this.download });
    });
    downloadText('board.csv', 'a,b\n1,2\n', 'text/csv');
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe('text/csv');
    expect(clicked).toEqual([{ href: 'blob:monitoring', download: 'board.csv' }]);
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:monitoring');
    vi.useRealTimers();
  });

  it('reads the late and missing thresholds from config and names the linked pages', () => {
    expect(LATE_AFTER_DAYS).toBe(definitions.documents.lateAfterDays);
    expect(MISSING_AFTER_DAYS).toBe(definitions.documents.missingAfterDays);
    expect(thresholdsLine()).toBe(
      `A report counts as late ${definitions.documents.lateAfterDays} days after its due date and as missing after ${definitions.documents.missingAfterDays} days (config/definitions.json documents).`,
    );
  });

  it('reads the board with its parameters sorted and retries only what a retry can change', async () => {
    expect(monitoringBoardQuery().queryKey).toEqual(['monitoring-board', {}]);
    expect(monitoringBoardQuery({ periodEnd: '2025-06-30' }).queryKey).toEqual([
      'monitoring-board',
      { periodEnd: '2025-06-30' },
    ]);
    expect(monitoringBoardQuery().retry).toBe(retryUnlessUnavailable);
    mockApi({});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await expect(client.fetchQuery(monitoringBoardQuery())).rejects.toThrow();
    await expect(
      client.fetchQuery(monitoringBoardQuery({ periodEnd: '2025-06-30', asOf: '2025-08-30' })),
    ).rejects.toThrow();
    const asked = vi
      .mocked(globalThis.fetch)
      .mock.calls.map(([input]) => (typeof input === 'string' ? input : ''));
    expect(asked).toEqual([
      '/api/v1/monitoring/board',
      '/api/v1/monitoring/board?asOf=2025-08-30&periodEnd=2025-06-30',
    ]);
  });

  it('fetches the export as text and raises the API problem when it is refused', async () => {
    mockApi({ '/api/v1/monitoring/board/export': failing(403, '/api/v1/monitoring/board/export') });
    await expect(fetchMonitoringExport({ asOf: '2025-08-30' })).rejects.toSatisfy(
      (error: unknown) => error instanceof ApiError && error.status === 403,
    );
    const asked = vi
      .mocked(globalThis.fetch)
      .mock.calls.map(([input]) => (typeof input === 'string' ? input : ''));
    expect(asked).toEqual(['/api/v1/monitoring/board/export?asOf=2025-08-30']);
    // A failure without a problem body still reads as an ApiError with the status.
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('gone', { status: 502, statusText: 'Bad Gateway' }),
    );
    await expect(fetchMonitoringExport()).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ApiError && error.status === 502 && error.message === 'Bad Gateway',
    );
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('a,b\n1,2\n', { status: 200, headers: { 'content-type': 'text/csv' } }),
    );
    await expect(fetchMonitoringExport()).resolves.toBe('a,b\n1,2\n');
  });

  it('never carries an em dash', () => {
    const texts = [
      MONITORING_META,
      thresholdsLine(),
      ...Object.values(DOCUMENT_STATUS_WORDS),
      ...Object.values(APPROVAL_WORDS),
      ageLabel('late', 16) ?? '',
      exportResult(2, exportFileName('2025-06-30')),
    ];
    for (const text of texts) expect(text).not.toContain(String.fromCharCode(0x2014));
  });
});
