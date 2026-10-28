import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Field as FluentField, Input, Option } from '@fluentui/react-components';
import type { OpportunityCreateBody } from '@pb/contracts';
import { describeActionError } from '../../app/mutations.js';
import { meQuery, sponsorQuery, sponsorsQuery, taxonomyQuery } from '../../app/queries.js';
import { ActionStatus } from '../../components/WorkflowActions.js';
import { Card, PageHeader, PageSkeleton, SectionHeader } from '../../components/ui.js';
import { formatMoneyM, labelOf } from '../../lib/format.js';
import { blockedTitle, resultSuffix, useActionLog } from '../../lib/workflow.js';
import { useCreateOpportunity } from './api.js';
import { isIsoDate, isPositiveAmount, mayUse, PIPELINE_ROLES, termsOf } from './pipeline.js';
import './pipeline.css';

interface Draft {
  name: string;
  companyName: string;
  sponsorId: string;
  sponsorFundId: string;
  dealType: string;
  sector: string;
  geography: string;
  receivedDate: string;
  targetCommitment: string;
  source: string;
}

const EMPTY: Draft = {
  name: '',
  companyName: '',
  sponsorId: '',
  sponsorFundId: '',
  dealType: '',
  sector: '',
  geography: '',
  receivedDate: '',
  targetCommitment: '',
  source: '',
};

/** The body as the contract takes it, or null while a required field is missing or malformed. */
function bodyOf(d: Draft): OpportunityCreateBody | null {
  const name = d.name.trim();
  const companyName = d.companyName.trim();
  const commitment = d.targetCommitment.trim();
  if (name === '' || companyName === '' || d.sponsorId === '' || d.dealType === '') return null;
  if (!isIsoDate(d.receivedDate)) return null;
  if (commitment !== '' && !isPositiveAmount(commitment)) return null;
  const source = d.source.trim();
  return {
    name,
    companyName,
    sponsorId: d.sponsorId,
    ...(d.sponsorFundId === '' ? {} : { sponsorFundId: d.sponsorFundId }),
    dealType: d.dealType,
    ...(d.sector === '' ? {} : { sector: d.sector }),
    ...(d.geography === '' ? {} : { geography: d.geography }),
    receivedDate: d.receivedDate,
    ...(commitment === '' ? {} : { targetCommitment: commitment }),
    ...(source === '' ? {} : { source }),
  };
}

function TermPicker({
  label,
  required = false,
  terms,
  value,
  onChange,
}: {
  label: string;
  required?: boolean;
  terms: readonly { code: string; label: string }[];
  value: string;
  onChange: (code: string) => void;
}): ReactNode {
  return (
    <FluentField label={label} required={required}>
      <Dropdown
        placeholder={terms.length === 0 ? 'No terms loaded' : `Choose ${label.toLowerCase()}`}
        value={value === '' ? '' : labelOf(value)}
        selectedOptions={value === '' ? [] : [value]}
        onOptionSelect={(_e, d) => onChange(d.optionValue ?? '')}
      >
        {required ? null : <Option value="">None</Option>}
        {terms.map((t) => (
          <Option key={t.code} value={t.code} text={t.label}>
            {t.label}
          </Option>
        ))}
      </Dropdown>
    </FluentField>
  );
}

function Form({ roles }: { roles: readonly string[] }): ReactNode {
  const navigate = useNavigate();
  const taxonomy = useQuery(taxonomyQuery);
  const sponsors = useQuery(sponsorsQuery);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [touched, setTouched] = useState(false);
  const sponsor = useQuery({ ...sponsorQuery(draft.sponsorId), enabled: draft.sponsorId !== '' });
  const create = useCreateOpportunity();
  const log = useActionLog();
  const set = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }));
  const body = bodyOf(draft);
  const canCreate = mayUse(roles, PIPELINE_ROLES.createOpportunity);
  const blocked = blockedTitle({ allowed: canCreate, roles: PIPELINE_ROLES.createOpportunity });
  const commitment = draft.targetCommitment.trim();
  const commitmentOk = commitment === '' || isPositiveAmount(commitment);
  const sponsorName = sponsors.data?.items.find((s) => s.id === draft.sponsorId)?.name ?? '';
  const funds = sponsor.data?.funds ?? [];
  const fundName = funds.find((f) => f.id === draft.sponsorFundId)?.name ?? '';
  const submit = (): void => {
    setTouched(true);
    if (body === null || blocked !== null) return;
    create.mutate(body, {
      onSuccess: (created) => {
        log.record('good', `${created.name} logged at Sourced ${resultSuffix()}`);
        void navigate({ to: '/pipeline/$id', params: { id: created.id } });
      },
      onError: (error) => log.record('bad', `New opportunity: ${describeActionError(error)}`),
    });
  };
  return (
    <Card testId="new-opportunity-card">
      <SectionHeader>Opportunity</SectionHeader>
      <ActionStatus latest={log.latest} testId="new-opportunity-status" />
      {blocked === null ? null : (
        <p className="pb-notice" data-testid="new-opportunity-blocked">
          {blocked}. The form is shown so you can see what a new opportunity records.
        </p>
      )}
      <form
        noValidate
        data-testid="new-opportunity-form"
        aria-label="New opportunity"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="pb-pipe-new">
          <FluentField
            label="Deal name"
            required
            hint="The working name the team uses, such as Project Dune."
            {...(touched && draft.name.trim() === ''
              ? { validationState: 'error' as const, validationMessage: 'Give the deal a name.' }
              : {})}
          >
            <Input value={draft.name} onChange={(_e, d) => set({ name: d.value })} />
          </FluentField>
          <FluentField
            label="Company name"
            required
            {...(touched && draft.companyName.trim() === ''
              ? { validationState: 'error' as const, validationMessage: 'Name the company.' }
              : {})}
          >
            <Input value={draft.companyName} onChange={(_e, d) => set({ companyName: d.value })} />
          </FluentField>
          <FluentField
            label="Sponsor"
            required
            {...(touched && draft.sponsorId === ''
              ? { validationState: 'error' as const, validationMessage: 'Choose the sponsor.' }
              : {})}
          >
            <Dropdown
              placeholder={sponsors.isError ? 'Sponsors could not load' : 'Choose a sponsor'}
              value={sponsorName}
              selectedOptions={draft.sponsorId === '' ? [] : [draft.sponsorId]}
              onOptionSelect={(_e, d) => set({ sponsorId: d.optionValue ?? '', sponsorFundId: '' })}
            >
              {(sponsors.data?.items ?? []).map((s) => (
                <Option key={s.id} value={s.id} text={s.name}>
                  {s.name}
                </Option>
              ))}
            </Dropdown>
          </FluentField>
          <FluentField
            label="Sponsor fund"
            hint={
              draft.sponsorId === ''
                ? 'Choose the sponsor first.'
                : funds.length === 0
                  ? 'This sponsor has no fund on record; leave it blank.'
                  : 'Optional: the fund the deal sits in.'
            }
          >
            <Dropdown
              placeholder="None"
              disabled={funds.length === 0}
              value={fundName}
              selectedOptions={draft.sponsorFundId === '' ? [] : [draft.sponsorFundId]}
              onOptionSelect={(_e, d) => set({ sponsorFundId: d.optionValue ?? '' })}
            >
              <Option value="">None</Option>
              {funds.map((f) => (
                <Option key={f.id} value={f.id} text={f.name}>
                  {f.name}
                </Option>
              ))}
            </Dropdown>
          </FluentField>
          <TermPicker
            label="Deal type"
            required
            terms={termsOf(taxonomy.data, 'deal_type')}
            value={draft.dealType}
            onChange={(dealType) => set({ dealType })}
          />
          <TermPicker
            label="Sector"
            terms={termsOf(taxonomy.data, 'sector')}
            value={draft.sector}
            onChange={(sector) => set({ sector })}
          />
          <TermPicker
            label="Geography"
            terms={termsOf(taxonomy.data, 'geography')}
            value={draft.geography}
            onChange={(geography) => set({ geography })}
          />
          <FluentField
            label="Received date"
            required
            {...(touched && !isIsoDate(draft.receivedDate)
              ? {
                  validationState: 'error' as const,
                  validationMessage: 'Give the date the deal reached us.',
                }
              : {})}
          >
            <Input
              type="date"
              value={draft.receivedDate}
              onChange={(_e, d) => set({ receivedDate: d.value })}
            />
          </FluentField>
          <FluentField
            label="Target commitment (dollars)"
            {...(touched && !commitmentOk
              ? {
                  validationState: 'error' as const,
                  validationMessage:
                    'Use digits with an optional decimal point, above zero, for example 15000000.00.',
                }
              : {
                  hint:
                    commitment !== '' && commitmentOk
                      ? `Reads as ${formatMoneyM(commitment)}.`
                      : 'Optional. Digits with an optional decimal point, for example 15000000.00.',
                })}
          >
            <Input
              inputMode="decimal"
              value={draft.targetCommitment}
              onChange={(_e, d) => set({ targetCommitment: d.value })}
            />
          </FluentField>
          <FluentField label="Source" hint="Optional: how the deal reached us, in plain words.">
            <Input value={draft.source} onChange={(_e, d) => set({ source: d.value })} />
          </FluentField>
        </div>
        <div className="pb-pipe-new-actions">
          <Button
            appearance="primary"
            type="submit"
            disabled={blocked !== null || create.isPending}
            {...(blocked === null ? {} : { title: blocked })}
          >
            Log opportunity
          </Button>
          <Link to="/pipeline">Back to the board</Link>
          <span className="pb-meta">
            Starts at Sourced with the diligence template of its deal type
            (config/diligence_templates.json).
          </span>
        </div>
      </form>
    </Card>
  );
}

/** Logs a new opportunity at Sourced (docs/04 M5): the deal team's first record of a deal. */
export function NewOpportunityPage(): ReactNode {
  const me = useQuery(meQuery);
  if (me.isPending) return <PageSkeleton rows={8} />;
  return (
    <>
      <p className="pb-meta pb-pipe-back">
        <Link to="/pipeline">Pipeline board</Link>
      </p>
      <PageHeader
        title="New opportunity"
        meta="What the deal team records at first look. Everything else is captured as the deal moves through its stages."
      />
      <Form roles={me.data?.roles ?? []} />
    </>
  );
}
