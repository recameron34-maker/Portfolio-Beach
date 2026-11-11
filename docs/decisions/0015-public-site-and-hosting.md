# 0015: A public website for the prototype, and how it is published

- **Status:** Accepted for the prototype
- **Date:** 2026-11-11
- **Deciders:** repo owner (asked for the site and named the domain); built in Claude Code

## Context

The owner asked for "a landing page for a website version" with "an overview of the actual portfolio management tool as well as demo videos, brochures, etc. with a cool, simple, and sleek modern style and gentle 'Portfolio Beach' theming", to be served from a personal domain of the owner's that another of their repositories serves today, and said they will change the domain at a later date.

Two rules of the build guide bear on this. CLAUDE.md says the prototype has no cloud deployment and that a session never deploys: deployment happens only in GitHub Actions after human approval. docs/16 section 5 says a hosted demo of the application goes through IT on a sandbox subscription.

## Options considered

1. **A static site in this repo, published by a manually started workflow to the host the domain already uses.** No backend, no database, no identity: the pages, the generated media and the static preview (recorded answers on synthetic data). The owner starts every publish.
2. **Pages hosting from this repo with the domain's records repointed.** Works, but the domain is attached to a Worker on another host today, so it means record changes as well as a detach, for no gain.
3. **Putting the site in the other repository.** Mixes two unrelated projects and their secrets.

## Decision

Option 1.

- `apps/site` (`@pb/site`) is a static package: one landing page, a 404 page and the interactive preview copied to `demo/`. The copy says only what the repo shows is built, marks the rest as planned, carries no employer information and no sales language, and says on every page that this is a prototype on synthetic data. Screenshots, screen recordings and PDF brochures are generated from the preview by script (`apps/site/scripts/`), so they can be regenerated when the tool changes; the output is not committed.
- Publishing is `.github/workflows/site.yml`: `workflow_dispatch` only, with a `preview` target (a temporary address) and a `production` target that reads the domain from the repository variable `SITE_DOMAIN`. No domain, account, zone or secret is in the repo; the two host secrets are repository secrets the owner sets; the production job sits in its own environment so the owner can require an approval.
- The application itself is still not deployed anywhere. What is published is static files; the demo inside it is the same recorded preview the private artifact shows, with mock identities and synthetic data only. The docs/16 rule for a hosted demo of the running application (ask IT) is unchanged and still applies to anything with a backend or to any use on employer resources.

## Consequences (security, cost, operations, migration)

- The compiled web app and every mock user's recorded answers become public when the owner publishes. They hold synthetic data only; `check-employer-data` runs over the built folder in the build and in the workflow. The pages carry `noindex` unless the owner switches it off in the site's configuration.
- The static preview shows the access rules from per-user recordings; it does not enforce them (decision 0008). The site says so beside the demo.
- A production publish takes the domain over from whichever Worker holds it, without a prompt, when run outside a terminal (see Verification). The other repository will take the domain back on its next deploy while its configuration still names it: removing that line is a change in that repository for its owner to approve.
- A manually started workflow appears in the Actions tab only once the workflow file is on the default branch, so publishing needs this branch merged first.
- `wrangler` is a devDependency of `@pb/site` (pinned 4.146.0), so every install downloads its runtime packages. No new paid service: the host is the one the owner already uses.
- Nothing here touches Azure, the employer or any employer system.

## SEC IDs affected

SEC-6.6 (no real data outside approved environments: the site and its demo hold synthetic data only), SEC-17.5 (GitHub controls: actions pinned by tag with the note to pin by SHA, secrets only through the environment of one step). SEC-17.5 also asks for private repository visibility on a personal repo; this repository is public today, which is the owner's setting to confirm (nothing in it is real data).

## Verification (what was checked, docs/versions consulted)

- The host's documentation site is outside this session's allowed network, so the configuration was verified from the deploy tool itself, **wrangler 4.146.0** (the version the owner's other repository pins): `deploy --help` (a directory of static assets, `--name`, `--domains`, `--dry-run`), `config-schema.json` (`assets.directory`, `html_handling`, `not_found_handling` and their allowed values) and its source (an asset may be 25 MiB; outside a terminal a custom domain held by another Worker is overridden: `override_existing_origin` and `override_existing_dns_record` are set without a prompt).
- `wrangler deploy --dry-run` reads the built folder with this configuration. No real deploy was run and nothing was authenticated.
- The site's own check serves the built folder from a sub-path and verifies every link and asset, that no request leaves the origin, the demo opening and signing in, the videos and brochures, accessibility in light and dark, and a phone width.
- The workflow file parses but has never run: its first run is the owner's.
