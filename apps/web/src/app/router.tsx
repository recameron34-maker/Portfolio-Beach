import type { ReactNode } from 'react';
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { AppShell } from '../components/AppShell.js';
import { ErrorState } from '../components/ui.js';
import { AdminFlagsPage } from '../pages/AdminFlags.js';
import { AccessPage, AuditPage, HealthPage } from '../pages/admin/Admin.js';
import { TaxonomyPage } from '../pages/admin/Taxonomy.js';
import {
  AnalyticsLayout,
  ClientAnalyticsTab,
  CreditTab,
  ExposureTab,
  PerformanceAnalyticsTab,
  RealizationsTab,
} from '../pages/analytics/Analytics.js';
import { AssistantsPage } from '../pages/assistants/Assistants.js';
import {
  CapitalActivityPage,
  CapitalNoticePage,
  CommitmentsPage,
} from '../pages/capital/CapitalActivity.js';
import { DataDictionaryPage, DataHealthPage } from '../pages/Data.js';
import { ActivityTab } from '../pages/deal/ActivityTab.js';
import { CapitalTab } from '../pages/deal/CapitalTab.js';
import { DealWorkspace } from '../pages/deal/DealWorkspace.js';
import { ClosingTab, DiligenceTab, DocumentsTab, TasksTab } from '../pages/deal/LaterTabs.js';
import { PerformanceTab } from '../pages/deal/PerformanceTab.js';
import { SponsorTab } from '../pages/deal/SponsorTab.js';
import { ValuationsTab } from '../pages/deal/ValuationsTab.js';
import { DocumentsPage } from '../pages/documents/Documents.js';
import { HomePage } from '../pages/Home.js';
import { InvestmentDetailPage } from '../pages/InvestmentDetail.js';
import { PipelinePage } from '../pages/pipeline/Pipeline.js';
import { PortfolioPage } from '../pages/Portfolio.js';
import { VehicleDetailPage, VehiclesPage } from '../pages/portfolio/Vehicles.js';
import { WatchlistPage } from '../pages/portfolio/Watchlist.js';
import { ClientsPage, DisclosuresPage, WeeklyReportPage } from '../pages/reporting/Reporting.js';
import { SignInPage } from '../pages/SignIn.js';
import { SponsorDetailPage, SponsorsPage } from '../pages/sponsors/Sponsors.js';
import { ValuationsPage } from '../pages/valuations/Valuations.js';
import { getCredential } from './session.js';

const rootRoute = createRootRoute({
  component: () => <Outlet />,
  notFoundComponent: () => (
    <ErrorState title="Page not found" detail="There is no page at this address." />
  ),
});

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

const child = <P extends string>(path: P, component: () => ReactNode) =>
  createRoute({ getParentRoute: () => appRoute, path, component });

const homeRoute = child('/', HomePage);
const portfolioRoute = child('/portfolio', PortfolioPage);
const vehiclesRoute = child('/portfolio/vehicles', VehiclesPage);
const vehicleRoute = child('/portfolio/vehicles/$id', VehicleDetailPage);
const watchlistRoute = child('/portfolio/watchlist', WatchlistPage);

/** Deal workspace: the one-pager is the Overview tab; the other tabs are children (docs/06 section 2). */
const investmentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/portfolio/$id',
  component: DealWorkspace,
});
const dealTab = <P extends string>(path: P, component: () => ReactNode) =>
  createRoute({ getParentRoute: () => investmentRoute, path, component });
const dealOverviewRoute = dealTab('/', InvestmentDetailPage);
const dealPerformanceRoute = dealTab('/performance', PerformanceTab);
const dealSponsorRoute = dealTab('/sponsor', SponsorTab);
const dealDiligenceRoute = dealTab('/diligence', DiligenceTab);
const dealClosingRoute = dealTab('/closing', ClosingTab);
const dealValuationsRoute = dealTab('/valuations', ValuationsTab);
const dealCapitalRoute = dealTab('/capital', CapitalTab);
const dealDocumentsRoute = dealTab('/documents', DocumentsTab);
const dealTasksRoute = dealTab('/tasks', TasksTab);
const dealActivityRoute = dealTab('/activity', ActivityTab);

const pipelineRoute = child('/pipeline', PipelinePage);
const sponsorsRoute = child('/sponsors', SponsorsPage);
const sponsorRoute = child('/sponsors/$id', SponsorDetailPage);
const documentsRoute = child('/documents', DocumentsPage);
const valuationsRoute = child('/valuations', ValuationsPage);
const capitalRoute = child('/capital-activity', CapitalActivityPage);
const commitmentsRoute = child('/capital-activity/commitments', CommitmentsPage);
const capitalNoticeRoute = child('/capital-activity/$id', CapitalNoticePage);
const reportingRoute = child('/reporting', WeeklyReportPage);
const clientsRoute = child('/reporting/clients', ClientsPage);
const disclosuresRoute = child('/reporting/disclosures', DisclosuresPage);

const analyticsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/analytics',
  component: AnalyticsLayout,
});
const analyticsTab = <P extends string>(path: P, component: () => ReactNode) =>
  createRoute({ getParentRoute: () => analyticsRoute, path, component });
const analyticsExposureRoute = analyticsTab('/', ExposureTab);
const analyticsPerformanceRoute = analyticsTab('/performance', PerformanceAnalyticsTab);
const analyticsCreditRoute = analyticsTab('/credit', CreditTab);
const analyticsRealizationsRoute = analyticsTab('/realizations', RealizationsTab);
const analyticsClientsRoute = analyticsTab('/clients', ClientAnalyticsTab);

const assistantsRoute = child('/assistants', AssistantsPage);
const adminFlagsRoute = child('/admin/flags', AdminFlagsPage);
const adminAuditRoute = child('/admin/audit', AuditPage);
const adminAccessRoute = child('/admin/access', AccessPage);
const adminHealthRoute = child('/admin/health', HealthPage);
const dataHealthRoute = child('/data/health', DataHealthPage);
const dataDictionaryRoute = child('/data/dictionary', DataDictionaryPage);
const dataTaxonomyRoute = child('/data/taxonomy', TaxonomyPage);

const routeTree = rootRoute.addChildren([
  signInRoute,
  appRoute.addChildren([
    homeRoute,
    portfolioRoute,
    vehiclesRoute,
    vehicleRoute,
    watchlistRoute,
    investmentRoute.addChildren([
      dealOverviewRoute,
      dealPerformanceRoute,
      dealSponsorRoute,
      dealDiligenceRoute,
      dealClosingRoute,
      dealValuationsRoute,
      dealCapitalRoute,
      dealDocumentsRoute,
      dealTasksRoute,
      dealActivityRoute,
    ]),
    pipelineRoute,
    sponsorsRoute,
    sponsorRoute,
    documentsRoute,
    valuationsRoute,
    capitalRoute,
    commitmentsRoute,
    capitalNoticeRoute,
    reportingRoute,
    clientsRoute,
    disclosuresRoute,
    analyticsRoute.addChildren([
      analyticsExposureRoute,
      analyticsPerformanceRoute,
      analyticsCreditRoute,
      analyticsRealizationsRoute,
      analyticsClientsRoute,
    ]),
    assistantsRoute,
    adminFlagsRoute,
    adminAuditRoute,
    adminAccessRoute,
    adminHealthRoute,
    dataHealthRoute,
    dataDictionaryRoute,
    dataTaxonomyRoute,
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
