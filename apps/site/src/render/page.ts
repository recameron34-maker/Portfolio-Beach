/**
 * The landing page, rendered to static markup at build time. Every media URL is relative
 * ("media/..."), so the built folder works from any base path and on any static host.
 */
import {
  BROCHURES,
  CONTROLS,
  DEMO,
  HERO,
  NAV,
  OVERVIEW,
  SITE,
  TOUR,
  VIDEOS,
} from '../content/site.js';
import type { Feature, RoadmapStatus } from '../content/site.js';
import { html } from './html.js';
import type { Markup } from './html.js';
import { icon, isIconName } from './icons.js';
import { lengthText, sizeText } from './media.js';
import type { Brochure, DemoVideo, Media } from './media.js';
import { crest, ripple, scene } from './scene.js';

function namedIcon(name: string, size = 24): Markup {
  if (!isIconName(name)) throw new Error(`the site has no icon named ${name}`);
  return icon(name, size);
}

/** Keeps a hyphenated term on one line: in large centred type a break after its hyphen reads badly. */
function unbroken(text: string, term: string): Markup {
  const at = text.indexOf(term);
  if (at === -1) return html`${text}`;
  return html`${text.slice(0, at)}<span class="nowrap">${term}</span>${text.slice(
      at + term.length,
    )}`;
}

/** What a build may change about the page. */
export interface PageOptions {
  /**
   * Where "Open the demo" goes. The site's own build copies the demo in and links to it
   * (SITE.demoHref); a build without the demo passes the address it was given, or null to leave
   * the action out.
   */
  demoHref?: string | null;
}

/** "Open the demo": always in a new tab, so the site stays open behind it. */
function demoLink(href: string, label: string, classes: string, withArrow: boolean): Markup {
  return html`<a class="${classes}" href="${href}" target="_blank" rel="noopener"
    >${label}${withArrow ? icon('arrow', 18) : null}<span class="visually-hidden">
      ${SITE.newTab}</span
    ></a
  >`;
}

function eyebrow(text: string): Markup {
  return html`<p class="eyebrow">${text}${ripple()}</p>`;
}

/** A screenshot from the media folder at two widths. A click opens the large one. */
function screenshot(
  media: Media,
  name: string,
  alt: string,
  options: { sizes: string; eager?: boolean },
): Markup {
  const shot = media.screens.get(name);
  if (shot === undefined)
    throw new Error(
      `the screenshot "${name}" is not in media/screens/manifest.json: run scripts/capture-screens.mjs`,
    );
  const base = 'media/screens';
  return html`<a
    class="shot"
    href="${base}/${shot.file2x}"
    data-lightbox
    aria-label="Enlarge the screenshot: ${alt}"
  >
    <img
      src="${base}/${shot.file}"
      srcset="${base}/${shot.file} ${shot.width}w, ${base}/${shot.file2x} ${shot.width * 2}w"
      sizes="${options.sizes}"
      width="${shot.width}"
      height="${shot.height}"
      alt="${alt}"
      loading="${options.eager === true ? 'eager' : 'lazy'}"
      decoding="async"
    />
  </a>`;
}

function header(demoHref: string | null): Markup {
  return html`<header class="site-header" data-header>
    <div class="container site-header-inner">
      <a class="wordmark" href="#top">${SITE.name}</a>
      <button
        class="icon-button menu-toggle"
        type="button"
        aria-expanded="false"
        aria-controls="site-nav"
        data-menu-toggle
      >
        <span class="visually-hidden">Menu</span>
        <span class="menu-open">${icon('menu', 22)}</span>
        <span class="menu-close">${icon('close', 22)}</span>
      </button>
      <nav class="site-nav" id="site-nav" aria-label="Sections">
        <ul>
          ${NAV.map((item) => html`<li><a href="${item.href}">${item.label}</a></li>`)}
        </ul>
      </nav>
      <div class="site-header-actions">
        <button class="icon-button theme-toggle" type="button" data-theme-toggle hidden>
          <span class="visually-hidden" data-theme-label>Switch to the dark theme</span>
          <span class="theme-sun">${icon('sun', 20)}</span>
          <span class="theme-moon">${icon('moon', 20)}</span>
        </button>
        ${demoHref === null ? null : demoLink(demoHref, HERO.primary, 'button button-small', false)}
      </div>
    </div>
  </header>`;
}

function hero(demoHref: string | null): Markup {
  return html`<section class="hero" id="top" aria-labelledby="hero-title">
    ${scene()}
    <div class="container hero-inner">
      <p class="chip">
        <span class="chip-mark">${SITE.notice}</span>
        <span>${SITE.noticeDetail}</span>
      </p>
      <h1 id="hero-title">${HERO.title}</h1>
      <p class="hero-lead">${unbroken(HERO.lead, 'co-investment')}</p>
      <div class="actions">
        ${demoHref === null ? null : demoLink(demoHref, HERO.primary, 'button', true)}
        <a class="button button-quiet" href="#videos">${icon('play', 18)}${HERO.secondary}</a>
      </div>
      <p class="hero-note">${HERO.note}</p>
    </div>
  </section>`;
}

function overview(media: Media): Markup {
  const { together, roles, flow, heroShot } = OVERVIEW;
  return html`<section
    class="band band-plain overview"
    id="overview"
    aria-labelledby="overview-title"
  >
    <div class="container">
      <figure class="lead-shot" data-reveal>
        ${screenshot(media, heroShot.name, heroShot.alt, {
          sizes: '(min-width: 1240px) 1100px, 94vw',
          eager: true,
        })}
        <figcaption>${heroShot.caption}</figcaption>
      </figure>

      <div class="section-head" data-reveal>
        ${eyebrow(OVERVIEW.eyebrow)}
        <h2 id="overview-title">${OVERVIEW.title}</h2>
        <p class="lead">${OVERVIEW.lead}</p>
      </div>

      <div class="together" data-reveal>
        <h3 class="visually-hidden">${together.title}</h3>
        <div class="together-from">
          <p class="together-label">${together.fromLabel}</p>
          <ul class="scatter">
            ${together.from.map((item) => html`<li>${item}</li>`)}
          </ul>
        </div>
        <div class="together-arrow" aria-hidden="true">${icon('arrow', 28)}</div>
        <div class="together-to">
          <p class="together-label">${together.toLabel}</p>
          <ul class="ticks">
            ${together.to.map((item) => html`<li>${icon('check', 18)}<span>${item}</span></li>`)}
          </ul>
        </div>
        <p class="together-boundary">${together.boundary}</p>
      </div>

      <div class="subsection" data-reveal>
        <h3 class="subhead">${roles.title}</h3>
        <ul class="roles">
          ${roles.items.map(
            (role) =>
              html`<li class="role">
                <span class="role-icon">${namedIcon(role.icon)}</span>
                <h4>${role.name}</h4>
                <p>${role.text}</p>
              </li>`,
          )}
        </ul>
        <p class="fine">${roles.also}</p>
      </div>

      <div class="subsection" data-reveal>
        <h3 class="subhead">${flow.title}</h3>
        <ol class="flow">
          ${flow.steps.map(
            (step, i) =>
              html`<li class="flow-step">
                <span class="flow-mark" aria-hidden="true">${i + 1}</span>
                <h4>${step.name}</h4>
                <p>${step.text}</p>
              </li>`,
          )}
        </ol>
      </div>
    </div>
  </section>`;
}

function feature(media: Media, item: Feature, index: number): Markup {
  return html`<article
    class="feature ${index % 2 === 1 ? 'feature-flip' : ''}"
    id="tour-${item.id}"
    data-reveal
  >
    <div class="feature-text">
      <p class="feature-kicker">
        <span class="feature-number" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
        ${item.kicker}
      </p>
      <h3>${item.title}</h3>
      <p>${item.body}</p>
      <ul class="points">
        ${item.points.map((point) => html`<li>${point}</li>`)}
      </ul>
    </div>
    <div class="feature-media">
      <figure class="feature-shot">
        ${screenshot(media, item.shot, item.alt, { sizes: '(min-width: 1000px) 680px, 94vw' })}
        <figcaption>${item.caption}</figcaption>
      </figure>
      ${
        item.more === undefined
          ? null
          : html`<div class="feature-more">
              ${item.more.map(
                (extra) =>
                  html`<figure class="feature-shot">
                    ${screenshot(media, extra.shot, extra.alt, {
                      sizes: '(min-width: 1000px) 330px, 46vw',
                    })}
                    <figcaption>${extra.caption}</figcaption>
                  </figure>`,
              )}
            </div>`
      }
    </div>
  </article>`;
}

const inProgress = (status: RoadmapStatus): boolean => status === 'In progress';

function tour(media: Media): Markup {
  const { roadmap } = TOUR;
  const features: readonly Feature[] = TOUR.features;
  return html`<section class="band band-sand tour" id="tour" aria-labelledby="tour-title">
    ${crest()}
    <div class="container">
      <div class="section-head" data-reveal>
        ${eyebrow(TOUR.eyebrow)}
        <h2 id="tour-title">${TOUR.title}</h2>
        <p class="lead">${TOUR.lead}</p>
        <nav class="tour-nav" aria-label="${TOUR.jumpLabel}">
          <ol>
            ${features.map(
              (item, i) =>
                html`<li>
                  <a href="#tour-${item.id}"
                    ><span aria-hidden="true">${String(i + 1).padStart(2, '0')}</span
                    >${item.short}</a
                  >
                </li>`,
            )}
          </ol>
        </nav>
      </div>
      <div class="features">${features.map((item, i) => feature(media, item, i))}</div>

      <div class="roadmap" data-reveal>
        <div class="roadmap-head">
          <h3 class="subhead">${roadmap.title}</h3>
          <p>${roadmap.lead}</p>
        </div>
        <ul class="roadmap-list">
          ${roadmap.items.map(
            (item) =>
              html`<li>
                <span class="status ${inProgress(item.status) ? 'status-progress' : ''}"
                  >${item.status}</span
                >
                <h4>${item.name}</h4>
                <p>${item.text}</p>
              </li>`,
          )}
        </ul>
      </div>
    </div>
  </section>`;
}

function controls(): Markup {
  return html`<section
    class="band band-deep controls"
    id="controls"
    aria-labelledby="controls-title"
  >
    ${crest()}
    <div class="container">
      <div class="section-head" data-reveal>
        ${eyebrow(CONTROLS.eyebrow)}
        <h2 id="controls-title">${CONTROLS.title}</h2>
        <p class="lead">${CONTROLS.lead}</p>
      </div>
      <ul class="control-grid">
        ${CONTROLS.items.map(
          (item) =>
            html`<li class="control" data-reveal>
              <span class="control-icon">${namedIcon(item.icon)}</span>
              <h3>${item.name}</h3>
              <p>${item.text}</p>
            </li>`,
        )}
      </ul>
      <p class="boundary" data-reveal>${CONTROLS.boundary}</p>
    </div>
  </section>`;
}

/**
 * One recording. `wide` gives it the full row with its text beside it: the first one, and the
 * last one when it would otherwise sit alone in a row of two (then mirrored, text first).
 */
function video(item: DemoVideo, wide: boolean, mirrored: boolean): Markup {
  const base = 'media/videos';
  return html`<article
    class="video ${wide ? 'video-featured' : ''} ${mirrored ? 'video-flip' : ''}"
    data-reveal
  >
    <div class="video-frame">
      <video
        controls
        playsinline
        preload="none"
        poster="${base}/${item.poster}"
        width="${item.width}"
        height="${item.height}"
        aria-label="Demo video: ${item.title}"
        data-video
      >
        <source src="${base}/${item.file}" type="video/webm" />
        <a href="${base}/${item.file}">Download the recording of ${item.title} (WebM)</a>
      </video>
    </div>
    <div class="video-text">
      <h3>${item.title}</h3>
      <p>${item.summary}</p>
      <p class="meta">${lengthText(item.seconds)} · ${sizeText(item.bytes)} · no sound</p>
      <p class="video-unsupported" data-video-unsupported hidden>${VIDEOS.unsupported}</p>
      <details class="steps">
        <summary>${VIDEOS.stepsLabel}</summary>
        <ol>
          ${item.steps.map((step) => html`<li>${step.text}</li>`)}
        </ol>
      </details>
    </div>
  </article>`;
}

function videos(media: Media): Markup {
  return html`<section class="band band-plain videos" id="videos" aria-labelledby="videos-title">
    ${crest()}
    <div class="container">
      <div class="section-head" data-reveal>
        ${eyebrow(VIDEOS.eyebrow)}
        <h2 id="videos-title">${VIDEOS.title}</h2>
        <p class="lead">${VIDEOS.lead}</p>
      </div>
      <div class="video-grid">
        ${media.videos.map((item, i) => {
          // After the first, the recordings pair up; an odd one out closes the section at full width.
          const alone = i > 0 && i === media.videos.length - 1 && i % 2 === 1;
          return video(item, i === 0 || alone, alone);
        })}
      </div>
    </div>
  </section>`;
}

function brochure(item: Brochure): Markup {
  const base = 'media/brochures';
  return html`<article class="brochure" data-reveal>
    <a
      class="brochure-cover"
      href="${base}/${item.file}"
      aria-label="Open the brochure: ${item.title} (PDF)"
    >
      <img
        src="${base}/${item.cover}"
        width="612"
        height="792"
        alt="The cover page of the brochure ${item.title}"
        loading="lazy"
        decoding="async"
      />
    </a>
    <div class="brochure-text">
      <h3>${item.title}</h3>
      <p>${item.description}</p>
      <p class="meta">${item.pages} pages · PDF · ${sizeText(item.bytes)}</p>
      <a class="button button-quiet button-small" href="${base}/${item.file}" download
        >${icon('download', 18)}${BROCHURES.download}<span class="visually-hidden"
          >: ${item.title}</span
        ></a
      >
    </div>
  </article>`;
}

function brochures(media: Media): Markup {
  return html`<section
    class="band band-sand brochures"
    id="brochures"
    aria-labelledby="brochures-title"
  >
    ${crest()}
    <div class="container">
      <div class="section-head" data-reveal>
        ${eyebrow(BROCHURES.eyebrow)}
        <h2 id="brochures-title">${BROCHURES.title}</h2>
        <p class="lead">${BROCHURES.lead}</p>
      </div>
      <div class="brochure-grid">${media.brochures.map(brochure)}</div>
    </div>
  </section>`;
}

function demo(demoHref: string | null): Markup {
  return html`<section class="band band-shore demo" id="demo" aria-labelledby="demo-title">
    ${crest()}
    <div class="container demo-inner" data-reveal>
      <div class="demo-text">
        ${eyebrow(DEMO.eyebrow)}
        <h2 id="demo-title">${DEMO.title}</h2>
        <p class="lead">${DEMO.lead}</p>
        ${
          demoHref === null
            ? html`<p class="fine">${DEMO.unlinked}</p>`
            : demoLink(demoHref, DEMO.action, 'button', true)
        }
      </div>
      <div class="demo-card">
        <ul class="ticks">
          ${DEMO.points.map((point) => html`<li>${icon('check', 18)}<span>${point}</span></li>`)}
        </ul>
        <p class="fine">${DEMO.note}</p>
      </div>
    </div>
  </section>`;
}

function footer(): Markup {
  return html`<footer class="site-footer">
    ${crest()}
    <div class="container site-footer-inner">
      <p class="wordmark wordmark-footer">${SITE.name}</p>
      <p class="footer-notice">${SITE.footer}</p>
    </div>
  </footer>`;
}

/** The lightbox a screenshot opens in. Filled by src/main.ts; without script the link opens the image itself. */
function lightbox(): Markup {
  return html`<dialog class="lightbox" data-lightbox-dialog aria-label="Screenshot, enlarged">
    <form method="dialog">
      <button class="icon-button lightbox-close" type="submit">
        <span class="visually-hidden">Close the screenshot</span>${icon('close', 22)}
      </button>
    </form>
    <img alt="" data-lightbox-image />
  </dialog>`;
}

export function renderPage(media: Media, options: PageOptions = {}): string {
  const demoHref = options.demoHref === undefined ? SITE.demoHref : options.demoHref;
  return html`<a class="skip-link" href="#main">Skip to the content</a>
    ${header(demoHref)}
    <main id="main">
      ${hero(demoHref)} ${overview(media)} ${tour(media)} ${controls()} ${videos(media)}
      ${brochures(media)} ${demo(demoHref)}
    </main>
    ${footer()} ${lightbox()}`.value;
}
