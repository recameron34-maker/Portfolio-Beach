import type { CSSProperties, ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight16Regular } from '@fluentui/react-icons';
import { mockUsersQuery } from '../app/queries.js';
import { setCredential } from '../app/session.js';
import { byRole, roleWords } from '../components/people.js';
import { PreviewGuide } from '../components/PreviewGuide.js';
import { ErrorState, PageHeader, RowsSkeleton } from '../components/ui.js';
import { Wordmark } from '../components/Wordmark.js';

/**
 * Prototype sign-in: pick a synthetic user. Entra ID single sign-on replaces this after merge
 * (SEC-4.1). One column under a bar like the app's: the users in one list, grouped by role.
 */
export function SignInPage(): ReactNode {
  const users = useQuery(mockUsersQuery);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  let body: ReactNode;
  if (users.isPending) {
    body = (
      <div className="pb-signin-list">
        <RowsSkeleton rows={6} />
      </div>
    );
  } else if (users.isError) {
    body = (
      <ErrorState
        title="Sign-in unavailable"
        detail="The sign-in service did not answer. Reload the page to try again."
      />
    );
  } else {
    // Each row's place in the list, so the rows settle in turn (styles.css, .pb-signin-row).
    let row = 0;
    body = (
      <div className="pb-signin-list" data-testid="mock-user-list">
        {byRole(users.data.users).map((group) => {
          const labelId = `pb-signin-${group.key.replace(/\W+/g, '-')}`;
          return (
            <div key={group.key} className="pb-signin-group" role="group" aria-labelledby={labelId}>
              <div id={labelId} className="pb-signin-group-label">
                {group.label}
              </div>
              {group.users.map((u) => (
                <button
                  key={u.externalId}
                  type="button"
                  className="pb-signin-row"
                  style={{ '--i': row++ } as CSSProperties}
                  // The name and the role as the row shows them, so what is heard is what is seen.
                  aria-label={`${u.displayName}, ${roleWords(u.roles)}`}
                  onClick={() => {
                    setCredential(u.externalId);
                    queryClient.clear();
                    void navigate({ to: '/' });
                  }}
                >
                  <span className="pb-signin-name">{u.displayName}</span>{' '}
                  <span className="pb-signin-role">{roleWords(u.roles)}</span>
                  <ChevronRight16Regular className="pb-signin-chevron" aria-hidden="true" />
                </button>
              ))}
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <div className="pb-signin-page">
      <header className="pb-signin-bar">
        <Wordmark />
        <p className="pb-signin-legal">
          Synthetic data only. No employer information is present anywhere in this system.
        </p>
      </header>
      <main className="pb-signin-picker" aria-label="Sign in">
        <PageHeader
          title="Sign in"
          meta="Choose a synthetic user. Each one holds a role, and each role sees only what it is entitled to."
        />
        {body}
        <p className="pb-signin-foot">
          In production, Microsoft Entra ID single sign-on replaces this picker.
        </p>
        <PreviewGuide variant="sign-in" />
      </main>
    </div>
  );
}
