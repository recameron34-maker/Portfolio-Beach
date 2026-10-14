/**
 * A small XML reader for the subset Excel writes: elements, attributes, text, CDATA, comments
 * and processing instructions, with the five predefined entities and numeric character
 * references decoded. It is not a general XML library: a document type declaration (the home of
 * entity expansion attacks), an undeclared entity, a stray `<` or a mismatched tag refuses the
 * part with a plain message, and nesting is capped so a hostile part cannot exhaust the stack.
 *
 * Element and attribute names keep their prefix as written (`r:id`); lookups compare local
 * names, so a writer that prefixes the main namespace still reads.
 */
import { WorkbookError } from './errors.js';

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

export interface ParseXmlOptions {
  /** The deepest element nesting accepted; one more level refuses the part. */
  maxDepth: number;
  /**
   * The most elements and text nodes accepted; one more refuses the part at that point, so a
   * hostile part never grows a tree past the budget before the refusal.
   */
  maxNodes: number;
  /** Names the part in messages, for example `xl/workbook.xml`. */
  part: string;
}

const CODE_LT = 0x3c;
const CODE_GT = 0x3e;
const CODE_SLASH = 0x2f;
const CODE_EQUALS = 0x3d;
const CODE_QUOTE = 0x22;
const CODE_APOS = 0x27;
const MAX_ENTITY_LENGTH = 10;

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function endsName(code: number): boolean {
  return isSpace(code) || code === CODE_GT || code === CODE_SLASH || code === CODE_EQUALS;
}

/** The characters XML 1.0 allows, by code point. */
export function isXmlChar(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

/**
 * The code points `isXmlChar` refuses, as a pattern: the `u` flag makes a surrogate pair one
 * code point, so only a lone surrogate matches. The control characters are the point of it.
 */
// eslint-disable-next-line no-control-regex
const NOT_XML_CHAR = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u;
const LINE_END = /\r\n?/g;

/**
 * Text as parsed: a character XML does not allow refuses the part, and `\r\n` or a lone `\r`
 * becomes `\n` (XML 1.0 section 2.11; this is why Excel writes a carriage return as `_x000D_`).
 * A carriage return given as a character reference is decoded afterwards, so it survives.
 */
function parsedText(raw: string, fail: (what: string) => never): string {
  if (NOT_XML_CHAR.test(raw)) fail('a character XML does not allow');
  return raw.includes('\r') ? raw.replace(LINE_END, '\n') : raw;
}

function decodeEntity(body: string, fail: (what: string) => never): string {
  switch (body) {
    case 'lt':
      return '<';
    case 'gt':
      return '>';
    case 'amp':
      return '&';
    case 'quot':
      return '"';
    case 'apos':
      return "'";
    default:
      break;
  }
  let code: number;
  if (/^#x[0-9A-Fa-f]{1,6}$/.test(body)) code = Number.parseInt(body.slice(2), 16);
  else if (/^#[0-9]{1,7}$/.test(body)) code = Number.parseInt(body.slice(1), 10);
  else return fail(`the entity &${body}; is not one XML defines`);
  if (!isXmlChar(code)) return fail(`the character reference &${body}; is outside what XML allows`);
  return String.fromCodePoint(code);
}

/** Replaces entity and character references; an unknown or unterminated one refuses. */
export function decodeEntities(text: string, fail: (what: string) => never): string {
  let amp = text.indexOf('&');
  if (amp < 0) return text;
  let out = '';
  let from = 0;
  while (amp >= 0) {
    out += text.slice(from, amp);
    const semi = text.indexOf(';', amp + 1);
    if (semi < 0 || semi - amp - 1 > MAX_ENTITY_LENGTH)
      fail('an entity reference is not terminated');
    out += decodeEntity(text.slice(amp + 1, semi), fail);
    from = semi + 1;
    amp = text.indexOf('&', from);
  }
  return out + text.slice(from);
}

export function parseXml(text: string, options: ParseXmlOptions): XmlElement {
  const { maxDepth, maxNodes, part } = options;
  const fail = (what: string): never => {
    throw new WorkbookError(`${part} is not well-formed XML: ${what}`, 'malformed');
  };
  const length = text.length;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let nodes = 0;
  let i = 0;

  /** Counts a node about to be kept; one past the budget refuses before the tree grows further. */
  const countNode = (): void => {
    nodes += 1;
    if (nodes > maxNodes) {
      throw new WorkbookError(
        `${part} holds more than ${maxNodes} elements and text nodes`,
        'too_large',
      );
    }
  };
  const appendText = (value: string): void => {
    const parent = stack[stack.length - 1];
    if (parent) {
      countNode();
      parent.children.push(value);
    } else if (value.trim() !== '') fail('text outside the root element');
  };

  while (i < length) {
    if (text.charCodeAt(i) !== CODE_LT) {
      const next = text.indexOf('<', i);
      const stop = next < 0 ? length : next;
      appendText(decodeEntities(parsedText(text.slice(i, stop), fail), fail));
      i = stop;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const stop = text.indexOf('?>', i + 2);
      if (stop < 0) fail('a processing instruction is not terminated');
      i = stop + 2;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      const stop = text.indexOf('-->', i + 4);
      if (stop < 0) fail('a comment is not terminated');
      i = stop + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const stop = text.indexOf(']]>', i + 9);
      if (stop < 0) fail('a CDATA section is not terminated');
      appendText(parsedText(text.slice(i + 9, stop), fail));
      i = stop + 3;
      continue;
    }
    if (text.startsWith('<!', i))
      fail('a document type or markup declaration, which workbooks never carry');
    if (text.startsWith('</', i)) {
      const stop = text.indexOf('>', i + 2);
      if (stop < 0) fail('a closing tag is not terminated');
      const name = text.slice(i + 2, stop).trim();
      const open = stack.pop();
      if (open?.name !== name) fail(`the closing tag </${name}> matches no open element`);
      i = stop + 1;
      continue;
    }
    i += 1;
    const nameStart = i;
    while (i < length && !endsName(text.charCodeAt(i))) i += 1;
    const name = text.slice(nameStart, i);
    if (name === '') fail('an element has no name');
    const attributes: Record<string, string> = {};
    let selfClosing = false;
    for (;;) {
      while (i < length && isSpace(text.charCodeAt(i))) i += 1;
      if (i >= length) fail(`the element <${name}> is not terminated`);
      const code = text.charCodeAt(i);
      if (code === CODE_GT) {
        i += 1;
        break;
      }
      if (code === CODE_SLASH) {
        if (text.charCodeAt(i + 1) !== CODE_GT) fail(`the element <${name}> is not terminated`);
        i += 2;
        selfClosing = true;
        break;
      }
      const attributeStart = i;
      while (i < length && !endsName(text.charCodeAt(i))) i += 1;
      const attribute = text.slice(attributeStart, i);
      if (attribute === '') fail(`an attribute of <${name}> has no name`);
      while (i < length && isSpace(text.charCodeAt(i))) i += 1;
      if (text.charCodeAt(i) !== CODE_EQUALS)
        fail(`the attribute ${attribute} of <${name}> has no value`);
      i += 1;
      while (i < length && isSpace(text.charCodeAt(i))) i += 1;
      const quote = text.charCodeAt(i);
      if (quote !== CODE_QUOTE && quote !== CODE_APOS) {
        fail(`the attribute ${attribute} of <${name}> has no quoted value`);
      }
      i += 1;
      const valueEnd = text.indexOf(String.fromCharCode(quote), i);
      if (valueEnd < 0) fail(`the attribute ${attribute} of <${name}> is not terminated`);
      const raw = text.slice(i, valueEnd);
      if (raw.includes('<')) fail(`the attribute ${attribute} of <${name}> holds a "<"`);
      if (attribute in attributes) fail(`the element <${name}> repeats the attribute ${attribute}`);
      attributes[attribute] = decodeEntities(parsedText(raw, fail), fail);
      i = valueEnd + 1;
    }
    if (stack.length + 1 > maxDepth) {
      throw new WorkbookError(`${part} nests elements deeper than ${maxDepth} levels`, 'too_large');
    }
    countNode();
    const element: XmlElement = { name, attributes, children: [] };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else if (root) fail('more than one root element');
    else root = element;
    if (!selfClosing) stack.push(element);
  }
  if (stack.length > 0)
    fail(`the element <${stack[stack.length - 1]?.name ?? ''}> is never closed`);
  return root ?? fail('no root element');
}

/** The part of a name after its prefix: `r:id` gives `id`, `sheet` gives `sheet`. */
export function localName(qualified: string): string {
  const colon = qualified.lastIndexOf(':');
  return colon < 0 ? qualified : qualified.slice(colon + 1);
}

export function isElement(node: XmlNode): node is XmlElement {
  return typeof node !== 'string';
}

/** The child elements whose local name matches, in document order. */
export function childElements(element: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of element.children) {
    if (isElement(child) && localName(child.name) === name) out.push(child);
  }
  return out;
}

export function firstChild(element: XmlElement, name: string): XmlElement | null {
  for (const child of element.children) {
    if (isElement(child) && localName(child.name) === name) return child;
  }
  return null;
}

/** The text directly inside an element (text and CDATA children joined), ignoring child elements. */
export function textOf(element: XmlElement): string {
  let out = '';
  for (const child of element.children) if (!isElement(child)) out += child;
  return out;
}

/** An attribute by local name; an unprefixed attribute wins over a prefixed one of the same name. */
export function attribute(element: XmlElement, name: string): string | undefined {
  const exact = element.attributes[name];
  if (exact !== undefined) return exact;
  for (const [key, value] of Object.entries(element.attributes)) {
    if (localName(key) === name) return value;
  }
  return undefined;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** Escapes text for an element body. */
export function escapeText(text: string): string {
  return text.replace(/[&<>]/g, (c) => ESCAPES[c] ?? c);
}

/** Escapes text for a double-quoted attribute value. */
export function escapeAttribute(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ESCAPES[c] ?? c);
}
