/**
 * The site's small behaviours. The page is complete without this file: every section is static
 * markup, the links work, the videos have their own controls. Script adds the theme switch, the
 * menu on a small screen, the rise of a block as it enters the view, the screenshot lightbox,
 * the mark on the current section's link and a note when the browser cannot play WebM.
 */
const root = document.documentElement;
// The mark that script runs. The document sets it before first paint; a host that wraps the
// page in its own document (the artifact build) has no such script, so it is set here too.
root.classList.add('js');
const THEME_KEY = 'pb-site-theme';
type Theme = 'light' | 'dark';

const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
// As the tool reads it (apps/web/src/components/motion.ts): reduced motion, or a slow display.
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce), (update: slow)');
/** Blocks that enter the view together arrive in turn, the sixth and later with the sixth (site.css). */
const REVEAL_STAGGER_MAX = 5;

function currentTheme(): Theme {
  const chosen = root.getAttribute('data-theme');
  if (chosen === 'light' || chosen === 'dark') return chosen;
  return prefersDark.matches ? 'dark' : 'light';
}

function themeSwitch(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
  const label = document.querySelector<HTMLElement>('[data-theme-label]');
  if (button === null) return;
  const describe = (): void => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    if (label !== null) label.textContent = `Switch to the ${next} theme`;
  };
  button.hidden = false;
  describe();
  button.addEventListener('click', () => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage blocked: the choice holds until the page is reloaded.
    }
    describe();
  });
  prefersDark.addEventListener('change', describe);
}

function header(): void {
  const bar = document.querySelector<HTMLElement>('[data-header]');
  const toggle = document.querySelector<HTMLButtonElement>('[data-menu-toggle]');
  if (bar === null || toggle === null) return;
  const setOpen = (open: boolean): void => {
    bar.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => {
    setOpen(!bar.classList.contains('is-open'));
  });
  bar.querySelectorAll<HTMLAnchorElement>('.site-nav a').forEach((link) => {
    link.addEventListener('click', () => {
      setOpen(false);
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && bar.classList.contains('is-open')) {
      setOpen(false);
      toggle.focus();
    }
  });
}

/** Marks the link of the section that holds the middle of the view. */
function currentSection(): void {
  const links = new Map<string, HTMLAnchorElement>();
  document.querySelectorAll<HTMLAnchorElement>('.site-nav a[href^="#"]').forEach((link) => {
    links.set(link.hash.slice(1), link);
  });
  const sections = [...links.keys()]
    .map((id) => document.getElementById(id))
    .filter((section): section is HTMLElement => section !== null);
  if (sections.length === 0 || !('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const link = links.get(entry.target.id);
        if (link === undefined) continue;
        if (entry.isIntersecting) {
          links.forEach((other) => {
            other.removeAttribute('aria-current');
          });
          link.setAttribute('aria-current', 'true');
        } else if (link.getAttribute('aria-current') === 'true') {
          link.removeAttribute('aria-current');
        }
      }
    },
    { rootMargin: '-45% 0px -50% 0px' },
  );
  sections.forEach((section) => {
    observer.observe(section);
  });
}

/**
 * A block rises into place the first time it enters the view, once. What is already in view
 * stays put; blocks that enter together (a row of the grid) arrive one after the other.
 */
function reveal(): void {
  const blocks = [...document.querySelectorAll<HTMLElement>('[data-reveal]')];
  if (blocks.length === 0 || prefersReducedMotion.matches || !('IntersectionObserver' in window))
    return;
  for (const block of blocks)
    if (block.getBoundingClientRect().top < window.innerHeight) block.classList.add('is-in');
  root.classList.add('reveal-ready');
  const observer = new IntersectionObserver(
    (entries) => {
      entries
        .filter((entry) => entry.isIntersecting)
        .forEach((entry, i) => {
          const block = entry.target as HTMLElement;
          block.style.setProperty('--reveal-i', String(Math.min(i, REVEAL_STAGGER_MAX)));
          block.classList.add('is-in');
          observer.unobserve(block);
        });
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  blocks
    .filter((block) => !block.classList.contains('is-in'))
    .forEach((block) => {
      observer.observe(block);
    });
}

/** A click on a screenshot opens the large file in a dialog. Without <dialog> the link opens the image. */
function lightbox(): void {
  const dialog = document.querySelector<HTMLDialogElement>('[data-lightbox-dialog]');
  const image = document.querySelector<HTMLImageElement>('[data-lightbox-image]');
  if (dialog === null || image === null || typeof dialog.showModal !== 'function') return;
  document.querySelectorAll<HTMLAnchorElement>('a[data-lightbox]').forEach((link) => {
    link.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      const shown = link.querySelector('img');
      // The shape of the picture is known before it loads, so the dialog opens at its size.
      if (shown !== null && shown.width > 0 && shown.height > 0)
        image.style.aspectRatio = `${shown.width} / ${shown.height}`;
      image.src = link.href;
      image.alt = shown?.alt ?? '';
      dialog.showModal();
    });
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    image.removeAttribute('src');
  });
}

/** The recordings are WebM. Where a browser cannot play it, say so beside the poster. */
function videoSupport(): void {
  document.querySelectorAll<HTMLVideoElement>('video[data-video]').forEach((video) => {
    const note = video.closest('.video')?.querySelector<HTMLElement>('[data-video-unsupported]');
    if (note === null || note === undefined) return;
    const show = (): void => {
      note.hidden = false;
    };
    if (video.canPlayType('video/webm; codecs="vp8"') === '') show();
    video.querySelector('source')?.addEventListener('error', show);
  });
}

themeSwitch();
header();
currentSection();
reveal();
lightbox();
videoSupport();
