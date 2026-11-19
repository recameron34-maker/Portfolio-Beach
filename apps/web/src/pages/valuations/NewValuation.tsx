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
import { fairValueProblem } from './board.js';
import { dialogSurfaceMotion, useReducedMotion } from '../../components/motion.js';

const positionLabel = (p: InvestmentSummary): string => `${p.investmentNumber} ${p.companyName}`;

/**
 * Starts a Draft version for one active position and the selected period (docs/18 section 1:
 * operations, investment active). The fair value is validated against the contract's
 * positiveMoney before anything is sent (above zero, at most 18 digits before the decimal point
 * and two after: what the column stores exactly as sent), and a refused value is told why in
 * the contract's own words.
 */
export function NewValuationDialog({
  positions,
  period,
  methods,
  methodFor,
  initialInvestmentId,
  onCancel,
  onSubmit,
}: {
  positions: readonly InvestmentSummary[];
  period: string;
  methods: readonly string[];
  /** The method the position was last marked with, offered as the default. */
  methodFor: (investmentId: string) => string | null;
  initialInvestmentId: string | null;
  onCancel: () => void;
  onSubmit: (body: ValuationCreateBody, position: InvestmentSummary) => void;
}): ReactNode {
  const [investmentId, setInvestmentId] = useState(initialInvestmentId ?? '');
  const [method, setMethod] = useState(
    initialInvestmentId === null ? '' : (methodFor(initialInvestmentId) ?? ''),
  );
  const [fairValue, setFairValue] = useState('');
  const [touched, setTouched] = useState(false);
  const position = positions.find((p) => p.id === investmentId);
  const valueText = fairValue.trim();
  const valueProblem = fairValueProblem(valueText);
  const valueOk = valueProblem === null;
  const ready = position !== undefined && method !== '' && valueOk;
  const showValueError = touched && valueText !== '' && !valueOk;
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
                  onOptionSelect={(_e, d) => {
                    const id = d.optionValue ?? '';
                    setInvestmentId(id);
                    const last = id === '' ? null : methodFor(id);
                    if (last !== null) setMethod(last);
                  }}
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
                  ? { validationState: 'error' as const, validationMessage: valueProblem }
                  : {
                      hint: valueOk
                        ? `Reads as ${formatMoneyM(valueText)}.`
                        : 'Digits with up to two decimals, for example 12500000.00.',
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
