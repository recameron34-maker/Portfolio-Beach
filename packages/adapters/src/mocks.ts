/**
 * Mock adapters for the prototype. Imported only from non-production composition code; the
 * production guard (`assertProductionSafe`) refuses to start if any of them is wired in.
 */
export { MockIdentityProvider } from './identity/mock.js';
export type { MockUser } from './identity/mock.js';
export { LocalFolderDocumentStore } from './documents/mock.js';
export { FixtureMailSource } from './mail/mock.js';
export { LocalFolderAccountingSystem } from './accounting/mock.js';
export { FixtureLookThroughProvider } from './lookthrough/mock.js';
export { MockAiClient } from './ai/mock.js';
export type { AiCallRecord } from './ai/mock.js';
export { SyntheticBenchmarkProvider } from './benchmarks/mock.js';
