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

/**
 * Operations only: stage an operations workbook from a chosen .xlsx file or from the ops drop
 * folder (docs/04 M2 ops-drop-import). The file is read as bytes and sent as base64; the API
 * matches it to a template by its sheet names and header, reads it like an accounting export and
 * stages it, or refuses an unknown template with a file finding naming the templates it knows.
 */
function WorkbookUpload({
  onStaged,
}: {
  onStaged: (result: IntakeImportResult) => void;
}): ReactNode {
  const inputId = useId();
  const importer = useOpsDropImport();
  const drops = useQuery(opsDropDropsQuery);
  const [chosen, setChosen] = useState<{ fileName: string; workbookBase64: string } | null>(null);
  const [message, setMessage] = useState<UploadMessage | null>(null);
  const busy = importer.isPending;

  const stage = (body: OpsDropImportBody, label: string): void => {
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
    // The same rule as the export: nothing in the file, or more than the API takes, said here in
    // plain words before the button is enabled (the limit is the API's, read from config).
    const problem = uploadSizeProblem(file.size, MAX_WORKBOOK_BYTES);
    if (problem !== null) {
      setMessage({ tone: 'bad', text: problem });
      return;
    }
    try {
      const bytes = await readBytes(file);
      if (bytes.length === 0) {
        setMessage({ tone: 'bad', text: EMPTY_FILE_PROBLEM });
        return;
      }
      setChosen({ fileName: file.name, workbookBase64: base64Of(bytes) });
      setMessage(null);
    } catch (error) {
      setMessage({
        tone: 'bad',
        text: error instanceof Error ? error.message : 'The file could not be read.',
      });
    }
  };

  return (
    <>
      <SectionHeader>Stage a workbook</SectionHeader>
      <p className="pb-meta">
        An operations workbook is matched to a template by its sheet names and its header row, then
        read like an accounting export. A workbook that matches no template is refused and stages
        nothing.
      </p>
      <div className="pb-intake-upload">
        <div className="pb-field">
          <Label htmlFor={inputId}>Operations workbook (XLSX)</Label>
          <input
            id={inputId}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
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
          Stage workbook
        </Button>
      </div>
      <UploadStatus message={message} testId="intake-workbook-status" />
      {drops.data !== undefined && drops.data.items.length > 0 ? (
        <>
          <SectionHeader>From the ops drop folder</SectionHeader>
          <ul className="pb-intake-drop" aria-label="Workbooks in the ops drop folder">
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
        <UnavailableState inline error={drops.error} subject="The ops drop folder" />
      ) : null}
    </>
  );
}

/** Operations only: stage an export from a chosen file, from the drop folder or, in the preview, a sample. */
function UploadCard({ onStaged }: { onStaged: (result: IntakeImportResult) => void }): ReactNode {
  const inputId = useId();
  const importer = useIntakeImport();
  const exports = useQuery(intakeExportsQuery);
  const [chosen, setChosen] = useState<{ fileName: string; csv: string } | null>(null);
  const [message, setMessage] = useState<UploadMessage | null>(null);
  const busy = importer.isPending;

  const stage = (body: IntakeImportBody, label: string): void => {
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

  return (
    <Card testId="intake-upload">
      <SectionHeader aside={<SimulatedBadge />}>Stage an export</SectionHeader>
      <p className="pb-meta">
        The file is read here and sent as text. Every row is linked, validated and compared with the
        current quarter before anyone approves it; nothing reaches production until then.
      </p>
      <div className="pb-intake-upload">
        <div className="pb-field">
          <Label htmlFor={inputId}>Accounting export (CSV)</Label>
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
          Stage export
        </Button>
      </div>
      <UploadStatus message={message} testId="intake-upload-status" />
      {exports.data !== undefined && exports.data.items.length > 0 ? (
        <>
          <SectionHeader>From the drop folder</SectionHeader>
          <ul className="pb-intake-drop" aria-label="Exports in the drop folder">
            {exports.data.items.map((item) => (
              <li key={item.id}>
                <span>{item.name}</span>
                <span className="pb-meta">Received {dayOf(item.receivedAt)}</span>
                <Button
                  size="small"
                  appearance="outline"
                  disabled={busy}
                  aria-label={`Stage, ${item.name}`}
                  onClick={() => stage({ exportId: item.id }, `Stage ${item.name}`)}
                >
                  Stage
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : exports.isError ? (
        <UnavailableState inline error={exports.error} subject="The drop folder" />
      ) : null}
      <WorkbookUpload onStaged={onStaged} />
      {previewMode ? (
        <>
          <SectionHeader>Sample exports</SectionHeader>
          <p className="pb-meta">
            Three synthetic exports built for the preview: one that matches the record, one with a
            restated position and a new quarter, and one with a defect for each validation rule.
          </p>
          <div className="pb-intake-samples">
            {SAMPLE_SCENARIOS.map((scenario) => (
              <Button
                key={scenario}
                size="small"
                appearance="secondary"
                disabled={busy}
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
