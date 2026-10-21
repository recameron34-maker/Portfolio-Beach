import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Input, Label, Option } from '@fluentui/react-components';
import type { DocumentDetail, DocumentPages } from '@pb/contracts';
import { ApiError } from '../../api/client.js';
import { describeActionError, useClassifyDocument } from '../../app/mutations.js';
import {
  documentPagesQuery,
  documentQuery,
  investmentsQuery,
  meQuery,
  sponsorQuery,
  sponsorsQuery,
  taxonomyQuery,
} from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  ErrorState,
  KeyValueTable,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  SimulatedBadge,
} from '../../components/ui.js';
import { ActionStatus } from '../../components/WorkflowActions.js';
import { formatDate, MISSING, plural } from '../../lib/format.js';
import { resultSuffix, useActionLog } from '../../lib/workflow.js';
import type { ActionLog } from '../../lib/workflow.js';
import {
  candidatesText,
  CLASSIFY_READ_ONLY,
  classifiedText,
  classifyBody,
  classifyOffered,
  classifyProblem,
  confidenceText,
  dayOf,
  docTypeLabel,
  docTypeOptions,
  hashShort,
  keywordsText,
  mayClassify,
  reviewTone,
  reviewWord,
  runTone,
  runWord,
  sizeText,
  subjectOf,
} from './documents.js';
import type { ClassifyForm } from './documents.js';
import './documents.css';

function BackLink(): ReactNode {
  return (
    <p className="pb-meta">
      <Link to="/documents">All documents</Link>
    </p>
  );
}

/** The position or the fund the document is linked to, as links where the reader may follow them. */
function Links({ doc }: { doc: DocumentDetail }): ReactNode {
  const subject = subjectOf(doc);
  const fund =
    doc.investmentId !== null && doc.sponsorFundName !== null ? doc.sponsorFundName : null;
  return (
    <span className="pb-documents-links">
      {subject.link === null ? (
        <span>{subject.text}</span>
      ) : (
        <Link to={subject.link.to} params={subject.link.params}>
          {subject.text}
        </Link>
      )}
      {doc.investmentNumber === null ? null : (
        <span className="pb-key">{doc.investmentNumber}</span>
      )}
      {fund === null ? null : doc.sponsorId === null ? (
        <span>{fund}</span>
      ) : (
        <Link to="/sponsors/$id" params={{ id: doc.sponsorId }}>
          {fund}
        </Link>
      )}
    </span>
  );
}

/** The store's metadata and what the classifier found; never the document's own content. */
function MetadataCard({ doc }: { doc: DocumentDetail }): ReactNode {
  return (
    <Card testId="document-detail">
      <SectionHeader>Metadata</SectionHeader>
      <KeyValueTable
        label="Document metadata"
        rows={[
          { label: 'File name', value: doc.fileName },
          { label: 'Folder', value: doc.folder },
          {
            label: 'Content hash',
            value: (
              <span className="pb-key" title={doc.contentHash}>
                {hashShort(doc.contentHash)}
              </span>
            ),
          },
          { label: 'Size', value: sizeText(doc.sizeBytes) },
          { label: 'Pages', value: doc.pageCount === null ? MISSING : String(doc.pageCount) },
          { label: 'Received', value: dayOf(doc.receivedAt) },
          { label: 'Indexed', value: dayOf(doc.indexedAt) },
          { label: 'Confidence', value: confidenceText(doc.classificationConfidence) },
          { label: 'Evidence keywords', value: keywordsText(doc.classifierEvidence) },
          { label: 'Candidates', value: candidatesText(doc.classifierEvidence) },
          {
            label: 'Classified by',
            value:
              doc.classifiedAt === null
                ? MISSING
                : `${doc.classifiedBy ?? 'the classifier'}, ${dayOf(doc.classifiedAt)}`,
          },
          { label: 'Confidentiality', value: doc.confidentiality },
          {
            label: 'Latest run',
            value:
              doc.latestRun === null ? (
                MISSING
              ) : (
                <Link to="/documents/extraction/$id" params={{ id: doc.latestRun.id }}>
                  <Badge tone={runTone(doc.latestRun.state)}>{runWord(doc.latestRun.state)}</Badge>
                </Link>
              ),
          },
        ]}
      />
    </Card>
  );
}

/** The original this item repeats, and the other items that repeat it (same content hash). */
function DuplicatesCard({ doc }: { doc: DocumentDetail }): ReactNode {
  if (doc.duplicateOfId === null && doc.duplicates.length === 0) return null;
  return (
    <Card testId="document-duplicates">
      <SectionHeader
        aside={doc.duplicates.length === 0 ? undefined : plural(doc.duplicates.length, 'copy')}
      >
        Duplicates
      </SectionHeader>
      {doc.duplicateOfId === null ? null : (
        <p className="pb-meta">
          The same bytes were indexed before:{' '}
          <Link to="/documents/$id" params={{ id: doc.duplicateOfId }}>
            open the original
          </Link>
          . This copy carries the original&apos;s links and is not classified on its own.
        </p>
      )}
      {doc.duplicates.length === 0 ? null : (
        <ul className="pb-documents-duplicates" aria-label="Duplicates">
          {doc.duplicates.map((d) => (
            <li key={d.id}>
              <Link to="/documents/$id" params={{ id: d.id }}>
                {d.fileName}
              </Link>
              <span className="pb-meta">{d.folder}</span>
              <span className="pb-meta">Indexed {dayOf(d.indexedAt)}</span>
              <Badge tone={reviewTone(d.reviewStatus)}>{reviewWord(d.reviewStatus)}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The lines of one page as the reader returned them, with a selector for the page. */
function PagesView({ pages }: { pages: DocumentPages }): ReactNode {
  const selectId = useId();
  const [number, setNumber] = useState(pages.pages[0]?.number ?? 1);
  const page = pages.pages.find((p) => p.number === number) ?? pages.pages[0];
  if (page === undefined) {
    return <p className="pb-meta">The reader found no page in this document.</p>;
  }
  return (
    <>
      <div className="pb-documents-page-select">
        <div className="pb-field">
          <Label htmlFor={selectId}>Page</Label>
          <Dropdown
            id={selectId}
            className="pb-documents-filter"
            value={`Page ${page.number} of ${pages.pageCount}`}
            selectedOptions={[String(page.number)]}
            onOptionSelect={(_e, d) => {
              const n = Number(d.optionValue);
              if (Number.isInteger(n) && n >= 1) setNumber(n);
            }}
          >
            {pages.pages.map((p) => (
              <Option key={p.number} value={String(p.number)} text={`Page ${p.number}`}>
                Page {p.number}
              </Option>
            ))}
          </Dropdown>
        </div>
        <span className="pb-meta">{plural(page.lines.length, 'line')}</span>
      </div>
      <pre
        className="pb-documents-page"
        tabIndex={0}
        aria-label={`Text of page ${page.number}`}
        data-testid="document-page-text"
      >
        {page.lines.join('\n')}
      </pre>
    </>
  );
}

/** The document's text page by page, read from the store on demand (audited); a file the reader refuses says so. */
function PagesCard({ doc }: { doc: DocumentDetail }): ReactNode {
  const q = useQuery(documentPagesQuery(doc.id));
  return (
    <Card testId="document-pages">
      <SectionHeader aside={doc.pageCount === null ? undefined : plural(doc.pageCount, 'page')}>
        Pages
      </SectionHeader>
      {q.isPending ? (
        <PageSkeleton rows={4} />
      ) : q.isError ? (
        <UnavailableState
          inline
          error={q.error}
          subject="The document's text"
          testId="document-pages-unavailable"
        />
      ) : (
        <PagesView pages={q.data} />
      )}
    </Card>
  );
}

/**
 * Deal team and operations: name the type and the links of a NeedsReview document (docs/18
 * section 6). A link left blank keeps what the classifier found; the sponsor fund is picked
 * through its sponsor. The reason goes to the audit trail.
 */
function ClassifyCard({ doc, log }: { doc: DocumentDetail; log: ActionLog }): ReactNode {
  const typeId = useId();
  const investmentId = useId();
  const sponsorId = useId();
  const fundId = useId();
  const periodId = useId();
  const reasonId = useId();
  const taxonomy = useQuery(taxonomyQuery);
  const investments = useQuery(investmentsQuery({ limit: 200 }));
  const sponsors = useQuery(sponsorsQuery);
  const [sponsor, setSponsor] = useState(doc.sponsorId ?? '');
  const sponsorDetail = useQuery({ ...sponsorQuery(sponsor), enabled: sponsor !== '' });
  const [form, setForm] = useState<ClassifyForm>({
    docType: '',
    investmentId: '',
    sponsorFundId: '',
    periodEnd: '',
    reason: '',
  });
  const classify = useClassifyDocument();
  const problem = classifyProblem(form);
  const busy = classify.isPending;
  const types = docTypeOptions(taxonomy.data);
  const positions = [...(investments.data?.items ?? [])].sort((a, b) =>
    a.investmentNumber.localeCompare(b.investmentNumber),
  );
  const funds = sponsorDetail.data?.funds ?? [];
  const investmentLabel = (id: string): string => {
    const p = positions.find((i) => i.id === id);
    return p === undefined ? '' : `${p.investmentNumber} ${p.companyName}`;
  };

  const submit = (): void => {
    if (problem !== null) return;
    classify.mutate(
      { id: doc.id, body: classifyBody(form) },
      {
        onSuccess: (updated) =>
          log.record('good', `${classifiedText(docTypeLabel(updated.docType))} ${resultSuffix()}`),
        onError: (error) => log.record('bad', `Classify: ${describeActionError(error)}`),
      },
    );
  };

  return (
    <Card testId="document-classify">
      <SectionHeader aside={<SimulatedBadge />}>Classify</SectionHeader>
      <p className="pb-meta">
        The classifier was not sure. Name the type, and the position or the sponsor fund and the
        period the document is about; a link left blank keeps what the classifier found. The
        decision is audited with your reason.
      </p>
      <form
        className="pb-documents-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="pb-field">
          <Label htmlFor={typeId} required>
            Document type
          </Label>
          <Dropdown
            id={typeId}
            className="pb-documents-filter"
            placeholder="Pick a type"
            value={form.docType === '' ? '' : docTypeLabel(form.docType)}
            selectedOptions={[form.docType]}
            disabled={busy}
            onOptionSelect={(_e, d) => setForm({ ...form, docType: d.optionValue ?? '' })}
          >
            {types.map((t) => (
              <Option key={t.code} value={t.code}>
                {t.label}
              </Option>
            ))}
          </Dropdown>
        </div>
        <div className="pb-field">
          <Label htmlFor={investmentId}>Investment</Label>
          <Dropdown
            id={investmentId}
            className="pb-documents-search"
            placeholder="Keep the classifier's"
            value={investmentLabel(form.investmentId)}
            selectedOptions={[form.investmentId]}
            disabled={busy}
            onOptionSelect={(_e, d) => setForm({ ...form, investmentId: d.optionValue ?? '' })}
          >
            <Option value="">Keep the classifier&apos;s</Option>
            {positions.map((p) => (
              <Option key={p.id} value={p.id} text={`${p.investmentNumber} ${p.companyName}`}>
                {p.investmentNumber} {p.companyName}
              </Option>
            ))}
          </Dropdown>
        </div>
        <div className="pb-field">
          <Label htmlFor={sponsorId}>Sponsor</Label>
          <Dropdown
            id={sponsorId}
            className="pb-documents-filter"
            placeholder="Pick a sponsor"
            value={sponsors.data?.items.find((s) => s.id === sponsor)?.name ?? ''}
            selectedOptions={[sponsor]}
            disabled={busy}
            onOptionSelect={(_e, d) => {
              setSponsor(d.optionValue ?? '');
              setForm({ ...form, sponsorFundId: '' });
            }}
          >
            <Option value="">Pick a sponsor</Option>
            {(sponsors.data?.items ?? []).map((s) => (
              <Option key={s.id} value={s.id}>
                {s.name}
              </Option>
            ))}
          </Dropdown>
        </div>
        <div className="pb-field">
          <Label htmlFor={fundId}>Sponsor fund</Label>
          <Dropdown
            id={fundId}
            className="pb-documents-filter"
            placeholder={sponsor === '' ? 'Pick a sponsor first' : "Keep the classifier's"}
            value={funds.find((f) => f.id === form.sponsorFundId)?.name ?? ''}
            selectedOptions={[form.sponsorFundId]}
            disabled={busy || sponsor === ''}
            onOptionSelect={(_e, d) => setForm({ ...form, sponsorFundId: d.optionValue ?? '' })}
          >
            <Option value="">Keep the classifier&apos;s</Option>
            {funds.map((f) => (
              <Option key={f.id} value={f.id}>
                {f.name}
              </Option>
            ))}
          </Dropdown>
        </div>
        <div className="pb-field">
          <Label htmlFor={periodId}>Period end</Label>
          <Input
            id={periodId}
            type="date"
            className="pb-documents-filter"
            value={form.periodEnd}
            disabled={busy}
            onChange={(_e, d) => setForm({ ...form, periodEnd: d.value })}
          />
        </div>
        <div className="pb-field">
          <Label htmlFor={reasonId}>Reason</Label>
          <Input
            id={reasonId}
            className="pb-documents-search"
            placeholder="Why this type and these links"
            value={form.reason}
            maxLength={500}
            disabled={busy}
            onChange={(_e, d) => setForm({ ...form, reason: d.value })}
          />
        </div>
        <Button
          type="submit"
          size="small"
          appearance="primary"
          disabledFocusable={problem !== null || busy}
          {...(problem === null ? {} : { title: problem })}
        >
          Classify
        </Button>
      </form>
    </Card>
  );
}

function DocumentBody({
  doc,
  roles,
}: {
  doc: DocumentDetail;
  roles: readonly string[];
}): ReactNode {
  const log = useActionLog();
  const offered = classifyOffered(roles, doc);
  return (
    <>
      <BackLink />
      <PageHeader
        title={doc.title}
        meta={
          <span className="pb-meta-list">
            <span>{doc.fileName}</span>
            <span>{doc.periodEnd === null ? 'No period' : formatDate(doc.periodEnd)}</span>
            <span>Received {dayOf(doc.receivedAt)}</span>
            <Links doc={doc} />
          </span>
        }
        actions={
          <span className="pb-documents-badges">
            <Badge plain tone="brand">
              {docTypeLabel(doc.docType)}
            </Badge>
            <Badge tone={reviewTone(doc.reviewStatus)}>{reviewWord(doc.reviewStatus)}</Badge>
          </span>
        }
        testId="document-banner"
      />
      <ActionStatus latest={log.latest} testId="document-action-status" />
      {offered ? <ClassifyCard doc={doc} log={log} /> : null}
      {doc.reviewStatus === 'NeedsReview' && !mayClassify(roles) ? (
        <p className="pb-meta" data-testid="document-read-only">
          {CLASSIFY_READ_ONLY}
        </p>
      ) : null}
      <MetadataCard doc={doc} />
      <DuplicatesCard doc={doc} />
      <PagesCard doc={doc} />
    </>
  );
}

/**
 * One document (docs/04 M3, docs/18 section 6): its banner and links, the store's metadata and
 * the classifier's evidence, its duplicates, its text page by page, and for a NeedsReview document
 * the classify form for the deal team and operations. A document past the reader's wall is not
 * found (SEC-8.5).
 */
export function DocumentDetailPage(): ReactNode {
  const { id } = useParams({ from: '/app/documents/$id' });
  const me = useQuery(meQuery);
  const q = useQuery(documentQuery(id));
  // The roles decide whether the classify form or the read-only sentence shows, so nothing is
  // said until they are known.
  if (q.isPending || me.isPending) return <PageSkeleton rows={8} />;
  if (q.isError) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <>
        <BackLink />
        {missing ? (
          <ErrorState
            title="Document not found or not visible to you"
            detail="There is no document with this id in your view."
          />
        ) : (
          <UnavailableState
            card
            error={q.error}
            subject="This document"
            errorTitle="Document unavailable"
            testId="document-unavailable"
          />
        )}
      </>
    );
  }
  return <DocumentBody doc={q.data} roles={me.data?.roles ?? []} />;
}
