import { z } from 'zod';
import { getKey } from './keys.js';

/**
 * preview/fixtures.json, written by scripts/build-preview.mjs. Bodies are content addressed: each
 * distinct body is stored once under a hash of its text and every recorded response points at its
 * hash, so the per-user copies of the same answer cost one key each.
 */
const previewUser = z.object({
  externalId: z.string().min(1),
  roles: z.array(z.string()),
  userId: z.string().min(1),
  displayName: z.string(),
});

const recordedResponse = z.object({
  status: z.number().int(),
  contentType: z.string(),
  /** Hash of the body in `bodies`. */
  body: z.string(),
});

const previewFixtures = z.object({
  generatedFrom: z.string(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  users: z.array(previewUser),
  bodies: z.record(z.string(), z.string()),
  responses: z.record(z.string(), recordedResponse),
});

export type PreviewUser = z.infer<typeof previewUser>;
export type RecordedResponse = z.infer<typeof recordedResponse>;
export type PreviewFixtures = z.infer<typeof previewFixtures>;

const REBUILD = 'rebuild it with pnpm --filter @pb/web build:preview';

/** Validates a loaded fixtures file; the error names the first problem and how to fix it. */
export function parseFixtures(raw: unknown): PreviewFixtures {
  const parsed = previewFixtures.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? '' : ` at ${issue.path.map(String).join('.') || '(root)'}`;
    throw new Error(`the recorded data is not in the expected format${where}; ${REBUILD}`);
  }
  for (const [key, response] of Object.entries(parsed.data.responses)) {
    if (parsed.data.bodies[response.body] === undefined)
      throw new Error(`the recorded data has no body for ${key}; ${REBUILD}`);
  }
  return parsed.data;
}

export interface Recording {
  status: number;
  contentType: string;
  text: string;
}

/** Read access to the recordings by key or by credential and path. */
export class Recordings {
  constructor(readonly fixtures: PreviewFixtures) {}

  get asOf(): string {
    return this.fixtures.asOf;
  }

  get users(): readonly PreviewUser[] {
    return this.fixtures.users;
  }

  user(credential: string): PreviewUser | undefined {
    return this.fixtures.users.find((u) => u.externalId === credential);
  }

  byKey(key: string): Recording | undefined {
    const response = this.fixtures.responses[key];
    if (response === undefined) return undefined;
    const text = this.fixtures.bodies[response.body];
    if (text === undefined) return undefined;
    return { status: response.status, contentType: response.contentType, text };
  }

  /** Status the credential's recorded GET for the path answered with; undefined when not recorded. */
  status(credential: string, path: string): number | undefined {
    return this.fixtures.responses[getKey(credential, path)]?.status;
  }

  /** The credential's recorded 200 body for a GET, parsed with the contract schema; undefined otherwise. */
  read<T>(credential: string, path: string, schema: z.ZodType<T>): T | undefined {
    const recording = this.byKey(getKey(credential, path));
    if (recording?.status !== 200) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(recording.text);
    } catch {
      return undefined;
    }
    const parsed = schema.safeParse(json);
    return parsed.success ? parsed.data : undefined;
  }
}
