import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Input, Label, Option } from '@fluentui/react-components';
import { Search16Regular } from '@fluentui/react-icons';
import type { DocumentReviewStatus } from '@pb/contracts';
import { describeActionError, useIndexDocuments } from '../../app/mutations.js';
import { DOCUMENTS_TABS } from '../../app/nav.js';
import { documentsQuery, LIST_LIMIT, meQuery, taxonomyQuery } from '../../app/queries.js';
import type { DocumentFilters } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Card,
  EmptyState,
  Field,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  SimulatedBadge,
  TabNav,
  Toolbar,
} from '../../components/ui.js';
import { ActionStatus } from '../../components/WorkflowActions.js';
import { plural } from '../../lib/format.js';
import { resultSuffix, useActionLog } from '../../lib/workflow.js';
import {
  dateFilter,
  docTypeLabel,
  docTypeOptions,
  DOCUMENTS_META,
  INDEX_READ_ONLY,
  indexResultText,
  isReviewStatus,
  mayIndex,
  REVIEW_STATUSES,
  reviewWord,
} from './documents.js';
import { DocumentsTable } from './DocumentsTable.js';
import './documents.css';

/**
 * The hub (docs/04 M3, SEC-8.5): every document the signed-in user may see, newest first, with
 * a full-text search and filters the API applies, a page at a time; operations indexes the store
 * from here. A row opens the document.
 */
function HubCard({ isOps }: { isOps: boolean }): ReactNode {
  const searchId = useId();
  const typeId = useId();
  const statusId = useId();
  const periodId = useId();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [docType, setDocType] = useState('');
  const [status, setStatus] = useState<DocumentReviewStatus | ''>('');
  const [period, setPeriod] = useState('');
  const taxonomy = useQuery(taxonomyQuery);
  const types = docTypeOptions(taxonomy.data);
  const filters: DocumentFilters = {
    q: q === '' ? undefined : q,
    docType: docType === '' ? undefined : docType,
    reviewStatus: status === '' ? undefined : status,
    periodEnd: dateFilter(period),
  };
  const docs = useInfiniteQuery({ ...documentsQuery(filters), placeholderData: keepPreviousData });
  const items = docs.data?.pages.flatMap((p) => p.items) ?? [];
  const narrowed = Object.values(filters).some((v) => v !== undefined);
  const log = useActionLog();
  const indexer = useIndexDocuments();

  const index = (): void => {
    indexer.mutate(undefined, {
      onSuccess: (result) => log.record('good', `${indexResultText(result)} ${resultSuffix()}`),
      onError: (error) => log.record('bad', `Index documents: ${describeActionError(error)}`),
    });
  };

  return (
    <Card testId="documents-card">
      <SectionHeader
        aside={
          <>
            {items.length === 0 ? null : plural(items.length, 'document')}
            <SimulatedBadge />
          </>
        }
      >
        Documents
      </SectionHeader>
      <Toolbar
        end={
          isOps ? (
            <Button
              size="small"
              appearance="primary"
              disabledFocusable={indexer.isPending}
              onClick={index}
            >
              Index documents
            </Button>
          ) : undefined
        }
      >
        <form
          className="pb-documents-search-form"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            setQ(search.trim());
          }}
        >
          <Field>
            <Label htmlFor={searchId}>Search</Label>
            <Input
              id={searchId}
              className="pb-documents-search"
              data-testid="documents-search"
              contentBefore={<Search16Regular />}
              placeholder="Title, file name or words in the text"
              value={search}
              onChange={(_e, d) => setSearch(d.value)}
            />
          </Field>
        </form>
        <Field>
          <Label htmlFor={typeId}>Type</Label>
          <Dropdown
            id={typeId}
            className="pb-documents-filter"
            value={docType === '' ? 'All types' : docTypeLabel(docType)}
            selectedOptions={[docType]}
            onOptionSelect={(_e, d) => setDocType(d.optionValue ?? '')}
          >
            <Option value="">All types</Option>
            {types.map((t) => (
              <Option key={t.code} value={t.code}>
                {t.label}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field>
          <Label htmlFor={statusId}>Status</Label>
          <Dropdown
            id={statusId}
            className="pb-documents-filter"
            value={status === '' ? 'All statuses' : reviewWord(status)}
            selectedOptions={[status]}
            onOptionSelect={(_e, d) => {
              const v = d.optionValue ?? '';
              setStatus(isReviewStatus(v) ? v : '');
            }}
          >
            <Option value="">All statuses</Option>
            {REVIEW_STATUSES.map((s) => (
              <Option key={s} value={s}>
                {reviewWord(s)}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field>
          <Label htmlFor={periodId}>Period end</Label>
          <Input
            id={periodId}
            type="date"
            className="pb-documents-filter"
            value={period}
            onChange={(_e, d) => setPeriod(d.value)}
          />
        </Field>
      </Toolbar>
      {isOps ? null : (
        <p className="pb-meta" data-testid="documents-read-only">
          {INDEX_READ_ONLY}
        </p>
      )}
      <ActionStatus latest={log.latest} testId="documents-action-status" />
      {docs.isPending ? (
        <PageSkeleton rows={4} />
      ) : docs.isError ? (
        <UnavailableState
          error={docs.error}
          subject="Documents"
          errorTitle="Documents unavailable"
          testId="documents-unavailable"
        />
      ) : items.length === 0 ? (
        <EmptyState
          title={narrowed ? 'No documents match' : 'No documents indexed yet'}
          detail={
            narrowed
              ? 'Clear the search, or pick another type, status or period.'
              : isOps
                ? 'Index the document store; every item it holds appears here with its classification.'
                : 'Operations indexes the document store; every item it holds appears here with its classification.'
          }
          testId="documents-empty"
        />
      ) : (
        <DocumentsTable items={items} label="Documents" testId="documents-table" />
      )}
      {docs.hasNextPage ? (
        <p className="pb-documents-more">
          <Button
            size="small"
            appearance="secondary"
            disabled={docs.isFetchingNextPage}
            onClick={() => void docs.fetchNextPage()}
          >
            Load more
          </Button>
          <span className="pb-meta">
            {' '}
            Showing {items.length} so far, {LIST_LIMIT} a page.
          </span>
        </p>
      ) : null}
    </Card>
  );
}

/**
 * Documents (docs/04 M3, decision 0012): the hub with search and filters, and the tabs to the
 * review queue, the expected-document tracker and extraction. Every read is the caller's own view
 * (SEC-8.5): a document behind a wall is absent from the list and from the search.
 */
export function DocumentsPage(): ReactNode {
  const me = useQuery(meQuery);
  // The roles decide whether the index button or the read-only sentence shows, so nothing is said
  // until they are known.
  if (me.isPending) return <PageSkeleton rows={6} />;
  const isOps = mayIndex(me.data?.roles ?? []);
  return (
    <>
      <PageHeader title="Documents" meta={DOCUMENTS_META} />
      <TabNav label="Documents" items={DOCUMENTS_TABS} />
      <HubCard isOps={isOps} />
    </>
  );
}
