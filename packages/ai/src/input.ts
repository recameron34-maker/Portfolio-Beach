import { AiError } from './errors.js';

/*
 * The input of a model call (SEC-8.3): a metadata block of `key: value` lines, a blank line, then
 * the document content between two delimiters, one page per `[page N]` heading. The system prompt
 * tells the model that everything between the delimiters is data. The content is never altered
 * (the validator compares quotes against the same page texts), so a page that could be mistaken
 * for the frame is refused rather than escaped: see buildInput.
 */

export const DOCUMENT_START = '<<<DOCUMENT_START>>>';
export const DOCUMENT_END = '<<<DOCUMENT_END>>>';

/** How buildInput lays the two parts out; the registry shows it to a reader of the prompt. */
export const INPUT_TEMPLATE = `{{metadata}}\n\n${DOCUMENT_START}\n{{content}}\n${DOCUMENT_END}\n`;

export type MetadataValue = string | number;
/** The metadata block: file_name, content_hash, page_count, and for extraction investment_number and company_name when linked. */
export type ModelInputMetadata = Readonly<Record<string, MetadataValue>>;

export interface ModelInputParts {
  metadata: ModelInputMetadata;
  /** One text per page, in page order; page 1 is the first entry. */
  pages: readonly string[];
}

export interface ParsedModelInput {
  /** Every metadata line as text, keyed as written. */
  metadata: Readonly<Record<string, string>>;
  pages: readonly string[];
}

const METADATA_KEY = /^[a-z][a-z0-9_]*$/;
/** Any C0 control character or DEL, which would break a one-line value or hide text from a reader. */
const CONTROL = /\p{Cc}/u;
const PAGE_HEADING = /^\[page (\d+)\]$/;

function pageHeading(n: number): string {
  return `[page ${n}]`;
}

/**
 * Builds the model input. Refused with an AiError 'invalid_input' (the run fails and a person
 * looks at the document) when: a metadata key is not snake_case, a metadata value holds a line
 * break or control character or a delimiter, there are no pages, or a page's text contains a
 * delimiter or a line that is exactly a page heading. Escaping instead would change the text the
 * model sees away from the text the citation check reads, so the frame is kept exact and the rare
 * document that collides with it is refused by name.
 */
export function buildInput({ metadata, pages }: ModelInputParts): string {
  const keys = Object.keys(metadata).sort();
  const lines: string[] = [];
  for (const key of keys) {
    if (!METADATA_KEY.test(key))
      throw new AiError(`metadata key "${key}" is not a snake_case name`, 'invalid_input');
    const raw = metadata[key];
    const value = typeof raw === 'number' ? String(raw) : raw;
    if (typeof raw === 'number' && !Number.isFinite(raw))
      throw new AiError(`metadata value for ${key} is not a finite number`, 'invalid_input');
    if (value === undefined)
      throw new AiError(`metadata value for ${key} is missing`, 'invalid_input');
    if (CONTROL.test(value))
      throw new AiError(
        `metadata value for ${key} contains a line break or control character`,
        'invalid_input',
      );
    if (value.includes(DOCUMENT_START) || value.includes(DOCUMENT_END))
      throw new AiError(`metadata value for ${key} contains the input delimiter`, 'invalid_input');
    lines.push(`${key}: ${value}`);
  }
  if (pages.length === 0) throw new AiError('the document has no pages', 'invalid_input');
  const blocks: string[] = [];
  pages.forEach((text, index) => {
    const number = index + 1;
    if (text.includes(DOCUMENT_START) || text.includes(DOCUMENT_END))
      throw new AiError(
        `page ${number} contains the input delimiter, so the document cannot be passed as data`,
        'invalid_input',
      );
    if (text.split('\n').some((line) => PAGE_HEADING.test(line)))
      throw new AiError(
        `page ${number} contains a line that reads as a page heading, so the document cannot be passed as data`,
        'invalid_input',
      );
    blocks.push(`${pageHeading(number)}\n${text}`);
  });
  return INPUT_TEMPLATE.replace('{{metadata}}', lines.join('\n')).replace(
    '{{content}}',
    blocks.join('\n\n'),
  );
}

/**
 * Reads an input built by buildInput back into its parts. An input without the exact frame
 * (both delimiters on their own lines, headings numbered 1, 2, 3 in order) is refused with an
 * AiError 'invalid_input': the prototype models only ever read what buildInput wrote.
 */
export function parseInput(input: string): ParsedModelInput {
  const startMarker = `\n\n${DOCUMENT_START}\n`;
  const endMarker = `\n${DOCUMENT_END}\n`;
  const start = input.indexOf(startMarker);
  if (start < 0 || !input.endsWith(endMarker))
    throw new AiError('the input is not framed as buildInput writes it', 'invalid_input');
  const head = input.slice(0, start);
  const content = input.slice(start + startMarker.length, input.length - endMarker.length);
  const metadata: Record<string, string> = {};
  for (const line of head === '' ? [] : head.split('\n')) {
    const colon = line.indexOf(': ');
    const key = colon < 0 ? '' : line.slice(0, colon);
    if (!METADATA_KEY.test(key))
      throw new AiError('a metadata line is not a "key: value" line', 'invalid_input');
    metadata[key] = line.slice(colon + 2);
  }
  if (content === '') throw new AiError('the input has no pages', 'invalid_input');
  const pages: string[] = [];
  let current: string[] | null = null;
  for (const line of content.split('\n')) {
    const heading = PAGE_HEADING.exec(line);
    if (heading !== null) {
      if (current !== null) pages.push(current.join('\n').replace(/\n$/, ''));
      if (Number(heading[1]) !== pages.length + 1)
        throw new AiError('the page headings are not numbered in order', 'invalid_input');
      current = [];
      continue;
    }
    if (current === null)
      throw new AiError('the content does not start with a page heading', 'invalid_input');
    current.push(line);
  }
  if (current === null) throw new AiError('the input has no pages', 'invalid_input');
  pages.push(current.join('\n'));
  return { metadata, pages };
}

/** The metadata block of an input built by buildInput (the fixture extractor reads content_hash from it). */
export function parseMetadata(input: string): Readonly<Record<string, string>> {
  return parseInput(input).metadata;
}
