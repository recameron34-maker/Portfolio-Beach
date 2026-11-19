import { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Field as FluentField, Input, Option } from '@fluentui/react-components';
import type { UnderwritingCaseBody, UnderwritingCaseVersion } from '@pb/contracts';
import { documentsOfInvestmentQuery } from '../../app/queries.js';
import { KeyValueTable, NumCell, SimulatedBadge, TableWrap } from '../../components/ui.js';
import { formatDate, MISSING } from '../../lib/format.js';
import { sourcePlace } from './underwriting.js';
import {
  bodyOf,
  documentHint,
  formatDollars,
  formatRatePct,
  ISO_DATE,
} from './underwriting-form.js';
import type { CaseDraft, CaseForm, DraftErrors, PlanRowDraft } from './underwriting-form.js';
import { useSaveUnderwritingCase } from './underwriting-api.js';
import './deal.css';

const FIGURES = [
  ['revenue', 'Revenue'],
  ['ebitda', 'EBITDA'],
  ['netDebt', 'Net debt'],
] as const;

/** A field's error once the reader has asked for the review, in the shape a Fluent field takes. */
function invalid(
  errors: DraftErrors,
  key: string,
): { validationState: 'error'; validationMessage: string } | Record<string, never> {
  const message = errors[key];
  return message === undefined ? {} : { validationState: 'error', validationMessage: message };
}

/** What is wrong with the plan rows, one sentence per fault, in row order. */
function rowFaults(errors: DraftErrors): string[] {
  return Object.entries(errors)
    .filter(([key]) => key === 'rows' || key.startsWith('rows.'))
    .map(([key, message]) => {
      const row = /^rows\.(\d+)\./.exec(key)?.[1];
      return row === undefined ? message : `Plan date ${Number(row) + 1}: ${message}`;
    })
    .filter((message, i, all) => all.indexOf(message) === i);
}

/**
 * The case as it will be stored: the plan in dollars in full, so a figure typed in the wrong unit
 * shows before it is saved, and a loan's yield and loss rate as the rates they are.
 */
function Review({
  form,
  title,
  body,
  documentName,
  heading,
  busy,
  onSave,
  onBack,
}: {
  form: CaseForm;
  title: string;
  body: UnderwritingCaseBody;
  documentName: string | null;
  /** The heading of the step, which takes focus when the step is shown. */
  heading: RefObject<HTMLHeadingElement | null>;
  busy: boolean;
  onSave: () => void;
  onBack: () => void;
}): ReactNode {
  const place = sourcePlace({
    page: body.sourcePage ?? null,
    locator: body.sourceLocator ?? null,
  });
  const source =
    body.sourceDocumentId === undefined
      ? (body.sourceNote ?? MISSING)
      : [documentName ?? 'The document chosen', place, body.sourceNote]
          .filter((part): part is string => part !== null && part !== undefined)
          .join(', ');
  const loan = form === 'credit';
  return (
    <div className="pb-deal-gap" data-testid="underwriting-review">
      <h3 ref={heading} tabIndex={-1} className="pb-deal-subhead">
        {title}: check the figures in full
      </h3>
      <KeyValueTable
        label="Terms as they will be saved"
        columns={2}
        rows={[
          { label: 'Case date', value: formatDate(body.caseDate) },
          ...(loan
            ? [
                { label: 'Expected repayment', value: formatDate(body.plannedExitDate) },
                {
                  label: 'Underwritten yield',
                  value:
                    body.underwrittenYield === undefined
                      ? MISSING
                      : formatRatePct(body.underwrittenYield),
                },
                {
                  label: 'Annual loss rate',
                  value:
                    body.annualLossRate === undefined
                      ? MISSING
                      : formatRatePct(body.annualLossRate),
                },
              ]
            : [
                { label: 'Planned exit', value: formatDate(body.plannedExitDate) },
                { label: 'Exit multiple', value: `${body.exitMultiple ?? MISSING}x` },
              ]),
          { label: 'Underwritten gross MOIC', value: `${body.grossMoic}x` },
          { label: 'Underwritten gross IRR', value: formatRatePct(body.grossIrr) },
          { label: 'Source', value: source },
          ...(body.note === undefined ? [] : [{ label: 'Note', value: body.note }]),
          ...(body.revisionReason === undefined
            ? []
            : [{ label: 'Reason for the revision', value: body.revisionReason }]),
        ]}
      />
      {loan ? null : (
        <div className="pb-deal-gap">
          <TableWrap label="Plan as it will be saved, in dollars">
            <table className="pb-table" aria-label="Plan as it will be saved, in dollars">
              <thead>
                <tr>
                  <th>Twelve months ending</th>
                  <th className="num">Revenue</th>
                  <th className="num">EBITDA</th>
                  <th className="num">Net debt</th>
                </tr>
              </thead>
              <tbody>
                {(body.points ?? []).map((p) => (
                  <tr key={p.periodEnd}>
                    <td className="pb-nowrap">{formatDate(p.periodEnd)}</td>
                    <NumCell>{formatDollars(p.revenueLtm) ?? MISSING}</NumCell>
                    <NumCell>{formatDollars(p.ebitdaLtm) ?? MISSING}</NumCell>
                    <NumCell>{formatDollars(p.netDebt) ?? MISSING}</NumCell>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </div>
      )}
      <p className="pb-meta pb-deal-note">
        {loan
          ? 'Saving records a draft: a second person confirms it before the loan is compared with it.'
          : 'The form takes US$ millions and the plan is kept in dollars. Saving records a draft: a second person confirms it before the position is compared with it.'}
      </p>
      <div className="pb-deal-actions">
        <Button appearance="primary" size="small" disabled={busy} onClick={onSave}>
          Save draft
        </Button>
        <Button appearance="secondary" size="small" disabled={busy} onClick={onBack}>
          Back to the form
        </Button>
        <SimulatedBadge />
      </div>
    </div>
  );
}

/**
 * The form the deal team records a base case with: the case date, the planned exit and its
 * multiple, the underwritten gross MOIC and IRR, the plan date by date in US$ millions, and
 * where the figures come from. A loan has no plan and no exit multiple: its form takes the
 * expected repayment, the underwritten yield and the loss rate beside the MOIC and the IRR. It
 * saves a Draft, new or in place of the one being edited, after showing every figure back in
 * full. Nothing typed is lost by a refusal: the form stays open with what was entered, and the
 * card says why.
 */
export function UnderwritingForm({
  investmentId,
  form = 'equity',
  title,
  initial,
  editing,
  needsReason,
  sourceDocumentName,
  onSaved,
  onFailed,
  onCancel,
}: {
  investmentId: string;
  /** What the position holds: a plan and exit terms, or a loan's yield and loss rate. */
  form?: CaseForm;
  title: string;
  initial: CaseDraft;
  /** The Draft this form replaces, with the row version it was opened on; left out for a new Draft. */
  editing?: { id: string; rowVersion: number } | undefined;
  /** From the second version a case says why it revises. */
  needsReason: boolean;
  /** The name of the source document the case already names, for a reader whose list lacks it. */
  sourceDocumentName?: string | undefined;
  onSaved: (saved: UnderwritingCaseVersion) => void;
  onFailed: (error: unknown) => void;
  onCancel: () => void;
}): ReactNode {
  const [draft, setDraft] = useState<CaseDraft>(initial);
  const [asked, setAsked] = useState(false);
  const [reviewing, setReviewing] = useState<UnderwritingCaseBody | null>(null);
  const documents = useQuery(documentsOfInvestmentQuery(investmentId));
  const save = useSaveUnderwritingCase(investmentId);
  const set = (patch: Partial<CaseDraft>): void => setDraft((d) => ({ ...d, ...patch }));
  const setRow = (index: number, patch: Partial<PlanRowDraft>): void =>
    setDraft((d) => ({
      ...d,
      rows: d.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }));
  // Each step replaces the button that led to it, so its heading takes focus: when the form
  // opens, when the figures are shown back, and when the reader returns to the form (their own
  // choice, or a refusal the card words above). A keyboard or screen-reader user stays in place.
  const heading = useRef<HTMLHeadingElement | null>(null);
  const inReview = reviewing !== null;
  useEffect(() => {
    heading.current?.focus();
  }, [inReview]);
  const loan = form === 'credit';
  const checked = bodyOf(draft, { needsReason, form });
  const errors: DraftErrors = asked && !checked.ok ? checked.errors : {};
  const listed = documents.data?.items ?? [];
  const chosen = listed.find((doc) => doc.id === draft.sourceDocumentId);
  const documentName =
    draft.sourceDocumentId === '' ? null : (chosen?.title ?? sourceDocumentName ?? null);
  const last = draft.rows.length - 1;

  if (reviewing !== null) {
    return (
      <Review
        form={form}
        title={title}
        body={reviewing}
        documentName={documentName}
        heading={heading}
        busy={save.isPending}
        onBack={() => setReviewing(null)}
        onSave={() =>
          save.mutate(
            { body: reviewing, draft: editing },
            {
              onSuccess: onSaved,
              onError: (error) => {
                // Back to the form with everything typed, so the reader can act on the refusal.
                setReviewing(null);
                onFailed(error);
              },
            },
          )
        }
      />
    );
  }

  const faults = rowFaults(errors);
  return (
    <form
      noValidate
      className="pb-deal-gap"
      data-testid="underwriting-form"
      aria-label={title}
      onSubmit={(event) => {
        event.preventDefault();
        setAsked(true);
        if (checked.ok) setReviewing(checked.body);
      }}
    >
      <h3 ref={heading} tabIndex={-1} className="pb-deal-subhead">
        {title}
      </h3>
      <div className="pb-deal-form-grid">
        <FluentField label="Case date" required {...invalid(errors, 'caseDate')}>
          <Input
            className="pb-deal-form-control"
            type="date"
            value={draft.caseDate}
            onChange={(_e, d) => set({ caseDate: d.value })}
          />
        </FluentField>
        <FluentField
          label={loan ? 'Expected repayment' : 'Planned exit'}
          required
          {...invalid(errors, 'plannedExitDate')}
        >
          <Input
            className="pb-deal-form-control"
            type="date"
            value={draft.plannedExitDate}
            onChange={(_e, d) => set({ plannedExitDate: d.value })}
          />
        </FluentField>
        {loan ? (
          <>
            <FluentField
              label="Underwritten yield (%)"
              required
              hint="Annual yield, as underwritten at entry. 11.5 is 11.5%."
              {...invalid(errors, 'underwrittenYield')}
            >
              <Input
                className="pb-deal-form-control"
                inputMode="decimal"
                value={draft.underwrittenYieldPct}
                onChange={(_e, d) => set({ underwrittenYieldPct: d.value })}
              />
            </FluentField>
            <FluentField
              label="Annual loss rate (%)"
              hint="The expected loss a year. Leave it empty if none was underwritten."
              {...invalid(errors, 'annualLossRate')}
            >
              <Input
                className="pb-deal-form-control"
                inputMode="decimal"
                value={draft.annualLossRatePct}
                onChange={(_e, d) => set({ annualLossRatePct: d.value })}
              />
            </FluentField>
          </>
        ) : (
          <FluentField
            label="Exit multiple"
            required
            hint="EV / EBITDA at the planned exit."
            {...invalid(errors, 'exitMultiple')}
          >
            <Input
              className="pb-deal-form-control"
              inputMode="decimal"
              value={draft.exitMultiple}
              onChange={(_e, d) => set({ exitMultiple: d.value })}
            />
          </FluentField>
        )}
        <FluentField
          label="Underwritten gross MOIC"
          required
          hint={
            loan
              ? 'From our entry to the expected repayment.'
              : 'From our entry to the planned exit.'
          }
          {...invalid(errors, 'grossMoic')}
        >
          <Input
            className="pb-deal-form-control"
            inputMode="decimal"
            value={draft.grossMoic}
            onChange={(_e, d) => set({ grossMoic: d.value })}
          />
        </FluentField>
        <FluentField
          label="Underwritten gross IRR (%)"
          required
          hint={
            loan
              ? 'From our entry to the expected repayment. 10 is 10%.'
              : 'From our entry to the planned exit. 20 is 20%.'
          }
          {...invalid(errors, 'grossIrr')}
        >
          <Input
            className="pb-deal-form-control"
            inputMode="decimal"
            value={draft.grossIrrPct}
            onChange={(_e, d) => set({ grossIrrPct: d.value })}
          />
        </FluentField>
      </div>

      {loan ? null : (
        <>
          <TableWrap label="Plan, in US$ millions">
            <table className="pb-table pb-deal-plan-form" aria-label="Plan, in US$ millions">
              <thead>
                <tr>
                  <th>Twelve months ending</th>
                  {FIGURES.map(([, label]) => (
                    <th key={label} className="num">
                      {label}
                    </th>
                  ))}
                  <th>
                    <span className="pb-visually-hidden">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {draft.rows.map((row, i) => (
                  // A row has no identity but its place, and every input in it is controlled.
                  <tr key={i}>
                    <td>
                      {i === last ? (
                        ISO_DATE.test(draft.plannedExitDate) ? (
                          `${formatDate(draft.plannedExitDate)}, the planned exit`
                        ) : (
                          'The planned exit'
                        )
                      ) : (
                        <Input
                          className="pb-deal-plan-date"
                          type="date"
                          aria-label={`Twelve months ending, plan date ${i + 1}`}
                          aria-invalid={errors[`rows.${i}.periodEnd`] !== undefined}
                          value={row.periodEnd}
                          onChange={(_e, d) => setRow(i, { periodEnd: d.value })}
                        />
                      )}
                    </td>
                    {FIGURES.map(([key, label]) => (
                      <td key={key} className="num">
                        <Input
                          className="pb-deal-plan-input"
                          inputMode="decimal"
                          aria-label={`${label} in US$ millions, plan date ${i + 1}`}
                          aria-invalid={
                            errors[`rows.${i}.${key}`] !== undefined ||
                            errors[`rows.${i}.figures`] !== undefined
                          }
                          value={row[key]}
                          onChange={(_e, d) => setRow(i, { [key]: d.value })}
                        />
                      </td>
                    ))}
                    <td>
                      {i === last || draft.rows.length <= 2 ? null : (
                        <Button
                          size="small"
                          appearance="subtle"
                          aria-label={`Remove plan date ${i + 1}`}
                          onClick={() =>
                            setDraft((d) => ({ ...d, rows: d.rows.filter((_row, at) => at !== i) }))
                          }
                        >
                          Remove
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          {faults.length === 0 ? null : (
            <div role="alert" data-testid="underwriting-plan-faults">
              <ul className="pb-deal-form-faults">
                {faults.map((fault) => (
                  <li key={fault}>{fault}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="pb-deal-actions">
            <Button
              size="small"
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  rows: [
                    ...d.rows.slice(0, -1),
                    { periodEnd: '', revenue: '', ebitda: '', netDebt: '' },
                    ...d.rows.slice(-1),
                  ],
                }))
              }
            >
              Add a plan date
            </Button>
          </div>
          <p className="pb-meta pb-deal-note">
            Figures in US$ millions: 200 is $200,000,000. Revenue and EBITDA are the twelve months
            ending on the date, net debt is at the date; net cash is a net debt below zero. Leave a
            figure empty where the plan has none.
          </p>
        </>
      )}

      <div className="pb-deal-form-grid">
        <FluentField
          label="Source document"
          hint={documentHint(
            documents.isPending
              ? 'loading'
              : documents.isError
                ? 'failed'
                : listed.length === 0
                  ? 'empty'
                  : 'listed',
          )}
          {...invalid(errors, 'sourceDocument')}
        >
          <Dropdown
            className="pb-deal-form-control"
            placeholder="None"
            disabled={listed.length === 0 && draft.sourceDocumentId === ''}
            value={documentName ?? ''}
            selectedOptions={draft.sourceDocumentId === '' ? [] : [draft.sourceDocumentId]}
            onOptionSelect={(_e, d) => {
              const id = d.optionValue ?? '';
              set(
                id === ''
                  ? { sourceDocumentId: '', sourcePage: '', sourceLocator: '' }
                  : { sourceDocumentId: id },
              );
            }}
          >
            <Option value="">None</Option>
            {listed.map((doc) => (
              <Option key={doc.id} value={doc.id} text={doc.title}>
                {doc.title}
              </Option>
            ))}
          </Dropdown>
        </FluentField>
        <FluentField label="Page" {...invalid(errors, 'sourcePage')}>
          <Input
            className="pb-deal-form-control"
            inputMode="numeric"
            disabled={draft.sourceDocumentId === ''}
            value={draft.sourcePage}
            onChange={(_e, d) => set({ sourcePage: d.value })}
          />
        </FluentField>
        <FluentField label="Sheet and cell">
          <Input
            className="pb-deal-form-control"
            disabled={draft.sourceDocumentId === ''}
            maxLength={200}
            value={draft.sourceLocator}
            onChange={(_e, d) => set({ sourceLocator: d.value })}
          />
        </FluentField>
        <FluentField
          label="Where the model is held"
          hint="When no document of the position holds the figures."
          {...invalid(errors, 'sourceNote')}
        >
          <Input
            className="pb-deal-form-control"
            maxLength={500}
            value={draft.sourceNote}
            onChange={(_e, d) => set({ sourceNote: d.value })}
          />
        </FluentField>
        <FluentField label="Note">
          <Input
            className="pb-deal-form-control"
            maxLength={2000}
            placeholder="Optional"
            value={draft.note}
            onChange={(_e, d) => set({ note: d.value })}
          />
        </FluentField>
        {needsReason ? (
          <FluentField
            label="Reason for the revision"
            required
            {...invalid(errors, 'revisionReason')}
          >
            <Input
              className="pb-deal-form-control"
              maxLength={500}
              value={draft.revisionReason}
              onChange={(_e, d) => set({ revisionReason: d.value })}
            />
          </FluentField>
        ) : null}
      </div>
      <p className="pb-meta pb-deal-note">
        A second person can confirm the case once it names a document or says where the model is
        held.
      </p>
      {errors.form === undefined ? null : (
        <p className="pb-notice pb-notice-bad" role="alert">
          {errors.form}
        </p>
      )}
      <div className="pb-deal-actions">
        <Button appearance="primary" size="small" type="submit">
          Review figures
        </Button>
        <Button appearance="secondary" size="small" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
