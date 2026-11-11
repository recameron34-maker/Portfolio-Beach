import { z } from 'zod';
import {
  IDEMPOTENCY_KEY_IN_PROGRESS,
  IDEMPOTENCY_KEY_ISSUE,
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_KEY_REUSE,
  IDEMPOTENCY_REPLAYED_HEADER,
} from './idempotency.js';
import { IF_MATCH_ISSUE, STALE_ROW_VERSION_CODE } from './row-version.js';
import { ROUTES } from './routes.js';
import type { RouteDefinition } from './routes.js';
import { problemDetails } from './schemas.js';

interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
}

function jsonSchema(schema: z.ZodTypeAny): unknown {
  return z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' });
}

/**
 * The request headers a route takes beyond the credential (docs/17 section 3), from its two
 * flags in the route table: `idempotent` (idempotency.ts) and `ifMatch` (row-version.ts). Both
 * headers are optional; the words are those rules, so the document says what the API does.
 */
function headerParameters(route: RouteDefinition): unknown[] {
  const params: unknown[] = [];
  if (route.idempotent === true)
    params.push({
      name: IDEMPOTENCY_KEY_ISSUE.path,
      in: 'header',
      required: false,
      description: `Names this request so that it can be sent again safely. A repeat with the same key and the same body (compared as JSON, whatever the order of its keys) answers the stored status and body of the first request with the response header ${IDEMPOTENCY_REPLAYED_HEADER}, and runs nothing. A key belongs to the caller, the method and the path. A request that is refused stores nothing, so the corrected request may use the key. Without the header the request runs as it is. A malformed key, an empty one included, is 400 \`validation\` with the path ${IDEMPOTENCY_KEY_ISSUE.path}.`,
      schema: { type: 'string', minLength: 1, maxLength: 200, pattern: IDEMPOTENCY_KEY_PATTERN },
    });
  if (route.ifMatch !== undefined)
    params.push({
      name: IF_MATCH_ISSUE.path,
      in: 'header',
      required: false,
      description: `The row version of the ${route.ifMatch.replace(/_/g, ' ')} as the caller read it (the rowVersion of the record, which is its ETag): one or more entity tags, each a quoted or bare row version, weak ones (W/"3") included, or "*". When none of the versions named is the record's, the answer is 412. Without the header, or with "*", the command runs on the record as it stands. A malformed header is 400 \`validation\` with the path ${IF_MATCH_ISSUE.path}.`,
      schema: { type: 'string' },
      example: '"3"',
    });
  return params;
}

function parameters(route: RouteDefinition): unknown[] {
  const params: unknown[] = [];
  for (const m of route.path.matchAll(/\{(\w+)\}/g)) {
    params.push({ name: m[1], in: 'path', required: true, schema: { type: 'string' } });
  }
  if (route.query !== undefined) {
    const js = jsonSchema(route.query) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    for (const [name, schema] of Object.entries(js.properties ?? {})) {
      params.push({ name, in: 'query', required: js.required?.includes(name) ?? false, schema });
    }
  }
  return [...params, ...headerParameters(route)];
}

const PROBLEM_CONTENT = {
  'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
};

/**
 * The problems the two headers can cause, by status, beside the general 4XX entry: 409 and 422
 * on a route that takes an Idempotency-Key, 412 on one that reads If-Match. A status a route
 * also answers for its own reasons (a transition the workflow table does not list is 409, a
 * failed precondition 422) says so, so the entry does not read as the only cause.
 */
function headerProblems(route: RouteDefinition): Record<string, unknown> {
  const problems: Record<string, unknown> = {};
  if (route.idempotent === true) {
    problems[String(IDEMPOTENCY_KEY_IN_PROGRESS.status)] = {
      description: `Conflict. \`${IDEMPOTENCY_KEY_IN_PROGRESS.code}\`: a request with this Idempotency-Key is still running, or its completion was never recorded; wait for its answer, or read the record again and send the request with a new key. Nothing was run for this repeat. The route's other conflicts use this status too (\`workflow-transition\`: the command is not allowed from the current state).`,
      content: PROBLEM_CONTENT,
    };
    problems[String(IDEMPOTENCY_KEY_REUSE.status)] = {
      description: `Unprocessable. \`${IDEMPOTENCY_KEY_REUSE.code}\`: this Idempotency-Key was already used with a different request body; nothing was run. The route's own rules use this status too (\`workflow-precondition\`).`,
      content: PROBLEM_CONTENT,
    };
  }
  if (route.ifMatch !== undefined)
    problems['412'] = {
      description: `Precondition failed. \`${STALE_ROW_VERSION_CODE}\`: the record changed since it was read; none of the row versions If-Match names is the one it is at now. Nothing was changed: read the record again.`,
      content: PROBLEM_CONTENT,
    };
  return problems;
}

/**
 * Builds the OpenAPI 3.1 document from the route table and the zod contracts (docs/17 section 3).
 * Paths and operations are collected in Maps and serialized with Object.fromEntries, so a path or
 * method string can never write to an object prototype (CodeQL js/prototype-polluting-assignment).
 */
export function buildOpenApi(
  version: string,
  routes: readonly RouteDefinition[] = ROUTES,
): OpenApiDocument {
  const paths = new Map<string, Map<string, unknown>>();
  for (const route of routes) {
    const operation: Record<string, unknown> = {
      summary: route.summary,
      tags: route.tags,
      parameters: parameters(route),
      responses: {
        [String(route.responseStatus ?? 200)]: {
          description: 'Success',
          ...(route.idempotent === true
            ? {
                headers: {
                  [IDEMPOTENCY_REPLAYED_HEADER]: {
                    description:
                      'Present, with the value "true", when this answer is the stored answer of an earlier request with the same Idempotency-Key: nothing was run for this request. The body is the one stored, in which bank details in clear are null.',
                    schema: { type: 'string', enum: ['true'] },
                  },
                },
              }
            : {}),
          content: {
            [route.responseContentType ?? 'application/json']: {
              schema: jsonSchema(route.response),
            },
          },
        },
        ...headerProblems(route),
        '4XX': { description: 'Problem details (RFC 9457)', content: PROBLEM_CONTENT },
      },
      security: route.auth ? [{ bearer: [] }] : [],
      ...(route.roles.length > 0 ? { 'x-roles': route.roles } : {}),
    };
    if (route.body !== undefined) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: jsonSchema(route.body) } },
      };
    }
    const operations = paths.get(route.path) ?? new Map<string, unknown>();
    operations.set(route.method.toLowerCase(), operation);
    paths.set(route.path, operations);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Portfolio Beach API',
      version,
      description:
        'Internal API. Errors are RFC 9457 problem details; records the caller may not see return 404.',
    },
    paths: Object.fromEntries(
      [...paths].map(([path, operations]) => [path, Object.fromEntries(operations)]),
    ),
    components: {
      schemas: { ProblemDetails: jsonSchema(problemDetails) },
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    },
  };
}
