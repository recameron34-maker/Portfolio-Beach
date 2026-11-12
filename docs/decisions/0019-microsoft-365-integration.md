# 0019: Microsoft 365 integration (sign-in, Copilot Studio agents, Power Apps)

- **Status:** Proposed. Nothing here is built. It waits on the owner's answers to the questions at the end and on a "go".
- **Date:** 2026-11-12
- **Deciders:** repo owner; the deploying firm's IT at merge. Drafted in Claude Code.

## Context

The owner said on 2026-11-12: "It will also be very important that the application can API into M365 as the login, as well as be able to connect to co-pilot studio agents and powerapps. The AI tools on the site will likely need to be created within our companies own M365 ecosystem".

Where the build guide already stands:

- **Sign-in through Microsoft 365 is already the design.** `docs/05` SEC-4.1 to SEC-4.7: Entra ID single sign-on only, no local accounts, Entra app roles mapped to Portfolio Beach roles, tokens checked on the server on every request. The prototype runs a mock identity provider behind the `IdentityProvider` adapter (`packages/adapters`), and the app refuses to start in production with a mock (rule 13).
- **Copilot Studio and Power Apps are not in the build guide.** `docs/13` weighed Power Platform as the place to build the whole product and chose a custom app (option B), for testability and exact arithmetic. It says nothing against Power Platform tools reaching the custom app, which is what is asked for here.
- **AI today** is code-defined services in `packages/ai` (a prompt registry, typed outputs, evals) behind the `AiModelClient` adapter, with a mock model in the prototype and "an approved enterprise endpoint" at merge (`docs/13` section 3).

So the first request confirms the plan, and the other two add integrations. The fourth sentence may change where the AI runs, which is the firm's decision.

## What Microsoft's documentation says (read 2026-11-12)

The session could search Microsoft Learn but not open its pages (the host is outside the sandbox's allowed network), so what follows is from search summaries of the pages named. Every point must be re-read on the page itself before an adapter is built, and the version noted here.

- **A custom web app talking to a Copilot Studio agent.** Three routes are documented: the Copilot Studio client of the Microsoft 365 Agents SDK (recommended for most apps), the default Web Chat frame (shown only for an agent with no authentication, so for public agents only), and Direct Line (when the SDK does not fit; the secret stays on the server). With the SDK, the app's Entra registration needs the delegated permission `CopilotStudio.Copilots.Invoke` on the Power Platform API, and the caller's sign-in is separate from the agent's own authentication setting. The JavaScript package is `@microsoft/agents-copilotstudio-client`; its connection settings name an environment id and the agent's schema name. Page: "Integrate web or native apps with Microsoft 365 Agents SDK" (Copilot Studio documentation).
- **A Copilot Studio agent calling an API.** Three routes: a REST API tool made from an OpenAPI document (marked preview on some pages; authentication none, API key or OAuth 2.0), a Power Platform custom connector, or a Model Context Protocol server. The pages disagree on the OpenAPI version (one says version 2 JSON with version 3 translated on upload, another accepts both). Pages: "Extend your agent with tools from a REST API", "Add tools to custom agents", "Connect your agent to an existing Model Context Protocol (MCP) server".
- **Power Apps calling an API.** A custom connector built from an OpenAPI document, with OAuth 2.0 against Microsoft Entra ID as the recommended authentication. The custom connector FAQ says only OpenAPI 2.0 is supported; the client credentials grant is not supported, so a connector acts for a signed-in user. The file must be under 1 MB. The licensing FAQ says custom connectors need a standalone Power Apps or Power Automate plan. Pages: "Custom connectors overview", "Authenticate your API and connector with Microsoft Entra ID", "Custom connector frequently asked questions", "Power Platform licensing FAQs".

## Proposal

**1. Sign-in: build the Entra adapter the guide already calls for.** A real `IdentityProvider` that validates an Entra access token (issuer, audience, signature, expiry, roles) and maps app roles to Portfolio Beach roles, and MSAL in the web app (authorization code flow with PKCE). The firm's IT registers two applications at merge (the web app, and the API exposing one delegated scope). In the prototype the adapter is tested against tokens signed by a key made in the test, with a made-up issuer; it is never pointed at a tenant, and the mock stays the default.

**2. One connector document for Power Apps, Power Automate and Copilot Studio.** Portfolio Beach already writes an OpenAPI 3.1 document from `packages/contracts`. Add a second, smaller document in the version the connector tooling accepts: the read endpoints first (portfolio, positions, pipeline, analytics), each with a plain-language summary an agent can choose by, signed in with Entra on behalf of the user. Because the caller is always a user, row-level security and deal walls apply to a Power App or an agent exactly as they do to the web app; nothing gets a second, wider path. Writes stay out of the first version. If they are added later they go only to the staging endpoints, so rule 5 holds: no agent and no Power App writes a financial record without human approval.

**3. Copilot Studio agents inside the app.** A new adapter, `AgentRuntime`, for a conversation with an agent the firm builds in Copilot Studio (the "Ask Portfolio Beach" panel is the first user). It is separate from `AiModelClient`, whose answers are validated against a schema; a conversation is not. It ships with a mock agent in the prototype, a kill switch, a health check and an Integration Health probe (rule 3c). The real adapter uses the Agents SDK client with the delegated permission above, and is written when a development tenant exists to test it against.

**4. Where the AI runs: three shapes, for the firm to choose.**

| | What lives in Copilot Studio | What stays code-defined | Notes |
|---|---|---|---|
| A (recommended) | The conversational agents: Ask Portfolio Beach, and any assistant the firm builds over the connector | Document tagging and financial extraction, in `packages/ai`, with the model served from an endpoint inside the firm's tenant | Keeps typed outputs, evals in CI and staging with approval for anything that becomes a number |
| B | Everything conversational and the extraction prompts too | Only validation, staging and approval | Extraction quality is harder to test and version in a low-code tool (`docs/13`, why option B was chosen) |
| C | Nothing | Everything, as today, with the model endpoint in the tenant | Meets "inside our own ecosystem" only if an Azure-hosted model counts |

Whichever is chosen, an extracted figure still goes through staging and human approval, and prompts sent to any model are redacted first (rules 4 and 5).

**5. Everything as code still applies (rule 8).** Agents and apps made in Copilot Studio and Power Apps are edited in a portal. To keep them reviewable they would be exported as Power Platform solutions and kept in the repository, with the connector document generated from the contracts, never edited by hand. How that export works is to be confirmed in Microsoft's documentation before it is relied on.

## What can be built in the prototype, with no tenant and no credentials

- The Entra `IdentityProvider` and its tests against locally signed tokens; MSAL wiring behind configuration, off by default.
- The connector document, generated and tested (size, version, a summary on every operation, read-only).
- The `AgentRuntime` adapter with a mock agent, and the Ask panel on it.

What cannot be proven here: a real sign-in, a real connector import, a real Copilot Studio conversation. Each needs a development tenant, which this repository must never connect to (`CLAUDE.md` section 3d). They are verified at merge by the firm's IT.

## Consequences

- New permissions, all delegated: the API's own scope, and `CopilotStudio.Copilots.Invoke` for the in-app agent. No application-level permission is proposed (rule 3).
- Possible licences: Power Apps or Power Automate plans for custom connectors, and Copilot Studio capacity. These are the firm's to confirm before anything depends on them (`CLAUDE.md` section 4: ask before adding a paid connector or licence).
- One new runtime dependency if shape A or B is chosen: the Agents SDK Copilot Studio client. The version is recorded here when it is added.
- `docs/02`, `docs/05` (a section for connector and agent access), `docs/07` and `docs/13` change when this is accepted.

## Questions for the owner

1. Which AI work must be built in Copilot Studio: only the conversational assistant, or document tagging and financial extraction as well (shapes A, B, C above)?
2. Does a model served from the firm's own Azure tenant count as "inside our M365 ecosystem", or must every model call go through Copilot Studio?
3. What should Power Apps do with Portfolio Beach: read its data into apps the team builds, or something more? Are plans that allow custom connectors available?
4. Will there be a development tenant where the firm's IT can try the sign-in, the connector and an agent? Nothing in this repository can.

## SEC IDs affected (when accepted)

SEC-4.1 to SEC-4.5 (Entra sign-in and token validation), SEC-5.3 (walls and row-level security hold for connector and agent callers, since they act as the user), SEC-10.7 (least-privilege delegated scopes), SEC-17.6 (no mock adapter in production).
