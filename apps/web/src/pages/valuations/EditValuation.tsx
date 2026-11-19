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
  Dropdown,
  Field as FluentField,
  Input,
  Option,
} from '@fluentui/react-components';
import { Add16Regular, Dismiss16Regular } from '@fluentui/react-icons';
import { useQuery } from '@tanstack/react-query';
import { trimFractionZeros } from '@pb/calc';
import { valuationEditBody } from '@pb/contracts';
import type { ValuationDetail, ValuationEditBody } from '@pb/contracts';
import { taxonomyQuery } from '../../app/queries.js';
import { formatMoneyM, labelOf } from '../../lib/format.js';
import {
  fairValueProblem,
  inputEntries,
  inputEntriesProblem,
  inputsFromEntries,
  sameInputs,
  versionLabel,
} from './board.js';
import type { InputEntry } from './board.js';
import { isSuggestionKey, splitSuggestionKeys } from './suggestions.js';
import './valuations.css';
import { dialogSurfaceMotion, useReducedMotion } from '../../components/motion.js';

/** The active valuation methods of the taxonomy, in its order, with the version's own method always among them. */
function methodChoices(
  domains: readonly { domain: string; terms: readonly { code: string; active: boolean }[] }[],
  current: string,
): string[] {
  const active = domains
    .filter((d) => d.domain === 'valuation_method')
    .flatMap((d) => d.terms.filter((t) => t.active).map((t) => t.code));
  return active.includes(current) ? active : [current, ...active];
}

/** Why a row named like a suggestion's own key is refused: the API would drop it without a word. */
const SUGGESTION_NAME =
  'Input names that start with "suggestion." are written by a suggestion and cannot be added here.';

/** A fair value without the zeros that say nothing: 27400000.00 and 27400000 are one value. */
const plainMoney = (value: string): string => trimFractionZeros(value);

/**
 * The edit of a Draft (docs/18 section 1): operations corrects the method, the fair value and
 * the method inputs before preparing the version. The form starts from what the version holds
 * and sends only what changed (inputs go whole: the API replaces them). The fair value and the
 * inputs are checked against the contract before anything is sent. A refusal stays in the
 * dialog, so nothing typed is lost.
 */
export function EditValuationDialog({
  detail,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  detail: ValuationDetail;
  busy: boolean;
  /** Why the last attempt was refused, in the page's words; null before one is made. */
  error: string | null;
  onCancel: () => void;
  onSubmit: (body: ValuationEditBody) => void;
}): ReactNode {
  const taxonomy = useQuery(taxonomyQuery);
  const [method, setMethod] = useState(detail.method);
  const [fairValue, setFairValue] = useState(detail.fairValue);
  // What a suggestion wrote on the draft (decision 0023) is shown and never edited: the API keeps
  // those keys whatever an edit sends, so the lock seals them, and the form sends them back as
  // they are.
  const { own, kept } = splitSuggestionKeys(detail.inputs);
  const keptRows = inputEntries(kept);
  // Null when the stored inputs hold something the form cannot carry: they are left as they are.
  const [entries, setEntries] = useState<InputEntry[] | null>(() =>
    keptRows === null ? null : inputEntries(own),
  );
  const methods = methodChoices(taxonomy.data?.domains ?? [], detail.method);

  const valueText = fairValue.trim();
  const valueProblem = fairValueProblem(valueText);
  const entriesProblem =
    entries === null
      ? null
      : (inputEntriesProblem(entries) ??
        (entries.some((entry) => isSuggestionKey(entry.name.trim())) ? SUGGESTION_NAME : null));
  const nextInputs =
    entries === null || entriesProblem !== null
      ? null
      : { ...inputsFromEntries(entries, own), ...inputsFromEntries(keptRows ?? [], kept) };
  const body: ValuationEditBody = {
    ...(method !== detail.method ? { method } : {}),
    ...(valueProblem === null && plainMoney(valueText) !== plainMoney(detail.fairValue)
      ? { fairValue: valueText }
      : {}),
    ...(nextInputs !== null && !sameInputs(nextInputs, detail.inputs)
      ? { inputs: nextInputs }
      : {}),
  };
  const ready =
    valueProblem === null && entriesProblem === null && valuationEditBody.safeParse(body).success;
  const setEntry = (i: number, patch: Partial<InputEntry>): void =>
    setEntries((prev) => prev?.map((e, j) => (j === i ? { ...e, ...patch } : e)) ?? null);

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
          // The contract decides what is valid, not the browser's own tooltips.
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !busy) onSubmit(body);
          }}
        >
          <DialogBody>
            <DialogTitle>Edit draft</DialogTitle>
            <DialogContent className="pb-dialog-content">
              <p className="pb-meta">{versionLabel(detail)}</p>
              <p className="pb-meta">
                Corrects the Draft before it is prepared. Only a Draft can be edited: a prepared
                version is sent back first, and a Locked one is reopened into a new Draft.
              </p>
              <FluentField label="Method" required>
                <Dropdown
                  value={labelOf(method)}
                  selectedOptions={[method]}
                  onOptionSelect={(_e, d) => setMethod(d.optionValue ?? detail.method)}
                >
                  {methods.map((m) => (
                    <Option key={m} value={m} text={labelOf(m)}>
                      {labelOf(m)}
                    </Option>
                  ))}
                </Dropdown>
              </FluentField>
              <FluentField
                label="Fair value (dollars)"
                required
                {...(valueProblem === null
                  ? { hint: `Reads as ${formatMoneyM(valueText)}.` }
                  : { validationState: 'error' as const, validationMessage: valueProblem })}
              >
                <Input
                  inputMode="decimal"
                  value={fairValue}
                  onChange={(_e, d) => setFairValue(d.value)}
                />
              </FluentField>
              <fieldset className="pb-val-form">
                <legend className="pb-meta">Method inputs (name and value)</legend>
                {entries === null ? (
                  <p className="pb-meta">
                    These inputs hold a value that is not text or a number, so they cannot be edited
                    here and stay as they are.
                  </p>
                ) : (
                  <>
                    <p className="pb-meta">
                      What the value rests on, such as a multiple and its basis. A value written as
                      a number is kept as a number, anything else as text. The lock covers them.
                    </p>
                    {entries.map((entry, i) => (
                      <div key={i} className="pb-val-form-row">
                        <FluentField label={`Input ${i + 1} name`} size="small">
                          <Input
                            value={entry.name}
                            maxLength={100}
                            onChange={(_e, d) => setEntry(i, { name: d.value })}
                          />
                        </FluentField>
                        <FluentField label={`Input ${i + 1} value`} size="small">
                          <Input
                            value={entry.value}
                            onChange={(_e, d) => setEntry(i, { value: d.value })}
                          />
                        </FluentField>
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={<Dismiss16Regular />}
                          aria-label={`Remove input ${i + 1}`}
                          onClick={() =>
                            setEntries((prev) => prev?.filter((_e, j) => j !== i) ?? null)
                          }
                        />
                      </div>
                    ))}
                    <div>
                      <Button
                        size="small"
                        appearance="secondary"
                        icon={<Add16Regular />}
                        onClick={() =>
                          setEntries((prev) => [...(prev ?? []), { name: '', value: '' }])
                        }
                      >
                        Add input
                      </Button>
                    </div>
                    {entriesProblem === null ? null : (
                      <p className="pb-notice pb-notice-bad">{entriesProblem}</p>
                    )}
                  </>
                )}
                {keptRows === null || keptRows.length === 0 ? null : (
                  <div data-testid="valuation-suggestion-keys">
                    <p className="pb-meta">
                      Written by the suggestion this draft took its value from. They stay as they
                      are, and the lock covers them.
                    </p>
                    <ul className="pb-list" aria-label="Inputs kept from the suggestion">
                      {keptRows.map((row) => (
                        <li key={row.name}>
                          <span className="pb-key">{row.name}</span> {row.value}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </fieldset>
              {error === null ? null : (
                <p className="pb-notice pb-notice-bad" role="alert">
                  {error}
                </p>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onCancel}>
                Cancel
              </Button>
              <Button appearance="primary" type="submit" disabled={!ready || busy}>
                Save changes
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
