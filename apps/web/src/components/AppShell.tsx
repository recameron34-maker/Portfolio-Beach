import { useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  DrawerBody,
  DrawerHeader,
  Dropdown,
  Option,
  OptionGroup,
  OverlayDrawer,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import {
  ArrowImport16Regular,
  ArrowSwap16Regular,
  BookOpen16Regular,
  Briefcase16Regular,
  CalendarWorkWeek16Regular,
  ChartMultiple16Regular,
  DataLine16Regular,
  Dismiss20Regular,
  DocumentTable16Regular,
  Eye16Regular,
  Flowchart16Regular,
  Folder16Regular,
  Handshake16Regular,
  Home16Regular,
  Navigation20Regular,
  Scales16Regular,
  Settings16Regular,
  SignOut20Regular,
  Sparkle16Regular,
  TagMultiple16Regular,
  Warning16Regular,
} from '@fluentui/react-icons';
import { meQuery, mockUsersQuery } from '../app/queries.js';
import { clearCredential, setCredential } from '../app/session.js';
import { ApiError } from '../api/client.js';
import { useSignOutOnRejectedCredential } from '../app/useSignOutOnRejectedCredential.js';
import { useTaxonomyLabels } from '../app/useTaxonomyLabels.js';
import { useNarrowScreen } from '../lib/media.js';
import { focusOf, navFor } from '../lib/role-focus.js';
import type { NavLink } from '../lib/role-focus.js';
import { RoleFocusContext } from '../lib/role-focus-context.js';
import { userLabel } from '../lib/roles.js';
import { DrawerSlide, useReducedMotion } from './motion.js';
import { byRole, initialsOf, roleWords } from './people.js';
import { PageSkeleton } from './ui.js';
import { Wordmark } from './Wordmark.js';

/** Icons keyed by route so nav.ts (the docs/06 list) stays data only. */
const NAV_ICONS: Record<string, ReactNode> = {
  '/': <Home16Regular />,
  '/pipeline': <Flowchart16Regular />,
  '/portfolio': <Briefcase16Regular />,
  '/sponsors': <Handshake16Regular />,
  '/documents': <Folder16Regular />,
  '/valuations': <Scales16Regular />,
  '/capital-activity': <ArrowSwap16Regular />,
  '/reporting': <DocumentTable16Regular />,
  '/analytics': <ChartMultiple16Regular />,
  '/assistants': <Sparkle16Regular />,
  '/admin/flags': <Settings16Regular />,
  '/data/health': <DataLine16Regular />,
  '/data/dictionary': <BookOpen16Regular />,
  '/data/taxonomy': <TagMultiple16Regular />,
  '/data/intake': <ArrowImport16Regular />,
  '/data/weekly': <CalendarWorkWeek16Regular />,
  '/data/lookthrough': <Eye16Regular />,
  '/data/exceptions': <Warning16Regular />,
};

function NavItem({
  link,
  onNavigate,
}: {
  link: NavLink;
  onNavigate?: (() => void) | undefined;
}): ReactNode {
  return (
    <Link
      to={link.href}
      className="pb-nav-item"
      activeOptions={{ exact: link.to === '/' }}
      activeProps={{ 'aria-current': 'page' }}
      onClick={onNavigate}
    >
      <span className="pb-nav-icon" aria-hidden="true">
        {NAV_ICONS[link.to]}
      </span>
      <span className="pb-nav-label">{link.label}</span>
    </Link>
  );
}

/** One group of the main navigation, under its name when it has one. */
function NavGroup({
  id,
  label,
  links,
  onNavigate,
}: {
  id: string;
  label: string | null;
  links: readonly NavLink[];
  onNavigate?: (() => void) | undefined;
}): ReactNode {
  if (links.length === 0) return null;
  return (
    <div
      className="pb-nav-group"
      {...(label === null ? {} : { role: 'group', 'aria-labelledby': id })}
    >
      {label === null ? null : (
        <span id={id} className="pb-nav-group-label">
          {label}
        </span>
      )}
      {links.map((link) => (
        <NavItem key={link.to} link={link} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

/**
 * The switcher of the prototype's mock users: its value is the current user's role in words, its
 * options the users grouped by role. Switching drops everything the previous user could see.
 */
export function RoleSwitcher(): ReactNode {
  const me = useQuery(meQuery);
  const users = useQuery({ ...mockUsersQuery, enabled: me.data?.mockIdentity === true });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  if (me.data?.mockIdentity !== true || users.data === undefined) return null;
  const current = me.data.externalId;
  return (
    <Dropdown
      aria-label="Switch mock user"
      data-testid="role-switcher"
      className="pb-user-switcher"
      size="small"
      value={roleWords(me.data.roles)}
      selectedOptions={[current]}
      listbox={{ className: 'pb-user-list' }}
      // The list is wider than the switcher: it opens under it, ending where the switcher ends.
      positioning="below-end"
      onOptionSelect={(_e, data) => {
        const next = data.optionValue;
        if (next === undefined || next === current) return;
        setCredential(next);
        // Nothing the previous user could see may survive the switch, cached or on screen: every
        // query drops its data, and the ones on screen fetch again as the new user (clear() would
        // leave the mounted queries detached, still showing the old answers).
        queryClient.getMutationCache().clear();
        void queryClient.resetQueries();
        void navigate({ to: '/' });
      }}
    >
      {byRole(users.data.users).map((group) => (
        <OptionGroup key={group.key} label={group.label}>
          {group.users.map((u) => (
            <Option key={u.externalId} value={u.externalId} text={userLabel(u)}>
              {u.displayName}
            </Option>
          ))}
        </OptionGroup>
      ))}
    </Dropdown>
  );
}

/** The data rule of the prototype, said once on every page (the shell's only status element). */
const PROTOTYPE_SENTENCE =
  'Mock identity and synthetic data only. No employer information is present anywhere in this system.';

/**
 * The prototype marker: a watch dot, "Prototype" and the data rule. On a phone the sentence is
 * still inside it, read by a screen reader and in its title, while the bar shows the dot and word.
 */
function PrototypeStatus({ compact }: { compact: boolean }): ReactNode {
  return (
    <div className="pb-mock-banner" role="status" title={PROTOTYPE_SENTENCE}>
      <span className="pb-mock-word">Prototype</span>
      <span className={compact ? 'pb-visually-hidden' : 'pb-mock-sentence'}>
        {PROTOTYPE_SENTENCE}
      </span>
    </div>
  );
}

/** A person's initials in a small circle, beside their name. Decoration: the name says it. */
function Initials({ name }: { name: string }): ReactNode {
  return (
    <span className="pb-initials" aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}

/** Moves keyboard focus past the navigation to the page (the router owns the URL's fragment). */
function skipToMain(event: MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault();
  document.getElementById('main')?.focus();
}

/**
 * The frame of every signed-in page (docs/06 section 2): a navigation rail the full height of the
 * page with the wordmark at its top, a light top bar over the page with the prototype marker and
 * the user, and the page. Under 760px one bar holds the menu, the mark, the marker, the user and
 * Sign out, and the navigation opens in a drawer. One main navigation and one status, at any width.
 */
export function AppShell(): ReactNode {
  const me = useQuery(meQuery);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const narrow = useNarrowScreen();
  const reduced = useReducedMotion();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The drawer is in the page only while it is open or leaving: a closed Fluent drawer still keeps
  // focus guards around the page, which a screen reader is told to skip yet the keyboard can reach.
  const [drawerMounted, setDrawerMounted] = useState(false);
  // Focus goes back to the menu button when the drawer closes.
  const restoreFocusTarget = useRestoreFocusTarget();
  const rejected = me.isError && me.error instanceof ApiError && me.error.status === 401;
  const labelsReady = useTaxonomyLabels();
  // The role's own areas come first, under its name; every other area stays, after them.
  const focus = focusOf(me.data?.roles);
  const nav = navFor(focus);
  const mock = me.data?.mockIdentity === true;
  const signOut = (): void => {
    clearCredential();
    queryClient.clear();
    void navigate({ to: '/sign-in' });
  };
  useSignOutOnRejectedCredential(rejected, signOut);
  const showDrawer = (open: boolean): void => {
    setDrawerOpen(open);
    if (open) setDrawerMounted(true);
    else if (reduced) setDrawerMounted(false);
  };
  const closeDrawer = (): void => showDrawer(false);
  // Widened past the phone width, the drawer goes, so narrowing again starts with it closed.
  const [wasNarrow, setWasNarrow] = useState(narrow);
  if (narrow !== wasNarrow) {
    setWasNarrow(narrow);
    if (!narrow) {
      setDrawerOpen(false);
      setDrawerMounted(false);
    }
  }
  const navigation = (onNavigate?: () => void): ReactNode => (
    <nav className="pb-nav" aria-label="Main">
      <NavGroup id="pb-nav-focus" label={nav.area} links={nav.focus} onNavigate={onNavigate} />
      <NavGroup id="pb-nav-more" label="More" links={nav.more} onNavigate={onNavigate} />
      <NavGroup id="pb-nav-data" label="Data" links={nav.data} onNavigate={onNavigate} />
    </nav>
  );
  return (
    <div className="pb-shell">
      <a href="#main" className="pb-skip" onClick={skipToMain}>
        Skip to content
      </a>
      {narrow ? null : (
        <div className="pb-rail">
          <div className="pb-rail-inner">
            <div className="pb-rail-brand">
              <Link to="/" className="pb-wordmark">
                <Wordmark />
              </Link>
            </div>
            {navigation()}
          </div>
        </div>
      )}
      <header className="pb-topbar">
        {narrow ? (
          <>
            <Button
              className="pb-topbar-icon"
              appearance="subtle"
              icon={<Navigation20Regular />}
              aria-label="Open navigation"
              aria-expanded={drawerOpen}
              {...restoreFocusTarget}
              onClick={() => showDrawer(true)}
            />
            <Link to="/" className="pb-wordmark">
              <Wordmark />
            </Link>
          </>
        ) : null}
        {mock ? <PrototypeStatus compact={narrow} /> : null}
        <span className="pb-topbar-spacer" />
        {me.data !== undefined ? (
          <>
            <div className="pb-topbar-identity">
              {narrow ? null : <Initials name={me.data.displayName} />}
              <span className="pb-topbar-user" data-testid="current-user">
                {me.data.displayName}
              </span>
              {narrow ? null : <RoleSwitcher />}
            </div>
            {narrow ? (
              <Button
                className="pb-topbar-icon"
                appearance="subtle"
                icon={<SignOut20Regular />}
                aria-label="Sign out"
                onClick={signOut}
              />
            ) : (
              <Button
                size="small"
                appearance="subtle"
                className="pb-topbar-signout"
                onClick={signOut}
              >
                Sign out
              </Button>
            )}
          </>
        ) : null}
      </header>
      {narrow && drawerMounted ? (
        <OverlayDrawer
          open={drawerOpen}
          onOpenChange={(_e, data) => showDrawer(data.open)}
          position="start"
          className="pb-drawer"
          aria-label="Navigation"
          backdrop={{ className: 'pb-dialog-backdrop' }}
          surfaceMotion={{
            children: (_component, props) => (
              <DrawerSlide
                {...props}
                reduced={reduced}
                onMotionFinish={(event, data) => {
                  props.onMotionFinish?.(event, data);
                  if (data.direction === 'exit') setDrawerMounted(false);
                }}
              />
            ),
          }}
        >
          <DrawerHeader className="pb-drawer-head">
            <Link to="/" className="pb-wordmark" onClick={closeDrawer}>
              <Wordmark />
            </Link>
            <Button
              className="pb-topbar-icon"
              appearance="subtle"
              icon={<Dismiss20Regular />}
              aria-label="Close navigation"
              onClick={closeDrawer}
            />
          </DrawerHeader>
          <DrawerBody className="pb-drawer-body">
            {mock ? <p className="pb-drawer-note">{PROTOTYPE_SENTENCE}</p> : null}
            {navigation(closeDrawer)}
            {me.data !== undefined ? (
              <div className="pb-drawer-identity">
                <Initials name={me.data.displayName} />
                <span className="pb-drawer-user">{me.data.displayName}</span>
                <RoleSwitcher />
              </div>
            ) : null}
          </DrawerBody>
        </OverlayDrawer>
      ) : null}
      <main id="main" className="pb-main" tabIndex={-1}>
        <RoleFocusContext.Provider value={focus}>
          {labelsReady ? <Outlet /> : <PageSkeleton />}
        </RoleFocusContext.Provider>
      </main>
    </div>
  );
}
