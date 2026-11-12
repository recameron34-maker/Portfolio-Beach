/**
 * `readPdf`: opens the file (see `xref.ts`), reads the document information dictionary, walks the
 * page tree (ISO 32000-1 section 7.7.3) with its inherited attributes (Resources, MediaBox,
 * Rotate), interprets every page's content streams (see `content.ts`) and groups the runs into
 * lines (see `layout.ts`). Positions are page coordinates with the media box's lower-left corner
 * at (0, 0) and y up, before any /Rotate is applied; the rotation is reported on the page.
 */
import { textString } from './bytes.js';
import { interpretContent, translation, type OperatorBudget, type TextRun } from './content.js';
import { PdfError } from './errors.js';
import type { Inflate } from './filters.js';
import type { LoadedFont } from './fonts.js';
import { buildLines, type TextLine } from './layout.js';
import { READ_LIMITS, resolveLimits, type ReadLimits } from './limits.js';
import {
  isArray,
  isDict,
  isName,
  isNumber,
  isStream,
  isString,
  type PdfDict,
  type PdfObject,
} from './objects.js';
import { PdfFile } from './xref.js';

export type { TextRun as PdfRun } from './content.js';
export type { TextLine as PdfLine } from './layout.js';
export { READ_LIMITS, type ReadLimits };

export interface PdfInfo {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  /** The date text as stored (`D:20260101120000Z`), never parsed. */
  creationDate?: string;
  modDate?: string;
}

export interface PdfPage {
  /** 1-based. */
  number: number;
  /** The media box size in points, before rotation. */
  width: number;
  height: number;
  /** The page's /Rotate, normalized to 0, 90, 180 or 270. */
  rotate: number;
  /** Every string shown, in drawing order, positioned in page units (y up). */
  runs: TextRun[];
  /** Runs grouped by baseline, top to bottom, each left to right. */
  lines: TextLine[];
  /** The lines joined by newlines. */
  text: string;
}

export interface PdfDocument {
  /** From the header, raised by the catalog's /Version when that is later. */
  version: string;
  pageCount: number;
  info: PdfInfo;
  pages: PdfPage[];
  /** True when the cross-reference data was damaged and the file was indexed by a linear scan. */
  reconstructed: boolean;
}

export interface ReadPdfOptions {
  /** The inflater for FlateDecode streams: `nodeInflate` from `@pb/pdf/node`, or a DecompressionStream wrapper in a browser. */
  inflate: Inflate;
  limits?: Partial<ReadLimits>;
}

const LETTER_WIDTH = 612;
const LETTER_HEIGHT = 792;

interface Inherited {
  resources: PdfDict | null;
  mediaBox: [number, number, number, number] | null;
  rotate: number | null;
}

interface PageSource {
  dict: PdfDict;
  inherited: Inherited;
}

async function readInfo(file: PdfFile): Promise<PdfInfo> {
  const dict = await file.resolve(file.trailer.map.get('Info') ?? null);
  const info: PdfInfo = {};
  if (!isDict(dict)) return info;
  const text = async (key: string): Promise<string | undefined> => {
    const value = await file.get(dict, key);
    return isString(value) ? textString(value.bytes, `The document ${key}`) : undefined;
  };
  const keys: [keyof PdfInfo, string][] = [
    ['title', 'Title'],
    ['author', 'Author'],
    ['subject', 'Subject'],
    ['keywords', 'Keywords'],
    ['creator', 'Creator'],
    ['producer', 'Producer'],
    ['creationDate', 'CreationDate'],
    ['modDate', 'ModDate'],
  ];
  for (const [field, key] of keys) {
    const value = await text(key);
    if (value !== undefined) info[field] = value;
  }
  return info;
}

async function mediaBoxOf(
  file: PdfFile,
  object: PdfObject,
): Promise<[number, number, number, number] | null> {
  if (!isArray(object) || object.items.length !== 4) return null;
  const values: number[] = [];
  for (const item of object.items) {
    const value = await file.resolve(item);
    if (!isNumber(value) || !Number.isFinite(value)) return null;
    values.push(value);
  }
  const [x1, y1, x2, y2] = values as [number, number, number, number];
  if (x1 === x2 || y1 === y2) return null;
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

async function inheritedOf(file: PdfFile, dict: PdfDict, parent: Inherited): Promise<Inherited> {
  const resources = await file.get(dict, 'Resources');
  const mediaBox = await mediaBoxOf(file, await file.get(dict, 'MediaBox'));
  const rotateObject = await file.get(dict, 'Rotate');
  const rotate = isNumber(rotateObject) ? rotateObject : null;
  return {
    resources: isDict(resources) ? resources : parent.resources,
    mediaBox: mediaBox ?? parent.mediaBox,
    rotate: rotate ?? parent.rotate,
  };
}

/** Walks the page tree depth first, collecting the leaves in order, within the page and depth limits. */
async function collectPages(file: PdfFile, limits: ReadLimits): Promise<PageSource[]> {
  const catalog = await file.resolve(file.trailer.map.get('Root') ?? null);
  if (!isDict(catalog)) throw new PdfError('The document catalog is not a dictionary', 'corrupt');
  const rootObject = catalog.map.get('Pages') ?? null;
  const root = await file.resolve(rootObject);
  if (!isDict(root)) throw new PdfError('The document has no page tree', 'corrupt');
  const pages: PageSource[] = [];
  const visited = new Set<PdfDict>();
  const visit = async (dict: PdfDict, parent: Inherited, depth: number): Promise<void> => {
    if (depth > limits.maxDepth) {
      throw new PdfError(
        `The page tree is deeper than the ${limits.maxDepth} levels the reader accepts`,
        'too_large',
      );
    }
    if (visited.has(dict)) return;
    visited.add(dict);
    const inherited = await inheritedOf(file, dict, parent);
    const type = await file.get(dict, 'Type');
    const kids = await file.get(dict, 'Kids');
    const isPages = isName(type, 'Pages') || (isArray(kids) && !isName(type, 'Page'));
    if (isPages) {
      if (!isArray(kids)) return;
      for (const kid of kids.items) {
        const child = await file.resolve(kid);
        if (isDict(child)) await visit(child, inherited, depth + 1);
      }
      return;
    }
    pages.push({ dict, inherited });
    if (pages.length > limits.maxPages) {
      throw new PdfError(
        `The document has more than the ${limits.maxPages} pages the reader accepts`,
        'too_large',
      );
    }
  };
  await visit(root, { resources: null, mediaBox: null, rotate: null }, 1);
  return pages;
}

async function contentOf(file: PdfFile, dict: PdfDict): Promise<Uint8Array> {
  const contents = await file.get(dict, 'Contents');
  const streams: Uint8Array[] = [];
  if (isStream(contents)) streams.push(await file.streamData(contents));
  else if (isArray(contents)) {
    for (const item of contents.items) {
      const stream = await file.resolve(item);
      if (isStream(stream)) streams.push(await file.streamData(stream));
    }
  }
  // Streams of one page are joined with a newline: a token may not straddle two of them.
  let length = 0;
  for (const stream of streams) length += stream.length + 1;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const stream of streams) {
    out.set(stream, offset);
    offset += stream.length;
    out[offset] = 0x0a;
    offset += 1;
  }
  return out;
}

function normalizeRotate(rotate: number | null): number {
  if (rotate === null || !Number.isFinite(rotate)) return 0;
  const quarter = Math.round(rotate / 90) * 90;
  return ((quarter % 360) + 360) % 360;
}

async function versionOf(file: PdfFile): Promise<string> {
  const catalog = await file.resolve(file.trailer.map.get('Root') ?? null);
  const version = isDict(catalog) ? await file.get(catalog, 'Version') : null;
  if (
    isName(version) &&
    /^\d+\.\d+$/.test(version.name) &&
    Number(version.name) > Number(file.headerVersion)
  ) {
    return version.name;
  }
  return file.headerVersion;
}

/**
 * Reads a PDF into positioned text runs, lines and text per page. Refuses, with a `PdfError`,
 * anything that is not a PDF, is encrypted, uses a filter or construct the reader does not
 * handle, is damaged beyond the fallback scan, or passes a read limit.
 */
export async function readPdf(bytes: Uint8Array, options: ReadPdfOptions): Promise<PdfDocument> {
  if (!(bytes instanceof Uint8Array)) {
    throw new PdfError('readPdf needs the file as a Uint8Array', 'invalid_input');
  }
  const limits = resolveLimits(options.limits);
  const file = await PdfFile.open(bytes, options.inflate, limits);
  const version = await versionOf(file);
  const info = await readInfo(file);
  const sources = await collectPages(file, limits);
  const budget: OperatorBudget = { used: 0, max: limits.maxOperators };
  const fontCache = new Map<PdfDict, LoadedFont>();
  const pages: PdfPage[] = [];
  for (const [index, source] of sources.entries()) {
    const box = source.inherited.mediaBox ?? [0, 0, LETTER_WIDTH, LETTER_HEIGHT];
    const width = box[2] - box[0];
    const height = box[3] - box[1];
    const data = await contentOf(file, source.dict);
    const runs = await interpretContent(data, {
      file,
      ctm: translation(-box[0], -box[1]),
      resources: source.inherited.resources,
      budget,
      fontCache,
    });
    const lines = buildLines(runs);
    pages.push({
      number: index + 1,
      width,
      height,
      rotate: normalizeRotate(source.inherited.rotate),
      runs,
      lines,
      text: lines.map((line) => line.text).join('\n'),
    });
  }
  return { version, pageCount: pages.length, info, pages, reconstructed: file.reconstructed };
}
