import { describe, expect, it } from 'vitest';
import { addMonths, containingQuarterEnd, latestQuarterEndOnOrBefore } from '@pb/calc';
import { generateDataset } from './generate.js';
import type { GeneratedDataset } from './generate.js';
import { latestLockedMark } from './marks.js';
import { FAILING_PACKAGE_SCENARIOS, failingPackageCase } from './package-case.js';

const small = generateDataset({ profile: 'small', seed: 42 });
const period = latestQuarterEndOnOrBefore(small.asOf);
const quarterStart = containingQuarterEnd(addMonths(period, -3));

/** A copy a test may change, so no test reads what another one left. */
const copyOf = (dataset: GeneratedDataset): GeneratedDataset => structuredClone(dataset);

const tagged = (dataset: GeneratedDataset, scenario: string) => {
  const inv = dataset.investments.find((i) => i.id === dataset.scenarios[scenario]?.[0]);
  if (inv === undefined) throw new Error(`the dataset has no ${scenario} position`);
  return inv;
};
const lockedAt = (dataset: GeneratedDataset, investmentId: string, periodEnd: string): boolean =>
  dataset.valuations.some(
    (v) => v.investmentId === investmentId && v.periodEnd === periodEnd && v.state === 'Locked',
  );

describe('the package that fails its checks (docs/14 section 3, docs/08 section 7)', () => {
  it('exists for seed 42, small: the first client with a share of the vehicle of the roll_forward_break position', () => {
    const found = failingPackageCase(small);
    if (found === null) throw new Error('seed 42, small has no failing package case');
    const position = tagged(small, 'roll_forward_break');
    expect(found.scenario).toBe('roll_forward_break');
    expect(found.positionNumber).toBe(position.investmentNumber);

    // The user prepares packages and is entitled to the client.
    expect(found.user.roles).toContain('investor_relations');
    expect(found.user.clientIds).toContain(found.client.id);
    expect(small.users).toContainEqual(found.user);
    expect(small.clients).toContainEqual(found.client);

    // The client is committed to the position's vehicle with a share on record, and no client
    // listed before it is: the first one in the dataset's own order.
    const sharing = small.clients.filter((c) =>
      small.lpCommitments.some(
        (l) => l.clientId === c.id && l.vehicleId === position.vehicleId && l.ownershipPct !== null,
      ),
    );
    expect(sharing[0]).toEqual(found.client);
    expect(found.client.name).toBe('Client Alpha Pension');
    expect(found.user.externalId).toBe('ir.one');
  });

  it('names a position whose record fails the quarter: held through it, marked at its end, with no Locked mark at its start', () => {
    const found = failingPackageCase(small);
    const position = tagged(small, 'roll_forward_break');
    expect(found?.positionNumber).toBe(position.investmentNumber);
    // Held before the quarter began, so its line needs a begin NAV and is not "new this quarter".
    expect(position.entryDate <= quarterStart).toBe(true);
    expect(position.isActive).toBe(true);
    expect(position.exitDate).toBeNull();
    // The mark the scenario removed, and the one it left.
    expect(lockedAt(small, position.id, quarterStart)).toBe(false);
    expect(lockedAt(small, position.id, period)).toBe(true);
    // Nobody is kept from reading it: the package of the user carries its line.
    expect(
      small.walls.some((w) =>
        w.records.some((r) => r.entity === 'investment' && r.entityId === position.id),
      ),
    ).toBe(false);
  });

  it('prefers the break to the stale mark, in the order of FAILING_PACKAGE_SCENARIOS', () => {
    expect(FAILING_PACKAGE_SCENARIOS).toEqual(['roll_forward_break', 'stale_valuation']);
    // Both scenarios are in the book, and the helper answers the first.
    expect(tagged(small, 'stale_valuation').id).not.toBe(tagged(small, 'roll_forward_break').id);
    expect(failingPackageCase(small)?.scenario).toBe('roll_forward_break');
  });

  it('falls back to the stale_valuation position when no client has a share of the break position vehicle', () => {
    const changed = copyOf(small);
    const broken = tagged(changed, 'roll_forward_break');
    const stale = tagged(changed, 'stale_valuation');
    // The two sit in different vehicles in this book, so the share of one can go alone.
    expect(stale.vehicleId).not.toBe(broken.vehicleId);
    for (const l of changed.lpCommitments)
      if (l.vehicleId === broken.vehicleId) l.ownershipPct = null;
    const found = failingPackageCase(changed);
    expect(found?.scenario).toBe('stale_valuation');
    expect(found?.positionNumber).toBe(stale.investmentNumber);
    // The stale position: carried at an earlier Locked mark, none for the latest quarter.
    expect(lockedAt(changed, stale.id, period)).toBe(false);
    expect(latestLockedMark(changed.valuations, stale.id, period)?.periodEnd).toBe(quarterStart);
    expect(
      changed.lpCommitments.some(
        (l) =>
          l.clientId === found?.client.id &&
          l.vehicleId === stale.vehicleId &&
          l.ownershipPct !== null,
      ),
    ).toBe(true);
  });

  it('passes over a client no investor relations user is entitled to', () => {
    const changed = copyOf(small);
    const first = failingPackageCase(changed);
    if (first === null) throw new Error('no case to start from');
    for (const u of changed.users) u.clientIds = u.clientIds.filter((id) => id !== first.client.id);
    const next = failingPackageCase(changed);
    expect(next?.scenario).toBe('roll_forward_break');
    expect(next?.client.id).not.toBe(first.client.id);
    expect(next?.client.name).toBe('Client Beta Endowment');
    expect(next?.user.clientIds).toContain(next?.client.id);
  });

  it('never names a user outside the information wall of the position', () => {
    const changed = copyOf(small);
    const broken = tagged(changed, 'roll_forward_break');
    const wall = changed.walls[0];
    if (wall === undefined) throw new Error('the dataset has no wall');
    // The break position goes behind the wall, which no investor relations user is on.
    wall.records.push({ entity: 'investment', entityId: broken.id });
    const found = failingPackageCase(changed);
    expect(found?.scenario).toBe('stale_valuation');
    // Once an entitled investor relations user is on the wall, the break is the case again.
    const ir = changed.users.find((u) => u.externalId === 'ir.one');
    if (ir === undefined) throw new Error('no ir.one');
    wall.memberUserIds.push(ir.id);
    expect(failingPackageCase(changed)).toMatchObject({
      scenario: 'roll_forward_break',
      positionNumber: broken.investmentNumber,
      user: { externalId: 'ir.one' },
    });
  });

  it('answers null when the book has no such position, no share or no preparer', () => {
    const untagged = copyOf(small);
    untagged.scenarios = { ...untagged.scenarios, roll_forward_break: [], stale_valuation: [] };
    expect(failingPackageCase(untagged)).toBeNull();

    const noShares = copyOf(small);
    for (const l of noShares.lpCommitments) l.ownershipPct = null;
    expect(failingPackageCase(noShares)).toBeNull();

    const noPreparer = copyOf(small);
    noPreparer.users = noPreparer.users.filter((u) => !u.roles.includes('investor_relations'));
    expect(failingPackageCase(noPreparer)).toBeNull();

    // A tag that names no investment of the dataset is no case.
    const dangling = copyOf(small);
    dangling.scenarios = {
      ...dangling.scenarios,
      roll_forward_break: ['00000000-0000-4000-8000-000000000000'],
      stale_valuation: [],
    };
    expect(failingPackageCase(dangling)).toBeNull();
  });

  it('exists in other seeds of the small profile, always the break position', () => {
    for (const seed of [1, 7, 2026]) {
      const dataset = generateDataset({ profile: 'small', seed });
      const found = failingPackageCase(dataset);
      expect(found?.scenario, `seed ${seed}`).toBe('roll_forward_break');
      expect(found?.positionNumber, `seed ${seed}`).toBe(
        tagged(dataset, 'roll_forward_break').investmentNumber,
      );
    }
  });

  it('leaves the dataset as it found it', () => {
    const before = JSON.stringify(small);
    failingPackageCase(small);
    expect(JSON.stringify(small)).toBe(before);
  });
});
