import type { ReportingPackageCommand, ReportingPackageState } from './machines.js';
import { reportingPackageMachine } from './machines.js';

/*
 * What the reporting package machine reads beyond the state and the roles (docs/18 section 5),
 * written once for the API and the static preview: who prepared a package, for the segregation
 * of duties (SEC-5.6), and which steps are investor relations' own, for the entitlement to the
 * client (SEC-5.2).
 */

/** The record keys the package machine reads for overrideQa and approve. */
export interface PackageCommandRecord {
  /** Whoever started the package. */
  preparedBy: string;
  /** Everyone who ran one of its generations, each once. */
  generatedBy: string[];
  /** Whoever submitted it for review; null until it is submitted. */
  submittedBy: string | null;
}

/**
 * The record of a package as the machine reads it. A package's figures are the reading of
 * whoever generated it, so every person in its generation runs is named beside whoever started
 * it and whoever submitted it; the machine refuses each of them where the table says so.
 */
export function packageCommandRecord(pkg: {
  preparedBy: string;
  /** The generation runs of the package (its change log), in any order. */
  runs: readonly { by: string }[];
  submittedBy: string | null;
}): PackageCommandRecord {
  return {
    preparedBy: pkg.preparedBy,
    generatedBy: [...new Set(pkg.runs.map((run) => run.by))].sort(),
    submittedBy: pkg.submittedBy,
  };
}

const INVESTOR_RELATIONS = 'investor_relations';

/**
 * Whether a command, from a state, is one the actor could only take as investor relations: the
 * table lists the roles of the step, and of those the actor holds investor relations alone.
 * Investor relations act for the clients they are entitled to (SEC-5.2), whatever a second role
 * lets them read, so such a step needs the entitlement to the package's client. A step the actor
 * may take under another role of the table (an approver approving, operations releasing) does
 * not: those roles act for every client. False where the table refuses the command or the actor
 * holds none of its roles: the machine answers those.
 */
export function packageStepIsInvestorRelations(
  from: ReportingPackageState,
  command: ReportingPackageCommand,
  actorRoles: readonly string[],
): boolean {
  const held = reportingPackageMachine.transitions
    .filter((t) => t.from === from && t.command === command)
    .flatMap((t) => t.roles.filter((role) => actorRoles.includes(role)));
  return held.length > 0 && held.every((role) => role === INVESTOR_RELATIONS);
}
