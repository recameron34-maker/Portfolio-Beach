import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { AppShell } from '../components/AppShell.js';
import { PlaceholderPage } from '../components/ui.js';
import { AdminFlagsPage } from '../pages/AdminFlags.js';
import { DataDictionaryPage, DataHealthPage } from '../pages/Data.js';
import { HomePage } from '../pages/Home.js';
import { InvestmentDetailPage } from '../pages/InvestmentDetail.js';
import { PortfolioPage } from '../pages/Portfolio.js';
import { SignInPage } from '../pages/SignIn.js';
import { getCredential } from './session.js';

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  component: SignInPage,
});

/** Everything under the shell needs a credential; without one the user goes to sign-in. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: AppShell,
  beforeLoad: () => {
    // TanStack Router signals a redirect by throwing its redirect object.
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- router idiom
    if (getCredential() === null) throw redirect({ to: '/sign-in' });
  },
});

const homeRoute = createRoute({ getParentRoute: () => appRoute, path: '/', component: HomePage });
const portfolioRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/portfolio',
  component: PortfolioPage,
});
const investmentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/portfolio/$id',
  component: InvestmentDetailPage,
});
const dataHealthRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/data/health',
  component: DataHealthPage,
});
const dataDictionaryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/data/dictionary',
  component: DataDictionaryPage,
});
const adminFlagsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin/flags',
  component: AdminFlagsPage,
});

const placeholders: { path: string; title: string; phase: string; modules: string }[] = [
  {
    path: '/pipeline',
    title: 'Pipeline',
    phase: 'Phase 5',
    modules: 'M5 pipeline, M7 diligence and IC',
  },
  {
    path: '/sponsors',
    title: 'Sponsors',
    phase: 'Phase 5',
    modules: 'M6 relationship intelligence, M18 coverage and AGMs',
  },
  {
    path: '/documents',
    title: 'Documents',
    phase: 'Phase 2',
    modules: 'M3 document hub, M4 extraction',
  },
  {
    path: '/valuations',
    title: 'Valuations',
    phase: 'Phase 3',
    modules: 'M10 valuation workflow, M11 deal change requests',
  },
  {
    path: '/capital-activity',
    title: 'Capital Activity',
    phase: 'Phase 3',
    modules: 'M16 calls, distributions and funding',
  },
  {
    path: '/reporting',
    title: 'Reporting',
    phase: 'Phase 4',
    modules: 'M12 weekly report, M14 report automation and QA, M19 disclosures',
  },
  {
    path: '/analytics',
    title: 'Analytics',
    phase: 'Phase 4 and 6',
    modules: 'M13 in-app analytics, M20 advanced analytics',
  },
  {
    path: '/assistants',
    title: 'Assistants',
    phase: 'Phase 6',
    modules: 'M15 Ask Portfolio Beach and Market Intelligence',
  },
];
const placeholderRoutes = placeholders.map((p) =>
  createRoute({
    getParentRoute: () => appRoute,
    path: p.path,
    component: () => <PlaceholderPage title={p.title} phase={p.phase} modules={p.modules} />,
  }),
);

const routeTree = rootRoute.addChildren([
  signInRoute,
  appRoute.addChildren([
    homeRoute,
    portfolioRoute,
    investmentRoute,
    dataHealthRoute,
    dataDictionaryRoute,
    adminFlagsRoute,
    ...placeholderRoutes,
  ]),
]);

// A static preview has no server to rewrite deep links, so it routes through the URL hash.
const previewMode = import.meta.env.VITE_PB_PREVIEW === 'true';
export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  ...(previewMode ? { history: createHashHistory() } : {}),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
