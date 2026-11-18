import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@fluentui/react-components';
import type { SuggestionInput, ValuationSuggestionRow } from '@pb/contracts';
import { extractionRunQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import { Badge, NumCell, PageSkeleton, TableWrap } from '../../components/ui.js';
import { formatDate, formatMoneyM2, MISSING } from '../../lib/format.js';
import { findQuote } from '../extraction/extraction.js';
import { PageView } from '../extraction/PageView.js';
import '../extraction/extraction.css';
import {
  contributionsSentence,
  crossCheckSentence,
  inputLabel,
  inputSourceText,
  inputValueText,
  REASON_SENTENCE,
  ruleSentence,
  tieSentence,
} from './suggestions.js';
import './valuations.css';

/**
 * The page an input was read from, drawn from the text of the run that read it, with the quote
 * of the figure highlighted when the run still holds it. The run is read only once a person asks
 * for the page (the API audits every open of a run).
 */
function SourcePage({
  runId,
  input,
  fileName,
}: {
  runId: string;
  input: SuggestionInput;
  fileName: string;
}): ReactNode {
  const q = useQuery(extractionRunQuery(runId));
  if (q.isPending) return <PageSkeleton rows={3} />;
  if (q.isError)
    return (
      <UnavailableState
        inline
        error={q.error}
        subject="The source page"
        testId="suggestion-page-unavailable"
      />
    );
  const page = q.data.pages.find((p) => p.number === input.source.page);
  if (page === undefined)
    return (
      <p className="pb-meta" data-testid="suggestion-page-missing">
        Page {input.source.page ?? MISSING} of {fileName} could not be drawn.{' '}
        <Link to="/documents/extraction/$id" params={{ id: runId }}>
          Open the review of this document
        </Link>
        .
      </p>
    );
  const quote = q.data.values.find((v) => v.field === input.key)?.quote ?? null;
  const highlight = findQuote(page, quote);
  return (
    <>
      <p className="pb-meta" data-testid="suggestion-page-note">
        {highlight.length === 0
          ? `${inputLabel(input.key)} is cited on page ${page.number} of ${fileName}.`
          : `Highlighting ${inputLabel(input.key)} on page ${page.number} of ${fileName}.`}{' '}
        <Link to="/documents/extraction/$id" params={{ id: runId }}>
          Open the review of this document
        </Link>
        .
      </p>
      <div
        className="pb-extraction-page-frame"
        role="region"
        aria-label={`Page ${page.number} of ${fileName}`}
        tabIndex={0}
      >
        <PageView
          page={page}
          highlight={highlight}
          label={`Page ${page.number} of ${fileName}, drawn from its text`}
        />
      </div>
    </>
  );
}

/** Where an input came from: a page a reader can open, the Locked mark itself, or plain words. */
function SourceCell({
  row,
  input,
  shown,
  onToggle,
}: {
  row: ValuationSuggestionRow;
  input: SuggestionInput;
  shown: boolean;
  onToggle: () => void;
}): ReactNode {
  const text = inputSourceText(input);
  const { source } = input;
  if (source.kind === 'valuation')
    return (
      <td>
        <Link to="/valuations/$id" params={{ id: source.id }}>
          {text}
        </Link>
      </td>
    );
  if (source.kind !== 'document') return <td>{text}</td>;
  // The page is drawn from the run that read the suggestion's own document; a figure read from
  // another document opens that document instead.
  if (source.id !== row.source.documentId || source.page === null)
    return (
      <td>
        <Link to="/documents/$id" params={{ id: source.id }}>
          {text}
        </Link>
      </td>
    );
  return (
    <td>
      <Button
        size="small"
        appearance="subtle"
        aria-expanded={shown}
        aria-label={`${text}: ${shown ? 'hide' : 'show'} the page for ${inputLabel(input.key)}`}
        onClick={onToggle}
      >
        {text}
      </Button>
    </td>
  );
}

function InputsTable({
  row,
  shownKey,
  onToggle,
}: {
  row: ValuationSuggestionRow;
  shownKey: string | null;
  onToggle: (key: string) => void;
}): ReactNode {
  return (
    <TableWrap label="Inputs">
      <table className="pb-table" aria-label="Inputs" data-testid="suggestion-inputs">
        <thead>
          <tr>
            <th>Input</th>
            <th className="num">Value</th>
            <th>For</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {row.workings.inputs.map((input) => (
            <tr key={input.key}>
              <td>{inputLabel(input.key)}</td>
              <NumCell>{inputValueText(input)}</NumCell>
              <td className="pb-nowrap">{formatDate(input.periodEnd)}</td>
              <SourceCell
                row={row}
                input={input}
                shown={shownKey === input.key}
                onToggle={() => onToggle(input.key)}
              />
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/**
 * How a suggested mark was worked out (docs/08 section 12): the rule in a sentence, each input
 * with its figure and where it came from, the two checks of a statement and the other sources of
 * the quarter beside it. A reader can check the value from what is shown; nothing is blended and
 * nothing here is calculated.
 */
export function SuggestionWorkings({ row }: { row: ValuationSuggestionRow }): ReactNode {
  const [shownKey, setShownKey] = useState<string | null>(null);
  const shown = row.workings.inputs.find((input) => input.key === shownKey);
  const { checks, comparison, currentMark } = row;
  return (
    <div className="pb-val-workings" data-testid="suggestion-workings">
      <p data-testid="suggestion-rule">{ruleSentence(row)}</p>
      {row.suggestedValue === null ? (
        <p className="pb-notice" data-testid="suggestion-not-calculable">
          Not calculable this quarter.{' '}
          {row.reasonCode === null ? null : REASON_SENTENCE[row.reasonCode]}
        </p>
      ) : null}
      {checks?.ownAccount === true ? <p className="pb-meta">Read as our own account.</p> : null}
      {row.workings.inputs.length === 0 ? (
        <p className="pb-meta">No input was read for this rule.</p>
      ) : (
        <InputsTable
          row={row}
          shownKey={shownKey}
          onToggle={(key) => setShownKey((prev) => (prev === key ? null : key))}
        />
      )}
      {shown === undefined ? null : (
        <SourcePage
          runId={row.source.extractionRunId}
          input={shown}
          fileName={shown.source.fileName ?? row.source.fileName ?? 'the document'}
        />
      )}
      {checks === null ? null : (
        <>
          <h3 className="pb-val-sub">Checks on the statement</h3>
          <ul className="pb-list" aria-label="Checks on the statement">
            <li>
              {tieSentence(checks)}
              {checks.ties === false ? (
                <>
                  {' '}
                  <Badge tone="watch">Does not tie</Badge>
                </>
              ) : null}
            </li>
            <li>
              {contributionsSentence(checks.contributionsCheck)}
              {checks.contributionsCheck.differs === true ? (
                <>
                  {' '}
                  <Badge tone="watch">Contributions differ</Badge>
                </>
              ) : null}
            </li>
            {comparison.netOfFlows === null &&
            comparison.beginningBalance !== null &&
            currentMark !== null ? (
              <li>
                The statement opens the quarter at {formatMoneyM2(comparison.beginningBalance)}; the
                mark on record is {formatMoneyM2(currentMark.value)}, so no change net of flows is
                shown.
              </li>
            ) : null}
          </ul>
          <p className="pb-meta">A check never changes the suggested value.</p>
        </>
      )}
      <h3 className="pb-val-sub">Other sources for this quarter</h3>
      {row.crossChecks.length === 0 ? (
        <p className="pb-meta">No other source is on hand for this quarter.</p>
      ) : (
        <ul className="pb-list" aria-label="Other sources for this quarter">
          {row.crossChecks.map((check) => (
            <li key={check.basis}>
              {crossCheckSentence(check, row.basis)}
              {check.differs ? (
                <>
                  {' '}
                  <Badge tone="watch">Sources differ</Badge>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
