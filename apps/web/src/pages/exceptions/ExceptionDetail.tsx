import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Input, Label, useArrowNavigationGroup } from '@fluentui/react-components';
import type { DataException, DataExceptionCommandBody } from '@pb/contracts';
import type { ExceptionCommand } from '@pb/workflows';
import { ApiError } from '../../api/client.js';
import { describeActionError } from '../../app/mutations.js';
import { meQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  ErrorState,
  Field,
  KeyValueTable,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  SimulatedBadge,
} from '../../components/ui.js';
import { ActionStatus, ReasonDialog } from '../../components/WorkflowActions.js';
import { formatDateTime, MISSING } from '../../lib/format.js';
import { resultSuffix, useActionLog } from '../../lib/workflow.js';
import { exceptionQuery, useExceptionCommand } from './exceptions-queries.js';
import {
  blockedReason,
  commandResult,
  contextLink,
  EXCEPTIONS_FORBIDDEN,
  exceptionActions,
  exceptionStateWord,
  exceptionTone,
  isTicket,
  MAX_TICKET_LENGTH,
  positionText,
  rowText,
  severityLabel,
  severityTone,
  sourceLabel,
  transitionLabel,
} from './exceptions.js';
import './exceptions.css';

function BackLink(): ReactNode {
  return (
    <p className="pb-meta">
      <Link to="/data/exceptions" search={{}}>
        All exceptions
      </Link>
    </p>
  );
}

/** The run or file and the position the exception is about, as links where the reader may follow them. */
function Context({ x }: { x: DataException }): ReactNode {
  const link = contextLink(x);
  const row = rowText(x);
  const position = positionText(x);
  if (link === null && row === null && position === null)
    return <span className="pb-meta">{x.entity}</span>;
  return (
    <span className="pb-exceptions-context-line">
      {link === null ? (
        <span>{x.context.intakeFileName ?? x.entity}</span>
      ) : (
        <Link to={link.to} params={link.params}>
          {link.label}
        </Link>
      )}
      {row === null ? null : <span className="pb-key">{row}</span>}
      {position === null ? null : x.context.investmentId === null ? (
        <span>{position}</span>
      ) : (
        <Link to="/portfolio/$id" params={{ id: x.context.investmentId }}>
          {position}
        </Link>
      )}
    </span>
  );
}

function ActionsCard({ x, roles }: { x: DataException; roles: readonly string[] }): ReactNode {
  const ticketId = useId();
  const log = useActionLog();
  const command = useExceptionCommand();
  const [dialog, setDialog] = useState<ExceptionCommand | null>(null);
  const [ticket, setTicket] = useState(x.externalTicket ?? '');
  const actions = exceptionActions(roles, x.state);
  const busy = command.isPending;
  // The action buttons are one tab stop with the arrow keys moving between them (the toolbar
  // pattern). The group also keeps Fluent's focus manager alive across the reason dialog: were the
  // dialog its only user on the page, closing it would dispose the manager with the aria-hidden it
  // put on the rest of the page still in place, leaving the page unreadable to a screen reader.
  const arrows = useArrowNavigationGroup({ axis: 'horizontal' });
  // The reason dialog has no trigger of its own, so when it closes focus is returned explicitly,
  // once the dialog is out of the document: to the button that opened it when the dialog was
  // cancelled, and to the actions group when it was submitted, since the command that follows
  // changes the state and takes that button away (a resolved exception lists no transition).
  const openers = useRef(new Map<string, HTMLButtonElement>());
  const group = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef<{ opener: string | null } | null>(null);
  // Fluent's Button infers its ref element from a slot union, so the element is captured by a
  // typed callback rather than a ref object.
  const captureOpener = useCallback((command: string, el: HTMLButtonElement | null): void => {
    if (el === null) openers.current.delete(command);
    else openers.current.set(command, el);
  }, []);
  useEffect(() => {
    if (dialog !== null || returnFocus.current === null) return;
    const { opener } = returnFocus.current;
    returnFocus.current = null;
    const target = opener === null ? group.current : (openers.current.get(opener) ?? group.current);
    target?.focus();
  }, [dialog]);

  const issue = (body: DataExceptionCommandBody): void => {
    const label = body.command === 'set_ticket' ? 'Set ticket' : transitionLabel(body.command);
    command.mutate(
      { id: x.id, body },
      {
        onSuccess: (after) =>
          log.record('good', `${commandResult(body.command, after)} ${resultSuffix()}`),
        onError: (error) => log.record('bad', `${label}: ${describeActionError(error)}`),
      },
    );
  };

  return (
    <Card testId="exception-actions">
      <SectionHeader aside={<SimulatedBadge />}>Actions</SectionHeader>
      {!actions.offered ? (
        <p className="pb-meta" data-testid="exception-read-only">
          Operations works the queue; your role reads it.
        </p>
      ) : (
        <>
          <div
            ref={group}
            className="pb-exceptions-actions"
            tabIndex={-1}
            data-testid="exception-actions-group"
            {...arrows}
          >
            {actions.transitions.length === 0 ? (
              <p className="pb-meta" data-testid="exception-terminal">
                {exceptionStateWord(x.state)} is final: a problem that comes back opens a new
                exception.
              </p>
            ) : (
              actions.transitions.map((option) => {
                const blocked = blockedReason(option);
                return (
                  <Button
                    key={option.command}
                    ref={(el) => captureOpener(option.command, el)}
                    size="small"
                    appearance={option.command === 'acknowledge' ? 'primary' : 'outline'}
                    disabledFocusable={blocked !== null || busy}
                    {...(blocked === null ? {} : { title: blocked })}
                    onClick={() => {
                      if (option.needsReason) setDialog(option.command);
                      else issue({ command: option.command });
                    }}
                  >
                    {transitionLabel(option.command)}
                  </Button>
                );
              })
            )}
          </div>
          <form
            className="pb-exceptions-ticket"
            onSubmit={(event) => {
              event.preventDefault();
              if (isTicket(ticket)) issue({ command: 'set_ticket', externalTicket: ticket.trim() });
            }}
          >
            <Field>
              <Label htmlFor={ticketId}>External ticket</Label>
              <Input
                id={ticketId}
                className="pb-exceptions-ticket-input"
                value={ticket}
                maxLength={MAX_TICKET_LENGTH}
                placeholder="Help desk or provider reference"
                onChange={(_e, d) => setTicket(d.value)}
              />
            </Field>
            <Button
              type="submit"
              size="small"
              appearance="secondary"
              disabled={!isTicket(ticket) || busy}
            >
              Set ticket
            </Button>
          </form>
        </>
      )}
      <ActionStatus latest={log.latest} testId="exception-action-status" />
      {dialog !== null ? (
        <ReasonDialog
          title={transitionLabel(dialog)}
          subject={`${x.ruleId} from ${sourceLabel(x.source)}${rowText(x) === null ? '' : `, ${rowText(x)}`}`}
          onCancel={() => {
            returnFocus.current = { opener: dialog };
            setDialog(null);
          }}
          onSubmit={(reason) => {
            returnFocus.current = { opener: null };
            issue({ command: dialog, reason });
            setDialog(null);
          }}
        />
      ) : null}
    </Card>
  );
}

function ExceptionBody({ x, roles }: { x: DataException; roles: readonly string[] }): ReactNode {
  return (
    <>
      <BackLink />
      <PageHeader
        title={x.ruleId}
        meta={
          <span className="pb-meta-list">
            <span>{sourceLabel(x.source)}</span>
            <span>Opened {formatDateTime(x.createdAt)}</span>
          </span>
        }
        actions={
          <span className="pb-exceptions-badges">
            <Badge tone={severityTone(x.severity)}>{severityLabel(x.severity)}</Badge>
            <Badge tone={exceptionTone(x.state)}>{exceptionStateWord(x.state)}</Badge>
          </span>
        }
        testId="exception-banner"
      />
      <Card testId="exception-detail">
        <SectionHeader>What the intake found</SectionHeader>
        <KeyValueTable
          label="Exception"
          rows={[
            { label: 'Expected', value: x.expected ?? MISSING },
            { label: 'Actual', value: x.actual ?? MISSING },
            { label: 'Context', value: <Context x={x} /> },
            {
              label: 'Candidates',
              value:
                x.candidates.length === 0
                  ? MISSING
                  : `${x.candidates.length} (${x.candidates.map((c) => c.reason).join(', ')}); listed on the staged row`,
            },
            { label: 'Owner', value: x.owner ?? MISSING },
            { label: 'External ticket', value: x.externalTicket ?? MISSING },
            { label: 'Updated', value: formatDateTime(x.updatedAt) },
          ]}
        />
      </Card>
      <ActionsCard x={x} roles={roles} />
    </>
  );
}

/**
 * One data exception (docs/18 section 9): what the intake found, where, and the commands the
 * signed-in roles may issue on it; acknowledge takes it, resolve and won't fix close it with a
 * reason, the ticket notes where it is being worked outside.
 */
export function ExceptionDetailPage(): ReactNode {
  const { id } = useParams({ from: '/app/data/exceptions/$id' });
  const me = useQuery(meQuery);
  const q = useQuery(exceptionQuery(id));
  if (q.isPending) return <PageSkeleton rows={6} />;
  if (q.isError) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <>
        <BackLink />
        {missing ? (
          <ErrorState
            title="Exception not found or not visible to you"
            detail="There is no data exception with this id in your view."
          />
        ) : (
          <UnavailableState
            card
            error={q.error}
            subject="This exception"
            forbidden={EXCEPTIONS_FORBIDDEN}
            errorTitle="Exception unavailable"
            testId="exception-unavailable"
          />
        )}
      </>
    );
  }
  return <ExceptionBody x={q.data} roles={me.data?.roles ?? []} />;
}
