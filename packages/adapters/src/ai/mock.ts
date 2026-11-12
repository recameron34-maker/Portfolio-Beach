import type { AiModelClient, AiRequest, AiResponse, HealthStatus, OutputSchema } from '../types.js';

export interface AiCallRecord {
  promptId: string;
  promptVersion: string;
  inputLength: number;
}

/**
 * A fixture that answers from the request input: the prototype models of packages/ai
 * (keywordClassifier, fixtureExtractor). It sees the input and nothing else, and may throw a
 * plain error, which the call rejects with.
 */
export type AiFixtureResolver = (input: string) => unknown;

/**
 * The prototype model client: returns recorded fixture outputs keyed by prompt id and never
 * invents anything. A fixture is either a recorded output or a resolver function called with the
 * request input. A missing fixture is an error, which is the behavior docs/07 rule 1 wants
 * ("never invent numbers"). Calls are recorded without content (SEC-8.9).
 */
export class MockAiClient implements AiModelClient {
  readonly info = { name: 'ai.mock', kind: 'mock', killSwitch: 'ai.extraction' } as const;
  readonly calls: AiCallRecord[] = [];
  private readonly fixtures = new Map<string, unknown>();

  constructor(fixtures: Readonly<Record<string, unknown>> = {}) {
    for (const [k, v] of Object.entries(fixtures)) this.fixtures.set(k, v);
  }

  /** Registers a recorded output, or, when `output` is a function, a resolver called with each request's input. */
  register(promptId: string, output: unknown): void {
    this.fixtures.set(promptId, output);
  }

  complete<T>(request: AiRequest, schema: OutputSchema<T>): Promise<AiResponse<T>> {
    this.calls.push({
      promptId: request.promptId,
      promptVersion: request.promptVersion,
      inputLength: request.input.length,
    });
    const fixture = this.fixtures.get(request.promptId);
    if (fixture === undefined) {
      return Promise.reject(
        new Error(
          `mock AI client has no fixture for prompt ${request.promptId}; it never invents output`,
        ),
      );
    }
    try {
      const raw =
        typeof fixture === 'function' ? (fixture as AiFixtureResolver)(request.input) : fixture;
      const output = schema.parse(raw);
      return Promise.resolve({
        output,
        modelId: 'mock',
        tokensIn: Math.ceil(request.input.length / 4),
        tokensOut: 64,
        latencyMs: 1,
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  healthCheck(): Promise<HealthStatus> {
    return Promise.resolve({ ok: true, detail: `${this.fixtures.size} fixtures` });
  }
}
