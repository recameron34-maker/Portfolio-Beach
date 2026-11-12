import definitions from '../../../../../config/definitions.json';
import templatesJson from '../../../../../config/ops_drop_templates.json';
import { TEMPLATE_HEADER_SEPARATOR, opsDropTemplates } from '@pb/contracts';
import type { IntakeExportList, OpsDropImportBody, OpsDropTemplate } from '@pb/contracts';
import { readAccountingFile, toCsv } from '@pb/validation';
import type { Finding } from '@pb/validation';
import { WorkbookError, readWorkbook, templateKey } from '@pb/xlsx';
import { z } from 'zod';
import type { Workbook } from '@pb/xlsx';
import { workbookSamplePath } from '../../pages/intake/intake.js';
import { sha256Hex } from '../hash.js';
import { browserInflateRaw, bytesOfBase64 } from '../inflate.js';
import { jsonResponse, problem } from '../problems.js';
import { contractBody, defineSimRoute, noBook } from './common.js';
import { accountingLayoutOf, hashRefusal, intakeSettings, stageAccountingFile } from './intake.js';
import type { AccountingRead } from './intake.js';

/**
 * The operations workbook drop (docs/04 M2 ops-drop-import, decision 0010) simulated in the
 * browser, the way apps/api/src/intake/ops-drop/ops-drop.service.ts serves it: the bundled
 * workbooks are the ops drop folder; an import decodes the workbook (uploaded as base64, or
 * fetched as a static asset beside the page), reads it with @pb/xlsx to the read limits of
 * config/definitions.json (the DecompressionStream inflater in place of zlib), matches it to a
 * template of config/ops_drop_templates.json by its sheet names and the SHA-256 of its header
 * cells, maps the header onto the accounting layout and stages it through the one staging the
 * accounting export uses (routes/intake.ts stageAccountingFile): linking, diff and rules as the
 * system actor, the file, its rows and its exceptions, with the template's name on the file. A
 * workbook that matches no template is a refused file (no rows) with the LAYOUT-05 finding that
 * names the known templates and the signature seen, never a cell, stageable again once a template
 * describes it. Idempotent by the SHA-256 of the workbook bytes.
 */

const SOURCE = 'ops_drop';
const EXCEPTION_SOURCE = 'ops_drop_import';
/** A file-level finding like LAYOUT-01 to LAYOUT-04 of the accounting reader: the workbook matched no template. */
const NO_TEMPLATE = { ruleId: 'LAYOUT-05', severity: 'error' } as const;

/** The template a workbook matched with its header as read, or the signature the refusal reports. */
type TemplateMatch =
  | { template: OpsDropTemplate; header: string[]; headerSheet: string }
  | { template: null; sheets: string[]; headerSheet: string | null; headerHash: string | null };

/** The SHA-256 of the header cells joined by the unit separator, the API's headerHashOf. */
const headerHashOf = (header: readonly string[]): Promise<string> =>
  sha256Hex(header.join(TEMPLATE_HEADER_SEPARATOR));

/**
 * The first template whose sheet names are the workbook's, in order, and whose header hash is the
 * hash of the header sheet's first row (trailing empty cells dropped, as templateKey reads it);
 * the API's matchTemplate with the browser's hash. Nothing is guessed from a near match: a renamed
 * header cell is a refusal, like a renamed CSV column.
 */
export async function matchTemplate(
  workbook: Workbook,
  templates: readonly OpsDropTemplate[],
): Promise<TemplateMatch> {
  const sheets = workbook.sheets.map((s) => s.name);
  const hasSheet = (name: string): boolean => sheets.includes(name);
  for (const template of templates) {
    if (!hasSheet(template.headerSheet)) continue;
    if (sheets.length !== template.sheets.length || sheets.some((s, i) => s !== template.sheets[i]))
      continue;
    const key = templateKey(workbook, template.headerSheet);
    if ((await headerHashOf(key.header)) === template.headerHash)
      return { template, header: key.header, headerSheet: template.headerSheet };
  }
  // The refusal names the signature it saw: the header sheet a template would read, else the
  // first sheet, hashed the same way, so a template can be written for the workbook.
  const headerSheet =
    templates.find((t) => hasSheet(t.headerSheet))?.headerSheet ?? sheets[0] ?? null;
  const headerHash =
    headerSheet === null ? null : await headerHashOf(templateKey(workbook, headerSheet).header);
  return { template: null, sheets, headerSheet, headerHash };
}

/** The refused file: no rows, one finding naming the known templates and the signature seen (never a cell). */
function refusal(
  match: Extract<TemplateMatch, { template: null }>,
  templates: readonly OpsDropTemplate[],
): AccountingRead {
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
    expected: templates.map((t) => t.name).join(', '),
    actual: seen,
  };
  return { file: { rows: [], fileFindings: [finding], columns: {} }, templateSignature: null };
}

/**
 * A bundled sample workbook as the preview ships it: `preview/samples/<name>.json` holding the
 * workbook's bytes in base64, because the publishing host serves data files but not workbooks
 * (scripts/build-preview.mjs writes it; workbookSamplePath names it).
 */
const workbookCarrier = z.object({ fileName: z.string(), base64: z.string() });

function decodeOrNull(base64: string): Uint8Array | null {
  try {
    return bytesOfBase64(base64);
  } catch {
    return null;
  }
}

/** The largest upload one import accepts, in base64 characters, and the bytes that is (base64 grows bytes by a third). */
const MAX_BASE64_CHARS: number = definitions.intake.maxWorkbookBase64Chars;
const MAX_WORKBOOK_BYTES = Math.floor((MAX_BASE64_CHARS * 3) / 4);

/** The workbook read to the configured limits; a refusal is a problem with the parser's plain message. */
async function readWorkbookOrRefuse(
  bytes: Uint8Array,
  instance: string,
): Promise<Workbook | Response> {
  try {
    return await readWorkbook(bytes, {
      inflateRaw: browserInflateRaw,
      maxCells: definitions.intake.workbookMaxCells,
      maxSheets: definitions.intake.workbookMaxSheets,
      maxPartBytes: definitions.intake.workbookMaxPartBytes,
    });
  } catch (error) {
    if (error instanceof WorkbookError) {
      if (error.code === 'too_large')
        return problem(413, 'too-large', error.message, { instance, simulated: true });
      return problem(422, 'workbook-refused', error.message, { instance, simulated: true });
    }
    throw error;
  }
}

/** GET /api/v1/intake/ops-drop/drops: the bundled workbooks are the ops drop folder (operations only). */
export const opsDropDropsRoute = defineSimRoute({
  method: 'GET',
  path: '/api/v1/intake/ops-drop/drops',
  what: 'drops',
  body: null,
  handle: (req, ctx) => {
    const book = ctx.book;
    if (book === null) return noBook(req.url.pathname);
    const list: IntakeExportList = {
      items: book.opsDropSamples.map((s) => ({
        id: s.fileName,
        name: s.fileName,
        receivedAt: `${s.periodEnd}T12:00:00Z`,
      })),
    };
    return jsonResponse(200, list, { simulated: true });
  },
});

/**
 * POST /api/v1/intake/ops-drop: stage an operations workbook, uploaded as base64 or named among
 * the bundled workbooks. The byte limit is the API's (config); a drop-folder workbook is held to
 * the same size as an upload. The file is matched to a template and staged through the shared
 * staging, or refused as a file with the LAYOUT-05 finding.
 */
export const opsDropImportRoute = defineSimRoute({
  method: 'POST',
  path: '/api/v1/intake/ops-drop',
  what: 'import',
  body: contractBody<OpsDropImportBody>('POST', '/api/v1/intake/ops-drop'),
  handle: async (req, ctx) => {
    const instance = req.url.pathname;
    const book = ctx.book;
    if (book === null) return noBook(instance);
    const body = req.body;
    let fileName: string;
    let bytes: Uint8Array;
    if ('workbookBase64' in body) {
      // The API's body schema caps the upload at intake.maxWorkbookBase64Chars (a 400).
      if (body.workbookBase64.length > MAX_BASE64_CHARS)
        return problem(400, 'validation', 'Invalid import', {
          instance,
          simulated: true,
          errors: [
            { path: 'workbookBase64', message: 'The workbook is larger than one import accepts' },
          ],
        });
      fileName = body.fileName;
      try {
        bytes = bytesOfBase64(body.workbookBase64);
      } catch {
        return problem(422, 'workbook-refused', 'The upload is not base64 text', {
          instance,
          simulated: true,
        });
      }
    } else {
      const sample = book.opsDropSamples.find((s) => s.fileName === body.dropId);
      if (sample === undefined)
        return problem(404, 'not-found', 'Workbook not found', { instance, simulated: true });
      const asset = await ctx.fetchAsset(workbookSamplePath(sample.fileName));
      const carrier = asset.ok
        ? workbookCarrier.safeParse(await asset.json().catch(() => null))
        : null;
      const decoded = carrier?.success === true ? decodeOrNull(carrier.data.base64) : null;
      if (decoded === null)
        return problem(503, 'unavailable', 'The sample workbook is missing from this preview', {
          instance,
          simulated: true,
        });
      fileName = sample.fileName;
      bytes = decoded;
    }
    if (bytes.length > MAX_WORKBOOK_BYTES)
      return problem(413, 'too-large', 'The workbook is larger than one import accepts', {
        instance,
        simulated: true,
      });
    const refused = hashRefusal(instance);
    if (refused !== null) return refused;
    const templates = opsDropTemplates.parse(templatesJson).templates;
    const settings = intakeSettings();
    const layout = accountingLayoutOf();
    return stageAccountingFile(
      ctx,
      req,
      {
        source: SOURCE,
        exceptionSource: EXCEPTION_SOURCE,
        fileName,
        contentHash: await sha256Hex(bytes),
        read: async (): Promise<AccountingRead | Response> => {
          const workbook = await readWorkbookOrRefuse(bytes, instance);
          if (workbook instanceof Response) return workbook;
          const match = await matchTemplate(workbook, templates);
          if (match.template === null) return refusal(match, templates);
          // The header sheet's rows below the header, every cell as text, under the accounting
          // layout's column names: the same reader and the same findings as the accounting
          // export, and a data line n is sheet row n + 1.
          const sheet = workbook.sheets.find((s) => s.name === match.headerSheet);
          const header = match.header.map((cell) => match.template.columns[cell] ?? cell);
          const rows = (sheet?.rows ?? []).slice(1);
          return {
            file: readAccountingFile(toCsv(header, rows), layout, { maxRows: settings.maxRows }),
            templateSignature: match.template.name,
          };
        },
      },
      instance,
    );
  },
});
