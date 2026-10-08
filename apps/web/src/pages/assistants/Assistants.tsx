import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Input, Label, Spinner } from '@fluentui/react-components';
import { Send20Regular } from '@fluentui/react-icons';
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
  SectionHeader,
} from '../../components/ui.js';
import {
  answerQuestion,
  matchQuestion,
  MOCK_ASSISTANT_LINE,
  QUESTIONS,
} from '../../lib/assistant.js';
import type { AssistantInputs, QuestionId } from '../../lib/assistant.js';
import { AssistantSwitch } from './AssistantSwitch.js';

interface Asked {
  id: QuestionId;
  /** The typed question when the fixed one was chosen by keyword overlap. */
  typed: string | null;
}

const FLAG_OFF =
  'The ai.assistant flag is off. Platform admins can turn it on under Admin, Flags; in the prototype the assistant answers from the figures on this page, not from a model.';

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
        meta="Answers are assembled from figures you can already see; nothing is sent to a model in the prototype (docs/07)."
        actions={
          enabled ? (
            <Badge tone="good">ai.assistant on</Badge>
          ) : (
            <Badge tone="watch">ai.assistant off</Badge>
          )
        }
      />
      {enabled ? null : (
        <>
          <p className="pb-notice" data-testid="assistant-disabled">
            {FLAG_OFF}
          </p>
          <AssistantSwitch />
        </>
      )}
      <Card>
        <SectionHeader aside={`${QUESTIONS.length} fixed questions`}>Questions</SectionHeader>
        <div className="pb-questions" data-testid="assistant-questions">
          {QUESTIONS.map((q) => (
            <Button
              key={q.id}
              appearance={asked?.id === q.id ? 'primary' : 'secondary'}
              aria-pressed={asked?.id === q.id}
              disabled={!enabled}
              onClick={() => ask(q.id, null)}
            >
              {q.text}
            </Button>
          ))}
        </div>
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
          A typed question is mapped to the fixed question it shares the most words with; the answer
          says which one it used.
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
            <Spinner size="tiny" label="Gathering the figures" />
          ) : (
            <>
              <div className="pb-prose" data-testid="assistant-paragraphs">
                {answer.paragraphs.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
              <p className="pb-meta">Sources</p>
              <ul className="pb-linklist" data-testid="assistant-sources">
                {answer.sources.map((s) => (
                  <li key={s.to}>
                    <Link to={s.to}>{s.label}</Link>
                    <span className="pb-meta">{s.to}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="pb-meta pb-mock-line" data-testid="assistant-mock-line">
            {MOCK_ASSISTANT_LINE}
          </p>
        </Card>
      ) : null}
    </>
  );
}
