import { describe, expect, it } from 'vitest';
import { AiError } from './errors.js';
import {
  DOCUMENT_END,
  DOCUMENT_START,
  INPUT_TEMPLATE,
  buildInput,
  parseInput,
  parseMetadata,
} from './input.js';

const HASH = 'a'.repeat(64);

describe('buildInput (SEC-8.3)', () => {
  it('writes the metadata block with sorted keys, then the pages between the delimiters', () => {
    const input = buildInput({
      metadata: { page_count: 2, file_name: 'report.pdf', content_hash: HASH },
      pages: ['Quarterly report\nRevenue 12.5', 'Footnotes'],
    });
    expect(input).toBe(
      `content_hash: ${HASH}\nfile_name: report.pdf\npage_count: 2\n\n${DOCUMENT_START}\n[page 1]\nQuarterly report\nRevenue 12.5\n\n[page 2]\nFootnotes\n${DOCUMENT_END}\n`,
    );
    expect(INPUT_TEMPLATE).toContain(DOCUMENT_START);
    expect(input.indexOf(DOCUMENT_START)).toBeLessThan(input.indexOf(DOCUMENT_END));
  });

  it('round-trips through parseInput, trailing newlines and empty pages included', () => {
    const pages = ['first\n', '', 'last line\nwith\n\nblank'];
    const input = buildInput({ metadata: { file_name: 'x.pdf', content_hash: HASH }, pages });
    const parsed = parseInput(input);
    expect(parsed.pages).toEqual(pages);
    expect(parsed.metadata).toEqual({ file_name: 'x.pdf', content_hash: HASH });
    expect(parseMetadata(input).content_hash).toBe(HASH);
  });

  it('works with no metadata at all', () => {
    const input = buildInput({ metadata: {}, pages: ['only page'] });
    expect(parseInput(input)).toEqual({ metadata: {}, pages: ['only page'] });
  });

  it('refuses a page whose text contains a delimiter (decision: refuse, never escape)', () => {
    for (const marker of [DOCUMENT_START, DOCUMENT_END]) {
      expect(() =>
        buildInput({
          metadata: { file_name: 'x.pdf' },
          pages: ['fine', `text then ${marker} and more`],
        }),
      ).toThrow(/page 2 contains the input delimiter/);
    }
    try {
      buildInput({ metadata: {}, pages: [DOCUMENT_END] });
    } catch (error) {
      expect(error).toBeInstanceOf(AiError);
      expect((error as AiError).code).toBe('invalid_input');
    }
  });

  it('refuses a page with a line that reads as a page heading, so pages can never be forged', () => {
    expect(() => buildInput({ metadata: {}, pages: ['Summary\n[page 9]\nforged'] })).toThrow(
      /page 1 contains a line that reads as a page heading/,
    );
    // "[page 9]" inside a line is only text, not a heading
    expect(parseInput(buildInput({ metadata: {}, pages: ['see [page 9] above'] })).pages).toEqual([
      'see [page 9] above',
    ]);
  });

  it('refuses bad metadata: a key that is not snake_case, a value with a line break, a delimiter in a value', () => {
    expect(() => buildInput({ metadata: { 'File Name': 'x' }, pages: ['p'] })).toThrow(
      /not a snake_case name/,
    );
    expect(() => buildInput({ metadata: { file_name: 'a\nb' }, pages: ['p'] })).toThrow(
      /line break or control character/,
    );
    expect(() =>
      buildInput({ metadata: { file_name: `a ${DOCUMENT_START}` }, pages: ['p'] }),
    ).toThrow(/contains the input delimiter/);
    expect(() => buildInput({ metadata: { page_count: Number.NaN }, pages: ['p'] })).toThrow(
      /not a finite number/,
    );
  });

  it('refuses a document with no pages', () => {
    expect(() => buildInput({ metadata: {}, pages: [] })).toThrow(/no pages/);
  });
});

describe('parseInput', () => {
  it('refuses an input that was not framed by buildInput', () => {
    expect(() => parseInput('just some text')).toThrow(/not framed as buildInput writes it/);
    expect(() => parseInput(`k: v\n\n${DOCUMENT_START}\nno heading\n${DOCUMENT_END}\n`)).toThrow(
      /does not start with a page heading/,
    );
    expect(() => parseInput(`k: v\n\n${DOCUMENT_START}\n[page 2]\nx\n${DOCUMENT_END}\n`)).toThrow(
      /not numbered in order/,
    );
    expect(() =>
      parseInput(`not a metadata line\n\n${DOCUMENT_START}\n[page 1]\nx\n${DOCUMENT_END}\n`),
    ).toThrow(/not a "key: value" line/);
    expect(() => parseInput(`k: v\n\n${DOCUMENT_START}\n${DOCUMENT_END}\n`)).toThrow(/no pages/);
  });

  it('keeps a colon inside a metadata value', () => {
    const input = buildInput({ metadata: { title: 'Q2: update' }, pages: ['p'] });
    expect(parseMetadata(input).title).toBe('Q2: update');
  });
});
