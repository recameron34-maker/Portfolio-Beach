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
- `wrangler` is a devDependency of `@pb/site` (pinned 4.146.0 when this was written; 4.161.0 since decision 0016, for the advisories in its runtime's dependencies, with the dry run repeated), so every install downloads its runtime packages. No new paid service: the host is the one the owner already uses.
- Nothing here touches Azure, the employer or any employer system.

## SEC IDs affected

SEC-6.6 (no real data outside approved environments: the site and its demo hold synthetic data only), SEC-17.5 (GitHub controls: actions pinned by tag with the note to pin by SHA, secrets only through the environment of one step). SEC-17.5 also asks for private repository visibility on a personal repo; this repository is public today, which is the owner's setting to confirm (nothing in it is real data).

## Verification (what was checked, docs/versions consulted)

- The host's documentation site is outside this session's allowed network, so the configuration was verified from the deploy tool itself, **wrangler 4.146.0** (the version the owner's other repository pins): `deploy --help` (a directory of static assets, `--name`, `--domains`, `--dry-run`), `config-schema.json` (`assets.directory`, `html_handling`, `not_found_handling` and their allowed values) and its source (an asset may be 25 MiB; outside a terminal a custom domain held by another Worker is overridden: `override_existing_origin` and `override_existing_dns_record` are set without a prompt).
- `wrangler deploy --dry-run` reads the built folder with this configuration. No real deploy was run and nothing was authenticated.
- The site's own check serves the built folder from a sub-path and verifies every link and asset, that no request leaves the origin, the demo opening and signing in, the videos and brochures, accessibility in light and dark, and a phone width.
- The workflow file parses but has never run: its first run is the owner's.

## Amendment, 2026-11-12: the owner connected Cloudflare's own build

While the site was being built, the owner connected this repository to the host's own build (it installs the workspace, runs the repository's build and then `npx wrangler deploy` from the repository root on every push to `main`). Its first run failed, as expected: `main` had no site yet and the repository root had no wrangler configuration. The owner asked for the simplest path, so that connection is now the one way to publish, and the manual workflow with repository secrets is gone:

- `wrangler.toml` moved to the repository root. It names the folder (`apps/site/dist`), runs the site's build itself before reading it (`[build] command`, verified with a dry run on wrangler 4.146.0: an assets-only configuration runs its build command first), and carries the domain in one `routes` line. Inside the host's build wrangler uses the connected Worker's name whatever the file says (read in its source: the name is overridden, with a warning).
- The host's build cannot run a browser, so the generated screenshots, recordings and brochures are committed under `apps/site/media` (tens of megabytes) and regenerated in a development session when the tool changes. The interactive preview needs no browser and is built there.
- `.github/workflows/site.yml` now only builds and checks the site by hand; it holds no secret and publishes nothing.
- This departs from the letter of CLAUDE.md ("deployment happens only in GitHub Actions after human approval") by the owner's own choice for this static site: the human approval is the merge to `main`. The application is still deployed nowhere.
- The first build after the merge to `main` is the real test: nothing here could run the host's build. The owner pastes its log if it fails.

## Amendment, 2026-11-12: the first publish

- After the repository went private the host's build could no longer see it ("The project is linked to a repository that no longer exists"). The owner reconnected it the same day.
- The owner ran the production build from `main`. It published, and cameroncastle.com serves the Portfolio Beach site (read from the session once the owner allowed the host: the page's title and opening lines are the site's).
- **The host's builds of other branches fail, and the cause is not known yet.** On every push to the open pull request's branch the host reports two failed checks: one within seconds ("Preview creation failed: This Worker does not exist on your account") and one after the build has run for about two minutes, with no message on GitHub. This happened before the first publish and still happens after it, so "the Worker did not exist yet" does not explain it. The site's own build passes when run by hand at the same commit, production publishes, and the log of the failed build is only in the host's dashboard, which the session cannot read.
- Until the log is read, the choice is the owner's: paste the log of a failed branch build so the cause can be found, or switch off builds for branches other than `main` in the host's settings. Branch previews are not needed for anything: the site publishes from `main` only.
- These checks are the host's and are not part of the repository's gate (guard, security, ci, e2e).

