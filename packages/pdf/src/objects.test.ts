import { describe, expect, it } from 'vitest';
import { latin1Bytes } from './bytes.js';
import { PdfError } from './errors.js';
import {
  Lexer,
  Parser,
  dictOf,
  isArray,
  isDict,
  isName,
  isOperator,
  isRef,
  isStream,
  isString,
  parseNumber,
  readObjectHeader,
  type PdfObject,
  type Token,
} from './objects.js';

const tokens = (text: string): Token[] => {
  const lexer = new Lexer(latin1Bytes(text));
  const out: Token[] = [];
  for (;;) {
    const token = lexer.next();
    out.push(token);
    if (token.kind === 'eof') return out;
  }
};

const parse = (text: string, allowRefs = true): PdfObject | undefined =>
  new Parser(latin1Bytes(text), { maxDepth: 64, allowRefs }).parse();

function refusal(run: () => unknown): PdfError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PdfError);
    return error as PdfError;
  }
  throw new Error('expected a PdfError');
}

describe('parseNumber', () => {
  it('reads integers and reals in every form the syntax allows', () => {
    expect(parseNumber('42')).toBe(42);
    expect(parseNumber('-17')).toBe(-17);
    expect(parseNumber('+3')).toBe(3);
    expect(parseNumber('34.5')).toBe(34.5);
    expect(parseNumber('-.002')).toBe(-0.002);
    expect(parseNumber('4.')).toBe(4);
    expect(parseNumber('.5')).toBe(0.5);
  });

  it('reads the loose forms some writers emit, as far as they make sense', () => {
    expect(parseNumber('--5')).toBe(-5);
    expect(parseNumber('3.4.5')).toBe(3.4);
  });

  it('refuses text that is not a number', () => {
    expect(refusal(() => parseNumber('abc')).code).toBe('corrupt');
  });
});

describe('Lexer', () => {
  it('tokenizes numbers, names, strings, delimiters and keywords, skipping comments', () => {
    const out = tokens('  12 -3.5 /Name /A#20B (hi) <414243> << >> [ ] { } obj % comment\nR');
    expect(out).toEqual([
      { kind: 'number', value: 12 },
      { kind: 'number', value: -3.5 },
      { kind: 'name', name: 'Name' },
      { kind: 'name', name: 'A B' },
      { kind: 'string', bytes: latin1Bytes('hi') },
      { kind: 'string', bytes: latin1Bytes('ABC') },
      { kind: 'delimiter', value: '<<' },
      { kind: 'delimiter', value: '>>' },
      { kind: 'delimiter', value: '[' },
      { kind: 'delimiter', value: ']' },
      { kind: 'delimiter', value: '{' },
      { kind: 'delimiter', value: '}' },
      { kind: 'keyword', value: 'obj' },
      { kind: 'keyword', value: 'R' },
      { kind: 'eof' },
    ]);
  });

  it('reads literal string escapes, nested parentheses and line ends', () => {
    const [token] = tokens('(a\\n\\r\\t\\b\\f\\(\\)\\\\ \\101\\12\\7 (nested) \\\r\nx\r\ny\rz)');
    expect(token?.kind).toBe('string');
    if (token?.kind !== 'string') return;
    expect(Array.from(token.bytes)).toEqual([
      ...Array.from(latin1Bytes('a\n\r\t\b\f()\\ A\n\u0007 (nested) ')),
      ...Array.from(latin1Bytes('x\ny\nz')),
    ]);
  });

  it('reads a hexadecimal string with white space and an odd final digit', () => {
    const [token] = tokens('<41 4\n2 4>');
    expect(token).toEqual({ kind: 'string', bytes: new Uint8Array([0x41, 0x42, 0x40]) });
  });

  it('refuses a hexadecimal string with a digit that is not hexadecimal', () => {
    expect(refusal(() => tokens('<4G>')).code).toBe('corrupt');
  });

  it('refuses strings that never close', () => {
    expect(refusal(() => tokens('(open')).code).toBe('corrupt');
    expect(refusal(() => tokens('<41')).code).toBe('corrupt');
  });

  it('keeps a bad name escape literal and reads a lone sign as zero', () => {
    expect(tokens('/A#ZZ')[0]).toEqual({ kind: 'name', name: 'A#ZZ' });
    expect(tokens('-')[0]).toEqual({ kind: 'number', value: 0 });
    expect(tokens('12abc')[0]).toEqual({ kind: 'keyword', value: '12abc' });
  });

  it('skips stray closing delimiters', () => {
    expect(tokens(') > 1')).toEqual([{ kind: 'number', value: 1 }, { kind: 'eof' }]);
  });

  it('skips a long run of stray closing delimiters without recursing (PDF-3)', () => {
    const one = [{ kind: 'number', value: 1 }, { kind: 'eof' }];
    expect(tokens(`${')'.repeat(100_000)} 1`)).toEqual(one);
    expect(tokens(`${'> '.repeat(50_000)}1`)).toEqual(one);
    expect(tokens(`${')>'.repeat(50_000)} 1`)).toEqual(one);
    // A lone ">" before ">>" is skipped and the pair still closes a dictionary.
    expect(tokens('> >>')).toEqual([{ kind: 'delimiter', value: '>>' }, { kind: 'eof' }]);
  });

  it('peeks without moving', () => {
    const lexer = new Lexer(latin1Bytes('1 2'));
    expect(lexer.peek()).toEqual({ kind: 'number', value: 1 });
    expect(lexer.next()).toEqual({ kind: 'number', value: 1 });
    expect(lexer.next()).toEqual({ kind: 'number', value: 2 });
    expect(lexer.next()).toEqual({ kind: 'eof' });
  });
});

describe('Parser', () => {
  it('parses scalars, references, arrays and dictionaries', () => {
    expect(parse('true')).toBe(true);
    expect(parse('false')).toBe(false);
    expect(parse('null')).toBe(null);
    expect(parse('3.25')).toBe(3.25);
    expect(parse('/Type')).toEqual({ kind: 'name', name: 'Type' });
    expect(parse('12 0 R')).toEqual({ kind: 'ref', num: 12, gen: 0 });
    expect(parse('12 0')).toBe(12);
    expect(parse('1.5 0 R')).toBe(1.5);
    const arr = parse('[1 (a) /b 2 0 R [3]]');
    expect(isArray(arr) && arr.items.length).toBe(5);
    const d = parse('<< /A 1 /B [1 2] /C << /D (x) >> /E 4 0 R >>');
    expect(isDict(d)).toBe(true);
    if (!isDict(d)) return;
    expect(d.map.get('A')).toBe(1);
    expect(isArray(d.map.get('B') ?? null)).toBe(true);
    expect(isDict(d.map.get('C') ?? null)).toBe(true);
    expect(isRef(d.map.get('E') ?? null)).toBe(true);
    expect(dictOf(d)).toBe(d);
    expect(dictOf(1)).toBeNull();
  });

  it('parses a stream by its /Length and keeps the raw bytes', () => {
    const s = parse('<< /Length 5 >>\r\nstream\r\nhello\r\nendstream');
    expect(isStream(s)).toBe(true);
    if (!isStream(s)) return;
    expect(latin1Bytes('hello')).toEqual(s.raw);
    expect(dictOf(s)).toBe(s.dict);
  });

  it('finds the end of a stream whose /Length is wrong, missing or an unresolved reference', () => {
    for (const header of ['/Length 99', '', '/Length 7 0 R', '/Length 2']) {
      const s = parse(`<< ${header} >>\nstream\nhello\nendstream`);
      expect(isStream(s) && latin1Bytes('hello')).toEqual(isStream(s) ? s.raw : null);
    }
  });

  it('resolves an indirect /Length through the callback', () => {
    const parser = new Parser(latin1Bytes('<< /Length 9 0 R >>\nstream\nhello\nendstream'), {
      maxDepth: 4,
      allowRefs: true,
      resolveLength: (r) => (r.num === 9 ? 5 : null),
    });
    const s = parser.parse();
    expect(isStream(s) && Array.from(s.raw)).toEqual(Array.from(latin1Bytes('hello')));
  });

  it('refuses a stream with no endstream', () => {
    expect(refusal(() => parse('<< >>\nstream\nhello')).code).toBe('corrupt');
  });

  it('refuses nesting past the depth limit', () => {
    const deep = '['.repeat(70) + ']'.repeat(70);
    expect(refusal(() => parse(deep)).code).toBe('too_large');
    expect(isArray(parse('['.repeat(60) + ']'.repeat(60)) ?? null)).toBe(true);
  });

  it('refuses unclosed arrays and dictionaries, bad keys and stray keywords in file mode', () => {
    expect(refusal(() => parse('[1 2')).code).toBe('corrupt');
    expect(refusal(() => parse('<< /A 1')).code).toBe('corrupt');
    expect(refusal(() => parse('<< 1 2 >>')).code).toBe('corrupt');
    expect(refusal(() => parse('endobj')).code).toBe('corrupt');
    expect(refusal(() => parse('>>')).code).toBe('corrupt');
  });

  it('closes a damaged array at the end of its dictionary', () => {
    const d = parse('<< /A [1 2 >>');
    expect(isDict(d) && isArray(d.map.get('A') ?? null)).toBe(true);
  });

  it('reads a key with no value as null', () => {
    const d = parse('<< /A >>');
    expect(isDict(d) && d.map.get('A')).toBeNull();
  });

  it('returns operators in content mode and never references', () => {
    const parser = new Parser(latin1Bytes('BT 1 0 R /F1 12 Tf [(a) -20 (b)] TJ ET }'), {
      maxDepth: 8,
      allowRefs: false,
    });
    const out: PdfObject[] = [];
    for (let o = parser.parse(); o !== undefined; o = parser.parse()) out.push(o);
    expect(out.map((o) => (isOperator(o) ? o.op : typeof o))).toEqual([
      'BT',
      'number',
      'number',
      'R',
      'object',
      'number',
      'Tf',
      'object',
      'TJ',
      'ET',
      '}',
    ]);
    expect(isName(out[4] ?? null, 'F1')).toBe(true);
    expect(isString((out[7] as { items: PdfObject[] }).items[0] ?? null)).toBe(true);
  });

  it('skips loose values inside a content-mode dictionary', () => {
    const d = parse('<< /A 1 2 /B 3 >>', false);
    expect(isDict(d) && d.map.get('B')).toBe(3);
  });

  it('returns undefined at the end of input', () => {
    expect(parse('')).toBeUndefined();
    expect(parse('  % only a comment')).toBeUndefined();
  });
});

describe('readObjectHeader', () => {
  it('reads "num gen obj" and rejects anything else', () => {
    expect(readObjectHeader(latin1Bytes('12 0 obj <<>>'), 0)).toEqual({
      num: 12,
      gen: 0,
      after: 8,
    });
    expect(readObjectHeader(latin1Bytes('12 0 R'), 0)).toBeNull();
    expect(readObjectHeader(latin1Bytes('x 0 obj'), 0)).toBeNull();
    expect(readObjectHeader(latin1Bytes('12 x obj'), 0)).toBeNull();
    expect(readObjectHeader(latin1Bytes('-1 0 obj'), 0)).toBeNull();
  });
});
