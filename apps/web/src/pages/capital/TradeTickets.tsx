import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Dropdown, Label, Option } from '@fluentui/react-components';
import type { CapitalNoticeRow, TradeTicketRow, TradeTicketState } from '@pb/contracts';
import { CAPITAL_TABS } from '../../app/nav.js';
import { capitalNoticesQuery, LIST_LIMIT } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  Field,
  NumCell,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  TableWrap,
  TabNav,
  Toolbar,
} from '../../components/ui.js';
import { formatDate, MISSING, plural } from '../../lib/format.js';
import { humanizeState } from '../../lib/states.js';
import { tradeTicketsQuery } from './api.js';
import { noticeAmount } from './notices.js';
import {
  BLOCKER_WORDS,
  blockerLabel,
  filterTickets,
  isTicketState,
  nothingToRelease,
  TICKET_STATES,
  ticketNoticeLabel,
} from './tickets.js';
import { ticketTone } from '../../lib/states.js';
import './capital.css';

/** Whether the ticket may be released now, or each blocker as a badge with its sentence on hover (SEC-12.3). */
function ReleaseCell({ ticket }: { ticket: TradeTicketRow }): ReactNode {
  if (nothingToRelease(ticket.state)) return <td className="pb-meta">Nothing to release</td>;
  if (ticket.release.allowed) {
    return (
      <td>
        <Badge tone="good">Allowed</Badge>
      </td>
    );
  }
  return (
    <td>
      <span className="pb-cap-subject">
        {ticket.release.blockers.map((b) => (
          <span key={b} title={BLOCKER_WORDS[b]}>
            <Badge tone="bad">{blockerLabel(b)}</Badge>
          </span>
        ))}
      </span>
    </td>
  );
}

function TicketsTable({
  rows,
  notices,
}: {
  rows: readonly TradeTicketRow[];
  notices: ReadonlyMap<string, CapitalNoticeRow>;
}): ReactNode {
  return (
    <TableWrap label="Trade tickets">
      <table className="pb-table" aria-label="Trade tickets">
        <thead>
          <tr>
            <th>Notice</th>
            <th className="num">Amount</th>
            <th>Funding date</th>
            <th>Prepared by</th>
            <th>Approved by</th>
            <th>Instruction</th>
            <th>State</th>
            <th>Release</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td>
                <Link to="/capital-activity/$id" params={{ id: t.capitalNoticeId }}>
                  {ticketNoticeLabel(t, notices)}
                </Link>
              </td>
              <NumCell>{noticeAmount(t.amount, t.currency)}</NumCell>
              <td className="pb-nowrap">{formatDate(t.fundingDate)}</td>
              <td>{t.preparedBy.name}</td>
              <td>{t.approvedBy === null ? MISSING : t.approvedBy.name}</td>
              <td className="pb-nowrap pb-wire-masked">
                {t.wireInstruction === null
                  ? MISSING
                  : `Version ${t.wireInstruction.version}: ${t.wireInstruction.bankDetailsMasked}`}
              </td>
              <td>
                <Badge tone={ticketTone(t.state)}>{humanizeState(t.state)}</Badge>
              </td>
              <ReleaseCell ticket={t} />
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/**
 * Every trade ticket the caller can see (docs/04 M16, SEC-12.3): one per notice, the preparer and
 * the approver, the instruction version it was approved against and whether it may be released
 * now. The notice names come from the notice board's own list when it is at hand.
 */
export function TradeTicketsPage(): ReactNode {
  const q = useQuery({ ...tradeTicketsQuery(), placeholderData: keepPreviousData });
  const notices = useQuery(capitalNoticesQuery({}));
  const [state, setState] = useState<TradeTicketState | ''>('');
  const header = (
    <>
      <PageHeader
        title="Trade tickets"
        meta="One ticket per notice. The preparer and the approver must differ, and a ticket releases only against a Verified wire instruction that did not change within the hold window (SEC-12.3)."
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
          subject="Trade tickets"
          forbidden={{
            title: 'Trade tickets: not visible to your role',
            detail:
              'Operations, approvers, auditors and the deal team read trade tickets (SEC-12.3). Ask a platform administrator if you need access.',
          }}
          errorTitle="Trade tickets unavailable"
          testId="tickets-unavailable"
        />
      </>
    );
  }
  const page = q.data;
  const rows = filterTickets(page.items, { state });
  const byNotice = new Map((notices.data?.items ?? []).map((n) => [n.id, n] as const));
  return (
    <>
      {header}
      <Card testId="trade-tickets">
        <SectionHeader aside="Latest funding date first">Tickets</SectionHeader>
        <Toolbar>
          <Field>
            <Label htmlFor="ticket-state">State</Label>
            <Dropdown
              id="ticket-state"
              className="pb-cap-filter"
              value={state === '' ? 'All states' : humanizeState(state)}
              selectedOptions={[state]}
              onOptionSelect={(_e, d) => {
                const v = d.optionValue ?? '';
                setState(isTicketState(v) ? v : '');
              }}
            >
              <Option value="">All states</Option>
              {TICKET_STATES.map((s) => (
                <Option key={s} value={s}>
                  {humanizeState(s)}
                </Option>
              ))}
            </Dropdown>
          </Field>
        </Toolbar>
        {rows.length === 0 ? (
          <EmptyState
            title={page.items.length === 0 ? 'No trade tickets yet' : 'No tickets in this state'}
            detail={
              page.items.length === 0
                ? 'A ticket is drafted from a reviewed capital notice on its page.'
                : 'Pick another state.'
            }
          />
        ) : (
          <TicketsTable rows={rows} notices={byNotice} />
        )}
        <p className="pb-meta" data-testid="ticket-count">
          {plural(rows.length, 'ticket')} shown.
          {page.nextCursor === null ? null : ` Showing the first ${LIST_LIMIT}; more exist.`}
        </p>
      </Card>
    </>
  );
}
