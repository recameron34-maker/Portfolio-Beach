import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Input, Label } from '@fluentui/react-components';
import { ChevronRight16Regular, Send20Regular } from '@fluentui/react-icons';
import {
  analyticsQuery,
  capitalNoticesQuery,
  flagsQuery,
  wallsQuery,
  watchlistQuery,
  weeklyReportQuery,
} from '../../app/queries.js';
import {
  AiDraftBadge,
  Badge,
  Card,
  ErrorState,
  Field,
  PageHeader,
  PageSkeleton,
  RowsSkeleton,
  SectionHeader,
} from '../../components/ui.js';
import { answerQuestion, matchQuestion, QUESTIONS } from '../../lib/assistant.js';
import type { AssistantInputs, QuestionId } from '../../lib/assistant.js';
import { AssistantSwitch } from './AssistantSwitch.js';

interface Asked {
  id: QuestionId;
  /** The typed question when the fixed one was chosen by keyword overlap. */
  typed: string | null;
}

/**
 * Under every answer: who answered, in the reader's words. The same facts as the library's
 * MOCK_ASSISTANT_LINE (lib/assistant.ts), which also names the configuration key that picks the
 * mock; a page never names one (docs/06 section 6).
 */
const MOCK_LINE =
  'Answered by the mock assistant: built from the recorded figures by a fixed template, not by a model.';

/** The off state in one line; the header's dot says Off, and the meta says no model is called. */
const FLAG_OFF = 'Switched off. A platform admin turns it on under Admin, Flags.';

/**
 * Ask Portfolio Beach, honest by construction: eight fixed questions answered by templates in
 * src/lib/assistant.ts from the figures the current user's own queries return (SEC-8.5), behind
 * the ai.assistant kill switch (SEC-8.10). Nothing here calls a model.
 */
export function AssistantsPage(): ReactNode {
  const flags = useQuery(flagsQuery);
  const analytics = useQuery(analyticsQuery);
  const watchlist = useQuery(watchlistQuery);
  const notices = useQuery(capitalNoticesQuery({}));
  const weekly = useQuery(weeklyReportQuery);
  const walls = useQuery(wallsQuery);
  const [asked, setAsked] = useState<Asked | null>(null);
  const [text, setText] = useState('');
  const [unmatched, setUnmatched] = useState<string | null>(null);

  if (flags.isPending) return <PageSkeleton rows={6} />;
  if (flags.isError)
    return <ErrorState title="Assistant unavailable" detail={flags.error.message} />;
  const enabled = flags.data.flags.find((f) => f.key === 'ai.assistant')?.enabled ?? false;
  const gathering = [analytics, watchlist, notices, weekly, walls].some((q) => q.isPending);
  const inputs: AssistantInputs = {
    analytics: analytics.data ?? null,
    watchlist: watchlist.data ?? null,
    capitalNotices: notices.data ?? null,
    weeklyReport: weekly.data ?? null,
    walls: walls.data ?? null,
  };
  const answer = asked === null || gathering ? null : answerQuestion(asked.id, inputs);

  const ask = (id: QuestionId, typed: string | null): void => {
    setUnmatched(null);
    setAsked({ id, typed });
  };
  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const question = text.trim();
    if (question === '') return;
    const match = matchQuestion(question);
    if (match === null) {
      setAsked(null);
      setUnmatched(question);
      return;
    }
    ask(match.question.id, question);
  };

  return (
    <>
      <PageHeader
        title="Ask Portfolio Beach"
        meta="Answers are assembled from figures you can already see; nothing is sent to a model in the prototype."
        actions={<Badge tone={enabled ? 'good' : 'watch'}>{enabled ? 'On' : 'Off'}</Badge>}
      />
      {enabled ? null : (
        <div className="pb-assistant-off">
          <p data-testid="assistant-disabled">{FLAG_OFF}</p>
          <AssistantSwitch />
        </div>
      )}
      <div className="pb-assistant">
        <Card>
          <SectionHeader aside={`${QUESTIONS.length} fixed questions`}>Questions</SectionHeader>
          {/* Readable while the assistant is off: marked unavailable, never greyed out of reach. */}
          <ul className="pb-questions" data-testid="assistant-questions" aria-label="Questions">
            {QUESTIONS.map((q) => (
              <li key={q.id}>
                <button
                  type="button"
                  className="pb-question"
                  aria-pressed={asked?.id === q.id}
                  aria-disabled={enabled ? undefined : true}
                  onClick={() => {
                    if (enabled) ask(q.id, null);
                  }}
                >
                  <span>{q.text}</span>
                  <ChevronRight16Regular className="pb-question-chevron" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <form className="pb-ask" onSubmit={onSubmit}>
            <Field>
              <Label htmlFor="assistant-question">Or type a question</Label>
              <Input
                id="assistant-question"
                value={text}
                disabled={!enabled}
                placeholder="Which deals are stale?"
                onChange={(_e, d) => setText(d.value)}
              />
            </Field>
            <Button
              type="submit"
              appearance="primary"
              icon={<Send20Regular />}
              disabled={!enabled || text.trim() === ''}
            >
              Ask
            </Button>
          </form>
          <p className="pb-meta">
            A typed question is mapped to the fixed question it shares the most words with; the
            answer says which one it used.
          </p>
          {unmatched !== null ? (
            <p className="pb-notice pb-notice-bad" data-testid="assistant-unmatched">
              No fixed question matches &quot;{unmatched}&quot;. The mock assistant answers only the
              questions listed above.
            </p>
          ) : null}
        </Card>
        {asked !== null ? (
          <Card testId="assistant-answer">
            <SectionHeader aside={<AiDraftBadge />}>
              {QUESTIONS.find((q) => q.id === asked.id)?.text ?? 'Answer'}
            </SectionHeader>
            {asked.typed !== null ? (
              <p className="pb-meta" data-testid="assistant-answered-as">
                Answered as the fixed question above for: &quot;{asked.typed}&quot;
              </p>
            ) : null}
            {answer === null ? (
              <RowsSkeleton rows={3} label="Gathering the figures" />
            ) : (
              <>
                <div className="pb-prose" data-testid="assistant-paragraphs">
                  {answer.paragraphs.map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
                <p className="pb-sources-label">Sources</p>
                <ul className="pb-source-list" data-testid="assistant-sources">
                  {answer.sources.map((s) => (
                    <li key={s.to}>
                      <Link to={s.to}>{s.label}</Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="pb-meta pb-mock-line" data-testid="assistant-mock-line">
              {MOCK_LINE}
            </p>
          </Card>
        ) : enabled ? (
          // From 1100px the answer sits beside the questions; until one is asked, this says so.
          <section className="pb-card pb-assistant-waiting">
            <p className="pb-meta">Choose a question to see the answer and its sources.</p>
          </section>
        ) : null}
      </div>
    </>
  );
}
