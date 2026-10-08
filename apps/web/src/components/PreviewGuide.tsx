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

/** Five walkthroughs of two to four steps each, in the order a reviewer would try them. */
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
          Switch to {p.wallMember}, who sits on the information wall, and open the{' '}
          <Link to="/portfolio">Portfolio</Link> again: the walled deal appears for this user only.
        </>,
        <>
          Switch to {p.investorRelations} and open <Link to="/data/health">Data Health</Link>:
          client figures cover only the clients this user is entitled to.
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
      id: 'analytics',
      title: 'Analytics and the weekly report',
      steps: [
        <>
          Open <Link to="/analytics">Analytics</Link> and step through Exposure, Performance, Credit
          book, Realizations and Clients.
        </>,
        <>
          Open the <Link to="/reporting">Weekly report</Link> and choose Print: the printed page
          leaves out the menus.
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
        <SimulatedBadge />
        <span className="pb-meta">
          Simulated changes stay in this browser tab and reset when the page reloads.
        </span>
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
  return (
    <Card testId="preview-guide">
      <div className="pb-guide-head">
        <SectionHeader>What to try in this preview</SectionHeader>
        {onHide === undefined ? null : (
          <Button size="small" appearance="subtle" autoFocus={focusHide} onClick={onHide}>
            Hide guide
          </Button>
        )}
      </div>
      <p className="pb-meta pb-guide-intro">
        {compact
          ? 'Five short walkthroughs on synthetic data. Sign in as the user a step names; after that, switch users with the user menu at the top of any page.'
          : 'Five short walkthroughs on synthetic data. Switch users with the user menu at the top of any page.'}
      </p>
      {compact ? (
        <div className="pb-guide-compact">
          {items.map((w) => (
            <details key={w.id} data-testid={`guide-${w.id}`}>
              <summary>{w.title}</summary>
              <StepList steps={w.steps} />
            </details>
          ))}
        </div>
      ) : (
        <ul className="pb-guide-list">
          {items.map((w) => (
            <li key={w.id} data-testid={`guide-${w.id}`}>
              <h3>{w.title}</h3>
              <StepList steps={w.steps} />
            </li>
          ))}
        </ul>
      )}
      {compact ? null : <ResetPreview />}
    </Card>
  );
}

/**
 * The preview walkthrough guide (lib/preview-guide.ts names the people): a compact card under the
 * sign-in list, and a card at the top of Home that the reviewer can hide, with the preview reset.
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
