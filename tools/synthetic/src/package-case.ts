import type { SyntheticDataset } from '@pb/db';

/**
 * The two scenarios whose position fails a check of a reporting package for the as-of quarter
 * (docs/14 section 3, docs/08 section 7), the first to look for first:
 *
 *  - `roll_forward_break`: no Locked mark at the end of the quarter before, so the line has no
 *    begin NAV. The quarter-start, roll-forward and sign checks fail, whatever the package is
 *    labelled, and locking a mark for the as-of quarter does not mend it.
 *  - `stale_valuation`: no Locked mark for the as-of quarter, so the line is carried at the last
 *    one and footnoted. The label check fails once the package is labelled final, and stops
 *    failing when somebody locks that quarter's mark.
 */
export const FAILING_PACKAGE_SCENARIOS = ['roll_forward_break', 'stale_valuation'] as const;
export type FailingPackageScenario = (typeof FAILING_PACKAGE_SCENARIOS)[number];

type PackageBook = Pick<
  SyntheticDataset,
  'users' | 'clients' | 'investments' | 'lpCommitments' | 'walls' | 'scenarios'
>;

export interface FailingPackageCase {
  /** An investor relations user entitled to the client, who can read the position. */
  user: SyntheticDataset['users'][number];
  /** A client committed, with an ownership share on record, to the position's vehicle. */
  client: SyntheticDataset['clients'][number];
  /** The number of the position whose record fails the checks. */
  positionNumber: string;
  scenario: FailingPackageScenario;
}

/**
 * A reporting package that fails its checks, for tests and journeys to start: who prepares it,
 * for which client, and the position that fails. A final package this user generates for this
 * client and the as-of quarter carries the position's line and a failed check about it.
 *
 * The position is the one the first scenario of FAILING_PACKAGE_SCENARIOS tags; the client is
 * the first, in the dataset's order, that is committed to the position's vehicle with a share on
 * record and has an investor relations user entitled to it who can read the position (a
 * package is built from what its preparer reads, so a user outside the position's information
 * wall would get a package without the line). Null when neither scenario gives one.
 */
export function failingPackageCase(dataset: PackageBook): FailingPackageCase | null {
  for (const scenario of FAILING_PACKAGE_SCENARIOS) {
    const position = dataset.investments.find((i) => i.id === dataset.scenarios[scenario]?.[0]);
    if (position === undefined) continue;
    const walls = dataset.walls.filter((w) =>
      w.records.some((r) => r.entity === 'investment' && r.entityId === position.id),
    );
    for (const client of dataset.clients) {
      const shares = dataset.lpCommitments.some(
        (l) =>
          l.clientId === client.id && l.vehicleId === position.vehicleId && l.ownershipPct !== null,
      );
      if (!shares) continue;
      const user = dataset.users.find(
        (u) =>
          u.roles.includes('investor_relations') &&
          u.clientIds.includes(client.id) &&
          (walls.length === 0 || walls.some((w) => w.memberUserIds.includes(u.id))),
      );
      if (user !== undefined)
        return { user, client, positionNumber: position.investmentNumber, scenario };
    }
  }
  return null;
}
