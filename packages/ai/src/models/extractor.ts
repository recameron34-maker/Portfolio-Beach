import { z } from 'zod';
import { AiError } from '../errors.js';
import { parseMetadata } from '../input.js';
import { confidenceText } from '../schema.js';
import type { ExtractionOutput } from '../schema.js';
import { UNITS } from '../units.js';

/*
 * The prototype extractor (docs/04 M4, decision 0012): answers the recorded truth of the
 * document named by the content_hash in the metadata block, and nothing else. It never reads the
 * document text, so no instruction inside a document can move it, and it refuses by name when it
 * has no truth for the hash (docs/07 rule 1: never invent). A real model replaces it behind the
 * same prompt id; the eval harness measures either one the same way.
 */

const truthFieldSchema = z.strictObject({
  value: z.string().nullable(),
  unit: z.enum(UNITS).nullable(),
  page: z.number().int().min(1).nullable(),
  quote: z.string().nullable(),
  /** Omitted in a sidecar; the extractor answers 1 for a recorded truth. */
  confidence: confidenceText.optional(),
});

/** The part of a truth sidecar the extractor answers (docs/14: `fields`, `highlights`, `commentary`). */
export const truthSchema = z.object({
  fields: z.record(z.string(), truthFieldSchema),
  highlights: z.array(z.string()),
  commentary: z.string().nullable(),
});
export type Truth = z.infer<typeof truthSchema>;
export type TruthField = Truth['fields'][string];

/** Reads a truth from parsed JSON (a sidecar); extra sidecar keys are ignored, a malformed one is an AiError 'invalid_config'. */
export function parseTruth(value: unknown): Truth {
  const parsed = truthSchema.safeParse(value);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.map(String).join('.') ?? '';
    throw new AiError(
      `the truth sidecar is not usable at ${path === '' ? 'the root' : path}`,
      'invalid_config',
    );
  }
  return parsed.data;
}

export type ExtractFn = (input: string) => ExtractionOutput;

/** The confidence a recorded truth is answered with. */
export const FIXTURE_CONFIDENCE = '1';

/**
 * An extract function over a map of content hash to truth. The input's `content_hash` metadata
 * line picks the truth; a missing line or an unknown hash is an AiError 'no_fixture'.
 */
export function fixtureExtractor(truths: ReadonlyMap<string, Truth>): ExtractFn {
  return (input) => {
    const metadata = parseMetadata(input);
    const hash = metadata.content_hash;
    if (hash === undefined || hash === '')
      throw new AiError(
        'the input names no content_hash, so no recorded output applies',
        'no_fixture',
      );
    const truth = truths.get(hash);
    if (truth === undefined)
      throw new AiError(
        'no recorded output for this document; the prototype model never invents one',
        'no_fixture',
      );
    const fields: ExtractionOutput['fields'] = {};
    for (const [key, field] of Object.entries(truth.fields)) {
      fields[key] = {
        value: field.value,
        unit: field.unit,
        page: field.page,
        quote: field.quote,
        confidence: field.confidence ?? FIXTURE_CONFIDENCE,
      };
    }
    return { fields, highlights: [...truth.highlights], commentary: truth.commentary };
  };
}
