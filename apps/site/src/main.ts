/**
 * The site's small behaviours. The page is complete without this file: every section is static
 * markup, the links work, the videos have their own controls. Script adds the theme switch, the
 * menu on a small screen, the rise of a block as it enters the view, the screenshot lightbox,
 * the mark on the current section's link and a note when the browser cannot play WebM.
 */
const root = document.documentElement;
const THEME_KEY = 'pb-site-theme';
type Theme = 'light' | 'dark';

const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

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
  if (bar === null) return;
  const onScroll = (): void => {
    bar.classList.toggle('is-scrolled', window.scrollY > 12);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
  if (toggle === null) return;
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

/** A block rises into place the first time it enters the view. What is already in view stays put. */
function reveal(): void {
  const blocks = [...document.querySelectorAll<HTMLElement>('[data-reveal]')];
  if (blocks.length === 0 || prefersReducedMotion.matches || !('IntersectionObserver' in window))
    return;
  for (const block of blocks)
    if (block.getBoundingClientRect().top < window.innerHeight) block.classList.add('is-in');
  root.classList.add('reveal-ready');
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-in');
        observer.unobserve(entry.target);
      }
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
