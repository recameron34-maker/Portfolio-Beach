import { describe, expect, it } from 'vitest';
import { generateDataset } from '@pb/synthetic';
// @ts-expect-error TS7016: plain JavaScript shared with the build scripts; its shape is declared below
import * as untypedWires from '../../scripts/preview-wires.mjs';
import { parseBook } from './book.js';
import { maskBankDetails } from './routes/wires.js';
import { BANK_DETAILS, IDS, testBook } from './test-fixtures.js';

/**
 * WEB-1 (SEC-12.2): the preview is published, so nothing it bundles may carry a full account
 * number, a routing code or a payment reference of the wire register in clear, synthetic or not.
 * The build writes the book and the recordings through scripts/preview-wires.mjs; these tests
 * read the same functions over the dataset the build generates (small profile, seed 42), so a
 * change that puts a clear detail back fails here, before any build.
 */

interface BankDetails {
  bankName: string;
  accountName: string;
  accountNumber: string;
  routingCode: string;
  reference?: string;
}
interface DatasetWire {
  id: string;
  bankDetails: BankDetails;
}
interface Leak {
  id: string;
  field: 'accountNumber' | 'routingCode' | 'reference';
}
interface WiresModule {
  WIRE_DETAIL: RegExp;
  bookWireInstructions: (
    dataset: { wireInstructions?: DatasetWire[] },
    mask: (d: BankDetails) => string,
  ) => unknown[];
  withoutSecrets: (path: string, text: string) => string;
  bankDetailLeaks: (dataset: { wireInstructions?: DatasetWire[] }, text: string) => Leak[];
}
const { WIRE_DETAIL, bookWireInstructions, withoutSecrets, bankDetailLeaks } =
  untypedWires as unknown as WiresModule;

const dataset = generateDataset({ profile: 'small', seed: 42 });
const wires: DatasetWire[] = dataset.wireInstructions;

describe('the wire register in the published preview (WEB-1)', () => {
  it('the dataset has instructions with full details, so the checks below have something to find', () => {
    expect(wires.length).toBeGreaterThan(1);
    for (const w of wires) {
      expect(w.bankDetails.accountNumber).toMatch(/^\d{6,20}$/);
      expect(w.bankDetails.routingCode).toMatch(/^\d{6,20}$/);
    }
  });

  it('the book carries every version in its masked form only: the id, the bank name and the last four digits', () => {
    const entries = bookWireInstructions(dataset, maskBankDetails);
    expect(entries).toEqual(
      wires.map((w) => ({
        id: w.id,
        bankDetailsMasked: `${w.bankDetails.bankName} ****${w.bankDetails.accountNumber.slice(-4)}`,
      })),
    );
    const text = JSON.stringify(entries);
    for (const w of wires) {
      expect(text).not.toContain(w.bankDetails.accountNumber);
      expect(text).not.toContain(w.bankDetails.routingCode);
      if (w.bankDetails.reference !== undefined)
        expect(text).not.toContain(w.bankDetails.reference);
    }
    expect(text).not.toMatch(/accountNumber|routingCode|accountName|reference/);
    expect(bankDetailLeaks(dataset, text)).toEqual([]);
  });

  it('a recorded wire detail is stored with its bank details nulled, whoever read it; every other body is stored as it is', () => {
    const [first] = wires;
    if (first === undefined) throw new Error('the dataset has no wire instruction');
    const body = JSON.stringify({
      id: first.id,
      bankDetailsMasked: maskBankDetails(first.bankDetails),
      bankDetails: first.bankDetails,
    });
    const path = `/api/v1/wire-instructions/${first.id}`;
    expect(WIRE_DETAIL.test(path)).toBe(true);
    const stored = withoutSecrets(path, body);
    expect(JSON.parse(stored)).toEqual({
      id: first.id,
      bankDetailsMasked: maskBankDetails(first.bankDetails),
      bankDetails: null,
    });
    expect(bankDetailLeaks(dataset, stored)).toEqual([]);
    // The list and every other path pass through untouched (they never carry the clear form).
    for (const other of ['/api/v1/wire-instructions?limit=200', '/api/v1/trade-tickets?limit=200'])
      expect(withoutSecrets(other, '{"items":[]}')).toBe('{"items":[]}');
  });

  it('the leak check names every full account number, routing code and reference that reaches a text', () => {
    for (const w of wires) {
      const clear = JSON.stringify({ any: { shape: [w.bankDetails] } });
      const found = bankDetailLeaks(dataset, clear).filter((leak) => leak.id === w.id);
      expect(found.map((leak) => leak.field).sort()).toEqual(
        [
          'accountNumber',
          'routingCode',
          ...(w.bankDetails.reference === undefined ? [] : ['reference']),
        ].sort(),
      );
      // A number quoted in a sentence, outside any JSON key, is still found.
      expect(
        bankDetailLeaks(dataset, `Please wire to account ${w.bankDetails.accountNumber} today.`)
          .filter((leak) => leak.id === w.id)
          .map((leak) => leak.field),
      ).toEqual(['accountNumber']);
    }
    // The masked form, a longer run of digits that only contains a number, and plain text: none.
    const [first] = wires;
    if (first === undefined) throw new Error('the dataset has no wire instruction');
    expect(bankDetailLeaks(dataset, maskBankDetails(first.bankDetails))).toEqual([]);
    expect(bankDetailLeaks(dataset, `9${first.bankDetails.accountNumber}9`)).toEqual([]);
    expect(bankDetailLeaks(dataset, 'No bank details here.')).toEqual([]);
    expect(bankDetailLeaks({}, first.bankDetails.accountNumber)).toEqual([]);
  });

  it('a book that carries bank details in clear does not load', () => {
    const book = testBook();
    expect(book.wireInstructions).toHaveLength(Object.keys(IDS.wire).length);
    const withClear = {
      ...book,
      wireInstructions: [{ id: IDS.wire.Verified, bankDetails: BANK_DETAILS.Verified }],
    };
    expect(() => parseBook(withClear)).toThrow(/wireInstructions\.0/);
    const withBoth = {
      ...book,
      wireInstructions: [
        {
          id: IDS.wire.Verified,
          bankDetailsMasked: maskBankDetails(BANK_DETAILS.Verified),
          bankDetails: BANK_DETAILS.Verified,
        },
      ],
    };
    expect(() => parseBook(withBoth)).toThrow(/wireInstructions\.0/);
    // The masked form must be masked: a full account number in its place is refused too.
    const unmasked = {
      ...book,
      wireInstructions: [
        { id: IDS.wire.Verified, bankDetailsMasked: BANK_DETAILS.Verified.accountNumber },
      ],
    };
    expect(() => parseBook(unmasked)).toThrow(/wireInstructions\.0/);
  });

  it('the test book and the fixtures of the simulation carry no full detail either', () => {
    const text = JSON.stringify(testBook());
    for (const clear of Object.values(BANK_DETAILS)) {
      expect(text).not.toContain(clear.accountNumber);
      expect(text).not.toContain(clear.routingCode);
    }
  });
});
