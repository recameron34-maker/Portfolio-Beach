import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
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
  Textarea,
} from '@fluentui/react-components';
import type {
  DealStage,
  OpportunityCommand,
  OpportunityCommandBody,
  OpportunityDetail,
} from '@pb/contracts';
import { dealStageMachine } from '@pb/workflows';
import { describeActionError } from '../../app/mutations.js';
import { taxonomyQuery } from '../../app/queries.js';
import { CommandButtons, ReasonDialog } from '../../components/WorkflowActions.js';
import { formatMoneyM, labelOf } from '../../lib/format.js';
import { commandLabel, commandOptions, humanizeState } from '../../lib/states.js';
import type { CommandOption } from '../../lib/states.js';
import { resultSuffix } from '../../lib/workflow.js';
import type { ActionLog } from '../../lib/workflow.js';
import { useOpportunityCommand } from './api.js';
import { advanceBlocker, isIsoDate, isPositiveAmount, nextStage, termsOf } from './pipeline.js';

type StageOption = CommandOption<DealStage, OpportunityCommand>;

type Pending =
  | { kind: 'pass'; option: StageOption }
  | { kind: 'reopen'; option: StageOption }
  | { kind: 'override'; option: StageOption }
  | { kind: 'closing'; option: StageOption };

/** A pass needs a reason code from the taxonomy (docs/04 M5) and may carry a note. */
function PassDialog({
  subject,
  onCancel,
  onSubmit,
}: {
  subject: string;
  onCancel: () => void;
  onSubmit: (passReasonCode: string, note: string) => void;
}): ReactNode {
  const taxonomy = useQuery(taxonomyQuery);
  const reasons = termsOf(taxonomy.data, 'pass_reason');
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  return (
    <Dialog
      open
      onOpenChange={(_e, d) => {
        if (!d.open) onCancel();
      }}
    >
      <DialogSurface>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (code !== '') onSubmit(code, note.trim());
          }}
        >
          <DialogBody>
            <DialogTitle>Pass</DialogTitle>
            <DialogContent className="pb-dialog-content">
              <p className="pb-meta">{subject}</p>
              <FluentField
                label="Reason code"
                required
                hint="A pass needs a reason code; the pass history is searchable by it (docs/04 M5)."
              >
                <Dropdown
                  placeholder={reasons.length === 0 ? 'No reason codes loaded' : 'Choose a reason'}
                  value={code === '' ? '' : labelOf(code)}
                  selectedOptions={code === '' ? [] : [code]}
                  onOptionSelect={(_e, d) => setCode(d.optionValue ?? '')}
                >
                  {reasons.map((r) => (
                    <Option key={r.code} value={r.code} text={r.label}>
                      {r.label}
                    </Option>
                  ))}
                </Dropdown>
              </FluentField>
              <FluentField label="Note" hint="Optional, in plain words.">
                <Textarea value={note} resize="vertical" onChange={(_e, d) => setNote(d.value)} />
              </FluentField>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onCancel}>
                Cancel
              </Button>
              <Button appearance="primary" type="submit" disabled={code === ''}>
                Pass
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}

/** Approved to Closing opens the closing record, so the close date and the commitment travel with the command. */
function ClosingDialog({
  subject,
  initialCommitment,
  onCancel,
  onSubmit,
}: {
  subject: string;
  initialCommitment: string;
  onCancel: () => void;
  onSubmit: (closeDate: string, commitmentAmount: string) => void;
}): ReactNode {
  const [closeDate, setCloseDate] = useState('');
  const [commitment, setCommitment] = useState(initialCommitment);
  const [touched, setTouched] = useState(false);
  const amount = commitment.trim();
  const ready = isIsoDate(closeDate) && isPositiveAmount(amount);
  return (
    <Dialog
      open
      onOpenChange={(_e, d) => {
        if (!d.open) onCancel();
      }}
    >
      <DialogSurface>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (ready) onSubmit(closeDate, amount);
          }}
        >
          <DialogBody>
            <DialogTitle>Open closing</DialogTitle>
            <DialogContent className="pb-dialog-content">
              <p className="pb-meta">{subject}</p>
              <p className="pb-meta">
                The close date is the single source for every report (docs/04 M8); the checklist
                from config/closing_checklist.json opens with it.
              </p>
              <FluentField
                label="Close date"
                required
                {...(touched && !isIsoDate(closeDate)
                  ? { validationState: 'error' as const, validationMessage: 'Give the close date.' }
                  : {})}
              >
                <Input type="date" value={closeDate} onChange={(_e, d) => setCloseDate(d.value)} />
              </FluentField>
              <FluentField
                label="Commitment (dollars)"
                required
                {...(touched && !isPositiveAmount(amount)
                  ? {
                      validationState: 'error' as const,
                      validationMessage:
                        'Use digits with an optional decimal point, above zero, for example 15000000.00.',
                    }
                  : {
                      hint: isPositiveAmount(amount)
                        ? `Reads as ${formatMoneyM(amount)}. Allocations must tie to it before the deal closes (M22).`
                        : 'Digits with an optional decimal point, for example 15000000.00.',
                    })}
              >
                <Input
                  inputMode="decimal"
                  value={commitment}
                  onChange={(_e, d) => setCommitment(d.value)}
                />
              </FluentField>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onCancel}>
                Cancel
              </Button>
              <Button appearance="primary" type="submit" disabled={!ready}>
                Open closing
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}

/** The commitment the closing dialog starts from: the latest approved IC amount, else the target. */
function suggestedCommitment(detail: OpportunityDetail): string {
  const approved = [...detail.icDecisions]
    .filter((d) => d.decision === 'approved' && d.amount !== null)
    .sort((a, b) => b.decisionDate.localeCompare(a.decisionDate))[0];
  return approved?.amount ?? detail.targetCommitment ?? '';
}

/**
 * The stage commands the transition table lists from this stage (docs/18 section 4): advance,
 * pass with a reason code, reopen with a reason. A gate the detail reports as closed disables the
 * advance and names the rule in the button's title; the API decides for real.
 */
export function StageActions({
  detail,
  roles,
  log,
}: {
  detail: OpportunityDetail;
  roles: readonly string[];
  log: ActionLog;
}): ReactNode {
  const command = useOpportunityCommand();
  const [pending, setPending] = useState<Pending | null>(null);
  const raw: StageOption[] = commandOptions(dealStageMachine, detail.stage, roles);
  const blocker = advanceBlocker(detail.stage, detail.gates, roles);
  const gatedKeys = new Set(
    raw
      .filter((o) => o.command === 'advance' && o.allowed && blocker !== null)
      .map((o) => `${o.command}-${o.to}`),
  );
  const options = raw.map((o) =>
    gatedKeys.has(`${o.command}-${o.to}`) ? { ...o, allowed: false } : o,
  );
  const next = nextStage(detail.stage);
  const subject = `${detail.name} (${detail.companyName}), now ${humanizeState(detail.stage)}`;
  const issue = (option: StageOption, body: OpportunityCommandBody): void => {
    command.mutate(
      { id: detail.id, body },
      {
        onSuccess: (updated) =>
          log.record(
            'good',
            `${updated.name} is now ${humanizeState(updated.stage)}${
              updated.stage === 'Closed' && updated.investmentId !== null
                ? ' and converted into a position'
                : ''
            } ${resultSuffix()}`,
          ),
        onError: (error) =>
          log.record(
            'bad',
            `${commandLabel(option.command)} for ${detail.name}: ${describeActionError(error)}`,
          ),
      },
    );
  };
  const start = (option: StageOption): void => {
    switch (option.command) {
      case 'pass':
        setPending({ kind: 'pass', option });
        return;
      case 'reopen':
        setPending({ kind: 'reopen', option });
        return;
      case 'advance':
        if (detail.stage === 'Approved') setPending({ kind: 'closing', option });
        else if (detail.stage === 'Diligence' && !detail.gates.diligence.ok)
          setPending({ kind: 'override', option });
        else issue(option, { command: 'advance' });
    }
  };
  const close = (): void => setPending(null);
  const notes = options.filter((o) => o.note !== undefined);
  return (
    <div className="pb-pipe-actions" data-testid="opportunity-stage-actions">
      {options.length === 0 ? (
        <p className="pb-meta">
          {humanizeState(detail.stage)} is the last stage; nothing further to do.
        </p>
      ) : (
        <CommandButtons
          options={options}
          busy={command.isPending}
          appearance="secondary"
          context={detail.name}
          notAllowedTitle={(o) =>
            gatedKeys.has(`${o.command}-${o.to}`) ? (blocker ?? undefined) : undefined
          }
          onIssue={start}
        />
      )}
      <ul className="pb-list pb-cap-notes">
        {next === null ? null : (
          <li className="pb-meta">Advance moves the deal to {humanizeState(next)}.</li>
        )}
        {notes.map((o) => (
          <li key={`${o.command}-${o.to}`} className="pb-meta">
            {commandLabel(o.command)}: {o.note}
          </li>
        ))}
      </ul>
      {pending?.kind === 'pass' ? (
        <PassDialog
          subject={subject}
          onCancel={close}
          onSubmit={(passReasonCode, note) => {
            issue(pending.option, {
              command: 'pass',
              passReasonCode,
              ...(note === '' ? {} : { note }),
            });
            close();
          }}
        />
      ) : null}
      {pending?.kind === 'reopen' ? (
        <ReasonDialog
          title="Reopen"
          subject={`${subject}. Reopening returns the deal to Screening.`}
          onCancel={close}
          onSubmit={(reason) => {
            issue(pending.option, { command: 'reopen', reason });
            close();
          }}
        />
      ) : null}
      {pending?.kind === 'override' ? (
        <ReasonDialog
          title="Advance"
          subject={`${subject}. Diligence tasks required for IC are still open: your reason is recorded with the override (docs/18 section 4).`}
          onCancel={close}
          onSubmit={(reason) => {
            issue(pending.option, { command: 'advance', reason });
            close();
          }}
        />
      ) : null}
      {pending?.kind === 'closing' ? (
        <ClosingDialog
          subject={subject}
          initialCommitment={suggestedCommitment(detail)}
          onCancel={close}
          onSubmit={(closeDate, commitmentAmount) => {
            issue(pending.option, { command: 'advance', closeDate, commitmentAmount });
            close();
          }}
        />
      ) : null}
    </div>
  );
}
