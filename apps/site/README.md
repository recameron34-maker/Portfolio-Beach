# @pb/site

The Portfolio Beach website: a static landing page with an overview of the tool, a feature tour with real screenshots, the controls it enforces, demo videos, brochures and the interactive demo itself. Synthetic data only, as everywhere in this repository: no real firm, fund, company or person appears.

It is a plain static folder. Every URL in it is relative, it asks nothing of any other origin (no CDN, no web font service, no analytics), and it works from any base path on any static host.

```bash
pnpm --filter @pb/site build            # everything, in order (about ten minutes)
pnpm --filter @pb/site build:site-only  # the pages only, reusing the media already generated
pnpm --filter @pb/site check            # the built site, served from a sub-path, in headless Chromium
pnpm --filter @pb/site serve            # look at apps/site/dist on http://127.0.0.1:4173/
pnpm --filter @pb/site start            # Vite dev server for the page (media must exist)
```

## What is in it

| Part | Where |
|---|---|
| The words | `src/content/site.ts`. One file, with the rules for it at the top: say only what the repository shows is built, mark the rest as planned or in progress, no number that is not in the repository, no real name, no em dashes. |
| The page | `src/render/` builds the markup when Vite builds (`vite.config.ts`); the browser renders nothing. `src/styles/site.css` is the stylesheet, `src/main.ts` the small behaviours (theme switch, menu, lightbox). The page is complete without script. |
| Colours and fonts | `scripts/lib/tokens.mjs` derives every colour from `config/brand.json`, light and dark, with the same kind of formulas as the web app's theme. The stylesheet, the brochures and the video captions read those custom properties and write no colour of their own. |
| The 404 page | `src/render/not-found.ts`: one self-contained file, since a host serves it at whatever address was not found. Its link goes to `/`; set `PB_SITE_BASE=/some/path/` at build time when the site lives under a sub-path. |
| The demo | The interactive preview of the web app (`apps/web/dist-preview`), copied to `dist/demo/` at build time. "Open the demo" goes to `demo/index.html`. |

Sections of the page: hero, overview (what it brings together, who uses it, how the work flows), feature tour (eight areas and the roadmap), controls and security, demo videos, brochures, the demo, footer.

## The media is generated, never committed

Everything visual comes from the interactive preview by script, so it can be made again when the tool changes. The output lives in `media/` (git-ignored) and is copied into `dist/media/` by the build.

| Script | Makes |
|---|---|
| `scripts/capture-screens.mjs` | Screenshots at 1440 by 900 with a device scale factor of 2, light theme, each taken as the mock user who holds the role for that screen. WebP at two widths, plus `media/screens/manifest.json`. `--only name,name` retakes some. |
| `scripts/record-demos.mjs` | Five recordings at 1280 by 720 with Playwright `recordVideo`: a title card, a caption bar that says what is happening, a visible pointer and pauses long enough to read each caption. WebM (VP8), a poster frame each, and a manifest with every recording's length, size and captions (the page prints the captions as a text list). `--only name` records one; `--frames <dir>` writes a still per caption to look at. |
| `scripts/make-brochures.mjs` | The HTML templates in `brochures/` rendered to Letter-size PDFs with `page.pdf()`, a cover thumbnail each, and a manifest with the page counts. It fails when a sheet's content would run past its footer. `--pages <dir>` writes every sheet as a PNG; `--ui-font "DejaVu Sans"` renders with another font to see that the sheets still fit. |
| `scripts/shoot-site.mjs` | Screenshots of the built site itself (desktop and phone, light and dark, whole page and each section), for looking at the design. |

`scripts/build.mjs` runs them in order: the preview when it is missing (`apps/web/scripts/build-preview.mjs`, after `tsc -b`), the screenshots, the recordings, the brochures, `vite build`, the copy of the demo, and the employer-data guard over the built folder. Pass `--fresh-preview` after the web app changed, so the media is taken from a new preview.

The scripts need Chromium. `PW_CHROMIUM_PATH` points at one; otherwise Playwright's own is used (`pnpm --filter @pb/site exec playwright install chromium`), or the preinstalled build of a cloud sandbox.

Two things to know about the recordings and screenshots:

- They use the system font stack, as the tool does, so they look like the machine that made them. The brochures are laid out to fit a wider font than the one they were designed with.
- A recording plays slightly longer than the script ran: Playwright writes every screen update as at least one frame at 25 frames a second, so anything that paints faster is slowed. The lengths the page shows are read from the files.

## Checks

`pnpm --filter @pb/site check` serves `dist` from `/portfolio-beach/` and fails on any of: a URL in `index.html` that is not relative; a link or asset that does not resolve; a request to another origin; a missing section, alt text or prototype notice; a video without a poster, a playable WebM source or its list of steps; a brochure link that is not a PDF; a text and background pair of the tokens under 4.5 to 1 (light and dark); a serious or critical axe finding on the landing page or the 404 page, light and dark, at 1440 and 390 pixels wide; a horizontal scroll at either width; a demo that does not open, sign in and render the portfolio from the sub-path.

The repository's own gates cover the source: `pnpm typecheck`, `pnpm lint`, `bash scripts/check-style.sh` and `bash scripts/check-employer-data.sh` (stage new files first: both read tracked files).

## Hosting the folder

`apps/site/dist` is the whole site. Any static host will do: upload the folder as it is and point the host at it.

- Serve `index.html` for a directory address, with the right content types for `.webp`, `.webm` and `.pdf`.
- Serve `404.html` with status 404 for an address that matches no file, if the host offers that.
- No rewrite rule is needed. The demo routes by the URL hash, so it works from a plain file server.
- The largest file is a demo recording of a few megabytes; no file is over 12 MB.

## Publishing

The repository carries one way to publish: `.github/workflows/site.yml` builds the site, checks it and deploys it as static assets on a Cloudflare Worker with wrangler (`wrangler.toml`). It runs only when a person starts it. Nothing in this repository deploys on a push, and no domain, account or secret is written in any file.

Steps for the owner:

1. **Secrets.** In this repository, under Settings > Secrets and variables > Actions, add the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (the same token and account the repository that serves the domain today uses).
2. **The domain.** On the Variables tab of the same page, add the variable `SITE_DOMAIN` with the domain the site should answer on, for example `www.example.com`. It lives only there, so it can be changed later without a code change.
3. **An approval, if you want one.** Under Settings > Environments, open `site-production` (it appears after the first production run, or create it first) and add yourself as a required reviewer. A production run then waits for your approval.
4. **Preview first.** Actions > site > Run workflow, with `target` left at `preview`. It deploys a Worker named `portfolio-beach-site-preview` to its workers.dev address, which the run's log prints. Look at it there.
5. **Then production.** Run the workflow again with `target` set to `production`. It deploys the Worker `portfolio-beach-site` to `SITE_DOMAIN`.

What to expect:

- **A production run takes the domain over** from whichever Worker holds it now. Wrangler does not ask when it is not run in a terminal. The site answers on the domain within a minute or so of the run.
- **The other repository will take the domain back on its next deploy** for as long as its configuration names the domain (the `routes` line of its wrangler file). Removing that line is a change to that repository, and yours to approve there.
- **Without the two secrets nothing is deployed.** The run still builds and checks the site, says so in a notice, and ends green; the built folder is the workflow artifact `portfolio-beach-site`, kept for 14 days.
- **A production run with `SITE_DOMAIN` empty fails** with a message that says which variable to set.
- **The workflow appears in the Actions tab only once its file is on the default branch.** A manually triggered workflow on another branch cannot be started from the web page.
- The page carries `<meta name="robots" content="noindex">`, so search engines are asked not to list it. Remove that line from `index.html` if the site should be found.

To check the wrangler configuration on a machine without credentials: `pnpm --filter @pb/site deploy:dry-run` (after a build). It reads `dist`, uploads nothing and needs no account.
