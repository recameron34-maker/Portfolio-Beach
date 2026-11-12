/**
 * The one error the package throws. Every message is plain language a reviewer can read on the
 * run page; the code lets the caller map it (a failed run, a configuration problem, a gate).
 */
export type AiErrorCode =
  /** config/extraction_schema.json, config/style.json or a definitions key is missing or unusable. */
  | 'invalid_config'
  /** The model input could not be built or read back (a delimiter inside the content, a bad metadata line). */
  | 'invalid_input'
  /** The fixture-backed model has no recorded truth for the document, so it answers nothing. */
  | 'no_fixture'
  /** An eval result is below a docs/04 threshold; the release gate. */
  | 'eval_threshold';

export class AiError extends Error {
  constructor(
    message: string,
    public readonly code: AiErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AiError';
  }
}
