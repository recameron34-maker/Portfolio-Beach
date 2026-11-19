import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Input, Label } from '@fluentui/react-components';
import { Search16Regular } from '@fluentui/react-icons';
import type { Taxonomy } from '@pb/contracts';
import { ADMIN_TABS } from '../../app/nav.js';
import { taxonomyQuery } from '../../app/queries.js';
import {
  Badge,
  Card,
  EmptyState,
  Field,
  PageHeader,
  PageSkeleton,
  TableWrap,
  TabNav,
  Toolbar,
} from '../../components/ui.js';
import { labelOf } from '../../lib/format.js';
import { UnavailableState } from '../../components/UnavailableState.js';

type Domain = Taxonomy['domains'][number];
type Term = Domain['terms'][number];

function matches(term: Term, needle: string): boolean {
  return (
    needle === '' ||
    term.code.toLowerCase().includes(needle) ||
    term.label.toLowerCase().includes(needle)
  );
}

/** How many terms a domain shows: all of them, or how many match the filter. */
function countOf(domain: Domain, shown: Term[]): string {
  const inactive = domain.terms.filter((t) => !t.active).length;
  return shown.length === domain.terms.length
    ? `${domain.terms.length} terms${inactive > 0 ? `, ${inactive} inactive` : ''}`
    : `${shown.length} of ${domain.terms.length} terms`;
}

const groupId = (domain: string): string => `taxonomy-group-${domain}`;

/**
 * Brings a domain's first row to the top of the table's region, under its header, and gives it
 * the keyboard. At once: nothing on a page scrolls smoothly.
 */
function jumpTo(domain: string): void {
  const row = document.getElementById(groupId(domain));
  const region = row?.closest<HTMLElement>('.pb-table-wrap');
  if (row === null || row === undefined || region === null || region === undefined) return;
  const head = region.querySelector('thead')?.getBoundingClientRect().height ?? 0;
  region.scrollTop += row.getBoundingClientRect().top - region.getBoundingClientRect().top - head;
  region.scrollIntoView({ block: 'nearest' });
  row.focus({ preventScroll: true });
}

/** One domain: a row naming it and its count, then its terms. */
function DomainRows({ domain, shown }: { domain: Domain; shown: Term[] }): ReactNode {
  return (
    <tbody data-testid={`taxonomy-${domain.domain}`}>
      <tr className="pb-group-row">
        <th colSpan={4} scope="rowgroup" id={groupId(domain.domain)} tabIndex={-1}>
          <span className="pb-group-name">{labelOf(domain.domain)}</span>
          <span className="pb-group-count">{countOf(domain, shown)}</span>
        </th>
      </tr>
      {shown.map((t) => (
        <tr key={t.code}>
          <td>
            <span className="pb-key">{t.code}</span>
          </td>
          <td>{t.label}</td>
          <td>{t.parentCode === null ? null : <span className="pb-key">{t.parentCode}</span>}</td>
          <td>
            {t.active ? (
              <span className="pb-meta">Active</span>
            ) : (
              <Badge tone="neutral">Inactive</Badge>
            )}
          </td>
        </tr>
      ))}
    </tbody>
  );
}

/** Taxonomy domains and terms (docs/03): the codes every record carries, with their labels and parents. */
export function TaxonomyPage(): ReactNode {
  const q = useQuery(taxonomyQuery);
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const domains = q.data?.domains ?? [];
  const filtered = domains
    .map((d) => ({ domain: d, shown: d.terms.filter((t) => matches(t, needle)) }))
    .filter((d) => d.shown.length > 0);
  const termCount = domains.reduce((n, d) => n + d.terms.length, 0);
  return (
    <>
      <PageHeader
        title="Taxonomy"
        meta={
          q.data !== undefined
            ? `${domains.length} domains, ${termCount} terms. Codes are stable; labels are what the screens show.`
            : 'Codes are stable; labels are what the screens show.'
        }
      />
      <TabNav label="Admin" items={ADMIN_TABS} />
      {q.isPending ? <PageSkeleton rows={8} /> : null}
      {q.isError ? (
        <UnavailableState
          card
          subject="The taxonomy"
          error={q.error}
          forbidden={{ title: 'The taxonomy is not available to your role' }}
          notReady={{ title: 'The taxonomy is not available yet' }}
          errorTitle="Taxonomy unavailable"
          testId="taxonomy-unavailable"
        />
      ) : null}
      {q.data !== undefined ? (
        <Card>
          <Toolbar>
            <Field>
              <Label htmlFor="taxonomy-filter">Filter by code or label</Label>
              <Input
                id="taxonomy-filter"
                contentBefore={<Search16Regular />}
                value={filter}
                onChange={(_e, d) => setFilter(d.value)}
                placeholder="deal_type, credit, healthcare"
              />
            </Field>
            <p className="pb-meta pb-toolbar-count" aria-live="polite" data-testid="taxonomy-count">
              {needle === ''
                ? `${termCount} terms across ${domains.length} domains`
                : `${filtered.reduce((n, d) => n + d.shown.length, 0)} of ${termCount} terms match in ${filtered.length} ${filtered.length === 1 ? 'domain' : 'domains'}`}
            </p>
          </Toolbar>
          {filtered.length === 0 ? (
            <EmptyState
              title={domains.length === 0 ? 'No taxonomy terms' : 'No terms match'}
              detail={
                domains.length === 0
                  ? 'The taxonomy is empty; seed the synthetic dataset to fill it.'
                  : 'Clear the filter to see every domain.'
              }
              testId="taxonomy-empty"
            />
          ) : (
            <div className="pb-taxonomy">
              {/* From 1100px: every domain shown, with its count, to jump to. */}
              <nav className="pb-taxonomy-index" aria-label="Domains">
                <ul>
                  {filtered.map((d) => (
                    <li key={d.domain.domain}>
                      <button type="button" onClick={() => jumpTo(d.domain.domain)}>
                        <span>{labelOf(d.domain.domain)}</span>{' '}
                        <span className="pb-taxonomy-index-count">
                          {d.shown.length}{' '}
                          <span className="pb-visually-hidden">
                            {d.shown.length === 1 ? 'term' : 'terms'}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
              <TableWrap label="Taxonomy terms" tall>
                <table className="pb-table pb-taxonomy-table" aria-label="Taxonomy terms">
                  <colgroup>
                    <col className="pb-taxonomy-code" />
                    <col className="pb-taxonomy-label" />
                    <col className="pb-taxonomy-parent" />
                    <col className="pb-taxonomy-status" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col">Code</th>
                      <th scope="col">Label</th>
                      <th scope="col">Parent</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  {filtered.map((d) => (
                    <DomainRows key={d.domain.domain} domain={d.domain} shown={d.shown} />
                  ))}
                </table>
              </TableWrap>
            </div>
          )}
        </Card>
      ) : null}
    </>
  );
}
