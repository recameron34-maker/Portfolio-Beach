import { describe, expect, it } from 'vitest';
import {
  analyticsSummary,
  capitalNoticePage,
  dataHealth,
  investmentPage,
  investmentPerformance,
  principal,
  problemDetails,
  watchlist,
} from '@pb/contracts';
import { problemFixture } from './api-mock.js';
import {
  analyticsFixture,
  capitalNoticePageFixture,
  dataHealthFixture,
  investmentFixture,
  investmentPageFixture,
  noticeFixture,
  performanceFixture,
  principalFixture,
  watchlistFixture,
} from './fixtures.js';

/** The page tests only mean something if their fixtures match the contracts the API serves. */
describe('test fixtures match the contracts', () => {
  it.each([
    ['principal', principal, principalFixture()],
    ['analytics summary', analyticsSummary, analyticsFixture()],
    ['watchlist', watchlist, watchlistFixture()],
    ['investment page', investmentPage, investmentPageFixture([investmentFixture()])],
    ['investment performance', investmentPerformance, performanceFixture()],
    ['capital notice page', capitalNoticePage, capitalNoticePageFixture([noticeFixture()])],
    ['data health', dataHealth, dataHealthFixture()],
    ['problem', problemDetails, problemFixture(501, '/api/v1/x')],
  ])('%s', (_name, schema, fixture) => {
    const result = schema.safeParse(fixture);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });
});
