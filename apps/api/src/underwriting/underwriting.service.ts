import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Principal } from '@pb/adapters';
import { CALC_VERSION, underwritingComparison } from '@pb/calc';
import { entryCaseOf, isComparableVersion } from '@pb/contracts';
import type { UnderwritingRead } from '@pb/contracts';
import { schema } from '@pb/db';
import { loadOperatingRows } from '../analytics/analytics.service.js';
import { ProblemError } from '../common/problem.js';
import { DEFINITIONS } from '../common/tokens.js';
import { DbService } from '../db/db.service.js';
import { loadInvestmentsWithMetrics } from '../portfolio/loaders.js';
import { str } from '../portfolio/metrics.js';
import { calcCaseOf, comparisonInputs, tolerancesOf, underwritingFormOf } from './comparison.js';
import type { UnderwritingDefinitions } from './comparison.js';
import { loadVersions } from './rows.js';

/*
 * Performance against the sponsor's underwritten base case (docs/04 M9, docs/08 section 11,
 * docs/18 section 13, decision 0022). The read answers every version of a position's base case
 * and the comparison of the position with one of them: the entry case, the Confirmed version with
 * the earliest case date, unless the reader names another that stands or stood as the plan. Only
 * a case a second person confirmed is compared (SEC-9.1): a Draft alone answers no comparison.
 * The comparison is worked out on read by underwritingComparison of @pb/calc, from the figures
 * the value creation card and the position summary carry for the same date; nothing of it is
 * stored. A position the caller cannot see is 404, its base case with it (SEC-5.3), and each read
 * of the card is in the audit trail (SEC-11.1).
 */

const INVESTMENT_NOT_FOUND = 'Investment not found';
const VERSION_NOT_FOUND = 'Base case version not found';

@Injectable()
export class UnderwritingService {
  constructor(
    private readonly db: DbService,
    @Inject(DEFINITIONS) private readonly definitions: UnderwritingDefinitions,
  ) {}

  /**
   * A position against its base case as of a date. `version` names the version to compare with
   * in place of the entry case; one that is not Confirmed or Superseded is 404. A position that
   * holds no base case (a primary fund) answers `form: null` and nothing else.
   */
  async read(
    principal: Principal,
    requestId: string,
    id: string,
    asOf: string,
    version?: number,
  ): Promise<UnderwritingRead> {
    // Read before the database is, so a missing tolerance discloses nothing and audits nothing.
    const tolerances = tolerancesOf(this.definitions);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const found = (await loadInvestmentsWithMetrics(tx, asOf, eq(schema.investment.id, id)))[0];
      if (found === undefined) throw new ProblemError(404, 'not-found', INVESTMENT_NOT_FOUND);
      const form = underwritingFormOf(found.row.dealType);
      const versions = form === null ? [] : await loadVersions(tx, found.row.id);
      const compared =
        version === undefined
          ? entryCaseOf(versions)
          : (versions.find((v) => v.version === version && isComparableVersion(v)) ?? null);
      if (version !== undefined && compared === null)
        throw new ProblemError(404, 'not-found', VERSION_NOT_FOUND);
      await audit({
        action: 'investment.underwriting.read',
        entity: 'core.investment',
        entityId: found.row.id,
        ...(compared === null ? {} : { details: { comparedVersion: compared.version } }),
      });

      const base = {
        asOf,
        form,
        versions,
        thresholds: {
          onPlanTolerance: str(tolerances.onPlanTolerance)!,
          irrTolerance: str(tolerances.irrTolerance)!,
        },
        calcVersion: CALC_VERSION,
      };
      if (compared === null)
        return {
          ...base,
          comparedVersion: null,
          comparison: null,
          notCalculable:
            form === null
              ? null
              : versions.some((v) => v.state === 'Draft')
                ? 'draft_only'
                : 'no_case',
        };
      const operating = (await loadOperatingRows(tx, [found.row.id])).get(found.row.id) ?? [];
      return {
        ...base,
        comparedVersion: compared.version,
        comparison: underwritingComparison(
          calcCaseOf(compared),
          comparisonInputs({ ...found, operating }, asOf),
          tolerances,
        ),
        notCalculable: null,
      };
    });
  }
}
