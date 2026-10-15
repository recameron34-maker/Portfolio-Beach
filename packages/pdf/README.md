# @pb/pdf

A dependency-free PDF writer and reader for Portfolio Beach (decision 0012; docs/04 M3 and M4: the synthetic generator writes quarterly reports and notices, the document hub and the extraction worker read every document that enters the system, and the preview reads the same bytes in the browser). Pure TypeScript: the inflater is injected, the main entry imports no runtime module, and the package never reads the wall clock, uses randomness or parses a float (it is listed with the domain packages in the lint config).

## What it does

- `writePdf({ title?, author?, subject?, keywords?, creator?, producer?, creationDate?, pages })` writes a PDF 1.4 file from pages of items: `{ kind: 'text', x, y, size, font, text }`, `{ kind: 'line', x1, y1, x2, y2, width? }` and `{ kind: 'rect', x, y, w, h, fill? }`, each page `{ width = 612, height = 792, items }` in points with the origin at the lower-left corner. One uncompressed content stream per page; the standard 14 text faces referenced by name (`Helvetica`, `Helvetica-Bold`, `Helvetica-Oblique`, `Helvetica-BoldOblique`, `Times-Roman`, `Times-Bold`, `Times-Italic`, `Times-BoldItalic`, `Courier`, `Courier-Bold`, `Courier-Oblique`, `Courier-BoldOblique`), never embedded; text in WinAnsiEncoding, a character the encoding cannot carry refused with a message naming it; an information dictionary only from the values the caller gives (no producer, no clock: `creationDate` is a PDF date string such as `D:20260630120000Z` the caller supplies); a classic cross-reference table with offsets computed from the bytes as written. Output is deterministic: the same input gives the same bytes.
- `measureText(text, font, size)` gives the width in points of WinAnsi text set in a standard face, from the embedded Adobe font metrics: Helvetica, Helvetica-Bold and Courier (every Courier glyph 600 units) are included; the oblique faces share their upright widths, as the metrics files do; **the Times faces use the Helvetica tables of the same weight**, an approximation (Times is narrower, by about a tenth on running text) stated here so a generator laying out a Times table leaves room.
- `readPdf(bytes, { inflate, limits? })` reads a document into `{ version, pageCount, info, pages, reconstructed }`. `info` holds `title`, `author`, `subject`, `keywords`, `creator`, `producer`, `creationDate` and `modDate` as text where the file has them (dates as stored, never parsed). Each page is `{ number, width, height, rotate, runs, lines, text }`: `runs` are every string shown, in drawing order, as `{ x, y, width, size, font, text, undecodable? }` with `x` and `y` the start of the baseline in page units (the media box's lower-left corner at 0,0 and y up, as PDF has it, before the page's `/Rotate`, which is reported), `width` the advance along the baseline, `size` the font size as drawn (the text matrix and the current transformation applied) and `font` the base font name without its subset tag; `lines` group the runs by baseline (within 2 units of the line's top-most run), ordered top to bottom and each left to right, with a space between two runs whose gap exceeds a third of the larger font size; `text` is the lines joined by newlines. A run whose font cannot decode one of its codes comes back with `undecodable: true` and empty text, never a guess. `reconstructed` is true when the cross-reference data was damaged and the file was indexed by the fallback scan (below), so a caller can log it.
- `PdfError` (with a `code`: `not_pdf`, `encrypted`, `unsupported`, `corrupt`, `too_large`, `invalid_input`) is the one error thrown. Messages are plain language for the documents page.

### What the reader handles

The file structure: the header (junk before it is skipped, offsets counting from the header), classic cross-reference tables with `/Prev` chains and hybrid `/XRefStm` files, cross-reference streams (`/W` widths, `/Index`, free and compressed entries), object streams, an indirect stream `/Length`, a stream whose `/Length` is wrong or missing (its end is found at `endstream`). Filters: FlateDecode through the injected inflater, with `/DecodeParms` predictors (TIFF predictor 2 at 8 bits per component, PNG predictors 10 to 15 at 1, 2, 4, 8 or 16 bits), ASCIIHexDecode, ASCII85Decode and RunLengthDecode, chained in any order. The page tree with inherited `Resources`, `MediaBox` and `Rotate` (a missing or damaged media box reads as US letter; a node without `/Type` is taken by its `/Kids`; a node that points back at itself is visited once). Fonts: the standard 14 and embedded simple fonts (Type1, MMType1, TrueType, Type3) with StandardEncoding, WinAnsiEncoding, MacRomanEncoding and `/Differences` through the glyph list (`uniXXXX` and `uXXXX` names included), the standard encoding by default for a non-symbolic font, widths from `/Widths` and `/MissingWidth` or from the standard metrics by base font name (Arial, TimesNewRoman and CourierNew folded to their standard faces), Type3 widths through `/FontMatrix`; Type0 fonts through their ToUnicode CMap (`bfchar`, `bfrange` with a string or an array destination, codespace ranges for mixed byte lengths), `Identity-H` and `Identity-V` encodings and embedded encoding CMaps (`cidchar`, `cidrange`) for widths from `/W` and `/DW`. A ToUnicode map, when present, is consulted first for every font. Content: `BT`, `ET`, `Tf`, `Td`, `TD`, `Tm`, `T*`, `TL`, `Tc`, `Tw`, `Tz`, `Ts`, `Tj`, `TJ`, `'`, `"`, `q`, `Q`, `cm`, form XObjects (`Do`, with their `/Matrix` and `/Resources`, a form that draws itself entered once), inline images skipped by their `ID` to `EI` extent, every other operator skipped with its operands. Positions resolve through the current transformation matrix and the text matrix, and runs advance by the font's widths, character and word spacing, horizontal scaling and `TJ` adjustments, so a table's columns read back where they were set.

### What the reader does not do

Font programs (`FontFile` streams) are never opened, so a symbolic font with no `/Encoding` and no ToUnicode map is undecodable, as is Symbol or ZapfDingbats text without a ToUnicode map; predefined CMaps other than the Identity ones are not bundled (a Type0 font using one splits its codes by its ToUnicode map and takes the code as the CID for widths); vertical writing is read as horizontal; PDFDocEncoding specials in information strings come back as the Latin-1 character of the same byte; `/Rotate` is reported, not applied; images are never decoded (an image XObject is skipped whatever its filter); annotations, form fields, bookmarks, links and JavaScript are never read, so nothing in a document runs.

## What it refuses

The reader refuses, rather than guesses at, what it does not understand: bytes with no `%PDF-` header in the first kilobyte (`not_pdf`); an encrypted document, by its trailer's `/Encrypt` (`encrypted`); LZWDecode, a Crypt filter, an image filter (DCTDecode, JPXDecode, JBIG2Decode, CCITTFaxDecode) on a stream that is not an image, a filter it does not know, a TIFF predictor at other than 8 bits (`unsupported`); a document with no catalog or no page tree, a stream with no `endstream`, a string or container that never closes, a cross-reference stream whose widths or index do not match its data, an object stream whose header is damaged or does not hold the object the index says, a predicted stream with partial rows or an unknown row filter, a stream that will not inflate, an ASCII stream with a character outside its alphabet (`corrupt`); and anything past the read limits (`too_large`). The writer and the measurer refuse a character outside WinAnsiEncoding, a font that is not one of the twelve text faces, a size that is not positive, a number that is not finite, an empty page list and a date that is not a PDF date string (`invalid_input`).

**Damaged cross-reference data** is the one place the reader repairs rather than refuses, as every mainstream reader does: when `startxref` is missing or points at nothing, a table or stream does not parse, an object is not where its entry says, or no trailer names a catalog, the file is indexed by a linear scan for `N G obj` occurrences (the last occurrence of each number wins), `trailer` dictionaries (later keys win), the `/Root` of any cross-reference stream, or the first object of `/Type /Catalog`; objects inside object streams are registered where no direct object of that number exists. The document comes back with `reconstructed: true`. The fallback never applies to encryption, limits or unsupported features, which are refused outright.

The limits (`READ_LIMITS`) stop a hostile file from running the parser forever or filling memory; a caller passes its own from configuration (`config/definitions.json` `documents.maxPdfBytes` and `maxPages`):

| Limit                 | Default   | Guards                                                                                                                      |
| --------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `maxBytes`            | 20 MiB    | The file itself, checked before anything is parsed                                                                          |
| `maxObjects`          | 100,000   | Cross-reference entries, the trailer's `/Size`, objects found by the fallback scan, objects fetched                          |
| `maxPages`            | 500       | Leaves of the page tree                                                                                                     |
| `maxStreamBytes`      | 16 MiB    | One stream once decoded; the inflater is capped there too, so an inflater that can stop early (zlib) refuses before filling memory |
| `maxTotalStreamBytes` | 64 MiB    | Every stream one read decodes, summed                                                                                       |
| `maxOperators`        | 2,000,000 | Content stream operators across every page and form of one document                                                        |
| `maxDepth`            | 64        | Nesting of arrays and dictionaries, saved graphics states (`q`), the page tree, and forms inside forms                       |

A CMap may hold at most 262,144 mappings.

## Inflater

`readPdf` takes `inflate(data, maxOutputBytes)` for zlib-wrapped deflate streams (RFC 1950, what FlateDecode holds). It may be synchronous or return a promise.

Node (the API and the generator):

```ts
import { readPdf } from '@pb/pdf';
import { nodeInflate } from '@pb/pdf/node';

const document = await readPdf(bytes, { inflate: nodeInflate });
```

`nodeInflate` passes the stream limit to zlib as `maxOutputLength`, so a stream that inflates past it is refused (`too_large`) before it fills memory; any other zlib failure is `corrupt`.

Browser (the preview), with `DecompressionStream`:

```ts
const inflate = async (data: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};
```

The reader checks the inflated length against `maxStreamBytes` in any case, so an inflater that cannot stop early still ends in a refusal rather than an oversized page. The main entry (`@pb/pdf`) has no Node import, so a browser bundle never sees zlib; only `@pb/pdf/node` does.

## ISO 32000-1 coverage

The writer emits: the file structure of section 7.5 (header, body, classic cross-reference table, trailer), literal strings of 7.3.4.2, the document information dictionary of 14.3.3, the page tree of 7.7.3, the standard 14 Type1 fonts of 9.6.2.2 with WinAnsiEncoding (Annex D), the text operators of 9.4 (`BT`, `Tf`, `Td`, `Tj`, `ET`) and the path operators of 8.5 (`m`, `l`, `re`, `S`, `f`, `w`). The reader accepts: the lexical conventions and objects of 7.2 and 7.3, streams and filters of 7.4 (7.4.2 ASCIIHex, 7.4.3 ASCII85, 7.4.4 Flate with the predictors of table 8, 7.4.5 RunLength), the file structure of 7.5 including 7.5.5 incremental updates, 7.5.7 object streams and 7.5.8 cross-reference streams, text strings of 7.9.2.2, the page tree and inheritance of 7.7.3, the graphics state and matrices of 8.3 and 8.4, form XObjects of 8.10, inline images of 8.9.7 (skipped), the text state, positioning and showing operators of 9.3 and 9.4 with the glyph advance of 9.4.4, simple fonts of 9.6 with the encodings of 9.6.6 and Annex D, Type3 fonts of 9.6.5, composite fonts of 9.7 with embedded CMaps of 9.7.5 and the widths of 9.7.4.3, and ToUnicode CMaps of 9.10.3.

## Layout

| File           | Covers                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `objects.ts`   | The object model, the lexer (numbers, names, strings, delimiters, keywords) and the parser        |
| `filters.ts`   | FlateDecode through the inflater, predictors, ASCIIHex, ASCII85, RunLength, refusals by name     |
| `xref.ts`      | `PdfFile`: header, cross-reference tables and streams, object streams, the fallback scan, fetch  |
| `encodings.ts` | StandardEncoding, WinAnsiEncoding, MacRomanEncoding and the glyph list                           |
| `cmap.ts`      | ToUnicode and embedded encoding CMaps                                                            |
| `fonts.ts`     | Simple and Type0 fonts: codes, text, widths                                                      |
| `metrics.ts`   | The standard 14 widths, `measureText`, base font name folding                                    |
| `content.ts`   | The content stream interpreter: matrices, text state, runs, forms, inline images                 |
| `layout.ts`    | Runs into lines                                                                                  |
| `read.ts`      | `readPdf`: information dictionary, page tree, pages                                              |
| `write.ts`     | `writePdf`: content streams, fonts, information dictionary, cross-reference table               |
| `limits.ts`    | `READ_LIMITS`                                                                                    |
| `node.ts`      | `nodeInflate` (the `@pb/pdf/node` entry)                                                         |
| `fixtures.ts`  | Builders for hand-made test files (tables, streams, updates); used by tests only                 |

## Commands

```bash
pnpm vitest run --project pdf      # round trips, hand-built fixtures, every refusal, limits at the boundary
pnpm --filter @pb/pdf build        # emits dist/
```
