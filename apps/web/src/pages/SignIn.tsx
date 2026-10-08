import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Spinner } from '@fluentui/react-components';
import { mockUsersQuery } from '../app/queries.js';
import { setCredential } from '../app/session.js';
import { BeachBackground } from '../components/BeachBackground.js';
import { PreviewGuide } from '../components/PreviewGuide.js';
import { Card, ErrorState, SectionHeader } from '../components/ui.js';
import { userLabel } from '../lib/roles.js';

/** Prototype sign-in: pick a synthetic user. Entra ID single sign-on replaces this after merge (SEC-4.1). */
export function SignInPage(): ReactNode {
  const users = useQuery(mockUsersQuery);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  let body: ReactNode;
  if (users.isPending) {
    body = (
      <Card>
        <Spinner label="Loading sign-in options" />
      </Card>
    );
  } else if (users.isError) {
    body = (
      <ErrorState
        title="Sign-in unavailable"
        detail="The API did not answer. Start it with pnpm dev and seed synthetic data first."
      />
    );
  } else {
    body = (
      <Card>
        <SectionHeader>Sign in (prototype)</SectionHeader>
        <p>
          Choose a synthetic user. Each one holds a role from docs/05; what you can see is enforced
          by the API and by row-level security in the database.
        </p>
        <div className="pb-signin-list" data-testid="mock-user-list">
          {users.data.users.map((u) => (
            <Button
              key={u.externalId}
              appearance="outline"
              onClick={() => {
                setCredential(u.externalId);
                queryClient.clear();
                void navigate({ to: '/' });
              }}
            >
              {userLabel(u)}
            </Button>
          ))}
        </div>
        <p className="pb-signin-foot">
          Entra ID single sign-on replaces this picker after merge (SEC-4.1).
        </p>
      </Card>
    );
  }
  return (
    <div className="pb-signin-page">
      <BeachBackground />
      <div className="pb-signin-lockup">
        <h1 className="pb-signin-wordmark">Portfolio Beach</h1>
        <p className="pb-signin-tagline">LP and co-investment portfolio workspace</p>
      </div>
      <main className="pb-signin" aria-label="Sign in">
        {body}
        <PreviewGuide variant="sign-in" />
      </main>
      <p className="pb-signin-legal">
        Synthetic data only. No employer information is present anywhere in this system.
      </p>
    </div>
  );
}
