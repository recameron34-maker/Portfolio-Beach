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
import { MONEY_UNITS } from '@pb/contracts';
import type { ExtractedValue, ExtractionRunCommandBody } from '@pb/contracts';
import { editBody, editProblems, finalValueText, unitLabel, valueHint } from './extraction.js';
import type { EditForm } from './extraction.js';

/**
 * Replaces a value with the reviewer's own, and for a money field its unit (docs/18 section 7).
 * The value is checked against the unit before anything is sent, with the contract's own rules;
 * a reason is required, since the edit changes a figure a client could see (CLAUDE.md rule 6).
 */
export function EditValueDialog({
  value,
  onCancel,
  onSubmit,
}: {
  value: ExtractedValue;
  onCancel: () => void;
  onSubmit: (body: ExtractionRunCommandBody) => void;
}): ReactNode {
  const [form, setForm] = useState<EditForm>({
    value: value.editedValue ?? value.value ?? '',
    unit: value.kind === 'money' ? (value.unit ?? 'USD_M') : '',
    reason: '',
  });
  const [touched, setTouched] = useState(false);
  const problems = editProblems(value, form);
  const ready = Object.keys(problems).length === 0;
  const error = (key: keyof typeof problems): object =>
    touched && problems[key] !== undefined
      ? { validationState: 'error' as const, validationMessage: problems[key] }
      : {};
  return (
    <Dialog
      open
      onOpenChange={(_e, d) => {
        if (!d.open) onCancel();
      }}
    >
      <DialogSurface>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (ready) onSubmit(editBody(value, form));
          }}
        >
          <DialogBody>
            <DialogTitle>Edit {value.label}</DialogTitle>
            <DialogContent className="pb-dialog-content">
              <p className="pb-meta">
                The model answered {finalValueText(value)}
                {value.page === null ? '' : ` on page ${value.page}`}. Your value replaces it when
                the run is approved; the model&apos;s answer stays on record.
              </p>
              <FluentField label="Value" required hint={valueHint(value.kind)} {...error('value')}>
                <Input
                  inputMode={value.kind === 'date' ? 'text' : 'decimal'}
                  value={form.value}
                  onChange={(_e, d) => setForm({ ...form, value: d.value })}
                  onBlur={() => setTouched(true)}
                />
              </FluentField>
              {value.kind === 'money' ? (
                <FluentField label="Unit" required {...error('unit')}>
                  <Dropdown
                    value={
                      form.unit === '' ? '' : unitLabel(form.unit as (typeof MONEY_UNITS)[number])
                    }
                    selectedOptions={form.unit === '' ? [] : [form.unit]}
                    onOptionSelect={(_e, d) => setForm({ ...form, unit: d.optionValue ?? '' })}
                  >
                    {MONEY_UNITS.map((u) => (
                      <Option key={u} value={u} text={unitLabel(u)}>
                        {unitLabel(u)}
                      </Option>
                    ))}
                  </Dropdown>
                </FluentField>
              ) : null}
              <FluentField
                label="Reason"
                required
                hint="Kept in the audit trail with the value before and after."
                {...error('reason')}
              >
                <Input
                  value={form.reason}
                  onChange={(_e, d) => setForm({ ...form, reason: d.value })}
                  onBlur={() => setTouched(true)}
                />
              </FluentField>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onCancel}>
                Cancel
              </Button>
              <Button appearance="primary" type="submit" disabled={touched && !ready}>
                Edit
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * Approves the run: the accepted and edited values are promoted into the quarter on record in
 * one audited transaction (SEC-9.1). The reason is optional; without one the API records the
 * document the figures came from.
 */
export function ApproveDialog({
  subject,
  onCancel,
  onSubmit,
}: {
  subject: string;
  onCancel: () => void;
  onSubmit: (reason: string | undefined) => void;
}): ReactNode {
  const [reason, setReason] = useState('');
  return (
    <Dialog
      open
      onOpenChange={(_e, d) => {
        if (!d.open) onCancel();
      }}
    >
      <DialogSurface>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const text = reason.trim();
            onSubmit(text === '' ? undefined : text);
          }}
        >
          <DialogBody>
            <DialogTitle>Approve and promote</DialogTitle>
            <DialogContent className="pb-dialog-content">
              <p className="pb-meta">{subject}</p>
              <p className="pb-meta">
                The accepted and edited values become the quarter on record, with the document, page
                and run as their source. The highlights and commentary are written only when
                accepted.
              </p>
              <FluentField label="Reason" hint="Optional; kept in the audit trail.">
                <Input value={reason} onChange={(_e, d) => setReason(d.value)} />
              </FluentField>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onCancel}>
                Cancel
              </Button>
              <Button appearance="primary" type="submit">
                Approve and promote
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
