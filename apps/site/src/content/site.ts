/**
 * Every word the site shows. The rules for this file (the brief, CLAUDE.md rules 1, 10, 15, 16):
 * say only what the repository shows is built and mark the rest as planned or in progress; no
 * number, customer, quote or benchmark that is not in the repository; no real firm, fund, company,
 * person, brand or system name; no em dashes; plain language.
 * Sources: CLAUDE.md section 1, docs/01, docs/04, docs/05, docs/09, docs/11 and docs/SESSION_LOG.md.
 */

export const SITE = {
  name: 'Portfolio Beach',
  description:
    'Portfolio Beach is a prototype of a portfolio management workspace for a private equity LP and co-investment team, built on synthetic data.',
  notice: 'Prototype',
  noticeDetail: 'Synthetic data only',
  footer: 'Prototype. Synthetic data only: no real firm, fund, company or person appears.',
  demoHref: 'demo/index.html',
} as const;

export const NAV = [
  { href: '#overview', label: 'Overview' },
  { href: '#tour', label: 'Tour' },
  { href: '#controls', label: 'Controls' },
  { href: '#videos', label: 'Videos' },
  { href: '#brochures', label: 'Brochures' },
] as const;

export const HERO = {
  title: 'Portfolio Beach',
  lead: 'One connected workspace for a private equity LP and co-investment team: pipeline, documents, monitoring, valuations, capital activity and analytics, all on a single record.',
  primary: 'Open the demo',
  secondary: 'Watch the tour',
  note: 'The demo runs in your browser on recorded synthetic data. Nothing is sent to a server.',
} as const;

export const OVERVIEW = {
  eyebrow: 'Overview',
  title: 'One record, many views.',
  lead: 'Portfolio Beach is a prototype of a portfolio management platform for an institutional team that commits to sponsor funds, co-invests alongside them, backs continuation vehicles and lends through a private credit vehicle, on behalf of several clients. It keeps the deal, the documents, the numbers and the approvals in one place. A position is stored once and read by everyone who is allowed to see it.',
  heroShot: {
    name: 'home',
    alt: 'The home page of the tool for an approver: tiles for active positions, invested capital, current NAV, gross MOIC, DPI, TVPI and gross IRR, a list of positions that need attention with their watchlist flags, and a table of capital notices with due dates and states.',
    caption: 'The home page, signed in as an approver. Every figure is synthetic.',
  },
  together: {
    title: 'What it brings together',
    fromLabel: 'Work that is usually scattered across',
    from: [
      'Spreadsheets',
      'Email threads and handoffs',
      'Accounting system exports',
      'Document folders',
      'Look-through extracts',
      'Task lists',
      'Dashboards',
    ],
    toLabel: 'In one connected system',
    to: [
      'Pipeline, diligence and closings',
      'Documents, tagged and read into reviewed figures',
      'Quarterly monitoring of every position',
      'Valuations with approvals and a lock',
      'Capital calls, trade tickets and the wire register',
      'Analytics over approved records',
    ],
    boundary:
      'It is not a general ledger, an investor onboarding system or a fund administrator. A separate fund accounting system stays the official book of record. Portfolio Beach is the workflow, data and analytics layer on top of it.',
  },
  roles: {
    title: 'Who uses it',
    items: [
      {
        icon: 'compass',
        name: 'Deal team',
        text: 'Works the pipeline and diligence, reads quarterly monitoring, raises deal change requests and gives the first approval on a valuation.',
      },
      {
        icon: 'layers',
        name: 'Operations',
        text: 'Runs intake, valuations, closings and capital activity. With approvers, the only role that reads full wire details.',
      },
      {
        icon: 'seal',
        name: 'Approvers',
        text: 'Give final approvals: they record investment committee decisions, lock valuations and approve trade tickets.',
      },
      {
        icon: 'people',
        name: 'Investor relations',
        text: 'Reads the look-through for the clients they are entitled to. Client reporting packages are on the roadmap.',
      },
      {
        icon: 'ledger',
        name: 'Auditors',
        text: 'Read-only access to the records and to the audit trail of who changed what, when and why.',
      },
    ],
    also: 'A read-only viewer role and a platform admin role for configuration, such as feature flags and kill switches, complete the set.',
  },
  flow: {
    title: 'How the work flows',
    steps: [
      {
        name: 'Pipeline',
        text: 'A deal moves from sourced through diligence and the investment committee, with a gate at each step.',
      },
      {
        name: 'Closing',
        text: 'One close date, a required-document checklist and allocations that tie. On close the deal becomes a position.',
      },
      {
        name: 'Monitoring',
        text: 'Each quarter, sponsor reports are indexed, read and reviewed. Approved figures feed the board and the one-pager.',
      },
      {
        name: 'Valuation',
        text: 'One valuation per position per period: prepared, approved and locked, with the preparer never the approver.',
      },
      {
        name: 'Capital activity',
        text: 'Calls, distributions and payments run from notice to trade ticket, funding and an approved cash flow.',
      },
      {
        name: 'Analytics',
        text: 'Exposure, performance, credit and client views read approved records. Reporting packages are planned.',
      },
    ],
  },
} as const;

export interface Feature {
  id: string;
  /** The name in the tour's own list of links. */
  short: string;
  kicker: string;
  title: string;
  body: string;
  points: readonly string[];
  shot: string;
  alt: string;
  caption: string;
}

export const TOUR = {
  eyebrow: 'Feature tour',
  title: 'What is built today.',
  lead: 'Eight areas of the tool, each with a screenshot taken by script from the interactive demo. The demo is the same web app, running on synthetic data.',
  jumpLabel: 'Areas of the tour',
  features: [
    {
      id: 'portfolio',
      short: 'Portfolio',
      kicker: 'Portfolio and one-pager',
      title: 'Every position in one grid, and one page per deal.',
      body: 'The portfolio lists every position with filters, search and a CSV export. Opening a row shows the deal workspace: a one-pager with invested capital, NAV, gross MOIC and gross IRR, the deal details and financial performance, and tabs for performance, sponsor, valuations and capital activity.',
      points: [
        'Co-investments, continuation vehicles and private credit positions, with credit terms shown for credit deals.',
        'A watchlist that flags positions against configured thresholds.',
        'A missing value shows a placeholder. The tool never fills a gap with a guess.',
      ],
      shot: 'one-pager',
      alt: 'The one-pager of a synthetic co-investment: tiles for invested capital, current NAV with the date of its Locked mark, gross MOIC and gross IRR; a deal details panel with sponsor, fund, sector and geography; and a financial performance table with revenue, EBITDA, margin, enterprise value and leverage for the latest quarter.',
      caption: 'A deal one-pager, with tabs for the rest of the deal workspace.',
    },
    {
      id: 'intake',
      short: 'Intake',
      kicker: 'Intake and exceptions',
      title: 'Files are staged, checked and approved before anything changes.',
      body: 'Operations stages an accounting export, a weekly values file, a look-through extract or an operations workbook. Each row is linked to a position, compared with the current record and checked against a library of validation rules. Validated rows are promoted on approval. Flagged rows wait for a decision.',
      points: [
        'Importing the same file twice creates no duplicates.',
        'Differences and unresolved names open data exceptions, worked in one queue.',
        'A row linked to a walled position is counted but never shown to a reader outside the wall.',
      ],
      shot: 'intake',
      alt: 'A staged accounting file: tiles counting rows, validated, flagged, promoted, rejected and exceptions; a note that two rows are linked to positions the user cannot see; and a table of staged rows with each row’s investment, period, difference against the record, rule findings and status.',
      caption: 'A staged accounting export with its differences and findings.',
    },
    {
      id: 'documents',
      short: 'Documents',
      kicker: 'Document hub and extraction',
      title: 'From a sponsor report to reviewed figures, with the page they came from.',
      body: 'The hub indexes the document store, marks duplicates by content hash and tags each file with a type and a confidence. A tag below the threshold waits in a review queue. Extraction reads quarterly financials into staged values that each carry a unit, a page, a short quote and a confidence. A reviewer accepts, edits or rejects them, then approves. Only then do the figures reach the record.',
      points: [
        'Click a value to see its page, with the quote highlighted.',
        'A tracker shows which documents are expected, late or missing for the quarter.',
        'In the prototype the classifier is keyword based and the extraction model is a mock over synthetic documents. No real model is called.',
      ],
      shot: 'extraction',
      alt: 'The review page of an extraction run: the lower rows of the table of extracted values, each with its page, quote, confidence, validation state and accept, edit and reject actions; below it, the cited page of the synthetic sponsor report drawn with the revenue line highlighted.',
      caption: 'Extraction review: each value beside the page it was read from.',
    },
    {
      id: 'monitoring',
      short: 'Monitoring',
      kicker: 'Monitoring board',
      title: 'The quarter at a glance, position by position.',
      body: 'For each active position the board shows whether the quarterly report is expected, received, late or missing, the state of its extraction run, any flags, and whether the figures are approved. It exports to CSV.',
      points: [
        'On each deal’s Performance tab: the quarterly series, prior-year comparisons, and growth and multiple change since entry.',
        'Prior year means the same fiscal quarter one year earlier, or a placeholder when it is not on record.',
        'A realization outlook that changes only by an explicit edit with a reason.',
      ],
      shot: 'monitoring',
      alt: 'The monitoring board for a quarter: tiles counting reports expected, received, late and missing, runs in review and figures approved; and a table of positions with the status of each report, its extraction run, flags and approval.',
      caption: 'The monitoring board for the latest quarter.',
    },
    {
      id: 'valuations',
      short: 'Valuations',
      kicker: 'Valuations, approvals and the lock',
      title: 'One controlled valuation per position per period.',
      body: 'A valuation moves from Draft to Ops prepared to Deal team approved to Locked. The person who prepares it cannot approve it. The lock is a SHA-256 hash over the version, the method, its inputs and the fair value. A correction after the lock reopens it into a new version and leaves the old one as it was.',
      points: [
        'A batch bar to approve or lock several versions at once.',
        'Reports and analytics read Locked valuations only.',
        'Deal change requests are routed to operations and shown on the valuation screen.',
      ],
      shot: 'valuation-lock',
      alt: 'A Locked valuation version: the four steps Draft, Ops prepared, Deal team approved and Locked; tiles for fair value, prior fair value, change and lock date; the method inputs; the lock text with its hash; and a table of three approvals by three different people.',
      caption: 'A Locked version with its lock text, hash and approvals.',
    },
    {
      id: 'capital',
      short: 'Capital activity',
      kicker: 'Capital calls, the wire register and dual control',
      title: 'Capital activity, with the payment controls built in.',
      body: 'Notices for calls, distributions and payments are tracked from review to a trade ticket, funding and reconciliation, with alerts as due dates approach. A reconciled notice writes the approved cash flow that returns and unfunded amounts read.',
      points: [
        'The preparer of a trade ticket cannot approve it.',
        'Bank details come only from a versioned wire register. A new or changed instruction is verified by a second person’s callback to an independently sourced number.',
        'A changed instruction holds the release. Inside the hold window the approval takes a third person.',
      ],
      shot: 'capital-notice',
      alt: 'A capital call notice: its seven steps from Received to Reconciled; a warning that the wire instructions changed within the hold window; alerts for a changed wire and for urgent language; tiles for amount and days to due; the trade ticket; and the wire instruction with masked bank details.',
      caption: 'A capital call that arrived with changed wire instructions.',
    },
    {
      id: 'pipeline',
      short: 'Pipeline',
      kicker: 'Pipeline, diligence, IC and closing',
      title: 'From first look to a closed position.',
      body: 'The pipeline board shows every deal by stage. Entering diligence creates the task list for the deal type. A deal cannot go to the investment committee while a required task is open, and cannot be approved without a recorded decision. The closing has one close date, a required-document checklist and allocations that must tie to the commitment exactly before operations can confirm it.',
      points: [
        'Passing on a deal needs a reason code.',
        'A confirmed closing is frozen until operations reopen it with a reason.',
        'On close the deal converts into a position. A walled deal becomes a walled position.',
      ],
      shot: 'pipeline',
      alt: 'The pipeline board: tiles counting deals in the pipeline, aging, at closing and passed; and one column per stage from Sourced to Approved, each holding cards with the deal name, company, sponsor, deal type, size, owner and days in stage.',
      caption: 'The pipeline board, one column per stage.',
    },
    {
      id: 'analytics',
      short: 'Analytics',
      kicker: 'Analytics',
      title: 'The portfolio from several angles.',
      body: 'Exposure by sector, geography, deal type, vehicle, sponsor and vintage. Pooled performance with the NAV trend and cash flows. The credit book with terms, yield, coverage and leverage. Realizations. And each entitled client’s look-through share of every vehicle. Every chart has a table behind it.',
      points: [
        'Figures cover only the positions the signed-in user may see.',
        'NAV reads Locked valuations only.',
        'Portfolio-level value creation and entry metric analytics are in progress.',
      ],
      shot: 'analytics',
      alt: 'The exposure tab of analytics: two horizontal bar charts, NAV by sector and invested capital by sector, above a table of sectors with positions, invested capital, NAV and share of NAV.',
      caption: 'Exposure by sector, with the table behind the charts.',
    },
  ] satisfies Feature[],
  roadmap: {
    title: 'On the roadmap',
    lead: 'Planned work, in the order of the prototype roadmap. None of it is claimed as built.',
    items: [
      {
        status: 'In progress',
        name: 'Value creation and entry metrics',
        text: 'Portfolio-level attribution of value to revenue, margin, multiple and leverage, and entry metric analytics. Today each deal shows its growth and multiple change since entry.',
      },
      {
        status: 'Planned',
        name: 'Reporting packages',
        text: 'A report quality gate, then weekly and client reports generated from templates. Today the prototype has an on-screen weekly report only.',
      },
      {
        status: 'Planned',
        name: 'Relationship intelligence',
        text: 'Activity capture from mail and calendar with summaries, relationship scores and warm paths. Today there is a sponsor page built on the firm’s own records.',
      },
      {
        status: 'Planned',
        name: 'The assistant',
        text: 'A permission-aware assistant that answers from records the user can already open and cites them. The demo carries a labelled mock with fixed questions, behind a switch that is off by default.',
      },
      {
        status: 'Planned',
        name: 'Benchmarking and forecasting',
        text: 'Public market equivalents and quartiles, liquidity forecasting and exit analytics.',
      },
      {
        status: 'Planned',
        name: 'Data access',
        text: 'A documented read interface, a spreadsheet add-in and a governed extract for a data warehouse.',
      },
    ],
  },
} as const;

export const CONTROLS = {
  eyebrow: 'Controls and security',
  title: 'What the prototype enforces.',
  lead: 'These rules are built and covered by tests in the repository. Access rules are enforced twice: by the application’s API and again by row-level security in the database.',
  items: [
    {
      icon: 'key',
      name: 'Roles and entitlements',
      text: 'Seven roles, from viewer to auditor. Client data is visible only to users entitled to that client. Each role reads what its access matrix allows and nothing else.',
    },
    {
      icon: 'wall',
      name: 'Walls around restricted deals',
      text: 'A walled deal is visible only to its named members. For everyone else the record answers as not found, so its existence is not revealed. The wall follows the deal into the position it becomes.',
    },
    {
      icon: 'people',
      name: 'The preparer never approves',
      text: 'The person who prepares a valuation cannot approve it, and the person who drafts a trade ticket cannot approve its release.',
    },
    {
      icon: 'ledger',
      name: 'Every change is audited',
      text: 'A change to a number a client could see is written to an append-only audit trail: who, what, when and why. The financial tables keep their full history.',
    },
    {
      icon: 'lock',
      name: 'Locked means locked',
      text: 'A Locked valuation cannot be updated in place: the database refuses it. A correction reopens it into a new version with a reason and a task for each prior approver.',
    },
    {
      icon: 'phone',
      name: 'Wire details verified by callback',
      text: 'Bank details are never extracted from a document. A new or changed instruction is verified only by a second person’s callback to an independently sourced number, and stays masked outside operations and approvers.',
    },
    {
      icon: 'review',
      name: 'AI output goes through a person',
      text: 'A tag below the confidence threshold waits in a review queue. Extracted values are staged with their citations and reach the record only after a reviewer approves. Each AI feature sits behind a kill switch.',
    },
    {
      icon: 'layers',
      name: 'Staging before the record',
      text: 'Imported files and extracted values land in staging first. Nothing is written to a core financial table without validation and a person’s approval.',
    },
    {
      icon: 'shell',
      name: 'Synthetic data, mock sign-in',
      text: 'The prototype runs on synthetic data and signs in with a picker of synthetic users. The application refuses to start in production mode with any mock adapter or mock identity.',
    },
  ],
  boundary:
    'Not part of the prototype: single sign-on with multi-factor authentication, private networking, managed encryption keys and security monitoring. They are specified in the security requirements and belong to deployment inside a firm’s own environment.',
} as const;

export const VIDEOS = {
  eyebrow: 'Demo videos',
  title: 'Watch it work.',
  lead: 'Short screen recordings made by script from the demo. A caption bar says what is happening at each step. There is no sound.',
  unsupported:
    'This browser cannot play WebM video. The frame above is from the recording, and the steps are listed below.',
  stepsLabel: 'Steps in this video',
} as const;

export const BROCHURES = {
  eyebrow: 'Brochures',
  title: 'Take it with you.',
  lead: 'Short PDFs, generated by script from the same screenshots and held to the same rules as this page.',
  download: 'Download PDF',
} as const;

export const DEMO = {
  eyebrow: 'The demo',
  title: 'Try it yourself.',
  lead: 'The demo is the web app itself, running in your browser on recorded synthetic data.',
  points: [
    'Sign in by picking a synthetic user. Each one holds a role.',
    'Switch users from the menu at the top of any page to see what each role can see and do.',
    'Your changes are simulated in the page and are gone when you reload it.',
  ],
  action: 'Open the demo',
  note: 'The demo opens with a guide to short walkthroughs: walls, valuation approval, capital controls, intake, documents and more. It replays the answers the application gave to each synthetic user, so it shows the access rules at work; it does not enforce them itself.',
} as const;

export const NOT_FOUND = {
  title: 'Page not found',
  heading: 'Nothing on this stretch of shore.',
  text: 'The page you asked for is not here. It may have moved, or the address may be mistyped.',
  action: 'Back to Portfolio Beach',
} as const;
