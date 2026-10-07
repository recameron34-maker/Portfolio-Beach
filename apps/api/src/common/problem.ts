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
import type { ProblemDetails } from '@pb/contracts';
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
      const status = exception.getStatus();
      problem = problemFor(
        status,
        status === 404 ? 'not-found' : 'http',
        requestId,
        status >= 500 ? undefined : exception.message,
        req.path,
      );
    } else {
      problem = problemFor(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'internal',
        requestId,
        'An unexpected error occurred. Quote the request id to support.',
        req.path,
      );
      this.logger.error(
        {
          request_id: requestId,
          err:
            exception instanceof Error
              ? { name: exception.name, message: exception.message }
              : String(exception),
        },
        'unhandled error',
      );
    }
    res.status(problem.status).type('application/problem+json').send(problem);
  }
}
