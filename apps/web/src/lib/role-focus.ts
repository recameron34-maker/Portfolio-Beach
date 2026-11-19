import { z } from 'zod';
import focusJson from '../../../../config/role_focus.json';
import {
  ADMIN_TABS,
  ANALYTICS_TABS,
  CAPITAL_TABS,
  DATA_LINKS,
  DOCUMENTS_TABS,
  NAV_GROUPS,
  PORTFOLIO_TABS,
  REPORTING_TABS,
  VALUATION_TABS,
} from '../app/nav.js';
import type { Role } from './roles.js';

/**
 * What each role sees first (config/role_focus.json): the order of the main navigation, the order
 * of the tabs inside an area and the work the home page lists. It orders; it never grants or
 * hides access, which stays with the API. A link the configuration leaves out keeps its usual
 * place after the listed ones, so a new page appears for every role without a change here.
 */
export const HOME_SECTIONS = [
  'work',
  'tiles',
  'attention',
  'capital',
  'charts',
  'dataHealth',
] as const;
export type HomeSection = (typeof HOME_SECTIONS)[number];

const workLink = z.object({ to: z.string(), label: z.string(), what: z.string() }).strict();
const roleFocus = z
  .object({
    area: z.string().min(1),
    does: z.string().min(1),
    nav: z.array(z.string()),
    tabs: z.record(z.string(), z.array(z.string())),
    landing: z.record(z.string(), z.string()),
    home: z.array(z.enum(HOME_SECTIONS)).min(1),
    work: z.array(workLink).min(1),
  })
  .strict();
const focusConfig = z
  .object({
    version: z.literal(1),
    about: z.string(),
    precedence: z.array(z.string()),
    roles: z.record(z.string(), roleFocus),
  })
  .strict();

export type WorkLink = z.infer<typeof workLink>;
export type RoleFocus = z.infer<typeof roleFocus> & { role: Role };

/** The configuration as written; a file that does not fit the shape stops the app at start. */
export const ROLE_FOCUS = focusConfig.parse(focusJson);

/**
 * The focus of a user: that of the first role in the configured precedence that the user holds.
 * A user with no configured role (the service account) has none and sees the usual order.
 */
export function focusOf(roles: readonly string[] | undefined): RoleFocus | null {
  if (roles === undefined) return null;
  const role = ROLE_FOCUS.precedence.find((r) => roles.includes(r));
  const focus = role === undefined ? undefined : ROLE_FOCUS.roles[role];
  return role === undefined || focus === undefined ? null : { ...focus, role: role as Role };
}

/** The listed items first, in the listed order, then every other item in its usual order. */
export function orderByFocus<T extends { to: string }>(
  items: readonly T[],
  first: readonly string[],
): T[] {
  const listed = first
    .map((to) => items.find((item) => item.to === to))
    .filter((item): item is T => item !== undefined);
  return [...listed, ...items.filter((item) => !listed.includes(item))];
}

export interface NavLink {
  /** The link's own path: its key and the name its icon is filed under. */
  to: string;
  label: string;
  /** Where the link goes for this role when that is another page of the same area. */
  href: string;
}

export interface RoleNav {
  /** The name over the first group: the role's area, or null when there is no focus. */
  area: string | null;
  /** Home, then the areas this role works in, in its order. */
  focus: NavLink[];
  /** Every other area, in the usual order. */
  more: NavLink[];
  /** The Data links that are not part of the role's own group. */
  data: NavLink[];
}

const HOME = '/';

/** The main navigation for a role: its own areas first, under its name, and nothing left out. */
export function navFor(focus: RoleFocus | null): RoleNav {
  const link = (item: { to: string; label: string }): NavLink => ({
    to: item.to,
    label: item.label,
    href: focus?.landing[item.to] ?? item.to,
  });
  if (focus === null)
    return { area: null, focus: NAV_GROUPS.map(link), more: [], data: DATA_LINKS.map(link) };
  const every = [...NAV_GROUPS, ...DATA_LINKS];
  const own = focus.nav
    .map((to) => every.find((item) => item.to === to))
    .filter((item): item is { to: string; label: string } => item !== undefined);
  const home = NAV_GROUPS.filter((item) => item.to === HOME);
  const rest = (items: readonly { to: string; label: string }[]): NavLink[] =>
    items.filter((item) => item.to !== HOME && !own.includes(item)).map(link);
  return {
    area: focus.area,
    focus: [...home, ...own].map(link),
    more: rest(NAV_GROUPS),
    data: rest(DATA_LINKS),
  };
}

/**
 * The tabs of an area in the role's order. A configured order applies to the tab row that holds
 * every path it lists; a row with no configured order, and any tab the order leaves out, keeps
 * the usual order.
 */
export function tabsFor<T extends { to: string }>(
  items: readonly T[],
  focus: RoleFocus | null,
): T[] {
  if (focus === null) return [...items];
  const order = Object.values(focus.tabs).find(
    (list) => list.length > 0 && list.every((to) => items.some((item) => item.to === to)),
  );
  return order === undefined ? [...items] : orderByFocus(items, order);
}

/** Every path a tab row or the main navigation links to: what the configuration may name. */
export const KNOWN_PATHS: ReadonlySet<string> = new Set(
  [
    ...NAV_GROUPS,
    ...DATA_LINKS,
    ...ADMIN_TABS,
    ...ANALYTICS_TABS,
    ...CAPITAL_TABS,
    ...DOCUMENTS_TABS,
    ...PORTFOLIO_TABS,
    ...REPORTING_TABS,
    ...VALUATION_TABS,
  ].map((item) => item.to),
);

/** The tab rows the configuration may reorder, by the area's own path. */
export const TAB_ROWS: Readonly<Record<string, readonly { to: string }[]>> = {
  '/admin/flags': ADMIN_TABS,
  '/analytics': ANALYTICS_TABS,
  '/capital-activity': CAPITAL_TABS,
  '/documents': DOCUMENTS_TABS,
  '/portfolio': PORTFOLIO_TABS,
  '/reporting': REPORTING_TABS,
  '/valuations': VALUATION_TABS,
};

/** The usual order of the page, for a user with no configured role. */
export const DEFAULT_HOME: readonly HomeSection[] = [
  'tiles',
  'attention',
  'capital',
  'charts',
  'dataHealth',
  'work',
];

/** The sections that take half the width; two that follow each other share a row. */
const HALF_WIDTH: ReadonlySet<HomeSection> = new Set(['attention', 'capital', 'dataHealth']);

/** Groups the sections into rows: a full-width one alone, half-width ones in pairs. */
export function homeRows(order: readonly HomeSection[]): HomeSection[][] {
  const rows: HomeSection[][] = [];
  for (const section of order) {
    const last = rows[rows.length - 1];
    const first = last?.[0];
    if (
      HALF_WIDTH.has(section) &&
      last !== undefined &&
      first !== undefined &&
      last.length === 1 &&
      HALF_WIDTH.has(first)
    )
      last.push(section);
    else rows.push([section]);
  }
  return rows;
}
