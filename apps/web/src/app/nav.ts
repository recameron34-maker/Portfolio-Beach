/** Navigation groups from docs/06 section 2, with the secondary tabs each area shows. */
export const NAV_GROUPS: { label: string; to: string }[] = [
  { label: 'Home', to: '/' },
  { label: 'Pipeline', to: '/pipeline' },
  { label: 'Portfolio', to: '/portfolio' },
  { label: 'Sponsors', to: '/sponsors' },
  { label: 'Documents', to: '/documents' },
  { label: 'Valuations', to: '/valuations' },
  { label: 'Capital Activity', to: '/capital-activity' },
  { label: 'Reporting', to: '/reporting' },
  { label: 'Analytics', to: '/analytics' },
  { label: 'Assistants', to: '/assistants' },
  { label: 'Admin', to: '/admin/flags' },
];

export const PORTFOLIO_TABS = [
  { to: '/portfolio', label: 'Positions', exact: true },
  { to: '/portfolio/vehicles', label: 'Vehicles' },
  { to: '/portfolio/watchlist', label: 'Watchlist' },
];
export const CAPITAL_TABS = [
  { to: '/capital-activity', label: 'Notices', exact: true },
  { to: '/capital-activity/commitments', label: 'Commitments and unfunded' },
];
export const REPORTING_TABS = [
  { to: '/reporting', label: 'Weekly report', exact: true },
  { to: '/reporting/clients', label: 'Clients' },
  { to: '/reporting/disclosures', label: 'Disclosures' },
];
export const ANALYTICS_TABS = [
  { to: '/analytics', label: 'Exposure', exact: true },
  { to: '/analytics/performance', label: 'Performance' },
  { to: '/analytics/credit', label: 'Credit book' },
  { to: '/analytics/realizations', label: 'Realizations' },
  { to: '/analytics/clients', label: 'Clients' },
];
export const ADMIN_TABS = [
  { to: '/admin/flags', label: 'Flags' },
  { to: '/admin/audit', label: 'Audit trail' },
  { to: '/admin/access', label: 'Access and walls' },
  { to: '/admin/health', label: 'Integration health' },
  { to: '/data/health', label: 'Data health' },
  { to: '/data/dictionary', label: 'Data dictionary' },
  { to: '/data/taxonomy', label: 'Taxonomy' },
];

/** Deal workspace tabs (docs/06 section 2). The Overview tab is the one-pager. */
export const DEAL_TABS = [
  { path: '', label: 'Overview' },
  { path: '/performance', label: 'Performance' },
  { path: '/sponsor', label: 'Sponsor and contacts' },
  { path: '/diligence', label: 'Diligence' },
  { path: '/closing', label: 'Closing' },
  { path: '/valuations', label: 'Valuations' },
  { path: '/capital', label: 'Capital activity' },
  { path: '/documents', label: 'Documents' },
  { path: '/tasks', label: 'Tasks' },
  { path: '/activity', label: 'Activity' },
] as const;
