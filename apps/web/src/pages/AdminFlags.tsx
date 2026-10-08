import { useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Label, Switch } from '@fluentui/react-components';
import { featureFlag } from '@pb/contracts';
import { api, ApiError } from '../api/client.js';
import { previewMode } from '../app/env.js';
import { ADMIN_TABS } from '../app/nav.js';
import { flagsQuery, meQuery } from '../app/queries.js';
import {
  Badge,
  Card,
  ErrorState,
  Field,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  TabNav,
  Toolbar,
} from '../components/ui.js';

/** Feature flags and kill switches (docs/17 section 5). Only platform admins can change them; the API and RLS both enforce it. */
export function AdminFlagsPage(): ReactNode {
  const me = useQuery(meQuery);
  const flags = useQuery(flagsQuery);
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const toggle = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) =>
      api(`/api/v1/flags/${encodeURIComponent(key)}`, featureFlag, {
        method: 'PATCH',
        body: JSON.stringify({ enabled, reason }),
      }),
    onSuccess: (f) => {
      setMessage(
        `${f.key} is now ${f.enabled ? 'on' : 'off'} ${previewMode ? '(simulated in this preview, not audited)' : '(audited)'}.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['flags'] });
    },
    onError: (e) =>
      setMessage(
        e instanceof ApiError
          ? `${e.problem.title}: ${e.problem.detail ?? ''}`
          : 'The change failed.',
      ),
  });
  if (flags.isPending) return <PageSkeleton rows={6} />;
  if (flags.isError) return <ErrorState title="Flags unavailable" detail={flags.error.message} />;
  const isAdmin = me.data?.roles.includes('platform_admin') ?? false;
  return (
    <>
      <PageHeader
        title="Feature flags and kill switches"
        meta={
          isAdmin
            ? 'You can change flags; every change needs a reason and is audited.'
            : 'Read-only for your role.'
        }
      />
      <TabNav label="Admin" items={ADMIN_TABS} />
      <Card>
        <SectionHeader>Flags</SectionHeader>
        {isAdmin ? (
          <Toolbar
            end={
              <Button size="small" appearance="subtle" onClick={() => setReason('')}>
                Clear reason
              </Button>
            }
          >
            <Field>
              <Label htmlFor="flag-reason">Reason for the next change</Label>
              <Input
                id="flag-reason"
                value={reason}
                onChange={(_e, d) => setReason(d.value)}
                placeholder="Why is this changing?"
              />
            </Field>
          </Toolbar>
        ) : null}
        <div className="pb-table-wrap">
          <table className="pb-table" aria-label="Feature flags">
            <thead>
              <tr>
                <th>Key</th>
                <th>Description</th>
                <th>Enabled</th>
              </tr>
            </thead>
            <tbody>
              {flags.data.flags.map((f) => (
                <tr key={f.key}>
                  <td>
                    <span className="pb-key">{f.key}</span>
                  </td>
                  <td>
                    {f.description}
                    {f.description.includes('Kill switch') ? (
                      <>
                        {' '}
                        <Badge tone="bad" plain>
                          Kill switch
                        </Badge>
                      </>
                    ) : null}
                  </td>
                  <td>
                    <Switch
                      aria-label={`${f.key} enabled`}
                      checked={f.enabled}
                      disabled={!isAdmin || toggle.isPending || reason.trim().length < 3}
                      onChange={(_e, d) => toggle.mutate({ key: f.key, enabled: d.checked })}
                    />
                    <span className="pb-meta">{f.enabled ? 'On' : 'Off'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {message !== null ? (
          <p
            role="status"
            data-testid="flag-message"
            className={toggle.isError ? 'pb-notice pb-notice-bad' : 'pb-notice pb-notice-good'}
          >
            {message}
          </p>
        ) : null}
      </Card>
    </>
  );
}
