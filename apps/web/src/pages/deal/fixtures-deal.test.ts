import { describe, expect, it } from 'vitest';
import {
  auditPage,
  capitalNoticePage,
  investmentDetail,
  investmentPerformance,
  principal,
  sponsorDetail,
  valuationPage,
} from '@pb/contracts';
import {
  auditPageFixture,
  creditDetailFixture,
  creditPerformanceFixture,
  dealDetailFixture,
  dealNoticePageFixture,
  equityPerformanceFixture,
  operationsPrincipalFixture,
  sponsorDetailFixture,
  valuationPageFixture,
} from '../../test/fixtures-deal.js';

/**
 * The deal tab tests only mean something if their fixtures match the contracts the API serves;
 * the valuation and notice lists answer 501 in this build, so their fixtures are the contract.
 */
describe('deal workspace fixtures match the contracts', () => {
  it.each([
    ['equity investment detail', investmentDetail, dealDetailFixture()],
    ['credit investment detail', investmentDetail, creditDetailFixture()],
    ['equity performance', investmentPerformance, equityPerformanceFixture()],
    ['credit performance', investmentPerformance, creditPerformanceFixture()],
    ['valuation page', valuationPage, valuationPageFixture()],
    ['capital notice page', capitalNoticePage, dealNoticePageFixture()],
    ['sponsor detail', sponsorDetail, sponsorDetailFixture()],
    ['audit page', auditPage, auditPageFixture()],
    ['operations principal', principal, operationsPrincipalFixture()],
  ])('%s', (_name, schema, fixture) => {
    const result = schema.safeParse(fixture);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });
});
