/* eslint-disable @typescript-eslint/explicit-module-boundary-types -- plain JavaScript shared by the build scripts; src/preview/wire-secrets.test.ts declares and checks its shape */
// What the preview build bundles of the wire register (decision 0013, WEB-1, SEC-12.2), kept
// apart from build-preview.mjs so the tests in src/preview/wire-secrets.test.ts read the same
// functions without running a build. The preview is published: nothing it bundles carries a full
// account number, a routing code or a payment reference in clear, synthetic or not. The book
// carries each version in its masked form, the recorded wire detail is stored with its bank
// details nulled, and the build fails if a clear detail of the dataset reaches either file.

/** The wire instruction detail: the one recorded path whose body can carry bank details in clear. */
export const WIRE_DETAIL = /^\/api\/v1\/wire-instructions\/[^/?]+$/;

/**
 * The register as the book carries it: the id and the masked form of every version
 * ("<bank name> ****<last four digits>", what `mask` gives: maskBankDetails of @pb/db in the
 * build), never the details themselves.
 */
export function bookWireInstructions(dataset, mask) {
  return (dataset.wireInstructions ?? []).map((w) => ({
    id: w.id,
    bankDetailsMasked: mask(w.bankDetails),
  }));
}

/**
 * A recorded body as it is stored. The wire detail answers the bank details in clear to
 * operations and approvers: the stored recording carries null for every credential, and the
 * simulation answers null too for a recorded version (the page says the full details are not
 * part of the preview).
 */
export function withoutSecrets(path, text) {
  if (!WIRE_DETAIL.test(path)) return text;
  return JSON.stringify({ ...JSON.parse(text), bankDetails: null });
}

/** The fields of an instruction that never leave the register in clear. */
const SECRET_FIELDS = ['accountNumber', 'routingCode', 'reference'];

/** Whether the value stands in the text on its own: digits inside a longer run of digits are another number. */
function standsIn(text, value) {
  const digits = /^\d+$/.test(value);
  let at = text.indexOf(value);
  while (at !== -1) {
    const before = text[at - 1] ?? '';
    const after = text[at + value.length] ?? '';
    if (!digits || (!/\d/.test(before) && !/\d/.test(after))) return true;
    at = text.indexOf(value, at + 1);
  }
  return false;
}

/**
 * Every full account number, routing code and payment reference of the dataset's wire
 * instructions that appears in the text, as { id, field } (never the value itself, so the
 * finding can be printed). Empty when the text carries none: what the build requires of the
 * book and the recordings.
 */
export function bankDetailLeaks(dataset, text) {
  const leaks = [];
  for (const w of dataset.wireInstructions ?? []) {
    for (const field of SECRET_FIELDS) {
      const value = w.bankDetails?.[field];
      if (typeof value === 'string' && value !== '' && standsIn(text, value))
        leaks.push({ id: w.id, field });
    }
  }
  return leaks;
}
