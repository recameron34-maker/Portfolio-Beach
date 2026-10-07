import { createApp } from './app.js';
import { buildRuntime } from './composition.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const runtime = await buildRuntime(config);
const app = await createApp(runtime);
await app.listen(config.PORT);
runtime.logger.info(
  {
    port: config.PORT,
    env: config.NODE_ENV,
    mockIdentity: runtime.adapters.identity.info.kind === 'mock',
  },
  'Portfolio Beach API listening',
);
