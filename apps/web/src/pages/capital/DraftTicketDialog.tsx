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
  Field as FluentField,
  Input,
} from '@fluentui/react-components';
import { isoDate, positiveDecimal } from '@pb/contracts';
import type { CapitalNoticeDetail } from '@pb/contracts';
import { formatDate } from '../../lib/format.js';
import { noticeAmount } from './notices.js';

export interface DraftTicketValues {
  fundingDate: string;
  amount: string;
}

/**
 * Drafts the trade ticket of a notice (docs/18 section 3, SEC-12.3): the funding date and the
 * amount start as the notice's due date and amount and may be changed before the draft is sent.
 * Both are checked against the contract (a real calendar date, a decimal above zero) before
 * anything leaves the page. Bank details are never part of a ticket: the ticket is released
 * against the register's Verified instruction only (SEC-12.1, SEC-12.2).
 */
export function DraftTicketDialog({
  notice,
  onCancel,
  onSubmit,
}: {
  notice: CapitalNoticeDetail;
  onCancel: () => void;
  onSubmit: (values: DraftTicketValues) => void;
}): ReactNode {
  const [fundingDate, setFundingDate] = useState(notice.dueDate);
  const [amount, setAmount] = useState(notice.amount);
  const [touched, setTouched] = useState(false);
  const dateText = fundingDate.trim();
  const amountText = amount.trim();
  const dateOk = isoDate.safeParse(dateText).success;
  const amountOk = positiveDecimal.safeParse(amountText).success;
  const ready = dateOk && amountOk;
  return (
    <Dialog
      open
      onOpenChange={(_e, d) => {
        if (!d.open) onCancel();
      }}
    >
      <DialogSurface>
        <form
          data-testid="draft-ticket-form"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (ready) onSubmit({ fundingDate: dateText, amount: amountText });
          }}
        >
          <DialogBody>
            <DialogTitle>Draft ticket</DialogTitle>
            <DialogContent className="pb-dialog-content">
              <p className="pb-meta">
                Prefilled from the notice: due {formatDate(notice.dueDate)},{' '}
                {noticeAmount(notice.amount, notice.currency)} {notice.currency}. A different person
                approves the ticket, against the counterparty&apos;s Verified wire instruction
                (SEC-12.3).
              </p>
              <FluentField
                label="Funding date"
                required
                {...(touched && !dateOk
                  ? {
                      validationState: 'error' as const,
                      validationMessage: 'Give a real calendar date as YYYY-MM-DD.',
                    }
                  : { hint: 'YYYY-MM-DD; the notice due date unless the wire goes earlier.' })}
              >
                <Input
                  value={fundingDate}
                  onChange={(_e, d) => setFundingDate(d.value)}
                  onBlur={() => setTouched(true)}
                />
              </FluentField>
              <FluentField
                label={`Amount (${notice.currency})`}
                required
                {...(touched && !amountOk
                  ? {
                      validationState: 'error' as const,
                      validationMessage:
                        'Digits above zero with an optional decimal point, for example 2500000.00.',
                    }
                  : {
                      hint: amountOk
                        ? `Reads as ${noticeAmount(amountText, notice.currency)}.`
                        : 'Digits with an optional decimal point, for example 2500000.00.',
                    })}
              >
                <Input
                  inputMode="decimal"
                  value={amount}
                  onChange={(_e, d) => setAmount(d.value)}
                  onBlur={() => setTouched(true)}
                />
              </FluentField>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onCancel}>
                Cancel
              </Button>
              <Button appearance="primary" type="submit" disabled={!ready}>
                Draft ticket
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
