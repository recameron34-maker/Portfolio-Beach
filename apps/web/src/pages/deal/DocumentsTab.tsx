import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Spinner } from '@fluentui/react-components';
import type { DocumentSummary } from '@pb/contracts';
import { documentsOfInvestmentQuery, LIST_LIMIT } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import { Badge, Card, EmptyState, SectionHeader, TableWrap } from '../../components/ui.js';
import { formatDate, labelOf, MISSING, plural } from '../../lib/format.js';
import { humanizeState } from '../../lib/states.js';
import {
  datePart,
  documentHref,
  documentStatusTone,
  runHref,
  runStateTone,
  useDealId,
} from './data.js';
import { HubLink } from './parts.js';
import './deal.css';

function DocumentsTable({ items }: { items: readonly DocumentSummary[] }): ReactNode {
  return (
    <TableWrap label="Documents">
      <table className="pb-table pb-deal-documents" aria-label="Documents">
        <thead>
          <tr>
            <th>Document</th>
            <th>Type</th>
            <th>Period</th>
            <th>Status</th>
            <th>Received</th>
          </tr>
        </thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id}>
              <td>
                <span className="pb-deal-document">
                  <HubLink href={documentHref(d.id)}>{d.title}</HubLink>
                  <span className="pb-meta">{d.fileName}</span>
                </span>
              </td>
              <td>{d.docType === null ? MISSING : labelOf(d.docType)}</td>
              <td className="pb-nowrap">
                {d.periodEnd === null ? MISSING : formatDate(d.periodEnd)}
              </td>
              <td>
                <span className="pb-deal-stack">
                  <Badge tone={documentStatusTone(d.reviewStatus)}>
                    {humanizeState(d.reviewStatus)}
                  </Badge>
                  {d.latestRun === null ? null : (
                    <HubLink href={runHref(d.latestRun.id)} className="pb-deal-run-link">
                      <Badge tone={runStateTone(d.latestRun.state)}>
                        <span className="pb-visually-hidden">Extraction</span>{' '}
                        {humanizeState(d.latestRun.state)}
                      </Badge>
                    </HubLink>
                  )}
                </span>
              </td>
              <td className="pb-nowrap">{formatDate(datePart(d.receivedAt))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/**
 * Documents tab (docs/04 M3): the documents the hub has linked to this position, newest first,
 * with the type and period the classifier or a reviewer set, the review status, the latest
 * extraction run and a link to each document. Only what the caller may see arrives (SEC-8.5).
 */
export function DocumentsTab(): ReactNode {
  const id = useDealId();
  const q = useQuery(documentsOfInvestmentQuery(id));
  const n = q.data?.items.length ?? 0;
  return (
    <Card testId="deal-documents">
      <SectionHeader
        aside={q.data === undefined ? undefined : `${plural(n, 'document')}, newest first`}
      >
        Documents
      </SectionHeader>
      {q.isPending ? <Spinner size="tiny" label="Loading documents" /> : null}
      {q.isLoadingError ? (
        <UnavailableState
          inline
          error={q.error}
          subject="Documents"
          notReady={{ title: 'The document hub is not available in this build' }}
          testId="deal-documents-unavailable"
        />
      ) : null}
      {q.data !== undefined ? (
        n === 0 ? (
          <EmptyState
            title="No documents for this position"
            detail="Quarterly reports, notices and other files appear here once operations indexes the document store and they are linked to this position."
            testId="deal-documents-empty"
          />
        ) : (
          <>
            <DocumentsTable items={q.data.items} />
            {q.data.nextCursor !== null ? (
              <p className="pb-meta pb-deal-note">
                Showing the first {LIST_LIMIT} documents; the document hub lists every document.
              </p>
            ) : null}
          </>
        )
      ) : null}
      <p className="pb-meta pb-deal-note">
        <Link to="/documents">Open the document hub</Link> for every document, the review queue and
        the expected-document tracker.
      </p>
    </Card>
  );
}
