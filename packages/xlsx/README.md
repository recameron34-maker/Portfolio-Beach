# @pb/xlsx

A dependency-free XLSX reader and writer for Portfolio Beach (docs/04 M2: the ops-drop import parses operations workbooks by template signature; the preview reads the same workbooks in the browser). Pure TypeScript: the zip inflater is injected, the main entry imports no runtime module, and the package never reads the wall clock, uses randomness or parses a float (it is listed with the domain packages in the lint config).

## What it does

- `readWorkbook(bytes, { inflateRaw, maxCells?, maxDepth?, maxPartBytes? })` reads an .xlsx into `{ sheets: [{ name, rows: string[][] }] }`, in workbook order (hidden sheets included; a chart sheet has no rows). Every cell is the text the file holds: a number is the number text exactly as stored (never through a float), a boolean is `TRUE` or `FALSE`, a formula cell gives its cached value, an error cell its error text (`#N/A`). Shared strings, inline strings and rich text runs are joined; Excel's `_xHHHH_` escapes are decoded. Sparse rows and columns are filled with empty text up to the last cell; a row element with no cells is an empty row.
- `writeWorkbook(sheets)` writes every cell as an inline string (`t="inlineStr"`), so a number given as text comes back as exactly that text. Output is deterministic: the same sheets give the same bytes (the zip timestamps are fixed to 1980-01-01, never the wall clock). Sheet names are checked the way Excel checks them (1 to 31 characters, none of `\ / ? * [ ] :`, no apostrophe at either end, not `History`, unique ignoring case).
- `templateKey(workbook, headerSheet)` gives `{ sheets, header, canonical }`, where `canonical` is the sheet names joined by the record separator (U+001E), then the unit separator (U+001F), then the header sheet's first row joined by the unit separator. The caller hashes it (`node:crypto` in the API, `SubtleCrypto` in the browser); the package itself does no hashing.
- `WorkbookError` (with a `code`: `not_zip`, `encrypted`, `unsupported`, `corrupt`, `missing_part`, `malformed`, `too_large`, `invalid_input`) is the one error thrown. Messages are plain language for the intake page.
- Cell reference helpers for lineage locators: `cellReference({ row, column })` gives `C7`, `parseCellReference('C7')` gives `{ row: 6, column: 2 }` (zero-based).

## What it refuses

The reader is a small hand-written parser for the subset Excel writes, not a general XML library, and it refuses what it does not understand rather than guessing: input that is not a zip, an encrypted workbook (an OLE container) or an encrypted entry, zip64 or multi-part archives, any compression method other than stored (0) or deflate (8), a missing workbook, relationships, sheet or shared strings part, a document type declaration, an unknown entity, a cell type it does not know, a shared string index the workbook does not have, and any part past the read limits. The limits (`READ_LIMITS`: 200,000 cells per sheet, counting each row as one slot plus its cells; 64 levels of nesting; 64 MiB per uncompressed part) stop a hostile file from running the parser forever; a caller passes its own from configuration. A declared part size over the limit is refused before anything is inflated, and the inflated bytes must match the declared size and CRC-32.

Macros are never run and their parts are never opened; an .xlsm reads like an .xlsx.

## Inflater

`readWorkbook` takes `inflateRaw(data, uncompressedSize)` for raw deflate streams (no zlib or gzip wrapper).

Node (the API):

```ts
import { readWorkbook } from '@pb/xlsx';
import { nodeInflateRaw } from '@pb/xlsx/node';

const workbook = await readWorkbook(bytes, { inflateRaw: nodeInflateRaw });
```

`nodeInflateRaw` passes the declared size to zlib as `maxOutputLength`, so a stream that inflates past what the archive declares is refused before it fills memory.

Browser (the preview), with `DecompressionStream`:

```ts
const inflateRaw = async (data: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};
```

The main entry (`@pb/xlsx`) has no Node import, so a browser bundle never sees zlib; only `@pb/xlsx/node` does.

## Layout

| File           | Covers                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `zip.ts`       | Central directory reader, entry reader (methods 0 and 8, size and CRC checks), stored-entry writer   |
| `xml.ts`       | The XML subset parser (elements, attributes, text, CDATA, entities, depth cap) and escaping         |
| `cells.ts`     | A1 references, column letters, Excel's `_xHHHH_` escapes                                            |
| `read.ts`      | `readWorkbook`: relationships, workbook, shared strings, sheet data, the read limits                 |
| `write.ts`     | `writeWorkbook`: the six parts Excel needs, inline strings, sheet name validation                    |
| `template.ts`  | `templateKey`                                                                                       |
| `node.ts`      | `nodeInflateRaw` (the `@pb/xlsx/node` entry)                                                        |
| `crc32.ts`     | CRC-32 in TypeScript                                                                                |

## Commands

```bash
pnpm vitest run --project xlsx     # round trips, Excel-like fixtures (deflated), refusals, determinism
pnpm --filter @pb/xlsx build       # emits dist/
```
