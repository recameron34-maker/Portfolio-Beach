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
