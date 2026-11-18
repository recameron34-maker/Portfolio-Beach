import type { ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { ReportPackageDetail } from '@pb/contracts';
import { ApiError } from '../../../api/client.js';
import { UnavailableState } from '../../../components/UnavailableState.js';
import { StepStrip } from '../../../components/StepStrip.js';
import {
  Card,
  ErrorState,
  KeyValueTable,
  PageHeader,
  PageSkeleton,
  SectionHeader,
} from '../../../components/ui.js';
import { formatDate, formatDateTime, formatQuarter, MISSING } from '../../../lib/format.js';
import { reportPackageQuery } from './api.js';
import {
  BASIS_WORDS,
  checksSummary,
  gateSteps,
  LABEL_WORDS,
  NET_NOTICE,
  NEXT_STEP_WORDS,
  WHO_READS_PACKAGES,
} from './packages.js';
import { PackageStateBadge } from './Packages.js';
import './packages.css';

function BackLink(): ReactNode {
  return (
    <p className="pb-meta pb-pkg-back">
      <Link to="/reporting/packages">Client packages</Link>
    </p>
  );
}

/** A person with the time they acted, or the missing placeholder while nobody has. */
function byAt(person: { name: string } | null, at: string | null): string {
  if (person === null) return MISSING;
  return at === null ? person.name : `${person.name}, ${formatDateTime(at)}`;
}

/**
 * The release gate (docs/18 section 5): where the package stands among the six steps, what
 * happens next and who does it, and who prepared, approved and released it.
 */
function ReleaseGateCard({ detail }: { detail: ReportPackageDetail }): ReactNode {
  return (
    <Card testId="package-gate">
      <SectionHeader>Release gate</SectionHeader>
      <StepStrip label="Release gate" steps={gateSteps(detail)} />
      <p className="pb-pkg-next" data-testid="package-next">
        {NEXT_STEP_WORDS[detail.state]}
      </p>
      <KeyValueTable
        label="Who moved the package"
        rows={[
          { label: 'Prepared by', value: detail.preparedBy.name },
          { label: 'Checks', value: checksSummary(detail.qa) },
          { label: 'Approved by', value: byAt(detail.reviewer, detail.approvedAt) },
          { label: 'Released by', value: byAt(detail.releasedBy, detail.releasedAt) },
          ...(detail.correctionReason === null
            ? []
            : [{ label: 'Reason for this version', value: detail.correctionReason }]),
        ]}
      />
    </Card>
  );
}

function Body({ detail }: { detail: ReportPackageDetail }): ReactNode {
  return (
    <div data-testid="package-detail">
      <BackLink />
      <PageHeader
        testId="package-banner"
        title={`${detail.client.name}: ${formatQuarter(detail.periodEnd)}`}
        meta={
          <span className="pb-meta-list">
            <span>{BASIS_WORDS[detail.basis]}</span>
            <span>{LABEL_WORDS[detail.label]}</span>
            <span>Version {detail.version}</span>
            <span>As of {formatDate(detail.asOf)}</span>
          </span>
        }
        actions={<PackageStateBadge state={detail.state} />}
      />
      {detail.basis === 'net' ? (
        <p className="pb-notice pb-pkg-standing" data-testid="package-net-notice">
          {NET_NOTICE}
        </p>
      ) : null}
      <ReleaseGateCard detail={detail} />
    </div>
  );
}

/**
 * One reporting package (docs/04 M14): its header and its release gate. A package of a client
 * the reader does not read answers 404 and reads as not found, so nothing says it exists.
 */
export function PackageDetailPage(): ReactNode {
  const { id } = useParams({ from: '/app/reporting/packages/$id' });
  const q = useQuery(reportPackageQuery(id));
  if (q.isPending) return <PageSkeleton rows={6} />;
  if (q.isError) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <>
        <BackLink />
        {missing ? (
          <ErrorState
            title="Package not found"
            detail="There is no package at this address among the clients you read."
          />
        ) : (
          <UnavailableState
            card
            error={q.error}
            subject="This package"
            forbidden={{
              title: 'This package: not visible to your role',
              detail: WHO_READS_PACKAGES,
            }}
            errorTitle="Package unavailable"
            testId="package-unavailable"
          />
        )}
      </>
    );
  }
  return <Body detail={q.data} />;
}
