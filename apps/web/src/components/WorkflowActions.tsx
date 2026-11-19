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
 * with a single group of commands may show why a command is blocked (`showBlockedReason`), one
 * line per reason under the buttons, and each blocked button points to its own.
 */
export function CommandButtons<S extends string, C extends string>({
  options,
  busy,
  context,
  notAllowedTitle,
  appearance = 'subtle',
  primary,
  showBlockedReason = false,
  onIssue,
}: {
  options: readonly CommandOption<S, C>[];
  busy: boolean;
  context?: string | undefined;
  notAllowedTitle?: ((option: CommandOption<S, C>) => string | undefined) | undefined;
  appearance?: 'subtle' | 'outline' | 'secondary';
  primary?: C | undefined;
  showBlockedReason?: boolean;
  onIssue: (option: CommandOption<S, C>) => void;
}): ReactNode {
  const reasonId = useId();
  if (options.length === 0) return <span className="pb-visually-hidden">No actions</span>;
  const blocked = options.map((o) => blockedTitle(o, notAllowedTitle?.(o)));
  const reasons = showBlockedReason
    ? [...new Set(blocked.filter((b): b is string => b !== null))]
    : [];
  const buttons = (
    <span className="pb-command-buttons">
      {options.map((o, i) => {
        const why = blocked[i] ?? null;
        const label = commandLabel(o.command);
        return (
          <Button
            key={`${o.command}-${o.to}`}
            size="small"
            appearance={o.command === primary ? 'primary' : appearance}
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
      })}
    </span>
  );
  if (reasons.length === 0) return buttons;
  return (
    <span className="pb-command-group">
      {buttons}
      <span className="pb-meta pb-command-reason">
        {reasons.map((r, i) => (
          <span key={r} id={`${reasonId}-${i}`}>
            {r}
          </span>
        ))}
      </span>
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
