import type { AppRole } from '@pb/db';

/** Every adapter says what it is. The production guard refuses `mock` (docs/17 section 6, SEC-17.6). */
export interface AdapterInfo {
  name: string;
  kind: 'mock' | 'real';
  /** Feature flag key that acts as this adapter's kill switch (docs/17 section 5). */
  killSwitch: string;
}

export interface HealthStatus {
  ok: boolean;
  detail?: string;
}

export interface Adapter {
  readonly info: AdapterInfo;
  healthCheck(): Promise<HealthStatus>;
}

export interface Principal {
  userId: string;
  externalId: string;
  displayName: string;
  roles: AppRole[];
  clientIds: string[];
}

export interface IdentityProvider extends Adapter {
  /** Resolves a bearer credential to a principal, or null when it is not valid. */
  authenticate(credential: string): Promise<Principal | null>;
}

export interface DocumentRef {
  id: string;
  name: string;
  folder: string;
  sizeBytes: number;
  contentHash: string;
  modifiedAt: string;
}

export interface DocumentStore extends Adapter {
  list(folder: string): Promise<DocumentRef[]>;
  read(id: string): Promise<Uint8Array>;
  put(folder: string, name: string, bytes: Uint8Array): Promise<DocumentRef>;
}

/** Mail metadata plus the body for in-memory processing only. The body is never persisted (SEC-6.4). */
export interface MailMessage {
  id: string;
  receivedAt: string;
  from: string;
  to: string[];
  subject: string;
  body: string;
  isInternalOnly: boolean;
}

export interface MailSource extends Adapter {
  listMessages(mailbox: string, sinceIso: string): Promise<MailMessage[]>;
}

export interface FileRef {
  id: string;
  name: string;
  receivedAt: string;
}

export interface AccountingSystem extends Adapter {
  listExports(): Promise<FileRef[]>;
  readExport(id: string): Promise<string>;
  writeUpload(name: string, csv: string): Promise<FileRef>;
}

export interface ExposureRow {
  investmentNumber: string | null;
  companyName: string;
  sector: string;
  geography: string;
  exposureAtCost: string;
  exposureAtNav: string;
  asOf: string;
}

export interface LookThroughProvider extends Adapter {
  fetchExposures(asOf: string): Promise<ExposureRow[]>;
}

export interface AiRequest {
  /** Prompt registry id and version (packages/ai). Logged; never the content. */
  promptId: string;
  promptVersion: string;
  /** Delimited, redacted input. Treated as data by the system prompt (SEC-8.3). */
  input: string;
  /** Tools are never offered for extraction (SEC-8.3). */
  tools?: never;
  maxTokens?: number;
}

export interface AiResponse<T> {
  output: T;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

export interface OutputSchema<T> {
  parse(value: unknown): T;
}

export interface AiModelClient extends Adapter {
  complete<T>(request: AiRequest, schema: OutputSchema<T>): Promise<AiResponse<T>>;
}

export interface IndexPoint {
  date: string;
  level: string;
}

export interface BenchmarkProvider extends Adapter {
  indexSeries(code: string, from: string, to: string): Promise<IndexPoint[]>;
}

/** Reads kill switches (ops.feature_flag in the app). */
export interface KillSwitchReader {
  isEnabled(key: string): Promise<boolean>;
}
