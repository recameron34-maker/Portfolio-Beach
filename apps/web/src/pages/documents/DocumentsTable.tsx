import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { DocumentSummary } from '@pb/contracts';
import { Badge, NumCell, TableWrap } from '../../components/ui.js';
import { formatDate, MISSING } from '../../lib/format.js';
import { reviewStatusTone, runStateTone, runStateWord } from '../../lib/states.js';
import {
  confidenceText,
  dayOf,
  docTypeLabel,
  reviewWord,
  statementHoldLine,
  subjectOf,
} from './documents.js';
import './documents.css';

/** The company or fund a document is about, as a link where the reader may follow it, its number after it. */
function SubjectCell({ doc }: { doc: DocumentSummary }): ReactNode {
  const subject = subjectOf(doc);
  return (
    <td className="pb-documents-subject">
      {subject.link === null ? (
        <span>{subject.text}</span>
      ) : (
        <Link to={subject.link.to} params={subject.link.params}>
          {subject.text}
        </Link>
      )}
      {doc.investmentNumber === null ? null : (
        <>
          {' '}
          <span className="pb-key">{doc.investmentNumber}</span>
        </>
      )}
    </td>
  );
}

/**
 * The hub's table, shared by the hub, the review queue and any tab that lists documents: title
 * (a link to the document) with its file name and, for a statement held because the position it
 * names did not link, what the reviewer is asked to choose; then type, company or fund, period, status, received,
 * the classifier's confidence and the latest extraction run (a link to its review page). The title
 * and the file name keep one line each, cut short with their whole text in the title. `busy` dims
 * the rows while a new search or filter replaces them.
 */
export function DocumentsTable({
  items,
  label,
  testId,
  busy = false,
}: {
  items: readonly DocumentSummary[];
  label: string;
  testId: string;
  busy?: boolean;
}): ReactNode {
  return (
    <TableWrap label={label} busy={busy}>
      <table className="pb-table pb-documents-table" aria-label={label} data-testid={testId}>
        <thead>
          <tr>
            <th>Title</th>
            <th>Type</th>
            <th>Company or fund</th>
            <th>Period</th>
            <th>Status</th>
            <th>Received</th>
            <th className="num">Confidence</th>
            <th>Latest run</th>
          </tr>
        </thead>
        <tbody>
          {items.map((doc) => {
            const hold = statementHoldLine(doc);
            return (
              <tr key={doc.id}>
                <td className="pb-documents-title">
                  <Link
                    to="/documents/$id"
                    params={{ id: doc.id }}
                    className="pb-documents-clip is-title"
                    title={doc.title}
                  >
                    {doc.title}
                  </Link>
                  {doc.fileName === doc.title ? null : (
                    <span className="pb-cell-sub">
                      <span className="pb-documents-clip" title={doc.fileName}>
                        {doc.fileName}
                      </span>
                    </span>
                  )}
                  {hold === null ? null : (
                    <span className="pb-cell-sub" data-testid={`statement-hold-${doc.id}`}>
                      {hold}
                    </span>
                  )}
                </td>
                <td className="pb-nowrap">{docTypeLabel(doc.docType)}</td>
                <SubjectCell doc={doc} />
                <td className="pb-nowrap">{formatDate(doc.periodEnd)}</td>
                <td>
                  <Badge tone={reviewStatusTone(doc.reviewStatus)}>
                    {reviewWord(doc.reviewStatus)}
                  </Badge>
                </td>
                <td className="pb-nowrap">{dayOf(doc.receivedAt)}</td>
                <NumCell>{confidenceText(doc.classificationConfidence)}</NumCell>
                <td>
                  {doc.latestRun === null ? (
                    <span className="pb-meta">{MISSING}</span>
                  ) : (
                    <Link to="/documents/extraction/$id" params={{ id: doc.latestRun.id }}>
                      <Badge tone={runStateTone(doc.latestRun.state)}>
                        {runStateWord(doc.latestRun.state)}
                      </Badge>
                    </Link>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}
