import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Spinner } from '@fluentui/react-components';
import { mockUsersQuery } from '../app/queries.js';
import { setCredential } from '../app/session.js';
import { Card, ErrorState, SectionHeader } from '../components/ui.js';

/** Prototype sign-in: pick a synthetic user. Entra ID single sign-on replaces this after merge (SEC-4.1). */
export function SignInPage(): ReactNode {
  const users = useQuery(mockUsersQuery);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  if (users.isPending) return <Spinner label="Loading sign-in options" />;
  if (users.isError)
    return (
      <ErrorState
        title="Sign-in unavailable"
        detail="The API did not answer. Start it with pnpm dev and seed synthetic data first."
      />
    );
  return (
    <div className="pb-signin">
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
              {u.displayName} ({u.roles.join(', ')})
            </Button>
          ))}
        </div>
      </Card>
    </div>
  );
}
