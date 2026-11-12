import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { WORKFLOW_REFUSALS } from '@pb/contracts';
import type { ProblemDetails } from '@pb/contracts';
import type { TransitionResult } from '@pb/workflows';
import { errorForLog } from './logging.js';
import type { Logger } from './logging.js';
import { LOGGER } from './tokens.js';

export const PROBLEM_BASE = 'https://portfolio-beach.example/problems/';

const TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Authentication required',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  412: 'Precondition failed',
  422: 'Unprocessable',
  429: 'Too many requests',
  500: 'Internal error',
  501: 'Not implemented',
  503: 'Service unavailable',
};

export interface RequestWithId extends Request {
  id?: string;
}

/** Problem-details error with a stable `type` code (docs/17 section 3). */
export class ProblemError extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    detail?: string,
    public readonly errors?: { path: string; message: string }[],
  ) {
    super(detail ?? TITLES[status] ?? 'Error', status);
  }
}

/** A refusal from attempt() in @pb/workflows as the problem the shared WORKFLOW_REFUSALS table assigns it (403 role, 409 transition, 422 precondition). */
export function workflowProblem(
  failure: Extract<TransitionResult<string>, { ok: false }>,
): ProblemError {
  const refusal = WORKFLOW_REFUSALS[failure.code];
  return new ProblemError(refusal.status, refusal.code, failure.message);
}

export function problemFor(
  status: number,
  code: string,
  requestId: string,
  detail?: string,
  instance?: string,
  errors?: ProblemDetails['errors'],
): ProblemDetails {
  return {
    type: `${PROBLEM_BASE}${code}`,
    title: TITLES[status] ?? 'Error',
    status,
    ...(detail !== undefined ? { detail } : {}),
    ...(instance !== undefined ? { instance } : {}),
    request_id: requestId,
    ...(errors !== undefined ? { errors } : {}),
  };
}

/** Converts zod issues to path-only error entries: paths and messages, never the offending values. */
export function zodIssues(error: ZodError): { path: string; message: string }[] {
  return error.issues.map((i) => ({
    path: i.path.map(String).join('.') || '(root)',
    message: i.message,
  }));
}

/**
 * What the framework itself refused (the API raises ProblemError for everything of its own). Its
 * message is not passed on, except for an unknown route: the parser's message for a body it could
 * not read spells out that body, and no answer may carry a value that was sent (SEC-11.4, docs/17
 * section 3). A request the framework could not read is a validation refusal in fixed words, the
 * same the static preview gives.
 */
function frameworkProblem(
  status: number,
  message: string,
  req: RequestWithId,
  requestId: string,
): ProblemDetails {
  if (status === 404) return problemFor(404, 'not-found', requestId, message, req.path);
  if (status === 400) {
    const declaresJson = /json/i.test(String(req.headers['content-type'] ?? ''));
    return declaresJson
      ? problemFor(400, 'validation', requestId, 'Invalid body', req.path, [
          { path: '(root)', message: 'The body is not valid JSON' },
        ])
      : problemFor(400, 'validation', requestId, 'The request could not be read', req.path);
  }
  if (status === 413)
    return problemFor(413, 'http', requestId, 'The request body is too large', req.path);
  return problemFor(status, 'http', requestId, undefined, req.path);
}

/**
 * The status of a refusal raised by the body parser itself (a body over the size limit, an
 * encoding it does not read): an error with a 4xx status and a type, which the framework does
 * not turn into one of its own exceptions. Undefined for anything else.
 */
function parserStatusOf(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const { status, type } = exception as { status?: unknown; type?: unknown };
  return typeof status === 'number' && status >= 400 && status < 500 && typeof type === 'string'
    ? status
    : undefined;
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<RequestWithId>();
    const requestId = req.id ?? 'unknown';
    let problem: ProblemDetails;
    if (exception instanceof ProblemError) {
      problem = problemFor(
        exception.getStatus(),
        exception.code,
        requestId,
        exception.message,
        req.path,
        exception.errors,
      );
    } else if (exception instanceof ZodError) {
      problem = problemFor(
        400,
        'validation',
        requestId,
        'The request did not match the contract',
        req.path,
        zodIssues(exception),
      );
    } else if (exception instanceof HttpException) {
      problem = frameworkProblem(exception.getStatus(), exception.message, req, requestId);
    } else if (parserStatusOf(exception) !== undefined) {
      problem = frameworkProblem(parserStatusOf(exception) ?? 400, '', req, requestId);
    } else {
      problem = problemFor(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'internal',
        requestId,
        'An unexpected error occurred. Quote the request id to support.',
        req.path,
      );
      // errorForLog keeps a database error to its code and constraint: the message of a failed
      // query carries its parameters, which no log line may hold (SEC-11.4).
      this.logger.error({ request_id: requestId, err: errorForLog(exception) }, 'unhandled error');
    }
    res.status(problem.status).type('application/problem+json').send(problem);
  }
}
