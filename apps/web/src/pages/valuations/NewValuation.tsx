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
import type { InvestmentSummary } from '@pb/contracts';
import type { ValuationCreateBody } from '../../app/mutations.js';
import { formatDate, formatMoneyM, labelOf } from '../../lib/format.js';
import { isFairValue } from './board.js';

const positionLabel = (p: InvestmentSummary): string => `${p.investmentNumber} ${p.companyName}`;

/**
 * Starts a Draft version for one active position and the selected period (docs/18 section 1:
 * operations, investment active). The fair value is validated against the decimalString contract
 * before anything is sent.
 */
export function NewValuationDialog({
  positions,
  period,
  methods,
  initialInvestmentId,
  onCancel,
  onSubmit,
}: {
  positions: readonly InvestmentSummary[];
  period: string;
  methods: readonly string[];
  initialInvestmentId: string | null;
  onCancel: () => void;
  onSubmit: (body: ValuationCreateBody, position: InvestmentSummary) => void;
}): ReactNode {
  const [investmentId, setInvestmentId] = useState(initialInvestmentId ?? '');
  const [method, setMethod] = useState('');
  const [fairValue, setFairValue] = useState('');
  const [touched, setTouched] = useState(false);
  const position = positions.find((p) => p.id === investmentId);
  const valueText = fairValue.trim();
  const valueOk = isFairValue(valueText);
  const ready = position !== undefined && method !== '' && valueOk;
  const showValueError = touched && valueText !== '' && !valueOk;
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
            if (ready)
              onSubmit(
                { investmentId: position.id, periodEnd: period, method, fairValue: valueText },
                position,
              );
          }}
        >
          <DialogBody>
            <DialogTitle>New valuation</DialogTitle>
            <DialogContent className="pb-dialog-content">
              <p className="pb-meta">
                Starts a Draft version. Operations prepares it, the deal team approves it and an
                approver locks it; reports read Locked versions only.
              </p>
              <FluentField label="Investment" required>
                <Dropdown
                  placeholder="Choose an active position"
                  value={position === undefined ? '' : positionLabel(position)}
                  selectedOptions={investmentId === '' ? [] : [investmentId]}
                  onOptionSelect={(_e, d) => setInvestmentId(d.optionValue ?? '')}
                >
                  {positions.map((p) => (
                    <Option key={p.id} value={p.id} text={positionLabel(p)}>
                      {positionLabel(p)}
                    </Option>
                  ))}
                </Dropdown>
              </FluentField>
              <FluentField label="Period end" hint="The period selected on the board.">
                <Input readOnly appearance="filled-darker" value={formatDate(period)} />
              </FluentField>
              <FluentField label="Method" required>
                <Dropdown
                  placeholder="Choose a method"
                  value={method === '' ? '' : labelOf(method)}
                  selectedOptions={method === '' ? [] : [method]}
                  onOptionSelect={(_e, d) => setMethod(d.optionValue ?? '')}
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
                {...(showValueError
                  ? {
                      validationState: 'error' as const,
                      validationMessage:
                        'Use digits with an optional decimal point, for example 12500000.00.',
                    }
                  : {
                      hint: valueOk
                        ? `Reads as ${formatMoneyM(valueText)}.`
                        : 'Digits with an optional decimal point, for example 12500000.00.',
                    })}
              >
                <Input
                  inputMode="decimal"
                  value={fairValue}
                  onChange={(_e, d) => setFairValue(d.value)}
                  onBlur={() => setTouched(true)}
                />
              </FluentField>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onCancel}>
                Cancel
              </Button>
              <Button appearance="primary" type="submit" disabled={!ready}>
                Create draft
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
