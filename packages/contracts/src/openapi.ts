import { z } from 'zod';
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

function queryParameters(route: RouteDefinition): unknown[] {
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
  return params;
}

/** Builds the OpenAPI 3.1 document from the route table and the zod contracts (docs/17 section 3). */
export function buildOpenApi(
  version: string,
  routes: readonly RouteDefinition[] = ROUTES,
): OpenApiDocument {
  const paths = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const route of routes) {
    const operation: Record<string, unknown> = {
      summary: route.summary,
      tags: route.tags,
      parameters: queryParameters(route),
      responses: {
        [String(route.responseStatus ?? 200)]: {
          description: 'Success',
          content: { 'application/json': { schema: jsonSchema(route.response) } },
        },
        '4XX': {
          description: 'Problem details (RFC 9457)',
          content: {
            'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
          },
        },
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
    paths[route.path] ??= Object.create(null) as Record<string, unknown>;
    paths[route.path]![route.method.toLowerCase()] = operation;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Portfolio Beach API',
      version,
      description:
        'Internal API. Errors are RFC 9457 problem details; records the caller may not see return 404.',
    },
    paths,
    components: {
      schemas: { ProblemDetails: jsonSchema(problemDetails) },
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    },
  };
}
