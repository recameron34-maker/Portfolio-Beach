import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Input, Label } from '@fluentui/react-components';
import { Search16Regular } from '@fluentui/react-icons';
import type { DataHealth } from '@pb/contracts';
import { ADMIN_TABS } from '../app/nav.js';
import { dataDictionaryQuery, dataHealthQuery, meQuery } from '../app/queries.js';
import {
  Card,
  CheckList,
  EmptyState,
  ErrorState,
  Field,
  PageHeader,
  PageSkeleton,
  TableWrap,
  TabNav,
  Toolbar,
} from '../components/ui.js';
import type { CheckRow } from '../components/ui.js';
import { formatDate, formatPct, plural } from '../lib/format.js';
import { seesAllClients, WHO_READS_EVERY_CLIENT } from '../lib/roles.js';
import { dataCheckRows, dictionaryLines } from './data-display.js';

/**
 * LP ownership per closed vehicle, as the last data check. The API sums the commitments the caller
 * can see, so only a role that sees every client gets a sum that can be checked against 100%;
 * anyone else is told whose check it is rather than shown the shortfall of a partial sum as a data
 * error. Its result is a sentence, so it runs across the detail column.
 */
function ownershipRow(gaps: DataHealth['vehiclesWithOwnershipGap'], checked: boolean): CheckRow {
  if (!checked) {
    return {
      check: 'Client ownership',
      wide: true,
      result: (
        <span className="pb-check-note" data-testid="ownership-not-checked">
          LP ownership is checked against 100% for {WHO_READS_EVERY_CLIENT}, who see every client's
          commitments. Your view covers only the clients you are entitled to, so it cannot be
          checked here.
        </span>
      ),
    };
  }
  if (gaps.length === 0) {
    return {
      check: 'Client ownership',
      wide: true,
      tone: 'good',
      result: "Every closed vehicle's LP ownership sums to 100%.",
    };
  }
  return {
    check: 'Client ownership',
    wide: true,
    tone: 'bad',
    result: (
      <ul className="pb-check-lines">
        {gaps.map((v) => (
          <li key={v.vehicleName}>
            {v.vehicleName}: ownership sums to {formatPct(v.ownershipTotal)}
          </li>
        ))}
      </ul>
    ),
  };
}

export function DataHealthPage(): ReactNode {
  const q = useQuery(dataHealthQuery);
  const me = useQuery(meQuery);
  if (q.isPending || me.isPending) return <PageSkeleton rows={5} />;
  if (q.isError) return <ErrorState title="Data health unavailable" detail={q.error.message} />;
  const h = q.data;
  const checked = me.data !== undefined && seesAllClients(me.data.roles);
  return (
    <>
      <PageHeader title="Data health" meta={<>As of {formatDate(h.asOf)}</>} />
      <TabNav label="Admin" items={ADMIN_TABS} />
      <Card>
        {/* The probe and the browser tests wait on this id, which once named a strip of tiles. */}
        <CheckList
          label="Data checks"
          testId="data-health-tiles"
          rows={[...dataCheckRows(h), ownershipRow(h.vehiclesWithOwnershipGap, checked)]}
        />
      </Card>
    </>
  );
}

/* ---- Data dictionary ---- */

export function DataDictionaryPage(): ReactNode {
  const q = useQuery(dataDictionaryQuery);
  const [filter, setFilter] = useState('');
  if (q.isPending) return <PageSkeleton rows={8} />;
  if (q.isError) return <ErrorState title="Data dictionary unavailable" detail={q.error.message} />;
  const terms = Object.entries(q.data.definitions)
    .filter(([k]) => !k.startsWith('_'))
    .map(([key, value]) => ({ key, lines: dictionaryLines(key, value) }));
  const needle = filter.trim().toLowerCase();
  // A term matches on its words, its name as configured, or anything shown under it.
  const shown =
    needle === ''
      ? terms
      : terms.filter(
          ({ key, lines }) =>
            key.toLowerCase().includes(needle) ||
            lines.some(
              (l) =>
                l.name.toLowerCase().includes(needle) || l.value.toLowerCase().includes(needle),
            ),
        );
  // Names starting with "_" are notes for the build and are skipped at every level, the units
  // note too: the page states nothing the terms themselves do not.
  return (
    <>
      <PageHeader title="Data dictionary" meta={`${plural(terms.length, 'term')}.`} />
      <TabNav label="Admin" items={ADMIN_TABS} />
      <Card>
        <Toolbar>
          <Field>
            <Label htmlFor="dict-filter">Filter terms</Label>
            <Input
              id="dict-filter"
              contentBefore={<Search16Regular />}
              value={filter}
              onChange={(_e, d) => setFilter(d.value)}
            />
          </Field>
          {/* The count says how many match while a filter is set; the header has the whole. */}
          <p className="pb-meta pb-toolbar-count" aria-live="polite" data-testid="dictionary-count">
            {needle === '' ? '' : `${shown.length} of ${plural(terms.length, 'term')} match`}
          </p>
        </Toolbar>
        {shown.length === 0 ? (
          <EmptyState title="No terms match" detail="Clear the filter to see every definition." />
        ) : (
          <TableWrap label="Definitions" tall>
            <table className="pb-table is-dense pb-dict" aria-label="Definitions">
              <thead>
                <tr>
                  <th scope="col">Term</th>
                  <th scope="col">Definition or setting</th>
                </tr>
              </thead>
              {shown.map(({ key, lines }) => (
                <tbody key={key}>
                  {lines.map((l) => (
                    <tr key={l.path}>
                      <th scope="row" className="pb-dict-name" data-depth={l.depth}>
                        {l.name}
                      </th>
                      <td className="pb-dict-value">{l.value}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}
