import { describe, expect, it } from 'vitest';
import { encodeUtf8 } from './bytes.js';
import { CMap, identityCMap, parseCMap } from './cmap.js';
import { PdfError } from './errors.js';

const parse = (text: string): CMap => parseCMap(encodeUtf8(text), 16);

const TO_UNICODE = `
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /Adobe-Identity-UCS def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
2 beginbfchar
<0003> <0020>
<0024> <0041>
endbfchar
3 beginbfrange
<0025> <0027> <0042>
<0030> <0032> [<0061> <0062> <00630064>]
<0040> <0040> <D83DDE00>
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;

describe('parseCMap', () => {
  it('reads codespace ranges, bfchar and both forms of bfrange', () => {
    const map = parse(TO_UNICODE);
    expect(map.codespace).toEqual([{ bytes: 2, low: 0, high: 0xffff }]);
    expect(map.hasText).toBe(true);
    expect(map.text({ code: 3, length: 2 })).toBe(' ');
    expect(map.text({ code: 0x24, length: 2 })).toBe('A');
    expect(map.text({ code: 0x25, length: 2 })).toBe('B');
    expect(map.text({ code: 0x27, length: 2 })).toBe('D');
    expect(map.text({ code: 0x28, length: 2 })).toBeNull();
    expect(map.text({ code: 0x30, length: 2 })).toBe('a');
    expect(map.text({ code: 0x32, length: 2 })).toBe('cd');
    expect(map.text({ code: 0x40, length: 2 })).toBe('\u{1f600}');
    expect(map.text({ code: 0x24, length: 1 })).toBeNull();
  });

  it('splits strings by the codespace ranges, mixed byte lengths included', () => {
    const map = parse(`2 begincodespacerange <00> <80> <8140> <9ffc> endcodespacerange`);
    expect(map.split(new Uint8Array([0x41, 0x81, 0x40, 0x20]))).toEqual([
      { code: 0x41, length: 1 },
      { code: 0x8140, length: 2 },
      { code: 0x20, length: 1 },
    ]);
    // A byte in no range: the shortest length is taken and the code comes back as it is.
    expect(map.split(new Uint8Array([0xf0, 0x41]))).toEqual([
      { code: 0xf0, length: 1 },
      { code: 0x41, length: 1 },
    ]);
    // A string that ends inside a two-byte code.
    expect(map.split(new Uint8Array([0x81]))).toEqual([{ code: 0x81, length: 1 }]);
  });

  it('takes byte lengths from the mappings when there is no codespace range', () => {
    const two = parse('1 beginbfchar <0041> <0061> endbfchar');
    expect(two.split(new Uint8Array([0, 0x41, 0, 0x42]))).toEqual([
      { code: 0x41, length: 2 },
      { code: 0x42, length: 2 },
    ]);
    const one = parse('1 beginbfrange <41> <43> <61> endbfrange');
    expect(one.split(new Uint8Array([0x41, 0x43]))).toEqual([
      { code: 0x41, length: 1 },
      { code: 0x43, length: 1 },
    ]);
    expect(one.text({ code: 0x43, length: 1 })).toBe('c');
    expect(parse('').split(new Uint8Array([1, 2]))).toEqual([
      { code: 1, length: 1 },
      { code: 2, length: 1 },
    ]);
  });

  it('reads destinations given as names, numbers and odd byte strings', () => {
    const map = parse('3 beginbfchar <01> /eacute <02> 66 <03> <41> endbfchar');
    expect(map.text({ code: 1, length: 1 })).toBe('é');
    expect(map.text({ code: 2, length: 1 })).toBe('B');
    expect(map.text({ code: 3, length: 1 })).toBe('A');
    const unknown = parse('1 beginbfchar <01> /g123 endbfchar');
    expect(unknown.text({ code: 1, length: 1 })).toBeNull();
    expect(unknown.hasText).toBe(false);
  });

  it('reads cidchar and cidrange and the Identity usecmap', () => {
    const map = parse(`
      /Identity-H usecmap
      1 begincidchar <0005> 7 endcidchar
      1 begincidrange <0010> <0012> 100 endcidrange`);
    expect(map.identity).toBe(true);
    expect(map.cid({ code: 0x1234, length: 2 })).toBe(0x1234);
    const plain = parse(`
      1 begincodespacerange <0000> <ffff> endcodespacerange
      1 begincidchar <0005> 7 endcidchar
      1 begincidrange <0010> <0012> 100 endcidrange`);
    expect(plain.identity).toBe(false);
    expect(plain.cid({ code: 5, length: 2 })).toBe(7);
    expect(plain.cid({ code: 0x11, length: 2 })).toBe(101);
    expect(plain.cid({ code: 0x20, length: 2 })).toBeNull();
    expect(plain.hasText).toBe(false);
  });

  it('skips malformed entries and ignores other operators', () => {
    const map = parse(`
      /Foo 1 def
      3 beginbfchar <01> <61> (not hex) <62> <02> endbfchar
      2 beginbfrange <03> <02> <61> <0000000000> <01> <61> endbfrange
      1 beginbfrange <05> <06> [<61>] endbfrange
      1 begincidchar (x) 5 endcidchar`);
    expect(map.text({ code: 1, length: 1 })).toBe('a');
    expect(map.text({ code: 3, length: 1 })).toBeNull();
    expect(map.text({ code: 5, length: 1 })).toBe('a');
    expect(map.text({ code: 6, length: 1 })).toBeNull();
  });

  it('refuses a section that never ends', () => {
    try {
      parse('1 beginbfchar <01> <61>');
    } catch (error) {
      expect(error).toBeInstanceOf(PdfError);
      expect((error as PdfError).code).toBe('corrupt');
      return;
    }
    throw new Error('expected a refusal');
  });

  it('refuses more mappings than the reader accepts', () => {
    const map = new CMap();
    for (let i = 0; i < 65_536 * 4; i += 1) map.addCid(i, i);
    expect(() => map.addCid(1, 1)).toThrow(PdfError);
  });

  it('keeps the first of overlapping ranges, singles winning over any range', () => {
    const map = new CMap();
    map.addRange(1, 0, 100, 'a');
    map.addRange(1, 50, 60, 'X');
    map.addRange(1, 90, 120, 'Y');
    map.addSingle(1, 55, 'single');
    // The wider earlier range covers 55 and 95; the later ones only reach past it.
    expect(map.text({ code: 54, length: 1 })).toBe(String.fromCharCode(97 + 54));
    expect(map.text({ code: 55, length: 1 })).toBe('single');
    expect(map.text({ code: 95, length: 1 })).toBe(String.fromCharCode(97 + 95));
    expect(map.text({ code: 100, length: 1 })).toBe(String.fromCharCode(97 + 100));
    expect(map.text({ code: 101, length: 1 })).toBe(String.fromCharCode(89 + 11));
    expect(map.text({ code: 120, length: 1 })).toBe(String.fromCharCode(89 + 30));
    expect(map.text({ code: 121, length: 1 })).toBeNull();
    expect(map.text({ code: 50, length: 2 })).toBeNull();
    // A narrow range added first keeps its codes when a wider one arrives later.
    const narrowFirst = new CMap();
    narrowFirst.addRange(1, 50, 60, 'X');
    narrowFirst.addRange(1, 0, 100, 'a');
    expect(narrowFirst.text({ code: 49, length: 1 })).toBe(String.fromCharCode(97 + 49));
    expect(narrowFirst.text({ code: 55, length: 1 })).toBe(String.fromCharCode(88 + 5));
    expect(narrowFirst.text({ code: 61, length: 1 })).toBe(String.fromCharCode(97 + 61));
    // A range added after a lookup is seen by the next one.
    narrowFirst.addRange(1, 200, 200, 'z');
    expect(narrowFirst.text({ code: 200, length: 1 })).toBe('z');
    const cids = new CMap();
    cids.addCidRange(10, 20, 100);
    cids.addCidRange(15, 30, 500);
    expect(cids.cid({ code: 17, length: 2 })).toBe(107);
    expect(cids.cid({ code: 25, length: 2 })).toBe(510);
    expect(cids.cid({ code: 31, length: 2 })).toBeNull();
    const spaces = new CMap();
    spaces.addCodespace(1, 0x20, 0x7e);
    spaces.addCodespace(2, 0x8140, 0x9ffc);
    spaces.addCodespace(2, 0x9000, 0xa000);
    expect(spaces.split(new Uint8Array([0x20, 0x9f, 0xfd, 0x7e]))).toEqual([
      { code: 0x20, length: 1 },
      { code: 0x9ffd, length: 2 },
      { code: 0x7e, length: 1 },
    ]);
  });

  it('looks codes up in logarithmic time over tens of thousands of ranges (PDF-5)', () => {
    const ranges = 50_000;
    const codes = 200_000;
    const map = new CMap();
    for (let i = 0; i < ranges; i += 1) map.addRange(2, 0x100 + i, 0x100 + i, 'A');
    let started = performance.now();
    let misses = 0;
    for (let n = 0; n < codes; n += 1) if (map.text({ code: 0, length: 2 }) === null) misses += 1;
    expect(misses).toBe(codes);
    expect(map.text({ code: 0x100 + ranges - 1, length: 2 })).toBe('A');
    expect(performance.now() - started).toBeLessThan(1000);

    const cids = new CMap();
    for (let i = 0; i < ranges; i += 1) cids.addCidRange(0x100 + i, 0x100 + i, i);
    started = performance.now();
    misses = 0;
    for (let n = 0; n < codes; n += 1) if (cids.cid({ code: 0, length: 2 }) === null) misses += 1;
    expect(misses).toBe(codes);
    expect(cids.cid({ code: 0x100 + ranges - 1, length: 2 })).toBe(ranges - 1);
    expect(performance.now() - started).toBeLessThan(1000);

    const spaces = new CMap();
    for (let i = 0; i < ranges; i += 1) spaces.addCodespace(2, 0x100 + i, 0x100 + i);
    const text = new Uint8Array(codes);
    started = performance.now();
    // Every two-byte code 0x0000 is outside every range, so each position tries every length.
    expect(spaces.split(text)).toHaveLength(codes / 2);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('advances the last code unit of a range destination and keeps overflow put', () => {
    const map = new CMap();
    map.addRange(1, 1, 3, 'ab');
    expect(map.text({ code: 3, length: 1 })).toBe('ad');
    map.addRange(1, 10, 12, '￿');
    expect(map.text({ code: 11, length: 1 })).toBe('￿');
    map.addRange(1, 20, 21, '');
    expect(map.text({ code: 21, length: 1 })).toBe('');
  });
});

describe('identityCMap', () => {
  it('maps two-byte codes to the same CID and has no text', () => {
    const map = identityCMap();
    expect(map.identity).toBe(true);
    expect(map.split(new Uint8Array([0, 5, 1, 0]))).toEqual([
      { code: 5, length: 2 },
      { code: 256, length: 2 },
    ]);
    expect(map.cid({ code: 256, length: 2 })).toBe(256);
    expect(map.text({ code: 256, length: 2 })).toBeNull();
  });
});
