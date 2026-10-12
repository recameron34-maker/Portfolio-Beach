import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { Request, Response } from 'express';
import { AppModule } from './app.module.js';
import { requestIdMiddleware } from './common/request-id.js';
import type { RequestWithId } from './common/problem.js';
import type { Runtime } from './composition.js';
import type { RequestWithPrincipal } from './auth/principal.js';

/**
 * The largest JSON body a request may carry: an intake upload holds a CSV of up to 2,000,000
 * characters (packages/contracts intakeImportBody), which JSON escaping and UTF-8 can treble.
 */
const JSON_BODY_LIMIT = '8mb';

/** Creates the Nest application over a built runtime. Tests call this with an in-memory database. */
export async function createApp(runtime: Runtime): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRuntime(runtime), {
    logger: false,
    bodyParser: false,
  });
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], frameAncestors: ["'none'"] } },
    }),
  );
  app.use(requestIdMiddleware);
  app.use((req: Request, res: Response, next: () => void) => {
    const started = runtime.adapters.clock.nowMs();
    res.on('finish', () => {
      const r = req as RequestWithId & RequestWithPrincipal;
      // Structured, content-free request log (docs/17 section 7): ids and status codes only.
      runtime.logger.info(
        {
          request_id: r.id,
          user_id: r.principal?.userId,
          action: `${req.method} ${req.path}`,
          status: res.statusCode,
          duration_ms: runtime.adapters.clock.nowMs() - started,
        },
        'request',
      );
    });
    next();
  });
  app.enableShutdownHooks();
  await app.init();
  return app;
}
