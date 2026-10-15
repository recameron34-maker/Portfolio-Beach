/**
 * `writePdf`: a PDF 1.4 file from pages of text, lines and rectangles. One uncompressed content
 * stream per page, the standard 14 text faces referenced by name (never embedded), text in
 * WinAnsiEncoding (a character the encoding cannot carry is refused with a plain message), an
 * information dictionary only from the values the caller gives (no producer, no clock), a
 * classic cross-reference table with offsets computed from the bytes as written. The same input
 * always gives the same bytes: nothing here reads the wall clock or draws a random value.
 */
import { concatBytes, encodeUtf8 } from './bytes.js';
import { winAnsiCode } from './encodings.js';
import { PdfError } from './errors.js';
import { isStandardFont, type StandardFont } from './metrics.js';

export interface TextItem {
  kind: 'text';
  /** The start of the baseline, in points from the lower-left corner. */
  x: number;
  y: number;
  size: number;
  font: StandardFont;
  text: string;
}

export interface LineItem {
  kind: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** The stroke width in points (default 1). */
  width?: number;
}

export interface RectItem {
  kind: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
  /** Fill the rectangle (black) instead of stroking its outline. */
  fill?: boolean;
}

export type PageItem = TextItem | LineItem | RectItem;

export interface PageInput {
  /** Points; default US letter, 612 by 792. */
  width?: number;
  height?: number;
  items: readonly PageItem[];
}

export interface WritePdfInput {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  /** A PDF date string, `D:YYYYMMDDHHmmSS` with an optional zone, given by the caller; never the clock. */
  creationDate?: string;
  pages: readonly PageInput[];
}

export const DEFAULT_PAGE_WIDTH = 612;
export const DEFAULT_PAGE_HEIGHT = 792;
export const PDF_VERSION = '1.4';
/** The most pages one call writes; more is a mistake, not a report. */
export const MAX_WRITE_PAGES = 10_000;
/** The most characters one text item holds. */
export const MAX_TEXT_LENGTH = 10_000;

/** `D:YYYY` through `D:YYYYMMDDHHmmSS`, then `Z` or `+HH'mm'` (the closing apostrophe optional, as PDF 2.0 has it). */
const DATE = /^D:\d{4}(\d{2}(\d{2}(\d{2}(\d{2}(\d{2})?)?)?)?)?([Zz]|[+-]\d{2}('(\d{2}'?)?)?)?$/;

/** A number as PDF writes it: at most four decimals, no exponent, no trailing zeros, `0` for -0. */
export function formatNumber(value: number, what: string): string {
  if (!Number.isFinite(value))
    throw new PdfError(`${what} is not a finite number`, 'invalid_input');
  if (Math.abs(value) > 1e9) throw new PdfError(`${what} is too large to write`, 'invalid_input');
  const text = value.toFixed(4).replace(/\.?0+$/, '');
  return text === '-0' || text === '' ? '0' : text;
}

/** A WinAnsi text as a PDF literal string, with bytes outside printable ASCII as octal escapes. */
export function encodeTextLiteral(text: string): string {
  let out = '(';
  for (const char of text) {
    const code = winAnsiCode(char);
    if (code < 0) {
      const point = (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
      throw new PdfError(
        `The text "${text}" holds the character "${char}" (U+${point}), which WinAnsiEncoding cannot carry`,
        'invalid_input',
      );
    }
    if (code === 0x28 || code === 0x29 || code === 0x5c) out += `\\${String.fromCharCode(code)}`;
    else if (code < 0x20 || code > 0x7e) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(code);
  }
  return `${out})`;
}

/**
 * An information string: a literal when it is printable ASCII, else UTF-16BE with a byte order
 * mark as a hexadecimal string (section 7.9.2.2), so any text the caller gives survives.
 */
export function encodeInfoString(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text) && !/[()\\]/.test(text)) return `(${text})`;
  let hex = 'FEFF';
  for (let i = 0; i < text.length; i += 1)
    hex += text.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  return `<${hex}>`;
}

function contentOf(page: PageInput, fonts: Map<StandardFont, number>, pageIndex: number): string {
  const parts: string[] = [];
  const where = (n: number): string => `page ${pageIndex + 1} item ${n + 1}`;
  page.items.forEach((item, n) => {
    switch (item.kind) {
      case 'text': {
        if (!isStandardFont(item.font)) {
          throw new PdfError(
            `${where(n)} names the font ${String(item.font)}, which is not one of the standard fonts`,
            'invalid_input',
          );
        }
        if (typeof item.text !== 'string')
          throw new PdfError(`${where(n)} has no text`, 'invalid_input');
        if (item.text.length > MAX_TEXT_LENGTH) {
          throw new PdfError(
            `${where(n)} holds more than ${MAX_TEXT_LENGTH} characters`,
            'invalid_input',
          );
        }
        if (!(item.size > 0))
          throw new PdfError(`${where(n)} has a font size that is not positive`, 'invalid_input');
        let index = fonts.get(item.font);
        if (index === undefined) {
          index = fonts.size + 1;
          fonts.set(item.font, index);
        }
        parts.push(
          `BT /F${index} ${formatNumber(item.size, `${where(n)} size`)} Tf ${formatNumber(item.x, `${where(n)} x`)} ${formatNumber(item.y, `${where(n)} y`)} Td ${encodeTextLiteral(item.text)} Tj ET`,
        );
        break;
      }
      case 'line': {
        const width = item.width ?? 1;
        if (!(width >= 0))
          throw new PdfError(`${where(n)} has a negative line width`, 'invalid_input');
        parts.push(
          `${formatNumber(width, `${where(n)} width`)} w ${formatNumber(item.x1, `${where(n)} x1`)} ${formatNumber(item.y1, `${where(n)} y1`)} m ${formatNumber(item.x2, `${where(n)} x2`)} ${formatNumber(item.y2, `${where(n)} y2`)} l S`,
        );
        break;
      }
      case 'rect':
        parts.push(
          `${formatNumber(item.x, `${where(n)} x`)} ${formatNumber(item.y, `${where(n)} y`)} ${formatNumber(item.w, `${where(n)} w`)} ${formatNumber(item.h, `${where(n)} h`)} re ${item.fill ? 'f' : 'S'}`,
        );
        break;
      default:
        throw new PdfError(`${where(n)} has a kind the writer does not know`, 'invalid_input');
    }
  });
  return parts.join('\n');
}

/** Writes the document. Deterministic: the same input gives the same bytes. */
export function writePdf(input: WritePdfInput): Uint8Array {
  if (!Array.isArray(input.pages) || input.pages.length === 0) {
    throw new PdfError('A document needs at least one page', 'invalid_input');
  }
  if (input.pages.length > MAX_WRITE_PAGES) {
    throw new PdfError(
      `A document cannot hold more than ${MAX_WRITE_PAGES} pages`,
      'invalid_input',
    );
  }
  if (input.creationDate !== undefined && !DATE.test(input.creationDate)) {
    throw new PdfError(
      'The creation date must be a PDF date string such as D:20260101120000Z',
      'invalid_input',
    );
  }
  const pages: readonly PageInput[] = input.pages;
  const fonts = new Map<StandardFont, number>();
  const contents: string[] = [];
  const sizes: [number, number][] = [];
  pages.forEach((page, index) => {
    const width = page.width ?? DEFAULT_PAGE_WIDTH;
    const height = page.height ?? DEFAULT_PAGE_HEIGHT;
    if (!(width > 0) || !(height > 0)) {
      throw new PdfError(
        `Page ${index + 1} has a width or height that is not positive`,
        'invalid_input',
      );
    }
    sizes.push([width, height]);
    contents.push(contentOf(page, fonts, index));
  });
  // Object numbers: 1 catalog, 2 pages, then per page (page, content), then fonts, then info.
  const pageCount = input.pages.length;
  const firstFont = 3 + pageCount * 2;
  const infoNumber = firstFont + fonts.size;
  const infoEntries: string[] = [];
  const infoKeys: [keyof WritePdfInput, string][] = [
    ['title', 'Title'],
    ['author', 'Author'],
    ['subject', 'Subject'],
    ['keywords', 'Keywords'],
    ['creator', 'Creator'],
    ['producer', 'Producer'],
  ];
  for (const [field, key] of infoKeys) {
    const value = input[field];
    if (typeof value === 'string') infoEntries.push(`/${key} ${encodeInfoString(value)}`);
  }
  if (input.creationDate !== undefined) infoEntries.push(`/CreationDate (${input.creationDate})`);
  const hasInfo = infoEntries.length > 0;
  const objectCount = hasInfo ? infoNumber : infoNumber - 1;

  const objects: Uint8Array[] = [];
  const kids = input.pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objects.push(encodeUtf8('<< /Type /Catalog /Pages 2 0 R >>'));
  objects.push(encodeUtf8(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`));
  const fontResources = [...fonts.values()]
    .map((index) => `/F${index} ${firstFont + index - 1} 0 R`)
    .join(' ');
  input.pages.forEach((_, i) => {
    const [width, height] = sizes[i] ?? [DEFAULT_PAGE_WIDTH, DEFAULT_PAGE_HEIGHT];
    objects.push(
      encodeUtf8(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${formatNumber(width, 'width')} ${formatNumber(height, 'height')}] /Resources << /Font << ${fontResources} >> >> /Contents ${4 + i * 2} 0 R >>`,
      ),
    );
    const content = encodeUtf8(contents[i] ?? '');
    objects.push(
      concatBytes([
        encodeUtf8(`<< /Length ${content.length} >>\nstream\n`),
        content,
        encodeUtf8('\nendstream'),
      ]),
    );
  });
  for (const font of fonts.keys()) {
    objects.push(
      encodeUtf8(`<< /Type /Font /Subtype /Type1 /BaseFont /${font} /Encoding /WinAnsiEncoding >>`),
    );
  }
  if (hasInfo) objects.push(encodeUtf8(`<< ${infoEntries.join(' ')} >>`));

  // The header, then the binary comment the specification recommends (four bytes above 127).
  const parts: Uint8Array[] = [
    concatBytes([
      encodeUtf8(`%PDF-${PDF_VERSION}\n%`),
      new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]),
      encodeUtf8('\n'),
    ]),
  ];
  let offset = parts[0]?.length ?? 0;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const bytes = concatBytes([encodeUtf8(`${i + 1} 0 obj\n`), body, encodeUtf8('\nendobj\n')]);
    parts.push(bytes);
    offset += bytes.length;
  });
  const startxref = offset;
  let table = `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) table += `${at.toString().padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R${hasInfo ? ` /Info ${infoNumber} 0 R` : ''} >>\nstartxref\n${startxref}\n%%EOF\n`;
  parts.push(encodeUtf8(table + trailer));
  return concatBytes(parts);
}
