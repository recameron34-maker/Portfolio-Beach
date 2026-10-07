import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { RequestWithId } from './problem.js';

const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** Accepts a well-formed caller request id or mints one; echoes it back on every response. */
export function requestIdMiddleware(req: RequestWithId, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.id = incoming !== undefined && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
}
