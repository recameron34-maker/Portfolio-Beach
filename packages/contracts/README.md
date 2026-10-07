# @pb/contracts

The API contract shared by the API, the web app and later the Outlook add-in and Teams app (docs/17 section 3).

- `schemas.ts`: zod schemas for every request and response. Money, rates and multiples are decimal strings; "not calculable" is `null`; query schemas are strict (unknown fields rejected) and cap page sizes at 200.
- `routes.ts`: the route table (method, path, roles, auth, query, body, response). The API's parity test fails if a controller implements a route that is not here, or the reverse.
- `openapi.ts`: `buildOpenApi(version)` turns the table and schemas into an OpenAPI 3.1 document (`pnpm openapi:generate`). Problem details are the error schema for every 4xx and 5xx.

Breaking changes get a new `/api/v{n}` prefix; additive changes update the schemas in place.
