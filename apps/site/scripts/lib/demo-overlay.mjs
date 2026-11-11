/* eslint-disable @typescript-eslint/explicit-module-boundary-types -- plain JavaScript shared by the media scripts; the shapes are written as JSDoc */
// What a demo recording draws over the preview so a first-time viewer can follow it: a title card
// while the app loads, a caption bar along the bottom of the frame, a pointer that glides to each
// target (Playwright's recordings carry no mouse pointer), a ripple on every click and a ring around
// the part of the page a caption talks about. All of it is decorative, ignores the pointer and
// lives outside the app's own root, so the app under it behaves exactly as it does in the demo.

export const CAPTION_HEIGHT = 92;

/**
 * Runs in the page before any of its scripts (context.addInitScript).
 * @param {{ tokens: string, title: string, subtitle: string, captionHeight: number }} options
 */
export function installOverlay(options) {
  const doc = globalThis.document;
  const css = `
${options.tokens}
#pbd-root, #pbd-root * { box-sizing: border-box; }
#pbd-root { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; font-family: var(--pb-font-ui); }
#pbd-caption { position: absolute; left: 0; right: 0; bottom: 0; height: ${options.captionHeight}px; display: flex; align-items: center; justify-content: center; padding: 0 56px; background: var(--pb-deep); border-top: 3px solid var(--pb-accent); color: var(--pb-on-deep); opacity: 0; transition: opacity 160ms ease; }
#pbd-caption.on { opacity: 1; }
#pbd-caption-text { margin: 0; max-width: 1080px; font-size: 25px; line-height: 1.28; font-weight: 500; letter-spacing: 0.005em; text-align: center; transition: opacity 100ms ease; }
#pbd-caption-text.swap { opacity: 0; }
#pbd-cursor { position: absolute; left: 0; top: 0; width: 28px; height: 28px; opacity: 0; transform: translate(640px, 320px); transition: transform 170ms cubic-bezier(0.3, 0.6, 0.3, 1), opacity 120ms ease; filter: drop-shadow(0 2px 3px rgba(var(--pb-text-rgb), 0.35)); }
#pbd-cursor.on { opacity: 1; }
.pbd-ripple { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid var(--pb-accent); background: rgba(var(--pb-accent-rgb), 0.22); animation: pbd-ripple 300ms ease-out forwards; }
@keyframes pbd-ripple { from { transform: scale(0.3); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }
#pbd-ring { position: absolute; border-radius: 12px; border: 3px solid var(--pb-accent); box-shadow: 0 0 0 6px rgba(var(--pb-accent-rgb), 0.18), 0 10px 30px -12px rgba(var(--pb-primary-rgb), 0.5); opacity: 0; transition: opacity 120ms ease; }
#pbd-ring.on { opacity: 1; }
#pbd-title { position: absolute; inset: 0; overflow: hidden; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; padding-top: 150px; text-align: center; background: linear-gradient(180deg, var(--pb-scene-sky-top) 0%, var(--pb-scene-sky-top) 22%, var(--pb-scene-sky) 61%, var(--pb-scene-sea-far) 61%, var(--pb-scene-sea-near) 84%, var(--pb-scene-sand) 84%, var(--pb-scene-sand-end) 100%); opacity: 1; transition: opacity 320ms ease; }
#pbd-title.off { opacity: 0; }
#pbd-title::before { content: ''; position: absolute; left: 0; right: 0; top: 61%; height: 1px; background: var(--pb-scene-horizon); }
#pbd-title::after { content: ''; position: absolute; left: 50%; top: calc(61% - 150px); width: 620px; height: 300px; margin-left: -310px; background: radial-gradient(ellipse 50% 50% at 50% 50%, var(--pb-scene-glow) 0%, transparent 70%); opacity: 0.8; }
#pbd-title > * { position: relative; z-index: 1; }
.pbd-wordmark { margin: 0 0 6px; font-family: var(--pb-font-display); font-size: 30px; line-height: 1.2; color: var(--pb-primary); letter-spacing: 0.01em; }
.pbd-kicker { margin: 0 0 44px; font-size: 13px; line-height: 1.4; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: var(--pb-accent-ink); }
.pbd-heading { margin: 0 0 16px; max-width: 980px; font-family: var(--pb-font-display); font-weight: 400; font-size: 62px; line-height: 1.08; letter-spacing: -0.01em; color: var(--pb-primary); }
.pbd-sub { margin: 0; max-width: 820px; font-size: 24px; line-height: 1.4; color: var(--pb-muted); }
.pbd-note { position: absolute !important; left: 0; right: 0; bottom: 34px; margin: 0; font-size: 16px; line-height: 1.4; font-weight: 600; letter-spacing: 0.04em; color: var(--pb-primary); }
`;
  const root = doc.createElement('div');
  root.id = 'pbd-root';
  root.setAttribute('aria-hidden', 'true');
  const style = doc.createElement('style');
  style.textContent = css;

  const title = doc.createElement('div');
  title.id = 'pbd-title';
  const line = (className, text, tag = 'p') => {
    const el = doc.createElement(tag);
    el.className = className;
    el.textContent = text;
    return el;
  };
  title.append(
    line('pbd-wordmark', 'Portfolio Beach'),
    line('pbd-kicker', 'Demo video'),
    line('pbd-heading', options.title),
    line('pbd-sub', options.subtitle),
    line(
      'pbd-note',
      'Prototype. Synthetic data only: no real firm, fund, company or person appears.',
    ),
  );

  const ring = doc.createElement('div');
  ring.id = 'pbd-ring';
  const cursor = doc.createElement('div');
  cursor.id = 'pbd-cursor';
  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 28 28');
  svg.setAttribute('width', '28');
  svg.setAttribute('height', '28');
  const arrow = doc.createElementNS(ns, 'path');
  arrow.setAttribute('d', 'M4 2 L4 22 L9.5 17 L13 25.5 L16.5 24 L13 15.8 L20.5 15.8 Z');
  arrow.setAttribute('fill', 'var(--pb-bg)');
  arrow.setAttribute('stroke', 'var(--pb-text)');
  arrow.setAttribute('stroke-width', '1.6');
  arrow.setAttribute('stroke-linejoin', 'round');
  svg.append(arrow);
  cursor.append(svg);

  const caption = doc.createElement('div');
  caption.id = 'pbd-caption';
  const captionText = doc.createElement('p');
  captionText.id = 'pbd-caption-text';
  caption.append(captionText);

  root.append(style, ring, cursor, caption, title);
  // An init script runs before the document has its root element: mount as soon as it exists,
  // so the title card covers the app while it loads.
  const mount = () => {
    if (doc.documentElement === null) return false;
    doc.documentElement.append(root);
    return true;
  };
  if (!mount()) {
    const observer = new globalThis.MutationObserver(() => {
      if (mount()) observer.disconnect();
    });
    observer.observe(doc, { childList: true });
  }

  let pointer = { x: 640, y: 320 };
  doc.addEventListener(
    'mousemove',
    (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      // The arrow's tip sits at the pointer.
      cursor.style.transform = `translate(${pointer.x - 4}px, ${pointer.y - 2}px)`;
    },
    true,
  );
  doc.addEventListener(
    'mousedown',
    () => {
      const ripple = doc.createElement('div');
      ripple.className = 'pbd-ripple';
      ripple.style.left = `${pointer.x}px`;
      ripple.style.top = `${pointer.y}px`;
      root.append(ripple);
      globalThis.setTimeout(() => ripple.remove(), 400);
    },
    true,
  );

  globalThis.__pbDemo = {
    caption(text) {
      if (text === '') {
        caption.classList.remove('on');
        return;
      }
      if (!caption.classList.contains('on')) {
        captionText.textContent = text;
        caption.classList.add('on');
        return;
      }
      captionText.classList.add('swap');
      globalThis.setTimeout(() => {
        captionText.textContent = text;
        captionText.classList.remove('swap');
      }, 100);
    },
    title(show) {
      title.classList.toggle('off', !show);
    },
    cursor(show) {
      cursor.classList.toggle('on', show);
    },
    /** Scrolls the window to a position over a short, eased glide. */
    scrollTo({ y, ms }) {
      const from = globalThis.scrollY;
      const max = doc.documentElement.scrollHeight - globalThis.innerHeight;
      const to = Math.max(0, Math.min(y, max));
      if (Math.abs(to - from) < 2) return Promise.resolve(false);
      const started = globalThis.performance.now();
      return new Promise((done) => {
        const step = (now) => {
          const k = Math.min(1, (now - started) / ms);
          const eased = 1 - (1 - k) ** 3;
          globalThis.scrollTo(0, from + (to - from) * eased);
          if (k < 1) globalThis.requestAnimationFrame(step);
          else done(true);
        };
        globalThis.requestAnimationFrame(step);
      });
    },
    ring(rect) {
      if (rect === null) {
        ring.classList.remove('on');
        return;
      }
      ring.style.left = `${rect.x}px`;
      ring.style.top = `${rect.y}px`;
      ring.style.width = `${rect.width}px`;
      ring.style.height = `${rect.height}px`;
      ring.classList.add('on');
    },
  };
}

/**
 * The Node side: paced actions for a recording. Every pause is deliberate; a viewer reads a
 * caption at about three words a second.
 * @param {import('@playwright/test').Page} page
 * @param {{ captionHeight?: number, debugFrame?: (label: string) => Promise<void> }} [options]
 */
export function director(page, options = {}) {
  const captionHeight = options.captionHeight ?? CAPTION_HEIGHT;
  const startedAt = Date.now();
  /** @type {{ at: number, text: string }[]} */
  const steps = [];
  /** @type {Buffer | null} */
  let posterPng = null;
  const wait = (ms) => page.waitForTimeout(ms);
  const call = (method, arg) =>
    page.evaluate(([m, a]) => globalThis.__pbDemo[m](a), [method, arg ?? null]);

  /** How long a caption needs on screen to be read: about three words a second, never under 2.4 seconds. */
  const readingTime = (text) => Math.max(2400, Math.round((text.split(/\s+/).length / 3.3) * 1000));
  let readableUntil = 0;

  /** Puts a caption up, after the one before it has had the time it needs to be read. */
  async function show(text) {
    const remaining = readableUntil - Date.now();
    if (remaining > 0) await wait(remaining);
    steps.push({ at: Math.round((Date.now() - startedAt) / 100) / 10, text });
    await call('caption', text);
    readableUntil = Date.now() + readingTime(text);
  }

  /** Shows a caption and holds the frame while it is read (a longer hold can be given). */
  async function say(text, hold) {
    await show(text);
    await wait(Math.max(hold ?? 0, readingTime(text)));
    if (options.debugFrame !== undefined) await options.debugFrame(text);
  }

  /** Shows a caption and returns at once: the next actions play while it is read. */
  async function caption(text) {
    await show(text);
    await wait(300);
  }

  /** Waits until the caption on screen has been up long enough to read. */
  async function finishCaption() {
    const remaining = readableUntil - Date.now();
    if (remaining > 0) await wait(remaining);
    if (options.debugFrame !== undefined) await options.debugFrame('caption');
  }

  const SCROLL_MS = 240;
  /** The top and bottom of the part of the frame the header and the caption bar leave free. */
  const FREE_TOP = 104;
  const freeBottom = () => (page.viewportSize()?.height ?? 720) - captionHeight - 20;

  /** Where the window must scroll so the target sits at the start or the center of the free area. */
  async function scrollTarget(locator, block) {
    return locator.evaluate(
      (el, { block, top, bottom }) => {
        const rect = el.getBoundingClientRect();
        const offset =
          block === 'start' ? top : top + Math.max(0, (bottom - top - rect.height) / 2);
        return rect.top + globalThis.scrollY - offset;
      },
      { block, top: FREE_TOP, bottom: freeBottom() },
    );
  }

  async function glide(y) {
    const moved = await call('scrollTo', { y, ms: SCROLL_MS });
    if (moved) await wait(260);
  }

  /** Scrolls the target into the free part of the frame, if it is not already there. */
  async function bring(locator, block = 'center') {
    const box = await locator.boundingBox();
    if (box === null) return;
    if (box.y >= FREE_TOP - 4 && box.y + box.height <= freeBottom()) return;
    await glide(await scrollTarget(locator, block));
  }

  /** Glides the pointer to the target, then clicks it. */
  async function click(locator, pause = 380) {
    await bring(locator);
    await locator.hover();
    await wait(340);
    await locator.click();
    await wait(pause);
  }

  /** Clicks a field and types into it at a pace a viewer can follow. */
  async function type(locator, text, pause = 450) {
    await bring(locator);
    await locator.hover();
    await wait(340);
    await locator.click();
    await locator.fill('');
    await locator.pressSequentially(text, { delay: 38 });
    await wait(pause);
  }

  /** Fills a field in one go (a date, a long amount) after gliding to it. */
  async function fill(locator, text, pause = 450) {
    await bring(locator);
    await locator.hover();
    await wait(340);
    await locator.fill(text);
    await wait(pause);
  }

  /** Picks an option of a dropdown by the label its field gives it. */
  async function pick(scope, combobox, option) {
    await click(scope.getByRole('combobox', { name: combobox }), 300);
    await click(page.getByRole('option', { name: option }).first(), 300);
  }

  /** Draws the ring around a part of the page. */
  async function ring(locator, block = 'center') {
    await bring(locator, block);
    const box = await locator.boundingBox();
    if (box === null) return;
    const pad = 6;
    const view = page.viewportSize() ?? { width: 1280, height: 720 };
    const x = Math.max(box.x - pad, 4);
    const y = Math.max(box.y - pad, 56);
    await call('ring', {
      x,
      y,
      width: Math.min(box.x + box.width + pad, view.width - 6) - x,
      height: Math.min(box.y + box.height + pad, view.height - captionHeight - 8) - y,
    });
    await wait(200);
  }
  const unring = () => call('ring', null);

  /** Scrolls the window so the target sits at the start or the center of the free area. */
  async function scrollTo(locator, block = 'start') {
    await unring();
    await glide(await scrollTarget(locator, block));
  }
  /** Scrolls the window by a number of pixels. */
  async function scrollBy(pixels) {
    await unring();
    await glide((await page.evaluate(() => globalThis.scrollY)) + pixels);
  }
  async function scrollTop() {
    await unring();
    await glide(0);
  }

  /** The frame the site shows before the video plays. */
  async function poster() {
    posterPng = await page.screenshot({ type: 'png' });
  }

  return {
    steps,
    wait,
    say,
    caption,
    finishCaption,
    bring,
    click,
    type,
    fill,
    pick,
    ring,
    unring,
    scrollTo,
    scrollBy,
    scrollTop,
    poster,
    getPoster: () => posterPng,
    showTitle: (show) => call('title', show),
    showCursor: (show) => call('cursor', show),
    clearCaption: () => call('caption', ''),
    elapsed: () => (Date.now() - startedAt) / 1000,
  };
}
