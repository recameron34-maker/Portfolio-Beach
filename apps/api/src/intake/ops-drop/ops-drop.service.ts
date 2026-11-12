import { Inject, Injectable } from '@nestjs/common';
import type { AdapterSet, Principal } from '@pb/adapters';
import { TEMPLATE_HEADER_SEPARATOR } from '@pb/contracts';
import type {
  IntakeExportList,
  IntakeImportResult,
  OpsDropImportBody,
  OpsDropTemplate,
  OpsDropTemplates,
} from '@pb/contracts';
import { readAccountingFile, toCsv } from '@pb/validation';
import type { Finding } from '@pb/validation';
import { WorkbookError, readWorkbook, templateKey } from '@pb/xlsx';
import type { Workbook } from '@pb/xlsx';
import { nodeInflateRaw } from '@pb/xlsx/node';
import { configInteger } from '../../common/definitions.js';
import { ProblemError } from '../../common/problem.js';
import {
  ACCOUNTING_LAYOUT,
  ADAPTERS,
  DEFINITIONS,
  OPS_DROP_TEMPLATES,
} from '../../common/tokens.js';
import { DbService } from '../../db/db.service.js';
import { accountingLayoutOf, contentHashOf, intakeSettingsOf, stageFile } from '../stage.js';
import type { ReadOutcome } from '../stage.js';

/*
 * The operations workbook drop (docs/04 M2 ops-drop-import, decision 0010): a workbook is parsed
 * by its template signature, the sheet names plus the SHA-256 of the header row's cells on the
 * template's header sheet (config/ops_drop_templates.json). A workbook that matches a template is
 * read through the template's column mapping into the accounting layout's columns and staged
 * exactly as an accounting export is (stage.ts: linking, diff and rules as the system actor, the
 * file, its rows, its exceptions and one audit event), with the template's name on the file; one
 * that matches no template is refused with a file finding naming the known templates, the sheets
 * and the header hash, never a cell, and stages nothing, re-stageable once a template is added.
 * Idempotent by the SHA-256 of the workbook bytes. The parser works to the read limits of
 * config/definitions.json; a workbook it refuses is a 422 (or a 413 past a limit) whose detail
 * is the parser's plain message, never the bytes.
 */

const SOURCE = 'ops_drop';
const EXCEPTION_SOURCE = 'ops_drop_import';
/** A file-level finding like LAYOUT-01 to LAYOUT-04 of the accounting reader: the workbook matched no template. */
const NO_TEMPLATE = { ruleId: 'LAYOUT-05', severity: 'error' } as const;

/** The read limits and the upload limit this intake reads from config/definitions.json (CLAUDE.md rule 9). */
interface Definitions {
  intake?: {
    maxWorkbookBase64Chars?: unknown;
    workbookMaxCells?: unknown;
    workbookMaxSheets?: unknown;
    workbookMaxPartBytes?: unknown;
  };
}

/** The template a workbook matched with its header as read, or the signature the refusal reports. */
type TemplateMatch =
  | { template: OpsDropTemplate; header: string[]; headerSheet: string }
  | { template: null; sheets: string[]; headerSheet: string | null; headerHash: string | null };

const headerHashOf = (header: readonly string[]): string =>
  contentHashOf(header.join(TEMPLATE_HEADER_SEPARATOR));

/**
 * The first template whose sheet names are the workbook's, in order, and whose header hash is the
 * hash of the header sheet's first row (trailing empty cells dropped, as templateKey reads it).
 * Nothing is guessed from a near match: a renamed header cell is a refusal, like a renamed CSV column.
 */
export function matchTemplate(
  workbook: Workbook,
  templates: readonly OpsDropTemplate[],
): TemplateMatch {
  const sheets = workbook.sheets.map((s) => s.name);
  const hasSheet = (name: string): boolean => sheets.includes(name);
  for (const template of templates) {
    if (!hasSheet(template.headerSheet)) continue;
    if (sheets.length !== template.sheets.length || sheets.some((s, i) => s !== template.sheets[i]))
      continue;
    const key = templateKey(workbook, template.headerSheet);
    if (headerHashOf(key.header) === template.headerHash)
      return { template, header: key.header, headerSheet: template.headerSheet };
  }
  // The refusal names the signature it saw: the header sheet a template would read, else the
  // first sheet, hashed the same way, so a template can be written for the workbook.
  const headerSheet =
    templates.find((t) => hasSheet(t.headerSheet))?.headerSheet ?? sheets[0] ?? null;
  const headerHash =
    headerSheet === null ? null : headerHashOf(templateKey(workbook, headerSheet).header);
  return { template: null, sheets, headerSheet, headerHash };
}

@Injectable()
export class OpsDropService {
  constructor(
    private readonly db: DbService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    @Inject(DEFINITIONS) private readonly definitions: Definitions,
    @Inject(ACCOUNTING_LAYOUT) private readonly rawLayout: unknown,
    @Inject(OPS_DROP_TEMPLATES) private readonly templates: OpsDropTemplates,
  ) {}

  /** The largest upload one import accepts, in base64 characters (definitions.intake.maxWorkbookBase64Chars). */
  maxWorkbookBase64Chars(): number {
    return configInteger(
      this.definitions.intake?.maxWorkbookBase64Chars,
      'intake.maxWorkbookBase64Chars',
    );
  }

  /** The workbooks waiting in the ops drop folder (the local folder adapter in the prototype). */
  async drops(): Promise<IntakeExportList> {
    return { items: await this.adapters.opsDrop.listFiles() };
  }

  /** The workbook bytes as uploaded (base64), or read from the drop folder by id; an id the folder does not list is not found. */
  private async workbookBytes(
    body: OpsDropImportBody,
  ): Promise<{ fileName: string; bytes: Uint8Array }> {
    if ('workbookBase64' in body)
      return { fileName: body.fileName, bytes: Buffer.from(body.workbookBase64, 'base64') };
    const listed = await this.adapters.opsDrop.listFiles();
    const ref = listed.find((e) => e.id === body.dropId);
    if (ref === undefined) throw new ProblemError(404, 'not-found', 'Workbook not found');
    return { fileName: ref.name, bytes: await this.adapters.opsDrop.readBytes(ref.id) };
  }

  /** The workbook read to the configured limits; a refusal is a problem with the parser's plain message. */
  private async readWorkbook(bytes: Uint8Array): Promise<Workbook> {
    const intake = this.definitions.intake;
    const limits = {
      maxCells: configInteger(intake?.workbookMaxCells, 'intake.workbookMaxCells'),
      maxSheets: configInteger(intake?.workbookMaxSheets, 'intake.workbookMaxSheets'),
      maxPartBytes: configInteger(intake?.workbookMaxPartBytes, 'intake.workbookMaxPartBytes'),
    };
    try {
      return await readWorkbook(bytes, { inflateRaw: nodeInflateRaw, ...limits });
    } catch (error) {
      if (error instanceof WorkbookError) {
        if (error.code === 'too_large') throw new ProblemError(413, 'too-large', error.message);
        throw new ProblemError(422, 'workbook-refused', error.message);
      }
      throw error;
    }
  }

  /**
   * Stage an operations workbook. The file is matched to a template, mapped onto the accounting
   * layout and staged through the shared staging; a workbook that matches no template is staged
   * as a refused file (status new, no rows) with the LAYOUT-05 finding, like a CSV the layout
   * refuses, so it is listed, readable and stageable again once a template describes it.
   */
  async import(
    principal: Principal,
    requestId: string,
    body: OpsDropImportBody,
  ): Promise<IntakeImportResult> {
    const settings = intakeSettingsOf(this.definitions);
    const layout = accountingLayoutOf(this.rawLayout);
    const { fileName, bytes } = await this.workbookBytes(body);
    // A drop-folder workbook is held to the same size as an upload (base64 grows bytes by a third).
    if (bytes.length > Math.floor((this.maxWorkbookBase64Chars() * 3) / 4))
      throw new ProblemError(413, 'too-large', 'The workbook is larger than one import accepts');
    return stageFile(this.db, principal, requestId, {
      source: SOURCE,
      exceptionSource: EXCEPTION_SOURCE,
      fileName,
      contentHash: contentHashOf(bytes),
      read: async (): Promise<ReadOutcome> => {
        const workbook = await this.readWorkbook(bytes);
        const match = matchTemplate(workbook, this.templates.templates);
        if (match.template === null)
          return { file: refusal(match, this.templates), templateSignature: null };
        // The header sheet's rows below the header, every cell as text, under the accounting
        // layout's column names: the same reader and the same findings as the accounting export.
        const sheet = workbook.sheets.find((s) => s.name === match.headerSheet);
        const header = match.header.map((cell) => match.template.columns[cell] ?? cell);
        const rows = dataLines((sheet?.rows ?? []).slice(1), header.length);
        return {
          file: readAccountingFile(toCsv(header, rows), layout, { maxRows: settings.maxRows }),
          templateSignature: match.template.name,
        };
      },
      layout,
      settings,
      asOf: this.adapters.clock.today(),
    });
  }
}

/**
 * Every sheet row below the header as exactly one data line of the header's width, so a data line
 * n is sheet row n + 1 for every row: the row number the reviewer sees and the promoted lineage
 * names (SEC-9.4). A blank row between two rows of figures (the reader gives it no cells) would
 * otherwise write an empty CSV line, which the CSV reader drops, and every row below it would be
 * numbered one short; padded to the header's width it stages as a row the required-field rules
 * flag (REQ-01 to REQ-03), with its numbering kept. A short row is padded the same way. Cells past
 * the header are dropped knowingly: the template names no column for them, and a column the
 * layout does not know is refused at the header, never guessed at from a cell. Blank rows below
 * the last row with content are not data (a sheet keeps formatted empty rows): they are dropped,
 * which shifts no number.
 */
export function dataLines(rows: readonly (readonly string[])[], width: number): string[][] {
  const blank = (cells: readonly string[]): boolean => cells.every((c) => c.trim() === '');
  let last = rows.length;
  while (last > 0 && blank(rows[last - 1] ?? [])) last -= 1;
  return rows
    .slice(0, last)
    .map((cells) => Array.from({ length: width }, (_, i) => cells[i] ?? ''));
}

/** The refused file: no rows, one finding naming the known templates and the signature seen (never a cell). */
function refusal(
  match: Extract<TemplateMatch, { template: null }>,
  templates: OpsDropTemplates,
): ReadOutcome['file'] {
  const seen = [
    `sheets: ${match.sheets.join(', ')}`,
    match.headerHash === null
      ? 'no header row'
      : `header hash: ${match.headerHash} (${match.headerSheet ?? ''})`,
  ].join('; ');
  const finding: Finding = {
    ruleId: NO_TEMPLATE.ruleId,
    severity: NO_TEMPLATE.severity,
    message: 'No template matches this workbook',
    field: null,
    expected: templates.templates.map((t) => t.name).join(', '),
    actual: seen,
  };
  return { rows: [], fileFindings: [finding], columns: {} };
}
