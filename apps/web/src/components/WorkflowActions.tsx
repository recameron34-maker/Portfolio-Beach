import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field as FluentField,
  Input,
} from '@fluentui/react-components';
import { dialogSurfaceMotion, useReducedMotion } from './motion.js';
import { Badge, Card, SectionHeader } from './ui.js';
import { commandLabel } from '../lib/states.js';
import type { CommandOption } from '../lib/states.js';
import { blockedTitle, isReason, MIN_REASON_LENGTH } from '../lib/workflow.js';
import type { ActionEntry } from '../lib/workflow.js';

/**
 * One small button per command the transition table lists from the record's state, under the
 * binding action rules (workflow.ts). `context` names the record so each button has a distinct
 * accessible name in a table of rows. With no command the cell stays blank to the eye and says
 * "No actions" to a screen reader. `primary` marks the one command the page leads with; a page
 * with a single group of commands may show why a command is blocked (`showBlockedReason`): the
 * reason sits under the button it explains, from that button's edge (blocked buttons side by side
 * with the same reason share one line), and each blocked button points to its own. `label` words a
 * command more fully than its name ("Advance to IC"); `size` is medium for a page's own commands
 * in its header. `quiet` draws the commands that step back (send back, reopen) as subtle buttons,
 * so the one that moves the record on reads first.
 */
export function CommandButtons<S extends string, C extends string>({
  options,
  busy,
  context,
  notAllowedTitle,
  appearance = 'subtle',
  primary,
  quiet,
  showBlockedReason = false,
  label: labelFor,
  size = 'small',
  onIssue,
}: {
  options: readonly CommandOption<S, C>[];
  busy: boolean;
  context?: string | undefined;
  notAllowedTitle?: ((option: CommandOption<S, C>) => string | undefined) | undefined;
  appearance?: 'subtle' | 'outline' | 'secondary';
  primary?: C | undefined;
  quiet?: readonly C[] | undefined;
  showBlockedReason?: boolean;
  label?: ((option: CommandOption<S, C>) => string) | undefined;
  size?: 'small' | 'medium';
  onIssue: (option: CommandOption<S, C>) => void;
}): ReactNode {
  const reasonId = useId();
  if (options.length === 0) return <span className="pb-visually-hidden">No actions</span>;
  const blocked = options.map((o) => blockedTitle(o, notAllowedTitle?.(o)));
  const reasons = showBlockedReason
    ? [...new Set(blocked.filter((b): b is string => b !== null))]
    : [];
  const button = (o: CommandOption<S, C>, i: number): ReactNode => {
    const why = blocked[i] ?? null;
    const label = labelFor?.(o) ?? commandLabel(o.command);
    return (
      <Button
        key={`${o.command}-${o.to}`}
        size={size}
        appearance={
          o.command === primary
            ? 'primary'
            : quiet?.includes(o.command) === true
              ? 'subtle'
              : appearance
        }
        disabled={why !== null || busy}
        {...(why === null ? {} : { title: why })}
        {...(why !== null && reasons.includes(why)
          ? { 'aria-describedby': `${reasonId}-${reasons.indexOf(why)}` }
          : {})}
        {...(context === undefined ? {} : { 'aria-label': `${label}, ${context}` })}
        onClick={() => onIssue(o)}
      >
        {label}
      </Button>
    );
  };
  if (reasons.length === 0) {
    return <span className="pb-command-buttons">{options.map(button)}</span>;
  }
  // Runs of buttons side by side: a reason's first run of blocked buttons carries the reason under
  // it, from its first button's edge, so the words sit under the command they explain; every other
  // button stands alone (a later button blocked for the same reason points to the same line).
  const runs: { reason: number | null; buttons: ReactNode[] }[] = [];
  const shown = new Set<number>();
  options.forEach((o, i) => {
    const why = blocked[i] ?? null;
    const r = why === null ? -1 : reasons.indexOf(why);
    const last = runs[runs.length - 1];
    if (r >= 0 && last?.reason === r) last.buttons.push(button(o, i));
    else if (r >= 0 && !shown.has(r)) {
      shown.add(r);
      runs.push({ reason: r, buttons: [button(o, i)] });
    } else runs.push({ reason: null, buttons: [button(o, i)] });
  });
  return (
    <span className="pb-command-buttons pb-command-group">
      {runs.flatMap((run): ReactNode[] =>
        run.reason === null
          ? run.buttons
          : [
              <span key={`reason-${run.reason}`} className="pb-command-item">
                <span className="pb-command-run">{run.buttons}</span>
                <span className="pb-meta pb-command-reason" id={`${reasonId}-${run.reason}`}>
                  {reasons[run.reason]}
                </span>
              </span>,
            ],
      )}
    </span>
  );
}

/** Asks for the reason a send back or reopen needs before the command is sent (docs/18). */
export function ReasonDialog({
  title,
  subject,
  onCancel,
  onSubmit,
}: {
  title: string;
  subject: string;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}): ReactNode {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const valid = isReason(reason);
  const motion = dialogSurfaceMotion(useReducedMotion());
  return (
    <Dialog
      open
      surfaceMotion={motion}
      onOpenChange={(_e, d) => {
        if (!d.open) onCancel();
      }}
    >
      <DialogSurface className="pb-dialog" backdrop={{ className: 'pb-dialog-backdrop' }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) onSubmit(reason.trim());
            else setTouched(true);
          }}
        >
          <DialogBody>
            <DialogTitle>{title}</DialogTitle>
            <DialogContent className="pb-dialog-content">
              <p className="pb-meta">{subject}</p>
              <FluentField
                label="Reason"
                required
                hint={`At least ${MIN_REASON_LENGTH} characters. A reason is required at this step.`}
                {...(touched && !valid
                  ? {
                      validationState: 'error' as const,
                      validationMessage: `Give a reason of at least ${MIN_REASON_LENGTH} characters.`,
                    }
                  : {})}
              >
                <Input
                  value={reason}
                  onChange={(_e, d) => setReason(d.value)}
                  onBlur={() => setTouched(true)}
                />
              </FluentField>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onCancel}>
                Cancel
              </Button>
              <Button appearance="primary" type="submit" disabled={!valid}>
                {title}
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}

/** The page's one status region: the latest action result, good or refused (AdminFlags pattern). */
export function ActionStatus({
  latest,
  testId,
}: {
  latest: ActionEntry | null;
  testId: string;
}): ReactNode {
  return (
    <div role="status" className="pb-action-status" data-testid={testId}>
      {latest === null ? null : (
        <p
          key={latest.id}
          className={
            latest.tone === 'good' ? 'pb-notice pb-notice-good' : 'pb-notice pb-notice-bad'
          }
        >
          {latest.text}
        </p>
      )}
    </div>
  );
}

/** Every result this page session, newest first; kept in page memory only. */
export function ActionLogCard({ entries }: { entries: readonly ActionEntry[] }): ReactNode {
  return (
    <Card testId="action-log">
      <SectionHeader aside={entries.length === 0 ? undefined : `${entries.length} this session`}>
        Actions this session
      </SectionHeader>
      {entries.length === 0 ? (
        <p className="pb-meta">No actions yet</p>
      ) : (
        <ul className="pb-action-log" aria-label="Actions this session">
          {entries.map((e) => (
            <li key={e.id}>
              <Badge tone={e.tone}>{e.tone === 'good' ? 'Done' : 'Refused'}</Badge>
              <span>{e.text}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
