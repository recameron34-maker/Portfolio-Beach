import { useState } from 'react';
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
  Textarea,
} from '@fluentui/react-components';
import type {
  QaFindingRow,
  ReportPackageCommandBody,
  ReportPackageDetail,
  ReportPackageState,
} from '@pb/contracts';
import type { ReportingPackageCommand } from '@pb/workflows';
import { CommandButtons, ReasonDialog } from '../../../components/WorkflowActions.js';
import { SimulatedBadge } from '../../../components/ui.js';
import { commandLabel } from '../../../lib/states.js';
import type { CommandOption } from '../../../lib/states.js';
import { resultSuffix } from '../../../lib/workflow.js';
import type { ActionLog } from '../../../lib/workflow.js';
import { describePackageError, usePackageCommand } from './api.js';
import {
  commandResultWords,
  explanationProblem,
  openFailures,
  overrideSubject,
  personCommands,
  positionWords,
  regenerateBody,
  tieOutWords,
  unexplainedTieOuts,
} from './packages.js';
import type { PositionNames } from './packages.js';

type PackageOption = CommandOption<ReportPackageState, ReportingPackageCommand>;

/**
 * Asks, before a regeneration, why a begin NAV differs from the last released package: one
 * optional box for each position whose tie-out failed with no explanation on record, beside
 * the two figures the check compared. A box left empty sends nothing for its position (the
 * record is to be fixed instead); one that is filled in is checked against the contract before
 * anything is sent. An explanation stays on the package, and the dialog says so first.
 */
function ExplanationsDialog({
  gaps,
  names,
  onCancel,
  onSubmit,
}: {
  /** The failed tie-out findings, one per position. */
  gaps: readonly QaFindingRow[];
  names: PositionNames;
  onCancel: () => void;
  onSubmit: (body: ReportPackageCommandBody) => void;
}): ReactNode {
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [touched, setTouched] = useState(false);
  const body = regenerateBody(drafts);
  return (
    <Dialog
      open
      onOpenChange={(_e, d) => {
        if (!d.open) onCancel();
      }}
    >
      <DialogSurface>
        <form
          // The dialog says what a box needs in its own words.
          noValidate
          data-testid="package-explanations-form"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (body !== null) onSubmit(body);
          }}
        >
          <DialogBody>
            <DialogTitle>Regenerate</DialogTitle>
            <DialogContent className="pb-dialog-content">
              <p className="pb-meta">
                {gaps.length === 1
                  ? 'The begin NAV of 1 position does'
                  : `The begin NAVs of ${gaps.length} positions do`}{' '}
                not tie to the last released package. Explain a difference that is expected; leave a
                box empty where the record is to be fixed instead. An explanation stays on the
                package and cannot be removed.
              </p>
              {gaps.map((gap) => {
                // Read as an own key only: a position number is data, never a property name.
                const text = Object.hasOwn(drafts, gap.entityRef)
                  ? (drafts[gap.entityRef] ?? '')
                  : '';
                const problem = touched ? explanationProblem(text) : null;
                return (
                  <FluentField
                    key={gap.entityRef}
                    label={positionWords(gap.entityRef, names)}
                    hint={`${tieOutWords(gap)} Optional, 3 to 500 characters.`}
                    {...(problem === null
                      ? {}
                      : { validationState: 'error' as const, validationMessage: problem })}
                  >
                    <Textarea
                      value={text}
                      resize="vertical"
                      onChange={(_e, d) =>
                        setDrafts((prev) => ({ ...prev, [gap.entityRef]: d.value }))
                      }
                      onBlur={() => setTouched(true)}
                    />
                  </FluentField>
                );
              })}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onCancel}>
                Cancel
              </Button>
              <Button appearance="primary" type="submit" disabled={touched && body === null}>
                Regenerate
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * The commands of the release gate (docs/18 section 5): one button for each step a person may
 * take from the package's state, live for the roles the transition table names and disabled,
 * with the role it needs, for everyone else. Every command carries the row version of the
 * package as the page shows it, so one that somebody moved meanwhile is refused instead of
 * being moved twice. What the API alone can judge is left to it and its refusal is shown: an
 * approver is offered Approve whoever prepared the package (SEC-5.6). An override asks for its
 * reason first; a regeneration asks for explanations only when a tie-out failed unexplained.
 */
export function PackageActions({
  detail,
  roles,
  names,
  onLog,
}: {
  detail: ReportPackageDetail;
  /** The roles of the signed-in person; none while they are not known. */
  roles: readonly string[];
  names: PositionNames;
  onLog: ActionLog;
}): ReactNode {
  const command = usePackageCommand();
  const [overriding, setOverriding] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const options = personCommands(detail.state, roles);
  const gaps = unexplainedTieOuts(detail);
  if (options.length === 0) return null;

  const send = (body: ReportPackageCommandBody): void =>
    command.mutate(
      { id: detail.id, rowVersion: detail.rowVersion, body },
      {
        onSuccess: (answer) =>
          onLog.record('good', `${commandResultWords(body.command, answer)} ${resultSuffix()}`),
        onError: (error) =>
          onLog.record('bad', `${commandLabel(body.command)}: ${describePackageError(error)}`),
      },
    );
  const issue = (option: PackageOption): void => {
    switch (option.command) {
      case 'overrideQa':
        setOverriding(true);
        return;
      case 'regenerate':
        if (gaps.length > 0) setExplaining(true);
        else send({ command: 'regenerate' });
        return;
      case 'generate':
      case 'submit':
      case 'approve':
      case 'release':
        send({ command: option.command });
        return;
      // The outcome of the checks is the system's to state: personCommands never offers it.
      case 'qaPass':
      case 'qaFail':
        return;
    }
  };
  return (
    <>
      <div className="pb-pkg-actions" data-testid="package-actions">
        <CommandButtons
          options={options}
          busy={command.isPending}
          appearance="secondary"
          onIssue={issue}
        />
        <SimulatedBadge />
      </div>
      {overriding ? (
        <ReasonDialog
          title="Override QA"
          subject={overrideSubject(openFailures(detail.findings))}
          onCancel={() => setOverriding(false)}
          onSubmit={(reason) => {
            send({ command: 'overrideQa', reason });
            setOverriding(false);
          }}
        />
      ) : null}
      {explaining ? (
        <ExplanationsDialog
          gaps={gaps}
          names={names}
          onCancel={() => setExplaining(false)}
          onSubmit={(body) => {
            send(body);
            setExplaining(false);
          }}
        />
      ) : null}
    </>
  );
}
