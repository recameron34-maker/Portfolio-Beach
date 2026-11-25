import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Dropdown,
  Field as FluentField,
  Option,
  Textarea,
} from '@fluentui/react-components';
import { Add16Regular } from '@fluentui/react-icons';
import type { ReportPackageRow } from '@pb/contracts';
import { describeActionError } from '../../../app/mutations.js';
import { clientsQuery } from '../../../app/queries.js';
import { UnavailableState } from '../../../components/UnavailableState.js';
import { Card, SectionHeader, SimulatedBadge } from '../../../components/ui.js';
import { formatDate, formatQuarter } from '../../../lib/format.js';
import { humanizeState } from '../../../lib/states.js';
import type { ActionLog } from '../../../lib/workflow.js';
import { useStartPackage } from './api.js';
import {
  BASIS_NOT_ON_RECORD,
  BASIS_WORDS,
  basisOnRecord,
  EMPTY_START_FORM,
  isPackageBasis,
  isPackageLabel,
  LABEL_WORDS,
  PACKAGE_BASES,
  PACKAGE_LABELS,
  packageWords,
  parsedStartBody,
  quarterChoices,
  startFieldLabel,
  startProblems,
  startStanding,
} from './packages.js';
import type { StartField, StartForm } from './packages.js';
import './packages.css';

/**
 * Starting a package (docs/18 section 5): a client the reader is entitled to, a quarter that has
 * ended, a basis and a label. There is no as-of field: the API reads the record as of its own
 * date. One package is in progress at a time for a client, quarter and basis, so the form reads
 * the list for the standing of the three: with one in progress it links to it and sends nothing,
 * and with a released one it asks why the new version is needed. Opened from a released package
 * it starts with that package's client, quarter and basis. The body is checked against the
 * contract before it is sent, and the API judges again.
 */
export function StartPackageForm({
  packages,
  initial,
  onLog,
  onDone,
}: {
  /** The packages the reader sees: what tells whether one is already in progress or released. */
  packages: readonly ReportPackageRow[];
  /** What the form opens with: the client, quarter and basis of a released package being corrected. */
  initial?: StartForm;
  onLog: ActionLog;
  onDone: () => void;
}): ReactNode {
  const start = useStartPackage();
  const navigate = useNavigate();
  const clients = useQuery(clientsQuery);
  const [form, setForm] = useState<StartForm>(initial ?? EMPTY_START_FORM);
  const [touched, setTouched] = useState(false);
  const asOf = clients.data?.asOf;
  const quarters = asOf === undefined ? [] : quarterChoices(asOf);
  // The latest quarter that has ended is the one a package is most often started for.
  const chosen: StartForm = {
    ...form,
    periodEnd: form.periodEnd === '' ? (quarters[0] ?? '') : form.periodEnd,
  };
  const items = clients.data?.items ?? [];
  const client = items.find((c) => c.id === chosen.clientId);
  const standing = startStanding(packages, chosen);
  const problems = startProblems(chosen, standing);
  const offRecord =
    client !== undefined &&
    chosen.basis !== '' &&
    !basisOnRecord(client.reportingBases, chosen.basis);
  const set = (patch: Partial<StartForm>): void => setForm((f) => ({ ...f, ...patch }));
  const error = (key: StartField): object =>
    touched && problems[key] !== undefined
      ? { validationState: 'error' as const, validationMessage: problems[key] }
      : {};
  return (
    <Card panel testId="package-start-form">
      <SectionHeader aside={<SimulatedBadge />}>Start a package</SectionHeader>
      <p className="pb-meta">
        A package starts as a draft with no figures. Generating it reads the record and runs every
        check.
      </p>
      <form
        // The form says what each field needs in its own words, for every field at once.
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          const body = parsedStartBody(chosen, standing);
          if (body === null) return;
          start.mutate(body, {
            onSuccess: (created) => {
              onDone();
              void navigate({ to: '/reporting/packages/$id', params: { id: created.id } });
            },
            onError: (err) =>
              onLog.record('bad', `Start package: ${describeActionError(err, startFieldLabel)}`),
          });
        }}
      >
        <div className="pb-pkg-form">
          <FluentField
            label="Client"
            required
            {...(clients.isPending ? { hint: 'Loading the list' } : {})}
            {...error('clientId')}
          >
            <Dropdown
              className="pb-pkg-control"
              placeholder="Choose a client"
              value={client?.name ?? ''}
              selectedOptions={chosen.clientId === '' ? [] : [chosen.clientId]}
              onOptionSelect={(_e, d) => set({ clientId: d.optionValue ?? '' })}
            >
              {items.map((c) => (
                <Option key={c.id} value={c.id}>
                  {c.name}
                </Option>
              ))}
            </Dropdown>
          </FluentField>
          <FluentField
            label="Quarter"
            required
            {...(asOf === undefined
              ? {}
              : { hint: `Quarters that ended on or before ${formatDate(asOf)}.` })}
            {...error('periodEnd')}
          >
            <Dropdown
              className="pb-pkg-control"
              placeholder="Choose a quarter"
              value={chosen.periodEnd === '' ? '' : formatQuarter(chosen.periodEnd)}
              selectedOptions={chosen.periodEnd === '' ? [] : [chosen.periodEnd]}
              onOptionSelect={(_e, d) => set({ periodEnd: d.optionValue ?? '' })}
            >
              {quarters.map((quarter) => (
                <Option key={quarter} value={quarter}>
                  {formatQuarter(quarter)}
                </Option>
              ))}
            </Dropdown>
          </FluentField>
          <FluentField
            label="Basis"
            required
            {...(offRecord
              ? { validationState: 'warning' as const, validationMessage: BASIS_NOT_ON_RECORD }
              : {})}
            {...error('basis')}
          >
            <Dropdown
              className="pb-pkg-control"
              placeholder="Gross or net"
              value={chosen.basis === '' ? '' : BASIS_WORDS[chosen.basis]}
              selectedOptions={chosen.basis === '' ? [] : [chosen.basis]}
              onOptionSelect={(_e, d) => {
                const value = d.optionValue ?? '';
                set({ basis: isPackageBasis(value) ? value : '' });
              }}
            >
              {PACKAGE_BASES.map((basis) => (
                <Option key={basis} value={basis}>
                  {BASIS_WORDS[basis]}
                </Option>
              ))}
            </Dropdown>
          </FluentField>
          <FluentField label="Label" required {...error('label')}>
            <Dropdown
              className="pb-pkg-control"
              placeholder="Preliminary or final"
              value={chosen.label === '' ? '' : LABEL_WORDS[chosen.label]}
              selectedOptions={chosen.label === '' ? [] : [chosen.label]}
              onOptionSelect={(_e, d) => {
                const value = d.optionValue ?? '';
                set({ label: isPackageLabel(value) ? value : '' });
              }}
            >
              {PACKAGE_LABELS.map((label) => (
                <Option key={label} value={label}>
                  {LABEL_WORDS[label]}
                </Option>
              ))}
            </Dropdown>
          </FluentField>
          {standing.kind === 'correction' ? (
            <FluentField
              className="is-wide"
              label="Reason for the new version"
              required
              hint={`Version ${standing.row.version} was released${
                standing.row.releasedAt === null
                  ? ''
                  : ` on ${formatDate(standing.row.releasedAt.slice(0, 10))}`
              } and cannot be changed. This starts version ${standing.row.version + 1}.`}
              {...error('correctionReason')}
            >
              <Textarea
                className="pb-pkg-control"
                value={form.correctionReason}
                resize="vertical"
                onChange={(_e, d) => set({ correctionReason: d.value })}
                onBlur={() => setTouched(true)}
              />
            </FluentField>
          ) : null}
        </div>
        {standing.kind === 'inProgress' ? (
          <p className="pb-notice pb-pkg-standing" data-testid="package-in-progress">
            <span>
              A package for this client, quarter and basis is already in progress:{' '}
              <Link to="/reporting/packages/$id" params={{ id: standing.row.id }}>
                {packageWords(standing.row)}
              </Link>{' '}
              ({humanizeState(standing.row.state)}). A new version can be started once it is
              released.
            </span>
          </p>
        ) : null}
        {clients.isError ? (
          <UnavailableState
            inline
            error={clients.error}
            subject="The client list"
            testId="package-clients-unavailable"
          />
        ) : null}
        {clients.isSuccess && items.length === 0 ? (
          <p className="pb-notice pb-pkg-standing" data-testid="package-no-clients">
            You are not entitled to any client yet, so there is none to start a package for. A
            platform administrator sets client entitlements.
          </p>
        ) : null}
        <div className="pb-pkg-form-actions">
          <Button appearance="secondary" onClick={onDone}>
            Cancel
          </Button>
          <Button
            appearance="primary"
            type="submit"
            icon={<Add16Regular />}
            disabled={start.isPending || standing.kind === 'inProgress'}
          >
            {standing.kind === 'correction' ? 'Start new version' : 'Start package'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
