import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  Button,
  Dropdown,
  Field as FluentField,
  Input,
  Option,
  Textarea,
} from '@fluentui/react-components';
import { icDecisionOutcome } from '@pb/contracts';
import type { DealStage, IcDecision } from '@pb/contracts';
import { describeActionError } from '../../app/mutations.js';
import { Badge, Card, EmptyState, NumCell, SectionHeader, TableWrap } from '../../components/ui.js';
import { formatDate, formatMoneyM, plural } from '../../lib/format.js';
import { humanizeState } from '../../lib/states.js';
import { blockedTitle, resultSuffix } from '../../lib/workflow.js';
import type { ActionLog } from '../../lib/workflow.js';
import { useRecordIcDecision } from './api.js';
import {
  conditionsFromText,
  decisionTone,
  isIsoDate,
  isPositiveAmount,
  mayUse,
  PIPELINE_ROLES,
} from './pipeline.js';

type Outcome = IcDecision['decision'];

const OUTCOMES: readonly Outcome[] = icDecisionOutcome.options;

function isOutcome(value: string): value is Outcome {
  return (OUTCOMES as readonly string[]).includes(value);
}

const NOT_AT_IC = 'IC decisions are recorded while the deal is at IC (docs/18 section 4)';

function DecisionForm({
  opportunityId,
  stage,
  roles,
  log,
}: {
  opportunityId: string;
  stage: DealStage;
  roles: readonly string[];
  log: ActionLog;
}): ReactNode {
  const record = useRecordIcDecision();
  const [decisionDate, setDecisionDate] = useState('');
  const [decision, setDecision] = useState<Outcome | ''>('');
  const [amount, setAmount] = useState('');
  const [conditions, setConditions] = useState('');
  const [touched, setTouched] = useState(false);
  const amountText = amount.trim();
  const amountOk = amountText === '' || isPositiveAmount(amountText);
  const ready = isIsoDate(decisionDate) && amountOk;
  const blocked =
    blockedTitle({
      allowed: mayUse(roles, PIPELINE_ROLES.icDecision),
      roles: PIPELINE_ROLES.icDecision,
    }) ?? (stage === 'IC' ? null : NOT_AT_IC);
  const submit = (): void => {
    setTouched(true);
    if (!ready || blocked !== null || decision === '') return;
    record.mutate(
      {
        id: opportunityId,
        body: {
          decisionDate,
          decision,
          ...(amountText === '' ? {} : { amount: amountText }),
          conditions: conditionsFromText(conditions),
        },
      },
      {
        onSuccess: () => {
          log.record(
            'good',
            `IC decision recorded: ${humanizeState(decision)} on ${formatDate(decisionDate)} ${resultSuffix()}`,
          );
          setConditions('');
          setAmount('');
          setDecision('');
          setDecisionDate('');
          setTouched(false);
        },
        onError: (error) => log.record('bad', `Record IC decision: ${describeActionError(error)}`),
      },
    );
  };
  return (
    <form
      noValidate
      className="pb-pipe-form"
      data-testid="ic-decision-form"
      aria-label="Record an IC decision"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <FluentField
        label="Decision date"
        required
        {...(touched && !isIsoDate(decisionDate)
          ? { validationState: 'error' as const, validationMessage: 'Give the decision date.' }
          : {})}
      >
        <Input
          className="pb-pipe-control is-short"
          type="date"
          value={decisionDate}
          onChange={(_e, d) => setDecisionDate(d.value)}
        />
      </FluentField>
      <FluentField label="Decision" required>
        <Dropdown
          className="pb-pipe-control is-short"
          placeholder="Choose"
          value={decision === '' ? '' : humanizeState(decision)}
          selectedOptions={decision === '' ? [] : [decision]}
          onOptionSelect={(_e, d) => {
            const v = d.optionValue ?? '';
            setDecision(isOutcome(v) ? v : '');
          }}
        >
          {OUTCOMES.map((o) => (
            <Option key={o} value={o} text={humanizeState(o)}>
              {humanizeState(o)}
            </Option>
          ))}
        </Dropdown>
      </FluentField>
      <FluentField
        label="Amount (dollars)"
        {...(touched && !amountOk
          ? {
              validationState: 'error' as const,
              validationMessage: 'Digits with an optional decimal point, above zero.',
            }
          : {
              hint:
                amountText !== '' && amountOk
                  ? `Reads as ${formatMoneyM(amountText)}.`
                  : 'Optional.',
            })}
      >
        <Input
          className="pb-pipe-control"
          inputMode="decimal"
          value={amount}
          onChange={(_e, d) => setAmount(d.value)}
        />
      </FluentField>
      <FluentField label="Conditions" hint="One per line; blank lines are dropped.">
        <Textarea
          className="pb-pipe-control is-wide"
          value={conditions}
          resize="vertical"
          onChange={(_e, d) => setConditions(d.value)}
        />
      </FluentField>
      <Button
        appearance="secondary"
        type="submit"
        disabled={blocked !== null || record.isPending}
        {...(blocked === null ? {} : { title: blocked })}
      >
        Record decision
      </Button>
      {blocked === null ? null : <p className="pb-meta pb-pipe-form-note">{blocked}.</p>}
    </form>
  );
}

/**
 * IC decisions (docs/18 section 4): a new row supersedes; the latest approved one clears the gate
 * from IC to Approved. Approvers record them while the deal sits at IC.
 */
export function IcDecisionsCard({
  opportunityId,
  stage,
  decisions,
  roles,
  log,
  readOnly = false,
}: {
  opportunityId: string;
  stage: DealStage;
  decisions: readonly IcDecision[];
  roles: readonly string[];
  log: ActionLog | null;
  readOnly?: boolean;
}): ReactNode {
  const rows = [...decisions].sort((a, b) => b.decisionDate.localeCompare(a.decisionDate));
  return (
    <Card testId="ic-decisions">
      <SectionHeader
        aside={rows.length === 0 ? undefined : `${plural(rows.length, 'decision')}, newest first`}
      >
        IC decisions
      </SectionHeader>
      {rows.length === 0 ? (
        <EmptyState
          title="No IC decision recorded"
          detail="An approver records the committee's decision, its amount and conditions while the deal is at IC."
          testId="ic-decisions-empty"
        />
      ) : (
        <TableWrap label="IC decisions">
          <table className="pb-table" aria-label="IC decisions">
            <thead>
              <tr>
                <th>Date</th>
                <th>Decision</th>
                <th className="num">Amount</th>
                <th>Conditions</th>
                <th>Recorded by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td className="pb-nowrap">{formatDate(d.decisionDate)}</td>
                  <td>
                    <Badge tone={decisionTone(d.decision)}>{humanizeState(d.decision)}</Badge>
                  </td>
                  <NumCell>{formatMoneyM(d.amount)}</NumCell>
                  <td>
                    {d.conditions.length === 0 ? (
                      <span className="pb-meta">None</span>
                    ) : (
                      <ul className="pb-list">
                        {d.conditions.map((c, i) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td>{d.recordedBy.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {readOnly || log === null ? null : (
        <DecisionForm opportunityId={opportunityId} stage={stage} roles={roles} log={log} />
      )}
    </Card>
  );
}
