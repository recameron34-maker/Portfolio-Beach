import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@fluentui/react-components';
import { previewMode } from '../app/env.js';
import { describeActionError, usePreviewReset } from '../app/mutations.js';
import { mockUsersQuery } from '../app/queries.js';
import { guidePeople } from '../lib/preview-guide.js';
import type { GuidePeople } from '../lib/preview-guide.js';
import { Card, SectionHeader, SimulatedBadge } from './ui.js';

interface Walkthrough {
  id: string;
  title: string;
  steps: ReactNode[];
}

/** Fourteen walkthroughs of two to four steps each, in the order a reviewer would try them. */
function walkthroughs(p: GuidePeople): Walkthrough[] {
  return [
    {
      id: 'walls',
      title: 'Walls and entitlements',
      steps: [
        <>
          Sign in as {p.viewer} and open the <Link to="/portfolio">Portfolio</Link>; note the
          positions listed.
        </>,
        <>
          Switch to {p.wallMember}, a member of the information wall, and open the{' '}
          <Link to="/portfolio">Portfolio</Link> again: the walled deal appears only for the wall's
          members.
        </>,
        <>
          Switch to {p.investorRelations} and open <Link to="/reporting/clients">Clients</Link>{' '}
          under Reporting: the look-through covers only the clients this user is entitled to.
        </>,
      ],
    },
    {
      id: 'valuations',
      title: 'Valuation approval',
      steps: [
        <>
          As {p.operations}, open <Link to="/valuations">Valuations</Link>, start a valuation for
          the position under Missing marks and Prepare it.
        </>,
        <>
          Switch to {p.dealTeam} to Deal team approve it, then to {p.approver} to Lock it.
        </>,
        <>Reopen the Locked version with a reason: a new Draft version starts for the period.</>,
        <>
          Back as {p.operations}, try to approve a version you prepared: Deal team approve stays
          disabled, because preparing and approving belong to different people.
        </>,
      ],
    },
    {
      id: 'capital',
      title: 'Capital controls',
      steps: [
        <>
          As {p.operations}, open <Link to="/capital-activity">Capital activity</Link> and the call
          marked Wire change.
        </>,
        <>Review it, then Draft ticket.</>,
        <>
          Try Approve ticket: it is refused, because the person who drafted the ticket cannot
          approve it.
        </>,
        <>
          Switch to {p.approver} and try again: still blocked, because the wire stays unverified
          until the wire register arrives.
        </>,
      ],
    },
    {
      id: 'intake',
      title: 'Accounting import',
      steps: [
        <>
          As {p.operations}, open <Link to="/data/intake">Intake</Link> under Data and stage the
          defects sample: the file page counts the rows a rule flagged and the exceptions opened for
          a person, and notes a row linked to a position outside your wall.
        </>,
        <>
          Approve the validated rows: they are promoted at once. Then reject the flagged rows with a
          reason.
        </>,
        <>
          Switch to {p.wallMember} and look at the same file: the walled position's row is listed
          and the note is gone.
        </>,
        <>Switch to {p.viewer} and open Intake: it says who intake is for.</>,
      ],
    },
    {
      id: 'weekly',
      title: 'Weekly values',
      steps: [
        <>
          As {p.operations}, open <Link to="/data/weekly">Weekly values</Link> under Data and stage{' '}
          <span className="pb-key">weekly-values-defects.csv</span> from the drop folder: every
          value is compared with its prior, and a move beyond the threshold is flagged for a person.
        </>,
        <>
          Approve the validated rows: each becomes a Draft valuation on the{' '}
          <Link to="/valuations">Valuations</Link> board, never a Locked mark.
        </>,
        <>
          Switch to {p.wallMember} and look at the same file: the walled position's value is listed
          and the note is gone.
        </>,
      ],
    },
    {
      id: 'lookthrough',
      title: 'Look-through and exceptions',
      steps: [
        <>
          As {p.operations}, open <Link to="/data/lookthrough">Look-through</Link> under Data and
          reconcile the as-of date: the run counts the differences against the record and the
          exceptions it opened, and nothing on record changes.
        </>,
        <>
          Follow the exceptions link to the <Link to="/data/exceptions">Exceptions</Link> queue,
          open one, acknowledge it, then resolve it with a reason or note a ticket.
        </>,
        <>
          Reconcile the quarter end before: the provider's extract agrees with the record and
          nothing is opened.
        </>,
      ],
    },
    {
      id: 'ops-drop',
      title: 'Workbook drop',
      steps: [
        <>
          As {p.operations}, open <Link to="/data/intake">Intake</Link> under Data and stage{' '}
          <span className="pb-key">ops-drop-clean.xlsx</span> from the ops drop folder: the workbook
          is matched to its template by its sheets and header, then staged like an accounting
          export.
        </>,
        <>
          Stage <span className="pb-key">ops-drop-unknown-template.xlsx</span>: it is refused with a
          finding that names the templates the drop knows, and nothing is staged.
        </>,
      ],
    },
    {
      id: 'documents',
      title: 'Documents and classification',
      steps: [
        <>
          As {p.operations}, open <Link to="/documents">Documents</Link> and choose Index documents:
          every bundled report, notice and statement is read, hashed and classified in the browser,
          and the second copy of one report is marked a duplicate.
        </>,
        <>
          Open the <Link to="/documents/review">Review queue</Link>: the untitled scan waits for a
          person. Open it, read its pages, and classify it with its position and quarter.
        </>,
        <>
          Open <Link to="/documents/expected">Expected documents</Link> and generate the latest
          quarter: one position's report is absent and stays expected; move Judged as of past the
          due date to see it turn late, then missing.
        </>,
        <>
          Switch to {p.wallMember} and search the hub for the walled company: its reports appear for
          a wall member only.
        </>,
      ],
    },
    {
      id: 'extraction',
      title: 'Extraction review',
      steps: [
        <>
          As {p.admin}, turn on AI extraction under <Link to="/admin/flags">Flags</Link>; then as{' '}
          {p.operations}, open <Link to="/documents/extraction">Extraction</Link> and start a batch
          for the latest quarter's quarterly financials: each run reads its report through the
          recorded fixture and the validator.
        </>,
        <>
          Open a run: accept the clean values, edit one value through its dialog, and choose a page
          number to see the quote highlighted on the page.
        </>,
        <>
          Approve and promote: the figures reach the position's Performance tab in dollars, with a
          source link to the page they were read from.
        </>,
      ],
    },
    {
      id: 'suggestions',
      title: 'Valuation suggestions',
      steps: [
        <>
          With the documents indexed and AI extraction on (the two walkthroughs above), as{' '}
          {p.operations} open <Link to="/documents/extraction">Extraction</Link> and start two
          batches for the latest quarter: its quarterly financials, then its capital account
          statements.
        </>,
        <>
          Open the report run of the position that <Link to="/valuations">Valuations</Link> lists
          under Missing marks, decide its values and approve it: the run page says a valuation
          suggestion was opened, the last Locked mark scaled by the sponsor's equity value.
        </>,
        <>
          Switch to {p.dealTeam} and approve the statement run of the same position: its ending
          balance replaces the first suggestion. Open{' '}
          <Link to="/valuations/suggestions">Suggestions</Link> under Valuations to read the
          workings, the page each figure came from and the report's indication beside it.
        </>,
        <>
          Back as {p.operations}, choose Open a draft valuation and Prepare the draft: no mark is
          written until it is approved and locked, and {p.dealTeam}, who approved the statement, is
          refused Deal team approve.
        </>,
      ],
    },
    {
      id: 'monitoring',
      title: 'Monitoring board',
      steps: [
        <>
          Open <Link to="/portfolio/monitoring">Monitoring</Link> under Portfolio: one row per
          position held at the quarter end, with its expected report, its latest run and its
          approval; move As of past the due date to see the absent report turn late.
        </>,
        <>Choose Export CSV: the download holds the same rows the board shows you.</>,
        <>
          Switch to {p.dealTeam} and set the realization outlook on a position's Performance tab
          with a reason; every other role reads it.
        </>,
        <>
          On the same tab, as {p.dealTeam}, record the sponsor's base case for a position that has
          none, then switch to {p.approver} to confirm it: the card then sets the position against
          plan. Whoever entered the figures cannot confirm them.
        </>,
      ],
    },
    {
      id: 'analytics',
      title: 'Analytics and the weekly report',
      steps: [
        <>
          Open <Link to="/analytics">Analytics</Link> and step through Exposure, Performance, Value
          creation, Entry metrics, Credit book, Realizations and Clients.
        </>,
        <>
          On Value creation, read how our gain splits into EBITDA growth, multiple expansion and
          debt paydown, open EBITDA growth into revenue and margin, and sort the positions; a
          company opens its own bridge on its Performance tab. Entry metrics compares performance by
          entry purchase multiple and entry net leverage.
        </>,
        <>
          Open the <Link to="/reporting">Weekly report</Link> and choose Print: the printed page
          leaves out the menus.
        </>,
      ],
    },
    {
      id: 'packages',
      title: 'Client packages',
      steps: [
        <>
          As {p.investorRelations}, open <Link to="/reporting/packages">Packages</Link> under
          Reporting, choose Start package, pick a client, Gross and Final, and start it.
        </>,
        <>
          Generate it: the checks run and some fail. Each failed check shows what it expected and
          what it found, and Submit is not offered while one fails.
        </>,
        <>
          Switch to {p.approver}, open the package from the list and choose Override QA with a
          reason. Back as {p.investorRelations}, Submit it.
        </>,
        <>
          As {p.approver}, Approve it: the hash of everything the package shows appears. As{' '}
          {p.investorRelations}, Release it: the package is read only from then on.
        </>,
      ],
    },
    {
      id: 'assistant',
      title: 'Ask Portfolio Beach',
      steps: [
        <>
          As {p.admin}, open <Link to="/assistants">Assistants</Link> and turn the assistant on for
          this session.
        </>,
        <>
          Switch to any user and ask a question: the answer uses only figures that user can already
          see.
        </>,
      ],
    },
  ];
}

function StepList({ steps }: { steps: ReactNode[] }): ReactNode {
  return (
    <ol className="pb-guide-steps">
      {steps.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ol>
  );
}

/** The reset button and its result, announced politely (the mock banner stays the page's status). */
function ResetPreview(): ReactNode {
  const reset = usePreviewReset();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="pb-guide-foot">
      <div className="pb-guide-reset">
        <Button
          size="small"
          appearance="secondary"
          disabled={reset.isPending}
          onClick={() =>
            reset.mutate(undefined, {
              onSuccess: () =>
                setMessage('Preview reset. Every simulated change in this tab is forgotten.'),
              onError: (error) => setMessage(`Reset preview: ${describeActionError(error)}`),
            })
          }
        >
          Reset preview
        </Button>
        <span className="pb-meta">
          Simulated changes stay in this browser tab and reset when the page reloads.
        </span>
        <SimulatedBadge />
      </div>
      <p className="pb-meta pb-guide-result" aria-live="polite" data-testid="guide-reset-result">
        {message}
      </p>
    </div>
  );
}

function Guide({
  variant,
  onHide,
  focusHide,
}: {
  variant: 'sign-in' | 'home';
  onHide?: (() => void) | undefined;
  focusHide: boolean;
}): ReactNode {
  const users = useQuery(mockUsersQuery);
  const items = walkthroughs(guidePeople(users.data?.users ?? []));
  const compact = variant === 'sign-in';
  // Folded at every width, a walkthrough a row, so the guide never outweighs the page above it;
  // on Home, two columns from 1100px.
  return (
    <Card testId="preview-guide">
      <div className="pb-guide-head">
        <SectionHeader>{`Preview walkthroughs (${items.length})`}</SectionHeader>
        {onHide === undefined ? null : (
          <Button size="small" appearance="subtle" autoFocus={focusHide} onClick={onHide}>
            Hide guide
          </Button>
        )}
      </div>
      <p className="pb-meta pb-guide-intro">
        {compact
          ? 'Fourteen short walkthroughs on synthetic data. Sign in as the user a step names; after that, switch users with the user menu at the top of any page.'
          : 'Fourteen short walkthroughs on synthetic data. Switch users with the user menu at the top of any page.'}
      </p>
      <div className={compact ? 'pb-guide-compact' : 'pb-guide-compact is-columns'}>
        {items.map((w) => (
          <details key={w.id} className="pb-details" data-testid={`guide-${w.id}`}>
            <summary>{w.title}</summary>
            <StepList steps={w.steps} />
          </details>
        ))}
      </div>
      {compact ? null : <ResetPreview />}
    </Card>
  );
}

/**
 * The preview walkthrough guide (lib/preview-guide.ts names the people): a section under the
 * sign-in list, and one after Home's dashboard that the reviewer can hide, with the preview reset.
 * Renders nothing outside the static preview.
 */
export function PreviewGuide({
  variant,
  onHide,
  focusHide = false,
}: {
  variant: 'sign-in' | 'home';
  onHide?: (() => void) | undefined;
  /** Move keyboard focus to the hide button when the guide appears (it was just shown again). */
  focusHide?: boolean | undefined;
}): ReactNode {
  if (!previewMode) return null;
  return <Guide variant={variant} onHide={onHide} focusHide={focusHide} />;
}
