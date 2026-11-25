import { html, trusted } from './html.js';
import type { Markup } from './html.js';

/**
 * The site's own small line icons, drawn on a 24 unit grid with one stroke width. They are
 * decorative: every one sits beside the words it stands for and is hidden from assistive technology.
 */
const PATHS = {
  // Deal team: a compass.
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="M15.4 8.6l-1.9 4.9-4.9 1.9 1.9-4.9z"/>',
  // Operations and staging: stacked layers.
  layers: '<path d="M12 4l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 16l8 4 8-4"/>',
  // Approvers: a seal with a check.
  seal: '<circle cx="12" cy="10" r="6"/><path d="M9.4 10.2l1.8 1.8 3.4-3.6"/><path d="M8.5 15l-1.2 5.2L12 18l4.7 2.2L15.5 15"/>',
  // People: two figures.
  people:
    '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c.4-3.1 2.6-5 5.5-5s5.1 1.9 5.5 5"/><circle cx="16.8" cy="9.5" r="2.3"/><path d="M16.5 14.2c2.3.2 3.7 1.8 4 4.3"/>',
  // The audit trail: a ruled page.
  ledger:
    '<path d="M6 3.5h9l3.5 3.5v13.5H6z"/><path d="M15 3.5V7h3.5"/><path d="M9 11h6.5M9 14h6.5M9 17h4"/>',
  // Roles: a key.
  key: '<circle cx="8" cy="15.5" r="4"/><path d="M11 12.6L19.5 4"/><path d="M16 7.5l2.5 2.5M13.6 9.9l1.8 1.8"/>',
  // Walls: courses of brick.
  wall: '<rect x="3.5" y="5" width="17" height="14" rx="1"/><path d="M3.5 9.7h17M3.5 14.3h17M9 5v4.7M15 5v4.7M12 9.7v4.6M9 14.3V19M15 14.3V19"/>',
  // The lock.
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5"/><path d="M12 14.2v2.4"/>',
  // The callback: a handset.
  phone:
    '<path d="M6.2 4h3l1.5 4-2 1.4a10.5 10.5 0 005.9 5.9l1.4-2 4 1.5v3c0 1-.8 1.9-1.9 1.8C10.3 19 5 13.7 4.4 5.9 4.3 4.8 5.2 4 6.2 4z"/>',
  // Human review: an eye over a tick.
  review:
    '<path d="M2.8 11.5C4.8 7.9 8.1 6 12 6s7.2 1.9 9.2 5.5c-2 3.6-5.3 5.5-9.2 5.5s-7.2-1.9-9.2-5.5z"/><path d="M9.3 11.6l1.9 1.9 3.6-3.8"/>',
  // Synthetic data: a flask (made for the test, never taken from a record).
  flask:
    '<path d="M9 3.5h6"/><path d="M10 3.5v5.3L5.2 17.6c-.6 1.3.3 2.9 1.8 2.9h10c1.5 0 2.4-1.6 1.8-2.9L14 8.8V3.5"/><path d="M7.6 14.5h8.8"/>',
  // Play.
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  // An arrow to the right.
  arrow: '<path d="M5 12h13.5M13 6.5l5.5 5.5-5.5 5.5"/>',
  // Download.
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>',
  // A tick.
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  // The sun and the moon for the theme switch.
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3L7 7M17 17l1.7 1.7M5.3 18.7L7 17M17 7l1.7-1.7"/>',
  moon: '<path d="M20 14.2A8.3 8.3 0 019.8 4a8.3 8.3 0 1010.2 10.2z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function isIconName(name: string): name is IconName {
  return name in PATHS;
}

export function icon(name: IconName, size = 24): Markup {
  return html`<svg
    class="icon"
    viewBox="0 0 24 24"
    width="${size}"
    height="${size}"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    ${trusted(PATHS[name])}
  </svg>`;
}
