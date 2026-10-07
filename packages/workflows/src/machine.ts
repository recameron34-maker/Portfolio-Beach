/**
 * A transition table is the only way a workflow state changes (docs/18). Each row names the
 * command, the roles that may issue it and a precondition over the record and the actor.
 * Anything not in the table is forbidden; tests enumerate every forbidden pair.
 */
export interface TransitionContext {
  actorId: string;
  actorRoles: readonly string[];
  /** Reason text supplied with the command, when the table requires one. */
  reason?: string;
  /** The record the command targets, as a plain object the preconditions can read. */
  record: Readonly<Record<string, unknown>>;
}

export interface Transition<S extends string, C extends string> {
  from: S;
  to: S;
  command: C;
  roles: readonly string[];
  /** Returns a failure message, or null when the transition may proceed. */
  precondition?: (ctx: TransitionContext) => string | null;
  /** Plain-language note shown in the UI and docs. */
  note?: string;
}

export interface Machine<S extends string, C extends string> {
  name: string;
  states: readonly S[];
  commands: readonly C[];
  initial: S;
  terminal: readonly S[];
  transitions: readonly Transition<S, C>[];
}

export type TransitionResult<S extends string> =
  { ok: true; to: S } | { ok: false; code: 'forbidden' | 'role' | 'precondition'; message: string };

/** Evaluates one command against the table. Pure: the caller persists the new state and the audit event. */
export function attempt<S extends string, C extends string>(
  machine: Machine<S, C>,
  from: S,
  command: C,
  ctx: TransitionContext,
): TransitionResult<S> {
  const candidates = machine.transitions.filter((t) => t.from === from && t.command === command);
  if (candidates.length === 0) {
    return {
      ok: false,
      code: 'forbidden',
      message: `${machine.name}: ${command} is not allowed from ${from}`,
    };
  }
  const byRole = candidates.filter((t) => t.roles.some((r) => ctx.actorRoles.includes(r)));
  if (byRole.length === 0) {
    const needed = [...new Set(candidates.flatMap((t) => t.roles))].join(', ');
    return {
      ok: false,
      code: 'role',
      message: `${machine.name}: ${command} from ${from} requires one of: ${needed}`,
    };
  }
  let lastFailure: string | null = null;
  for (const t of byRole) {
    const failure = t.precondition?.(ctx) ?? null;
    if (failure === null) return { ok: true, to: t.to };
    lastFailure = failure;
  }
  return {
    ok: false,
    code: 'precondition',
    message: `${machine.name}: ${lastFailure ?? 'precondition failed'}`,
  };
}

/** All (state, command) pairs that no row allows, for exhaustive rejection tests. */
export function forbiddenPairs<S extends string, C extends string>(
  machine: Machine<S, C>,
): { from: S; command: C }[] {
  const out: { from: S; command: C }[] = [];
  for (const from of machine.states) {
    for (const command of machine.commands) {
      if (!machine.transitions.some((t) => t.from === from && t.command === command))
        out.push({ from, command });
    }
  }
  return out;
}

export const requireReason = (ctx: TransitionContext): string | null =>
  ctx.reason !== undefined && ctx.reason.trim().length > 0 ? null : 'a reason is required';

export const flag =
  (key: string, expected: boolean, message: string) =>
  (ctx: TransitionContext): string | null =>
    ctx.record[key] === expected ? null : message;

export const notSameAs =
  (key: string, message: string) =>
  (ctx: TransitionContext): string | null =>
    ctx.record[key] !== ctx.actorId ? null : message;

export const all =
  (...checks: ((ctx: TransitionContext) => string | null)[]) =>
  (ctx: TransitionContext): string | null => {
    for (const c of checks) {
      const f = c(ctx);
      if (f !== null) return f;
    }
    return null;
  };
