import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field as FluentField,
  Input,
  Option,
} from '@fluentui/react-components';
import { uuid } from '@pb/contracts';
import type { DiligenceTask, DiligenceTaskCommandBody } from '@pb/contracts';
import { describeActionError } from '../../app/mutations.js';
import { taxonomyQuery } from '../../app/queries.js';
import { ReasonDialog } from '../../components/WorkflowActions.js';
import { Badge, Card, EmptyState, SectionHeader, TableWrap } from '../../components/ui.js';
import { formatDate, labelOf, MISSING, plural } from '../../lib/format.js';
import { humanizeState } from '../../lib/states.js';
import { blockedTitle, resultSuffix } from '../../lib/workflow.js';
import type { ActionLog } from '../../lib/workflow.js';
import { useCreateDiligenceTask, useDiligenceTaskCommand } from './api.js';
import {
  carriedOverNote,
  isIsoDate,
  mayUse,
  personName,
  PIPELINE_ROLES,
  taskStatusTone,
  termsOf,
} from './pipeline.js';
import { dialogSurfaceMotion, useJustChanged, useReducedMotion } from '../../components/motion.js';

type Pending = { kind: 'complete'; task: DiligenceTask } | { kind: 'waive'; task: DiligenceTask };

/** Completing a task may name the hub document that evidences it; the id is optional. */
function EvidenceDialog({
  task,
  onCancel,
  onSubmit,
}: {
  task: DiligenceTask;
  onCancel: () => void;
  onSubmit: (evidenceDocumentId: string | null) => void;
}): ReactNode {
  const [documentId, setDocumentId] = useState('');
  const id = documentId.trim();
  const ok = id === '' || uuid.safeParse(id).success;
  const motion = dialogSurfaceMotion(useReducedMotion());
  return (
    <Dialog
      surfaceMotion={motion}
      open
      onOpenChange={(_e, d) => {
        if (!d.open) onCancel();
      }}
    >
      <DialogSurface className="pb-dialog" backdrop={{ className: 'pb-dialog-backdrop' }}>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) onSubmit(id === '' ? null : id);
          }}
        >
          <DialogBody>
            <DialogTitle>Complete task</DialogTitle>
            <DialogContent className="pb-dialog-content">
              <p className="pb-meta">{task.title}</p>
              <FluentField
                label="Evidence document id"
                {...(ok
                  ? {
                      hint: 'Optional: the id of the hub document that evidences the task. Leave it blank to complete without evidence.',
                    }
                  : {
                      validationState: 'error' as const,
                      validationMessage: 'A document id is a UUID as the document hub shows it.',
                    })}
              >
                <Input
                  className="pb-pipe-id"
                  value={documentId}
                  onChange={(_e, d) => setDocumentId(d.value)}
                />
              </FluentField>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onCancel}>
                Cancel
              </Button>
              <Button appearance="primary" type="submit" disabled={!ok}>
                Complete
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}

function AddTaskForm({
  opportunityId,
  roles,
  log,
}: {
  opportunityId: string;
  roles: readonly string[];
  log: ActionLog;
}): ReactNode {
  const taxonomy = useQuery(taxonomyQuery);
  const create = useCreateDiligenceTask();
  const [workstream, setWorkstream] = useState('');
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [requiredForIc, setRequiredForIc] = useState(false);
  const workstreams = termsOf(taxonomy.data, 'diligence_workstream');
  const blocked = blockedTitle({
    allowed: mayUse(roles, PIPELINE_ROLES.createTask),
    roles: PIPELINE_ROLES.createTask,
  });
  const ready = workstream !== '' && title.trim() !== '' && (dueDate === '' || isIsoDate(dueDate));
  const submit = (): void => {
    if (!ready || blocked !== null) return;
    create.mutate(
      {
        id: opportunityId,
        body: {
          workstream,
          title: title.trim(),
          ...(dueDate === '' ? {} : { dueDate }),
          requiredForIc,
        },
      },
      {
        onSuccess: () => {
          log.record('good', `Task added: ${title.trim()} ${resultSuffix()}`);
          setTitle('');
          setDueDate('');
          setRequiredForIc(false);
        },
        onError: (error) => log.record('bad', `Add task: ${describeActionError(error)}`),
      },
    );
  };
  return (
    <form
      noValidate
      className="pb-pipe-form"
      data-testid="diligence-task-form"
      aria-label="Add a diligence task"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <FluentField label="Workstream" required>
        <Dropdown
          placeholder={workstreams.length === 0 ? 'No workstreams loaded' : 'Choose a workstream'}
          value={workstream === '' ? '' : labelOf(workstream)}
          selectedOptions={workstream === '' ? [] : [workstream]}
          onOptionSelect={(_e, d) => setWorkstream(d.optionValue ?? '')}
        >
          {workstreams.map((w) => (
            <Option key={w.code} value={w.code} text={w.label}>
              {w.label}
            </Option>
          ))}
        </Dropdown>
      </FluentField>
      <FluentField className="pb-pipe-span-2" label="Title" required>
        <Input value={title} onChange={(_e, d) => setTitle(d.value)} />
      </FluentField>
      <FluentField label="Due date">
        <Input type="date" value={dueDate} onChange={(_e, d) => setDueDate(d.value)} />
      </FluentField>
      <Checkbox
        className="pb-pipe-check"
        label="Required for IC"
        checked={requiredForIc}
        onChange={(_e, d) => setRequiredForIc(d.checked === true)}
      />
      <Button
        className="pb-pipe-submit"
        appearance="secondary"
        type="submit"
        disabled={blocked !== null || !ready || create.isPending}
        {...(blocked === null ? {} : { title: blocked })}
      >
        Add task
      </Button>
    </form>
  );
}

function TaskActions({
  task,
  roles,
  busy,
  onStart,
  onReopen,
}: {
  task: DiligenceTask;
  roles: readonly string[];
  busy: boolean;
  onStart: (pending: Pending) => void;
  onReopen: (task: DiligenceTask) => void;
}): ReactNode {
  const blocked = blockedTitle({
    allowed: mayUse(roles, PIPELINE_ROLES.taskCommand),
    roles: PIPELINE_ROLES.taskCommand,
  });
  // A step back (Reopen) is drawn quiet, as it is on the valuation board, so the commands that move
  // the item on read first.
  const button = (
    label: string,
    onClick: () => void,
    appearance: 'outline' | 'subtle' = 'outline',
  ): ReactNode => (
    <Button
      size="small"
      appearance={appearance}
      disabled={blocked !== null || busy}
      {...(blocked === null ? {} : { title: blocked })}
      aria-label={`${label}, ${task.title}`}
      onClick={onClick}
    >
      {label}
    </Button>
  );
  return (
    <span className="pb-command-buttons">
      {task.status === 'open' ? (
        <>
          {button('Complete', () => onStart({ kind: 'complete', task }))}
          {button('Waive', () => onStart({ kind: 'waive', task }))}
        </>
      ) : (
        button('Reopen', () => onReopen(task), 'subtle')
      )}
    </span>
  );
}

/**
 * The diligence tasks of an opportunity (docs/04 M7 skeleton, docs/18 section 4): the template
 * tasks of its deal type plus any added by hand, with the IC gate's required flag. Read only on
 * the deal workspace's Diligence tab; on the opportunity page the deal team and approvers
 * complete, waive or reopen them and the deal team adds tasks. A deal that was passed and
 * reopened keeps the tasks it had done: the header says how many of the required ones predate
 * the reopen (the diligence gate's `carriedOver`).
 */
export function DiligenceTasksCard({
  opportunityId,
  tasks,
  carriedOver,
  roles,
  log,
  readOnly = false,
}: {
  opportunityId: string;
  tasks: readonly DiligenceTask[];
  /** Tasks required for IC done or waived before the deal was last reopened from Passed. */
  carriedOver: number;
  roles: readonly string[];
  log: ActionLog | null;
  readOnly?: boolean;
}): ReactNode {
  const command = useDiligenceTaskCommand();
  const changed = useJustChanged();
  const [pending, setPending] = useState<Pending | null>(null);
  const requiredOpen = tasks.filter((t) => t.requiredForIc && t.status === 'open').length;
  const carried = carriedOverNote(carriedOver);
  const issue = (task: DiligenceTask, body: DiligenceTaskCommandBody): void => {
    command.mutate(
      { id: opportunityId, taskId: task.id, body },
      {
        onSuccess: (updated) => {
          const now = updated.diligenceTasks.find((t) => t.id === task.id);
          changed.mark(task.id);
          log?.record(
            'good',
            `${task.title} is now ${humanizeState(now?.status ?? body.command)} ${resultSuffix()}`,
          );
        },
        onError: (error) =>
          log?.record(
            'bad',
            `${humanizeState(body.command)} ${task.title}: ${describeActionError(error)}`,
          ),
      },
    );
  };
  const close = (): void => setPending(null);
  return (
    <Card testId="diligence-tasks">
      <SectionHeader
        aside={
          tasks.length === 0
            ? undefined
            : `${plural(tasks.length, 'task')}, ${plural(requiredOpen, 'required task')} open${carried === null ? '' : `; ${carried}`}`
        }
      >
        Diligence tasks
      </SectionHeader>
      {tasks.length === 0 ? (
        <EmptyState
          title="No diligence tasks yet"
          detail="The template tasks of the deal type are created when the deal enters Diligence; the deal team may add tasks before that."
          testId="diligence-tasks-empty"
        />
      ) : (
        <TableWrap label="Diligence tasks">
          <table className="pb-table" aria-label="Diligence tasks">
            <thead>
              <tr>
                <th className="pb-col-fit">Workstream</th>
                <th className="pb-col-text">Task</th>
                <th className="pb-col-fit">Owner</th>
                <th className="pb-col-fit">Due</th>
                <th className="pb-col-fit">Status</th>
                <th className="pb-col-fit">For IC</th>
                <th className="pb-col-fit">Evidence</th>
                {readOnly ? null : <th className="pb-col-fit">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id} data-testid={`diligence-task-${t.id}`} {...changed.rowProps(t.id)}>
                  <td className="pb-col-fit">{labelOf(t.workstream)}</td>
                  <td className="pb-col-text">
                    {t.title}
                    {t.waivedReason === null ? null : (
                      <span className="pb-cell-sub">Waived: {t.waivedReason}</span>
                    )}
                  </td>
                  <td className="pb-col-fit">{personName(t.owner)}</td>
                  <td className="pb-col-fit">{formatDate(t.dueDate)}</td>
                  <td className="pb-col-fit">
                    <Badge tone={taskStatusTone(t)}>{humanizeState(t.status)}</Badge>
                  </td>
                  <td className="pb-col-fit">{t.requiredForIc ? 'Required' : 'Optional'}</td>
                  <td className="pb-col-fit">
                    {t.evidenceDocumentId === null ? (
                      MISSING
                    ) : (
                      <Link to="/documents/$id" params={{ id: t.evidenceDocumentId }}>
                        Document
                      </Link>
                    )}
                  </td>
                  {readOnly ? null : (
                    <td className="pb-col-fit">
                      <TaskActions
                        task={t}
                        roles={roles}
                        busy={command.isPending}
                        onStart={setPending}
                        onReopen={(task) => issue(task, { command: 'reopen' })}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {readOnly || log === null ? null : (
        <AddTaskForm opportunityId={opportunityId} roles={roles} log={log} />
      )}
      {pending?.kind === 'complete' ? (
        <EvidenceDialog
          task={pending.task}
          onCancel={close}
          onSubmit={(evidenceDocumentId) => {
            issue(pending.task, {
              command: 'complete',
              ...(evidenceDocumentId === null ? {} : { evidenceDocumentId }),
            });
            close();
          }}
        />
      ) : null}
      {pending?.kind === 'waive' ? (
        <ReasonDialog
          title="Waive"
          subject={pending.task.title}
          onCancel={close}
          onSubmit={(reason) => {
            issue(pending.task, { command: 'waive', reason });
            close();
          }}
        />
      ) : null}
    </Card>
  );
}
