import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Dropdown, Field as FluentField, Input, Option } from '@fluentui/react-components';
import { Add16Regular, Dismiss16Regular } from '@fluentui/react-icons';
import { useQuery } from '@tanstack/react-query';
import type { ChangeRequestCreateBody, ChangeRequestRow } from '@pb/contracts';
import { describeActionError } from '../../app/mutations.js';
import { taxonomyQuery } from '../../app/queries.js';
import { SimulatedBadge } from '../../components/ui.js';
import { labelOf } from '../../lib/format.js';
import { resultSuffix } from '../../lib/workflow.js';
import type { ActionLog } from '../../lib/workflow.js';
import { useCreateChangeRequest } from './api.js';
import { detailsRecord, formProblems } from './changes.js';
import type { DetailEntry } from './changes.js';
import './valuations.css';

/** The change_type terms of the taxonomy (core.taxonomy_term, migration 0013), active ones only. */
function changeTypes(
  domains: readonly { domain: string; terms: readonly { code: string; active: boolean }[] }[],
): string[] {
  return domains
    .filter((d) => d.domain === 'change_type')
    .flatMap((d) => d.terms.filter((t) => t.active).map((t) => t.code));
}

const EMPTY_ENTRY: DetailEntry = { key: '', value: '' };

/** The validation props a Fluent Field takes when a value is refused. */
interface FieldValidation {
  validationState: 'error';
  validationMessage: string;
}

/**
 * The one change request form (docs/04 M11): the change type from the taxonomy, the effective
 * date, a one-line summary and the details as named plain-text fields. The body is checked
 * against the contract before it is sent, so the form refuses what the API would refuse; the
 * result goes into the page's action log.
 */
export function ChangeRequestForm({
  investmentId,
  investmentName,
  log,
  onSubmitted,
}: {
  investmentId: string;
  investmentName: string;
  log: ActionLog;
  onSubmitted?: ((row: ChangeRequestRow) => void) | undefined;
}): ReactNode {
  const taxonomy = useQuery(taxonomyQuery);
  const create = useCreateChangeRequest();
  const [changeType, setChangeType] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [summary, setSummary] = useState('');
  const [entries, setEntries] = useState<DetailEntry[]>([EMPTY_ENTRY]);
  const [touched, setTouched] = useState(false);
  const types = taxonomy.data === undefined ? [] : changeTypes(taxonomy.data.domains);

  const body: ChangeRequestCreateBody = {
    investmentId,
    changeType,
    effectiveDate,
    summary: summary.trim(),
    details: detailsRecord(entries),
  };
  const problems = touched ? formProblems(body) : {};
  const problem = (field: string): Partial<FieldValidation> => {
    const message = problems[field];
    return message === undefined ? {} : { validationState: 'error', validationMessage: message };
  };
  const setEntry = (i: number, patch: Partial<DetailEntry>): void =>
    setEntries((prev) => prev.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  const submit = (): void => {
    setTouched(true);
    if (Object.keys(formProblems(body)).length > 0) return;
    create.mutate(body, {
      onSuccess: (row) => {
        log.record(
          'good',
          `Change request submitted for ${row.investmentName}: ${row.summary} ${resultSuffix()}`,
        );
        setChangeType('');
        setEffectiveDate('');
        setSummary('');
        setEntries([EMPTY_ENTRY]);
        setTouched(false);
        onSubmitted?.(row);
      },
      onError: (error) =>
        log.record('bad', `Change request for ${investmentName}: ${describeActionError(error)}`),
    });
  };

  return (
    <form
      className="pb-val-form"
      data-testid="change-request-form"
      aria-label="Request a change"
      // The contract decides what is valid (formProblems), not the browser's own tooltips.
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="pb-meta">
        One form for every change to {investmentName}: an add-on, a new security, a distribution
        treatment, a recapitalization, a partial exit. The deal team routes it to an operations
        owner, who applies it in a quarter or rejects it with a reason.
      </p>
      <FluentField label="Change type" required {...problem('changeType')}>
        <Dropdown
          placeholder={
            taxonomy.isPending
              ? 'Loading change types'
              : types.length === 0
                ? 'Change types could not load'
                : 'Choose a change type'
          }
          value={changeType === '' ? '' : labelOf(changeType)}
          selectedOptions={changeType === '' ? [] : [changeType]}
          disabled={types.length === 0}
          onOptionSelect={(_e, d) => setChangeType(d.optionValue ?? '')}
        >
          {types.map((code) => (
            <Option key={code} value={code} text={labelOf(code)}>
              {labelOf(code)}
            </Option>
          ))}
        </Dropdown>
      </FluentField>
      <FluentField label="Effective date" required {...problem('effectiveDate')}>
        <Input type="date" value={effectiveDate} onChange={(_e, d) => setEffectiveDate(d.value)} />
      </FluentField>
      <FluentField
        label="Summary"
        required
        {...(problems.summary === undefined
          ? { hint: 'One line, 3 to 200 characters, in plain words.' }
          : problem('summary'))}
      >
        <Input value={summary} maxLength={200} onChange={(_e, d) => setSummary(d.value)} />
      </FluentField>
      <fieldset className="pb-val-form">
        <legend className="pb-meta">Details (name and value, as many as needed)</legend>
        {entries.map((entry, i) => (
          <div key={i} className="pb-val-form-row">
            <FluentField label={`Field ${i + 1} name`} size="small">
              <Input value={entry.key} onChange={(_e, d) => setEntry(i, { key: d.value })} />
            </FluentField>
            <FluentField label={`Field ${i + 1} value`} size="small">
              <Input value={entry.value} onChange={(_e, d) => setEntry(i, { value: d.value })} />
            </FluentField>
            <Button
              size="small"
              appearance="subtle"
              icon={<Dismiss16Regular />}
              aria-label={`Remove field ${i + 1}`}
              disabled={entries.length === 1}
              onClick={() => setEntries((prev) => prev.filter((_e, j) => j !== i))}
            />
          </div>
        ))}
        <div>
          <Button
            size="small"
            appearance="secondary"
            icon={<Add16Regular />}
            onClick={() => setEntries((prev) => [...prev, EMPTY_ENTRY])}
          >
            Add field
          </Button>
        </div>
        {problems.details === undefined ? null : (
          <p className="pb-notice pb-notice-bad">{problems.details}</p>
        )}
      </fieldset>
      <div className="pb-val-form-actions">
        <Button appearance="primary" type="submit" disabled={create.isPending}>
          Submit request
        </Button>
        <SimulatedBadge />
        <span className="pb-meta">Submitted requests start at Submitted and wait for routing.</span>
      </div>
    </form>
  );
}
