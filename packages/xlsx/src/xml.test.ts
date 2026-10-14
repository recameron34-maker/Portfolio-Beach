import { describe, expect, it } from 'vitest';
import { WorkbookError } from './errors.js';
import {
  attribute,
  childElements,
  decodeEntities,
  escapeAttribute,
  escapeText,
  firstChild,
  localName,
  parseXml,
  textOf,
} from './xml.js';

const parse = (text: string, maxDepth = 16, maxNodes = 1024) =>
  parseXml(text, { maxDepth, maxNodes, part: 'part.xml' });

function refusal(run: () => unknown): WorkbookError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkbookError);
    return error as WorkbookError;
  }
  throw new Error('expected a WorkbookError');
}

describe('parseXml', () => {
  it('reads elements, attributes, text, CDATA, and skips the declaration, comments and instructions', () => {
    const root = parse(
      '<?xml version="1.0" encoding="UTF-8"?>\n<a x="1" y=\'2&amp;3\'><!-- note --><b>t&lt;u</b>' +
        '<![CDATA[<raw>&amp;]]><?pi target?><c/><d  k = "v" /></a>\n',
    );
    expect(root.name).toBe('a');
    expect(root.attributes).toEqual({ x: '1', y: '2&3' });
    expect(childElements(root, 'b').map(textOf)).toEqual(['t<u']);
    expect(textOf(root)).toBe('<raw>&amp;');
    expect(firstChild(root, 'c')?.children).toEqual([]);
    expect(firstChild(root, 'd')?.attributes).toEqual({ k: 'v' });
    expect(firstChild(root, 'zz')).toBeNull();
  });

  it('decodes the five entities and numeric references', () => {
    const fail = (what: string): never => {
      throw new Error(what);
    };
    expect(decodeEntities('&lt;&gt;&amp;&quot;&apos;&#65;&#x42;&#x1F600;', fail)).toBe(
      '<>&"\'AB\u{1F600}',
    );
    expect(decodeEntities('plain', fail)).toBe('plain');
  });

  it('keeps prefixes on names and matches by local name', () => {
    const root = parse('<x:a xmlns:x="u" r:id="rId1" id="plain"><x:b/></x:a>');
    expect(root.name).toBe('x:a');
    expect(localName(root.name)).toBe('a');
    expect(childElements(root, 'b')).toHaveLength(1);
    expect(attribute(root, 'id')).toBe('plain');
    expect(attribute(parse('<s r:id="rId2"/>'), 'id')).toBe('rId2');
    expect(attribute(root, 'missing')).toBeUndefined();
  });

  it('refuses a document type declaration', () => {
    const error = refusal(() => parse('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'));
    expect(error.code).toBe('malformed');
    expect(error.message).toBe(
      'part.xml is not well-formed XML: a document type or markup declaration, which workbooks never carry',
    );
  });

  it('refuses entities it does not know, bad character references and unterminated ones', () => {
    expect(refusal(() => parse('<a>&nbsp;</a>')).message).toContain(
      '&nbsp; is not one XML defines',
    );
    expect(refusal(() => parse('<a>&#1;</a>')).message).toContain('outside what XML allows');
    expect(refusal(() => parse('<a>&#xD800;</a>')).message).toContain('outside what XML allows');
    expect(refusal(() => parse('<a>a &amp b</a>')).message).toContain('not terminated');
    expect(refusal(() => parse('<a>&;</a>')).code).toBe('malformed');
  });

  it('refuses mismatched, unclosed and unterminated markup, and text outside the root', () => {
    expect(refusal(() => parse('<a></b>')).message).toContain('</b> matches no open element');
    expect(refusal(() => parse('<a>')).message).toContain('<a> is never closed');
    expect(refusal(() => parse('<a')).message).toContain('<a> is not terminated');
    expect(refusal(() => parse('<a x=1/>')).message).toContain('no quoted value');
    expect(refusal(() => parse('<a x="1/>')).message).toContain('is not terminated');
    expect(refusal(() => parse('<a x/>')).message).toContain('has no value');
    expect(refusal(() => parse('<a x="<"/>')).message).toContain('holds a "<"');
    expect(refusal(() => parse('<a x="1" x="2"/>')).message).toContain('repeats the attribute x');
    expect(refusal(() => parse('<a/><b/>')).message).toContain('more than one root element');
    expect(refusal(() => parse('x<a/>')).message).toContain('text outside the root element');
    expect(refusal(() => parse('')).message).toContain('no root element');
    expect(refusal(() => parse('<!-- open')).message).toContain('a comment is not terminated');
    expect(refusal(() => parse('<?pi')).message).toContain(
      'processing instruction is not terminated',
    );
    expect(refusal(() => parse('<a><![CDATA[x</a>')).message).toContain(
      'CDATA section is not terminated',
    );
    expect(refusal(() => parse('<></>')).message).toContain('an element has no name');
    expect(refusal(() => parse('<a <b/>')).code).toBe('malformed');
  });

  it('caps nesting depth so a hostile part cannot run the parser deep', () => {
    expect(parse('<a><b><c><d/></c></b></a>', 4).name).toBe('a');
    const error = refusal(() => parse('<a><b><c><d/></c></b></a>', 3));
    expect(error.code).toBe('too_large');
    expect(error.message).toBe('part.xml nests elements deeper than 3 levels');
    expect(parse('<a><b/><b/><b/><b/><b/></a>', 2).children).toHaveLength(5);
  });

  it('caps the number of elements and text nodes so a hostile part is refused before its tree exists', () => {
    expect(parse('<a><b/><b/><b/></a>', 16, 4).children).toHaveLength(3);
    const elements = refusal(() => parse('<a><b/><b/><b/><b/></a>', 16, 4));
    expect(elements.code).toBe('too_large');
    expect(elements.message).toBe('part.xml holds more than 4 elements and text nodes');
    expect(textOf(parse('<a>x<b/>y</a>', 16, 4))).toBe('xy');
    expect(refusal(() => parse('<a>x<b/>y</a>', 16, 3)).code).toBe('too_large');
    expect(refusal(() => parse('<a><![CDATA[x]]><![CDATA[y]]></a>', 16, 2)).code).toBe('too_large');
    // The tail is not well-formed: reaching it would refuse the part as malformed instead, so a
    // too_large refusal proves the parser stopped at the budget, long before the end.
    const hostile = `<a>${'<b>t</b>'.repeat(1000)}<never-closed`;
    const early = refusal(() => parse(hostile, 16, 100));
    expect(early.code).toBe('too_large');
    expect(refusal(() => parse(hostile, 16, 10_000)).code).toBe('malformed');
  });

  it('refuses characters XML does not allow in text, CDATA and attributes', () => {
    const message = 'part.xml is not well-formed XML: a character XML does not allow';
    for (const bad of [
      '\u0000',
      '\u0001',
      '\u000b',
      '\u001f',
      '\ufffe',
      '\uffff',
      '\ud800',
      '\udc00',
    ]) {
      const label = JSON.stringify(bad);
      expect(refusal(() => parse(`<a>x${bad}y</a>`)).message, label).toBe(message);
      expect(refusal(() => parse(`<a><![CDATA[${bad}]]></a>`)).message, label).toBe(message);
      expect(refusal(() => parse(`<a x="${bad}"/>`)).message, label).toBe(message);
      expect(refusal(() => parse(`<a x='${bad}'/>`)).code, label).toBe('malformed');
    }
    expect(textOf(parse('<a>tab\tfeed\n\u{1F600}\u007f�</a>'))).toBe('tab\tfeed\n\u{1F600}\u007f�');
    expect(parse('<a x="\t\u{1F600}"/>').attributes).toEqual({ x: '\t\u{1F600}' });
  });

  it('folds CRLF and a lone CR into LF in parsed text, but keeps a CR given as a character reference', () => {
    expect(textOf(parse('<a>one\r\ntwo\rthree\n\r\r\n</a>'))).toBe('one\ntwo\nthree\n\n\n');
    expect(textOf(parse('<a><![CDATA[a\r\nb\rc]]></a>'))).toBe('a\nb\nc');
    expect(parse('<a x="1\r\n2\r3"/>').attributes).toEqual({ x: '1\n2\n3' });
    expect(textOf(parse('<a>x&#13;y&#xD;&#10;z</a>'))).toBe('x\ry\r\nz');
    expect(parse('<a x="&#13;"/>').attributes).toEqual({ x: '\r' });
    expect(parse('<a>\r\n</a>\r\n').children).toEqual(['\n']);
  });

  it('escapes text and attribute values', () => {
    expect(escapeText('a < b & c > "d"')).toBe('a &lt; b &amp; c &gt; "d"');
    expect(escapeAttribute('a < b & "d"')).toBe('a &lt; b &amp; &quot;d&quot;');
  });
});
