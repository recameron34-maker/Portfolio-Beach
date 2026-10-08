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
  SectionHeader,
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

function DomainCard({ domain, shown }: { domain: Domain; shown: Term[] }): ReactNode {
  const inactive = domain.terms.filter((t) => !t.active).length;
  const aside =
    shown.length === domain.terms.length
      ? `${domain.terms.length} terms${inactive > 0 ? `, ${inactive} inactive` : ''}`
      : `${shown.length} of ${domain.terms.length} terms`;
  return (
    <Card testId={`taxonomy-${domain.domain}`}>
      <SectionHeader aside={aside}>{labelOf(domain.domain)}</SectionHeader>
      <div className="pb-table-wrap">
        <table className="pb-table" aria-label={`${labelOf(domain.domain)} terms`}>
          <thead>
            <tr>
              <th>Code</th>
              <th>Label</th>
              <th>Parent</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => (
              <tr key={t.code}>
                <td>
                  <span className="pb-key">{t.code}</span>
                </td>
                <td>{t.label}</td>
                <td>
                  {t.parentCode === null ? (
                    <span className="pb-meta">none</span>
                  ) : (
                    <span className="pb-key">{t.parentCode}</span>
                  )}
                </td>
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
        </table>
      </div>
    </Card>
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
            ? `${domains.length} domains, ${termCount} terms. Codes are stable; labels are what the screens show (docs/03).`
            : 'Codes are stable; labels are what the screens show (docs/03).'
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
        <>
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
            </Toolbar>
            <p className="pb-meta" data-testid="taxonomy-count">
              {needle === ''
                ? `${termCount} terms across ${domains.length} domains`
                : `${filtered.reduce((n, d) => n + d.shown.length, 0)} of ${termCount} terms match in ${filtered.length} ${filtered.length === 1 ? 'domain' : 'domains'}`}
            </p>
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
            ) : null}
          </Card>
          {filtered.map((d) => (
            <DomainCard key={d.domain.domain} domain={d.domain} shown={d.shown} />
          ))}
        </>
      ) : null}
    </>
  );
}
