import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@fluentui/react-components';
import { previewMode } from '../../app/env.js';
import { describeActionError, useFlagChange } from '../../app/mutations.js';
import { meQuery, mockUsersQuery } from '../../app/queries.js';
import { SimulatedBadge } from '../../components/ui.js';

const REASON = 'Preview demonstration of the mock assistant';

/**
 * Preview only: the ai.assistant kill switch stays off by default (migration 0003), so the preview
 * offers platform admins the same simulated flag change the Admin, Flags page makes, and tells
 * everyone else which mock user can make it. Outside the preview this renders nothing.
 */
export function AssistantSwitch(): ReactNode {
  const me = useQuery(meQuery);
  const users = useQuery({
    ...mockUsersQuery,
    enabled: previewMode && me.data?.mockIdentity === true,
  });
  const change = useFlagChange();
  if (!previewMode || me.data === undefined) return null;
  if (me.data.roles.includes('platform_admin')) {
    return (
      <div className="pb-assistant-switch" data-testid="assistant-switch">
        <Button
          appearance="primary"
          disabled={change.isPending}
          onClick={() => change.mutate({ key: 'ai.assistant', enabled: true, reason: REASON })}
        >
          Turn the assistant on for this session
        </Button>
        <SimulatedBadge />
        {change.isError ? (
          <p className="pb-notice pb-notice-bad">{describeActionError(change.error)}</p>
        ) : null}
      </div>
    );
  }
  const admin = users.data?.users.find((u) => u.roles.includes('platform_admin'));
  return (
    <p className="pb-meta" data-testid="assistant-switch-hint">
      In this preview, switch to{' '}
      {admin === undefined ? 'the platform admin' : `${admin.displayName} (platform admin)`} with
      the user menu at the top, then turn the assistant on from this page.
    </p>
  );
}
