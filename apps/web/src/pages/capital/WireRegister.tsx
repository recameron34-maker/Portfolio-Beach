import { useState } from 'react';
import type { ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Button,
  Dropdown,
  Field as FluentField,
  Input,
  Label,
  Option,
} from '@fluentui/react-components';
import { Add16Regular } from '@fluentui/react-icons';
import type { WireInstructionState } from '@pb/contracts';
import { describeActionError } from '../../app/mutations.js';
import { CAPITAL_TABS } from '../../app/nav.js';
import { commitmentsQuery, investmentsQuery, LIST_LIMIT, meQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import { ActionLogCard, ActionStatus } from '../../components/WorkflowActions.js';
import {
  Card,
  EmptyState,
  Field,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  SimulatedBadge,
  TabNav,
  Toolbar,
} from '../../components/ui.js';
import { plural } from '../../lib/format.js';
import { humanizeState, rolesLabel } from '../../lib/states.js';
import { resultSuffix, useActionLog } from '../../lib/workflow.js';
import type { ActionLog } from '../../lib/workflow.js';
import { ACTIVE_POSITIONS } from '../valuations/board.js';
import { useProposeWireInstruction, wireInstructionsQuery } from './api.js';
import { WireTable } from './WireTable.js';
import {
  counterpartyNames,
  EMPTY_PROPOSE_FORM,
  filterWires,
  isWireState,
  kindLabel,
  parsedProposeBody,
  PROPOSE_ROLES,
  proposeProblems,
  WIRE_STATES,
} from './wires.js';
import type { ProposeField, ProposeForm } from './wires.js';
import './capital.css';

interface Choice {
  id: string;
  name: string;
}

/** The sponsor funds the firm has commitments to, each once, by name. */
function fundChoices(
  items: readonly { sponsorFundId: string; sponsorFundName: string }[],
): Choice[] {
  const byId = new Map<string, string>();
  for (const c of items) byId.set(c.sponsorFundId, c.sponsorFundName);
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A new version for a counterparty, typed by operations from a verified source (docs/18
 * section 11, SEC-12.1). The counterparty is an active position or a sponsor fund the firm has a
 * commitment to; the body is checked against the contract before it is sent, so the API's
 * refusals are only the ones a form cannot see.
 */
function ProposeForm({ onLog, onDone }: { onLog: ActionLog; onDone: () => void }): ReactNode {
  const propose = useProposeWireInstruction();
  const positions = useQuery(investmentsQuery(ACTIVE_POSITIONS));
  const commitments = useQuery(commitmentsQuery);
  const [form, setForm] = useState<ProposeForm>(EMPTY_PROPOSE_FORM);
  const [touched, setTouched] = useState(false);
  const problems = proposeProblems(form);
  const source = form.kind === 'investment' ? positions : commitments;
  const choices: Choice[] =
    form.kind === 'investment'
      ? (positions.data?.items ?? []).map((p) => ({
          id: p.id,
          name: `${p.investmentNumber} ${p.companyName}`,
        }))
      : fundChoices(commitments.data?.items ?? []);
  const plainName = (id: string): string => {
    if (form.kind === 'investment')
      return positions.data?.items.find((p) => p.id === id)?.companyName ?? '';
    return choices.find((c) => c.id === id)?.name ?? '';
  };
  const chosen = choices.find((c) => c.id === form.counterpartyId);
  const set = (key: ProposeField, value: string): void => setForm((f) => ({ ...f, [key]: value }));
  const error = (key: ProposeField): object =>
    touched && problems[key] !== undefined
      ? { validationState: 'error' as const, validationMessage: problems[key] }
      : {};
  const text = (
    key: ProposeField,
    label: string,
    hint: string,
    required: boolean,
    inputMode?: 'numeric',
  ): ReactNode => (
    <FluentField label={label} required={required} hint={hint} {...error(key)}>
      <Input
        value={form[key]}
        {...(inputMode === undefined ? {} : { inputMode })}
        onChange={(_e, d) => set(key, d.value)}
        onBlur={() => setTouched(true)}
      />
    </FluentField>
  );
  return (
    <Card testId="wire-propose-form">
      <SectionHeader aside={<SimulatedBadge />}>Propose a new instruction</SectionHeader>
      <p className="pb-meta">
        Type the details from a verified source: a signed closing or subscription document, the fund
        administrator or a known contact. Never from the notice or from an email asking for a change
        (SEC-12.1). A second person verifies the version by callback before any ticket releases
        against it (SEC-12.2).
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          const body = parsedProposeBody(form);
          if (body === null || form.counterpartyId === '') return;
          propose.mutate(body, {
            onSuccess: (d) => {
              onLog.record(
                'good',
                `Version ${d.version} proposed for ${d.counterparty.name} (${d.bankDetailsMasked}); a second person must verify it by callback ${resultSuffix()}`,
              );
              onDone();
            },
            onError: (err) =>
              onLog.record('bad', `Propose instruction: ${describeActionError(err)}`),
          });
        }}
      >
        <div className="pb-wire-form">
          <FluentField label="Counterparty kind" required>
            <Dropdown
              value={kindLabel(form.kind)}
              selectedOptions={[form.kind]}
              onOptionSelect={(_e, d) =>
                setForm((f) => ({
                  ...f,
                  kind: d.optionValue === 'sponsor_fund' ? 'sponsor_fund' : 'investment',
                  counterpartyId: '',
                  counterpartyName: '',
                }))
              }
            >
              <Option value="investment">Investment</Option>
              <Option value="sponsor_fund">Sponsor fund</Option>
            </Dropdown>
          </FluentField>
          <FluentField
            label="Counterparty"
            required
            {...(source.isPending ? { hint: 'Loading the list' } : {})}
            {...error('counterpartyId')}
          >
            <Dropdown
              placeholder={
                form.kind === 'investment' ? 'Choose an active position' : 'Choose a sponsor fund'
              }
              value={chosen?.name ?? ''}
              selectedOptions={form.counterpartyId === '' ? [] : [form.counterpartyId]}
              onOptionSelect={(_e, d) => {
                const id = d.optionValue ?? '';
                setForm((f) => ({
                  ...f,
                  counterpartyId: id,
                  counterpartyName:
                    f.counterpartyName === '' || f.counterpartyName === plainName(f.counterpartyId)
                      ? plainName(id)
                      : f.counterpartyName,
                }));
              }}
            >
              {choices.map((c) => (
                <Option key={c.id} value={c.id} text={c.name}>
                  {c.name}
                </Option>
              ))}
            </Dropdown>
          </FluentField>
          {text('counterpartyName', 'Counterparty name', 'As it appears on the instruction.', true)}
          {text('bankName', 'Bank name', 'The receiving bank.', true)}
          {text(
            'accountName',
            'Account name',
            'The account holder named on the instruction.',
            true,
          )}
          {text('accountNumber', 'Account number', 'Digits only, 6 to 20.', true, 'numeric')}
          {text('routingCode', 'Routing code', 'Digits only, 6 to 20.', true, 'numeric')}
          {text('reference', 'Reference', 'Optional payment reference.', false)}
          {text(
            'sourceNote',
            'Source note',
            'How the instruction reached us, in plain words: never a document or email body.',
            false,
          )}
        </div>
        {source.isError ? (
          <UnavailableState
            inline
            error={source.error}
            subject={form.kind === 'investment' ? 'The positions list' : 'The sponsor fund list'}
            testId="wire-choices-unavailable"
          />
        ) : null}
        <div className="pb-wire-form-actions">
          <Button
            appearance="primary"
            type="submit"
            icon={<Add16Regular />}
            disabled={propose.isPending}
          >
            Propose version
          </Button>
          <Button appearance="secondary" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * The wire instruction register (docs/04 M16, docs/18 section 11, SEC-12.2): every version of
 * every counterparty, masked, with its proposer, its callback and whether it is the active one.
 * Operations propose new versions here; a second person verifies them on the version's page.
 */
export function WireRegisterPage(): ReactNode {
  const me = useQuery(meQuery);
  const q = useQuery({ ...wireInstructionsQuery({}), placeholderData: keepPreviousData });
  const log = useActionLog();
  const [proposing, setProposing] = useState(false);
  const [state, setState] = useState<WireInstructionState | ''>('');
  const [counterparty, setCounterparty] = useState('');
  const roles = me.data?.roles ?? [];
  const canPropose = roles.some((r) => PROPOSE_ROLES.includes(r));
  const header = (
    <>
      <PageHeader
        title="Wire instruction register"
        meta="Bank details are typed from a verified source and verified by a second person's callback (SEC-12.1, SEC-12.2). Every role sees the masked form."
      />
      <TabNav label="Capital activity" items={CAPITAL_TABS} />
    </>
  );
  if (q.isPending) return <PageSkeleton rows={8} />;
  if (q.isError) {
    return (
      <>
        {header}
        <UnavailableState
          card
          error={q.error}
          subject="The wire register"
          forbidden={{
            title: 'The wire register: not visible to your role',
            detail:
              'Operations, approvers, auditors and platform admins read the register (SEC-12.2). Ask a platform administrator if you need access.',
          }}
          errorTitle="Wire register unavailable"
          testId="wires-unavailable"
        />
      </>
    );
  }
  const page = q.data;
  const rows = filterWires(page.items, { state, counterparty });
  const names = counterpartyNames(page.items);
  const pending = page.items.filter((w) => w.state === 'Proposed').length;
  return (
    <>
      {header}
      <ActionStatus latest={log.latest} testId="wire-action-status" />
      {proposing ? <ProposeForm onLog={log} onDone={() => setProposing(false)} /> : null}
      <Card testId="wire-register">
        <SectionHeader aside="Newest proposal first">Register</SectionHeader>
        <Toolbar
          end={
            <Button
              size="small"
              appearance="primary"
              icon={<Add16Regular />}
              disabled={!canPropose || proposing}
              {...(canPropose ? {} : { title: `Needs ${rolesLabel(PROPOSE_ROLES)}` })}
              onClick={() => setProposing(true)}
            >
              Propose instruction
            </Button>
          }
        >
          <Field>
            <Label htmlFor="wire-state">State</Label>
            <Dropdown
              id="wire-state"
              className="pb-cap-filter"
              value={state === '' ? 'All states' : humanizeState(state)}
              selectedOptions={[state]}
              onOptionSelect={(_e, d) => {
                const v = d.optionValue ?? '';
                setState(isWireState(v) ? v : '');
              }}
            >
              <Option value="">All states</Option>
              {WIRE_STATES.map((s) => (
                <Option key={s} value={s}>
                  {humanizeState(s)}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Field>
            <Label htmlFor="wire-counterparty">Counterparty</Label>
            <Dropdown
              id="wire-counterparty"
              className="pb-cap-filter is-wide"
              value={counterparty === '' ? 'All counterparties' : counterparty}
              selectedOptions={[counterparty]}
              onOptionSelect={(_e, d) => setCounterparty(d.optionValue ?? '')}
            >
              <Option value="">All counterparties</Option>
              {names.map((n) => (
                <Option key={n} value={n}>
                  {n}
                </Option>
              ))}
            </Dropdown>
          </Field>
        </Toolbar>
        {rows.length === 0 ? (
          <EmptyState
            title={page.items.length === 0 ? 'No wire instructions yet' : 'No versions match'}
            detail={
              page.items.length === 0
                ? 'Operations propose the first version of a counterparty from a verified source; a second person verifies it by callback.'
                : 'Pick another state or counterparty.'
            }
          />
        ) : (
          <WireTable rows={rows} label="Wire instructions" />
        )}
        <p className="pb-meta" data-testid="wire-count">
          {plural(rows.length, 'version')} shown; {plural(pending, 'version')} waiting for a
          callback.
          {page.nextCursor === null ? null : ` Showing the first ${LIST_LIMIT}; more exist.`}
        </p>
      </Card>
      <ActionLogCard entries={log.entries} />
    </>
  );
}
