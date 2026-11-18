import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { ValuationSuggestionRow } from '@pb/contracts';
import { SUGGESTIONS_PATH } from '../../app/nav.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import { Badge, Card, NumCell, SectionHeader, TableWrap } from '../../components/ui.js';
import { formatDate, formatMoneyM, formatPct, MISSING } from '../../lib/format.js';
import { suggestionsQuery } from './suggestions-api.js';
import {
  canReadSuggestions,
  currentMarkNote,
  flagBadges,
  REASON_SENTENCE,
  SOURCE_LABEL,
} from './suggestions.js';
import './valuations.css';

function Row({ row }: { row: ValuationSuggestionRow }): ReactNode {
  const { comparison, currentMark } = row;
  const badges = flagBadges(row.flags);
  return (
    <tr>
      <td className="pb-nowrap">{formatDate(row.periodEnd)}</td>
      <NumCell>{formatMoneyM(row.suggestedValue)}</NumCell>
      <td className={currentMark === null ? 'num is-missing' : 'num'}>
        {formatMoneyM(currentMark?.value)}
        {currentMark === null ? null : (
          <span className="pb-cell-sub">{currentMarkNote(currentMark)}</span>
        )}
      </td>
      <NumCell>{formatPct(comparison.changePct)}</NumCell>
      <td>
        <span>{SOURCE_LABEL[row.basis]}</span>
        {row.reasonCode === null ? null : (
          <span className="pb-cell-sub">Not calculable. {REASON_SENTENCE[row.reasonCode]}</span>
        )}
        {badges.length === 0 ? null : (
          <span className="pb-val-flags">
            {badges.map((b) => (
              <span key={b.label} title={b.title}>
                <Badge tone={b.tone}>{b.label}</Badge>
              </span>
            ))}
          </span>
        )}
      </td>
      <td>
        <Link
          to={SUGGESTIONS_PATH}
          search={{ id: row.id }}
          aria-label={`Workings, ${formatDate(row.periodEnd)}`}
        >
          Workings
        </Link>
      </td>
    </tr>
  );
}

/**
 * The marks suggested for one position and not yet decided (decision 0023), on its Valuations
 * tab: the quarter, the value beside the mark on record and where it came from, each opening its
 * workings on the Suggestions tab, where operations decides it. The panel is read for the roles
 * that read suggestions and shown only while the position has one open: for anyone else, and for
 * a position with none, nothing is asked for or drawn.
 */
export function SuggestedMarkPanel({
  investmentId,
  roles,
}: {
  investmentId: string;
  roles: readonly string[];
}): ReactNode {
  const reader = canReadSuggestions(roles);
  const q = useQuery({ ...suggestionsQuery({ investmentId }), enabled: reader });
  if (!reader || q.isPending) return null;
  if (q.isError)
    return (
      <Card testId="deal-suggested-mark">
        <SectionHeader>Suggested mark</SectionHeader>
        <UnavailableState
          inline
          error={q.error}
          subject="The suggested mark"
          testId="deal-suggested-mark-unavailable"
        />
      </Card>
    );
  const rows = q.data.items.filter((row) => row.state === 'Open');
  if (rows.length === 0) return null;
  return (
    <Card testId="deal-suggested-mark">
      <SectionHeader aside="Open, not yet a mark">Suggested mark</SectionHeader>
      <TableWrap label="Suggested mark">
        <table className="pb-table pb-val-table" aria-label="Suggested mark">
          <thead>
            <tr>
              <th>Quarter</th>
              <th className="num">Suggested mark</th>
              <th className="num">Current mark</th>
              <th className="num">Change</th>
              <th>Source</th>
              <th>Workings</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Row key={row.id} row={row} />
            ))}
          </tbody>
        </table>
      </TableWrap>
      <p className="pb-meta pb-deal-note">
        Worked out from an approved statement or sponsor report. It becomes a mark only once
        operations opens a draft valuation from it and the draft is approved and Locked.
        {rows.some((row) => row.suggestedValue === null) ? ` ${MISSING} means not calculable.` : ''}
      </p>
    </Card>
  );
}
