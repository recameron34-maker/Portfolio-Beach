import { useId, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button, Label } from '@fluentui/react-components';
import type {
  IntakeFile,
  IntakeFilePage,
  IntakeImportBody,
  IntakeImportResult,
  OpsDropImportBody,
} from '@pb/contracts';
import { previewMode } from '../../app/env.js';
import { describeActionError, useIntakeImport } from '../../app/mutations.js';
import { ADMIN_TABS } from '../../app/nav.js';
import { intakeExportsQuery, intakeFilesQuery, LIST_LIMIT, meQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  NumCell,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  SimulatedBadge,
  TableWrap,
  TabNav,
} from '../../components/ui.js';
import { MISSING, plural } from '../../lib/format.js';
import { humanizeState, stagingTone } from '../../lib/states.js';
import {
  base64Of,
  countsLine,
  dayOf,
  EMPTY_FILE_PROBLEM,
  exceptionsText,
  fileRoute,
  INTAKE_FORBIDDEN,
  INTAKE_META,
  MAX_WORKBOOK_BYTES,
  SAMPLE_SCENARIOS,
  sampleFileName,
  sampleUrl,
  sourceWord,
  templateLine,
  uploadSizeProblem,
} from './intake.js';
import type { SampleScenario } from './intake.js';
import { opsDropDropsQuery, useOpsDropImport } from './ops-drop.js';
import './intake.css';

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

/** The bytes of a chosen workbook, read in the browser; the API receives them as base64. */
function readBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(
        reader.result instanceof ArrayBuffer ? new Uint8Array(reader.result) : new Uint8Array(),
      );
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsArrayBuffer(file);
  });
}

function UploadStatus({
  message,
  testId,
}: {
  message: UploadMessage | null;
  testId: string;
}): ReactNode {
  return (
    <div role="status" className="pb-intake-upload-status" data-testid={testId}>
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
  );
}

/** One file waiting in a drop folder, with the command that stages it. */
export interface DropRow {
  id: string;
  name: string;
  /** The folder in words: "Accounting exports". */
  folder: string;
  receivedAt: string;
  busy: boolean;
  stage: () => void;
}

/**
 * The files waiting in the drop folders, as one table: the file, its folder, when it arrived and
 * the command that stages it (named "Stage, <file>"). Shared by Intake and Weekly values.
 */
export function DropFolderTable({
  rows,
  testId,
}: {
  rows: readonly DropRow[];
  testId?: string | undefined;
}): ReactNode {
  return (
    <>
      <SectionHeader aside={plural(rows.length, 'file')}>Waiting in the drop folders</SectionHeader>
      <TableWrap label="Waiting in the drop folders">
        <table
          className="pb-table pb-intake-drops"
          aria-label="Waiting in the drop folders"
          data-testid={testId}
        >
          <thead>
            <tr>
              <th>File</th>
              <th>Folder</th>
              <th>Received</th>
              <th className="num">
                <span className="pb-visually-hidden">Command</span>
                <SimulatedBadge />
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.folder}|${row.id}`}>
                <td>{row.name}</td>
                <td>{row.folder}</td>
                <td className="pb-nowrap">{dayOf(row.receivedAt)}</td>
                <td className="num pb-col-fit">
                  <Button
                    size="small"
                    appearance="outline"
                    disabled={row.busy}
                    aria-label={`Stage, ${row.name}`}
                    onClick={row.stage}
                  >
                    Stage
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </>
  );
}

/**
 * A native file input and its command, in the app's look (styles.css .pb-file): the input keeps
 * its label, its tab stop and its focus ring; only its button is drawn as a small button.
 */
export function FileField({
  label,
  accept,
  busy,
  onFile,
  command,
  ready,
  onStage,
}: {
  label: string;
  accept: string;
  busy: boolean;
  onFile: (event: ChangeEvent<HTMLInputElement>) => void;
  command: string;
  ready: boolean;
  onStage: () => void;
}): ReactNode {
  const inputId = useId();
  return (
    <div className="pb-intake-upload">
      <div className="pb-field">
        <Label htmlFor={inputId}>{label}</Label>
        <input
          id={inputId}
          className="pb-file"
          type="file"
          accept={accept}
          disabled={busy}
          onChange={onFile}
        />
      </div>
      <span className="pb-actions">
        <Button size="small" appearance="primary" disabled={!ready || busy} onClick={onStage}>
          {command}
        </Button>
        <SimulatedBadge />
      </span>
    </div>
  );
}

/**
 * Operations only: stage an accounting export (CSV, read as text) or an operations workbook (XLSX,
 * read as bytes and sent as base64; the API matches it to a template by its sheet names and header
 * and refuses an unknown one with a file finding naming the templates it knows), from a chosen
 * file, from the drop folders or, in the preview, a sample. Each upload reports in its own region.
 */
function UploadCard({ onStaged }: { onStaged: (result: IntakeImportResult) => void }): ReactNode {
  const exportImporter = useIntakeImport();
  const workbookImporter = useOpsDropImport();
  const exports = useQuery(intakeExportsQuery);
  const drops = useQuery(opsDropDropsQuery);
  const [chosen, setChosen] = useState<{ fileName: string; csv: string } | null>(null);
  const [book, setBook] = useState<{ fileName: string; workbookBase64: string } | null>(null);
  const [message, setMessage] = useState<UploadMessage | null>(null);
  const [bookMessage, setBookMessage] = useState<UploadMessage | null>(null);
  const exportBusy = exportImporter.isPending;
  const bookBusy = workbookImporter.isPending;

  const stage = (body: IntakeImportBody, label: string): void => {
    exportImporter.mutate(body, {
      onSuccess: (result) => {
        setMessage(null);
        onStaged(result);
      },
      onError: (error) =>
        setMessage({ tone: 'bad', text: `${label}: ${describeActionError(error)}` }),
    });
  };
  const stageBook = (body: OpsDropImportBody, label: string): void => {
    workbookImporter.mutate(body, {
      onSuccess: (result) => {
        setBookMessage(null);
        onStaged(result);
      },
      onError: (error) =>
        setBookMessage({ tone: 'bad', text: `${label}: ${describeActionError(error)}` }),
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
  const onBook = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    setBook(null);
    if (file === undefined) return;
    // The same rule as the export: nothing in the file, or more than the API takes, said here in
    // plain words before the button is enabled (the limit is the API's, read from config).
    const problem = uploadSizeProblem(file.size, MAX_WORKBOOK_BYTES);
    if (problem !== null) {
      setBookMessage({ tone: 'bad', text: problem });
      return;
    }
    try {
      const bytes = await readBytes(file);
      if (bytes.length === 0) {
        setBookMessage({ tone: 'bad', text: EMPTY_FILE_PROBLEM });
        return;
      }
      setBook({ fileName: file.name, workbookBase64: base64Of(bytes) });
      setBookMessage(null);
    } catch (error) {
      setBookMessage({
        tone: 'bad',
        text: error instanceof Error ? error.message : 'The file could not be read.',
      });
    }
  };
  const stageSample = async (scenario: SampleScenario): Promise<void> => {
    let csv: string;
    try {
      const res = await fetch(sampleUrl(scenario));
      if (!res.ok) throw new Error(String(res.status));
      csv = await res.text();
    } catch {
      setMessage({ tone: 'bad', text: `The ${scenario} sample could not be loaded.` });
      return;
    }
    stage({ fileName: sampleFileName(scenario), csv }, `Stage the ${scenario} sample`);
  };
  const waiting: DropRow[] = [
    ...(exports.data?.items ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      folder: 'Accounting exports',
      receivedAt: item.receivedAt,
      busy: exportBusy,
      stage: () => stage({ exportId: item.id }, `Stage ${item.name}`),
    })),
    ...(drops.data?.items ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      folder: 'Operations workbooks',
      receivedAt: item.receivedAt,
      busy: bookBusy,
      stage: () => stageBook({ dropId: item.id }, `Stage ${item.name}`),
    })),
  ];

  return (
    <Card testId="intake-upload">
      <SectionHeader>Stage an export</SectionHeader>
      <p className="pb-meta">
        The file is read here and sent as text. Every row is linked, validated and compared with the
        current quarter before anyone approves it; nothing reaches production until then.
      </p>
      <FileField
        label="Accounting export (CSV)"
        accept=".csv,text/csv"
        busy={exportBusy}
        onFile={(event) => void onFile(event)}
        command="Stage export"
        ready={chosen !== null}
        onStage={() => {
          if (chosen !== null) stage(chosen, `Stage ${chosen.fileName}`);
        }}
      />
      <UploadStatus message={message} testId="intake-upload-status" />
      <SectionHeader>Stage a workbook</SectionHeader>
      <p className="pb-meta">
        An operations workbook is matched to a template by its sheet names and its header row, then
        read like an accounting export. A workbook that matches no template is refused and stages
        nothing.
      </p>
      <FileField
        label="Operations workbook (XLSX)"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        busy={bookBusy}
        onFile={(event) => void onBook(event)}
        command="Stage workbook"
        ready={book !== null}
        onStage={() => {
          if (book !== null) stageBook(book, `Stage ${book.fileName}`);
        }}
      />
      <UploadStatus message={bookMessage} testId="intake-workbook-status" />
      {waiting.length > 0 ? <DropFolderTable rows={waiting} /> : null}
      {exports.isError ? (
        <UnavailableState inline error={exports.error} subject="The drop folder" />
      ) : null}
      {drops.isError ? (
        <UnavailableState inline error={drops.error} subject="The ops drop folder" />
      ) : null}
      {previewMode ? (
        <>
          <SectionHeader>Sample exports</SectionHeader>
          <p className="pb-meta">
            Three synthetic exports built for the preview: one that matches the record, one with a
            restated position and a new quarter, and one with a defect for each validation rule.
          </p>
          <div className="pb-actions">
            {SAMPLE_SCENARIOS.map((scenario) => (
              <Button
                key={scenario}
                size="small"
                appearance="secondary"
                disabled={exportBusy}
                data-testid={`intake-sample-${scenario}`}
                onClick={() => void stageSample(scenario)}
              >
                Stage the {scenario} sample
              </Button>
            ))}
          </div>
        </>
      ) : null}
    </Card>
  );
}

function FilesTable({ files }: { files: readonly IntakeFile[] }): ReactNode {
  return (
    <TableWrap label="Intake files">
      <table
        className="pb-table pb-intake-files"
        aria-label="Intake files"
        data-testid="intake-files"
      >
        <thead>
          <tr>
            <th>File</th>
            <th>Source</th>
            <th>Received</th>
            <th>Received by</th>
            <th className="num">Rows</th>
            <th>Status</th>
            <th>Counts</th>
            <th className="num">Exceptions</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr key={file.id}>
              <td>
                <Link to={fileRoute(file.source)} params={{ id: file.id }}>
                  {file.fileName}
                </Link>
              </td>
              <td>
                <span>{sourceWord(file.source)}</span>
                {templateLine(file) === null ? null : (
                  <span className="pb-cell-sub">{templateLine(file)}</span>
                )}
              </td>
              <td className="pb-nowrap">{dayOf(file.receivedAt)}</td>
              <td>{file.receivedBy ?? MISSING}</td>
              <NumCell>{String(file.rowCount)}</NumCell>
              <td>
                <Badge tone={stagingTone(file.status)}>{humanizeState(file.status)}</Badge>
              </td>
              <td>{countsLine(file.counts)}</td>
              <NumCell>{exceptionsText(file)}</NumCell>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function FilesCard({ page, isOps }: { page: IntakeFilePage; isOps: boolean }): ReactNode {
  return (
    <Card testId="intake-files-card">
      <SectionHeader
        aside={page.items.length === 0 ? undefined : plural(page.items.length, 'file')}
      >
        Intake files
      </SectionHeader>
      {page.items.length === 0 ? (
        <EmptyState
          title="No intake files yet"
          detail={
            isOps
              ? 'Stage an accounting export above; it appears here with its rows, findings and status.'
              : 'Operations stages accounting exports; each one appears here with its rows, findings and status.'
          }
        />
      ) : (
        <FilesTable files={page.items} />
      )}
      {page.nextCursor !== null ? (
        <p className="pb-meta" data-testid="intake-files-truncated">
          Showing the first {LIST_LIMIT} files; more exist.
        </p>
      ) : null}
    </Card>
  );
}

/**
 * Intake (docs/04 M2, SEC-9.1): every intake file (accounting exports, operations workbooks,
 * weekly values and look-through runs), newest first, each opening on the page of its source,
 * and for operations the ways to stage an export or a workbook. Every row stays in staging until
 * a reviewer approves it on the file's own page.
 */
export function IntakePage(): ReactNode {
  const me = useQuery(meQuery);
  const files = useQuery({ ...intakeFilesQuery, placeholderData: keepPreviousData });
  const navigate = useNavigate();
  if (files.isPending || me.isPending) return <PageSkeleton rows={6} />;
  if (files.isError) {
    return (
      <>
        <PageHeader title="Intake" meta={INTAKE_META} />
        <TabNav label="Admin" items={ADMIN_TABS} />
        <UnavailableState
          card
          error={files.error}
          subject="Intake"
          forbidden={INTAKE_FORBIDDEN}
          errorTitle="Intake unavailable"
          testId="intake-unavailable"
        />
      </>
    );
  }
  const isOps = (me.data?.roles ?? []).includes('operations');
  return (
    <>
      <PageHeader title="Intake" meta={INTAKE_META} />
      <TabNav label="Admin" items={ADMIN_TABS} />
      {isOps ? (
        <UploadCard
          onStaged={(result) =>
            void navigate({
              to: '/data/intake/$id',
              params: { id: result.id },
              search: result.duplicate ? { duplicate: true } : {},
            })
          }
        />
      ) : null}
      <FilesCard page={files.data} isOps={isOps} />
    </>
  );
}
