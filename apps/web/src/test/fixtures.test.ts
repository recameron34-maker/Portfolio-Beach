import { describe, expect, it } from 'vitest';
import {
  analyticsSummary,
  capitalNoticePage,
  dataHealth,
  intakeExportList,
  intakeFileDetail,
  intakeFilePage,
  intakeImportResult,
  investmentPage,
  investmentPerformance,
  principal,
  problemDetails,
  watchlist,
} from '@pb/contracts';
import { problemFixture } from './api-mock.js';
import {
  approvedDetailFixture,
  intakeExportListFixture,
  intakeFileDetailFixture,
  intakeFilePageFixture,
  intakeImportResultFixture,
  rejectedDetailFixture,
} from './fixtures-intake.js';
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
    ['intake file page', intakeFilePage, intakeFilePageFixture()],
    ['intake file detail', intakeFileDetail, intakeFileDetailFixture()],
    ['intake file detail after approve', intakeFileDetail, approvedDetailFixture()],
    ['intake file detail after reject', intakeFileDetail, rejectedDetailFixture('Not ours')],
    ['intake import result', intakeImportResult, intakeImportResultFixture(true)],
    ['intake export list', intakeExportList, intakeExportListFixture()],
    ['problem', problemDetails, problemFixture(501, '/api/v1/x')],
  ])('%s', (_name, schema, fixture) => {
    const result = schema.safeParse(fixture);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });
});
