import { useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Label, Switch } from '@fluentui/react-components';
import { previewMode } from '../app/env.js';
import { describeActionError, patchFlag } from '../app/mutations.js';
import type { FeatureFlag } from '../app/mutations.js';
import { ADMIN_TABS } from '../app/nav.js';
import { flagsQuery, meQuery } from '../app/queries.js';
import { useJustChanged } from '../components/motion.js';
import type { JustChangedProps } from '../components/motion.js';
import {
  Badge,
  Card,
  ErrorState,
  PageHeader,
  PageSkeleton,
  TableWrap,
  TabNav,
} from '../components/ui.js';
import { useNarrowScreen } from '../lib/media.js';
import { withoutReferences } from '../lib/references.js';

/**
 * A flag as the result line names it: its description without the control it cites, and a kill
 * switch as "The switch for ...". "Kill switch for AI extraction calls is now off" would read as
 * the calls being allowed, when off is what stops them.
 */
const switchWords = (description: string): string =>
  withoutReferences(description).replace(/^Kill switch for /, 'The switch for ');

/** A switch the reader can change, or not yet: the reason unlocks it, the role allows it. */
interface FlagRowProps {
  flag: FeatureFlag;
  disabled: boolean;
  narrow: boolean;
  onChange: (enabled: boolean) => void;
  washing: JustChangedProps;
}

/**
 * One flag: its description without the control it cites (the key is never shown), its state as a
 * dot and a word, and the switch. On a phone the switch comes second so it stays on screen. The
 * switch keeps the key in its accessible name, which the preview's probe reads
 * (docs/SESSION_LOG.md, open items).
 */
function FlagRow({ flag, disabled, narrow, onChange, washing }: FlagRowProps): ReactNode {
  const name = (
    <th scope="row" className="pb-flag-name">
      {withoutReferences(flag.description)}
      {flag.description.includes('Kill switch') ? (
        <span className="pb-flag-marker">Kill switch</span>
      ) : null}
    </th>
  );
  const state = (
    <td className="pb-col-fit">
      <Badge tone={flag.enabled ? 'good' : 'neutral'}>{flag.enabled ? 'On' : 'Off'}</Badge>
    </td>
  );
  const change = (
    <td className="pb-col-fit pb-flag-change">
      <span className="pb-switch-cell">
        <Switch
          aria-label={`${flag.key} enabled`}
          checked={flag.enabled}
          disabled={disabled}
          onChange={(_e, d) => onChange(d.checked)}
        />
      </span>
    </td>
  );
  return (
    <tr {...washing}>
      {name}
      {narrow ? change : state}
      {narrow ? state : change}
    </tr>
  );
}

/** Feature flags and kill switches (docs/17 section 5). Only platform admins can change them; the API and RLS both enforce it. */
export function AdminFlagsPage(): ReactNode {
  const me = useQuery(meQuery);
  const flags = useQuery(flagsQuery);
  const queryClient = useQueryClient();
  const narrow = useNarrowScreen();
  const changed = useJustChanged();
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const toggle = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) =>
      patchFlag({ key, enabled, reason }),
    onSuccess: (f) => {
      // The flag by its description, as the table names it; the key stays with the switch.
      setMessage(
        `${switchWords(f.description)} is now ${f.enabled ? 'on' : 'off'} ${previewMode ? '(simulated in this preview, not audited)' : '(audited)'}.`,
      );
      changed.mark(f.key);
      void queryClient.invalidateQueries({ queryKey: ['flags'] });
    },
    onError: (e) => setMessage(describeActionError(e)),
  });
  if (flags.isPending) return <PageSkeleton rows={6} />;
  if (flags.isError) return <ErrorState title="Flags unavailable" detail={flags.error.message} />;
  const isAdmin = me.data?.roles.includes('platform_admin') ?? false;
  const columns = narrow ? ['Change', 'State'] : ['State', 'Change'];
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
        {isAdmin ? (
          <div className="pb-field pb-flag-reason">
            <Label htmlFor="flag-reason">Reason for the next change</Label>
            <span className="pb-flag-reason-row">
              <Input
                id="flag-reason"
                value={reason}
                onChange={(_e, d) => setReason(d.value)}
                placeholder="Why is this changing?"
                aria-describedby="flag-reason-note"
              />
              <Button size="small" appearance="subtle" onClick={() => setReason('')}>
                Clear reason
              </Button>
            </span>
            <p className="pb-note" id="flag-reason-note">
              Type a reason to unlock the switches. Every change is audited.
            </p>
          </div>
        ) : null}
        <TableWrap label="Feature flags">
          <table className="pb-table pb-table-short pb-flags" aria-label="Feature flags">
            <thead>
              <tr>
                <th scope="col">Flag</th>
                {columns.map((c) => (
                  <th key={c} scope="col" className="pb-col-fit">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {flags.data.flags.map((f) => (
                <FlagRow
                  key={f.key}
                  flag={f}
                  narrow={narrow}
                  disabled={!isAdmin || toggle.isPending || reason.trim().length < 3}
                  onChange={(enabled) => toggle.mutate({ key: f.key, enabled })}
                  washing={changed.rowProps(f.key)}
                />
              ))}
            </tbody>
          </table>
        </TableWrap>
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
