import { useId, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Label, Option } from '@fluentui/react-components';
import type { IntakeFile, StagingState, WeeklyImportBody, WeeklyImportResult } from '@pb/contracts';
import { describeActionError } from '../../app/mutations.js';
import { meQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  Field,
  NumCell,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  TableWrap,
  Toolbar,
} from '../../components/ui.js';
import { MISSING, plural } from '../../lib/format.js';
import { humanizeState, stagingTone } from '../../lib/states.js';
import {
  dayOf,
  EMPTY_FILE_PROBLEM,
  INTAKE_FILTER_STATES,
  isStagingState,
  uploadSizeProblem,
} from '../intake/intake.js';
import { useWeeklyImport } from './mutations.js';
import { weeklyDropsQuery, weeklyFilesQuery } from './queries.js';
import { WEEKLY_FORBIDDEN, WEEKLY_META } from './weekly.js';
import '../intake/intake.css';
import './weekly.css';

interface UploadMessage {
  tone: 'good' | 'bad';
  text: string;
}

/** The text of a chosen file, read in the browser; the API receives text, never bytes. */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsText(file);
  });
}

/** Operations only: stage a weekly values file from a chosen file or from the drop folder. */
function UploadCard({ onStaged }: { onStaged: (result: WeeklyImportResult) => void }): ReactNode {
  const inputId = useId();
  const importer = useWeeklyImport();
  const drops = useQuery(weeklyDropsQuery);
  const [chosen, setChosen] = useState<{ fileName: string; csv: string } | null>(null);
  const [message, setMessage] = useState<UploadMessage | null>(null);
  const busy = importer.isPending;

  const stage = (body: WeeklyImportBody, label: string): void => {
    importer.mutate(body, {
      onSuccess: (result) => {
        setMessage(null);
        onStaged(result);
      },
      onError: (error) =>
        setMessage({ tone: 'bad', text: `${label}: ${describeActionError(error)}` }),
    });
  };
  const onFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    setChosen(null);
    if (file === undefined) return;
    // Nothing in the file, or too much: said here in plain words, before the button is enabled.
    const problem = uploadSizeProblem(file.size);
    if (problem !== null) {
      setMessage({ tone: 'bad', text: problem });
      return;
    }
    try {
      const csv = await readText(file);
      if (csv === '') {
        setMessage({ tone: 'bad', text: EMPTY_FILE_PROBLEM });
        return;
      }
      setChosen({ fileName: file.name, csv });
      setMessage(null);
    } catch (error) {
      setMessage({
        tone: 'bad',
        text: error instanceof Error ? error.message : 'The file could not be read.',
      });
    }
  };

  return (
    <Card testId="weekly-upload">
      <SectionHeader>Stage weekly values</SectionHeader>
      <p className="pb-meta">
        The file is read here and sent as text. Every value is linked to its position and compared
        with the prior (the latest Locked mark, or the weekly value promoted after it) before anyone
        approves it; an approved value becomes a Draft valuation, never a mark.
      </p>
      <div className="pb-intake-upload">
        <div className="pb-field">
          <Label htmlFor={inputId}>Weekly values (CSV)</Label>
          <input
            id={inputId}
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            onChange={(event) => void onFile(event)}
          />
        </div>
        <Button
          size="small"
          appearance="primary"
          disabled={chosen === null || busy}
          onClick={() => {
            if (chosen !== null) stage(chosen, `Stage ${chosen.fileName}`);
          }}
        >
          Stage weekly values
        </Button>
      </div>
      <div role="status" className="pb-intake-upload-status" data-testid="weekly-upload-status">
        {message === null ? null : (
          <p
            className={
              message.tone === 'good' ? 'pb-notice pb-notice-good' : 'pb-notice pb-notice-bad'
            }
          >
            {message.text}
          </p>
        )}
      </div>
      {drops.data !== undefined && drops.data.items.length > 0 ? (
        <>
          <SectionHeader>From the drop folder</SectionHeader>
          <ul
            className="pb-intake-drop"
            aria-label="Files in the weekly drop folder"
            data-testid="weekly-drops"
          >
            {drops.data.items.map((item) => (
              <li key={item.id}>
                <span>{item.name}</span>
                <span className="pb-meta">Received {dayOf(item.receivedAt)}</span>
                <Button
                  size="small"
                  appearance="outline"
                  disabled={busy}
                  aria-label={`Stage, ${item.name}`}
                  onClick={() => stage({ dropId: item.id }, `Stage ${item.name}`)}
                >
                  Stage
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : drops.isError ? (
        <UnavailableState inline error={drops.error} subject="The drop folder" />
      ) : null}
    </Card>
  );
}

function FilesTable({ files }: { files: readonly IntakeFile[] }): ReactNode {
  return (
    <TableWrap label="Weekly files">
      <table
        className="pb-table pb-weekly-files"
        aria-label="Weekly files"
        data-testid="weekly-files"
      >
        <thead>
          <tr>
            <th>File</th>
            <th>Received</th>
            <th>Received by</th>
            <th className="num">Rows</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr key={file.id}>
              <td>
                <Link to="/data/weekly/$id" params={{ id: file.id }}>
                  {file.fileName}
                </Link>
              </td>
              <td className="pb-nowrap">{dayOf(file.receivedAt)}</td>
              <td>{file.receivedBy ?? MISSING}</td>
              <NumCell>{String(file.rowCount)}</NumCell>
              <td>
                <Badge tone={stagingTone(file.status)}>{humanizeState(file.status)}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/** The staged files, newest first, filtered by status and read a page at a time on the API's cursor. */
function FilesCard({ isOps }: { isOps: boolean }): ReactNode {
  const [status, setStatus] = useState<StagingState | ''>('');
  const files = useInfiniteQuery({
    ...weeklyFilesQuery(status === '' ? {} : { status }),
    placeholderData: keepPreviousData,
  });
  const items = files.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card testId="weekly-files-card">
      <SectionHeader aside={items.length === 0 ? undefined : plural(items.length, 'file')}>
        Weekly files
      </SectionHeader>
      <Toolbar>
        <Field>
          <Label htmlFor="weekly-status">Status</Label>
          <Dropdown
            id="weekly-status"
            className="pb-intake-filter"
            value={status === '' ? 'All states' : humanizeState(status)}
            selectedOptions={[status]}
            onOptionSelect={(_e, d) => {
              const v = d.optionValue ?? '';
              setStatus(isStagingState(v) ? v : '');
            }}
          >
            <Option value="">All states</Option>
            {INTAKE_FILTER_STATES.map((s) => (
              <Option key={s} value={s}>
                {humanizeState(s)}
              </Option>
            ))}
          </Dropdown>
        </Field>
      </Toolbar>
      {files.isPending ? (
        <PageSkeleton rows={4} />
      ) : files.isError ? (
        <UnavailableState
          error={files.error}
          subject="Weekly files"
          forbidden={WEEKLY_FORBIDDEN}
          errorTitle="Weekly files unavailable"
          testId="weekly-unavailable"
        />
      ) : items.length === 0 ? (
        <EmptyState
          title={status === '' ? 'No weekly files yet' : 'No weekly files in this state'}
          detail={
            isOps
              ? 'Stage a weekly values file above; it appears here with its rows, findings and status.'
              : 'Operations stages the weekly report values; each file appears here with its rows, findings and status.'
          }
        />
      ) : (
        <FilesTable files={items} />
      )}
      {files.hasNextPage ? (
        <p className="pb-weekly-more">
          <Button
            size="small"
            appearance="secondary"
            disabled={files.isFetchingNextPage}
            onClick={() => void files.fetchNextPage()}
          >
            Load more files
          </Button>
        </p>
      ) : null}
    </Card>
  );
}

/**
 * Weekly values (docs/04 M2 weekly-report-intake, decision 0010): the weekly report value files
 * staged into valuation staging, newest first, and for operations the ways to stage another. Every
 * value stays in staging until a reviewer approves it on the file's own page, where it becomes a
 * Draft valuation.
 */
export function WeeklyPage(): ReactNode {
  const me = useQuery(meQuery);
  const navigate = useNavigate();
  if (me.isPending) return <PageSkeleton rows={6} />;
  const roles = me.data?.roles ?? [];
  const isOps = roles.includes('operations');
  return (
    <>
      <PageHeader title="Weekly values" meta={WEEKLY_META} />
      {isOps ? (
        <UploadCard
          onStaged={(result) =>
            void navigate({
              to: '/data/weekly/$id',
              params: { id: result.id },
              search: result.duplicate ? { duplicate: true } : {},
            })
          }
        />
      ) : null}
      <FilesCard isOps={isOps} />
    </>
  );
}
