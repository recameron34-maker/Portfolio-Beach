// Records the demo videos from the interactive preview with Playwright: five scripted walks at
// 1280 by 720, each with a title card, a caption bar that says what is happening, a visible pointer
// and unhurried pauses. The steps follow apps/web/scripts/probe-preview.mjs and the journeys in
// apps/web/e2e/journey*.spec.ts. Chromium records WebM (VP8); that is the format the site ships.
// Output: media/videos/<name>.webm, <name>.webp (the poster frame) and manifest.json, which also
// carries each recording's captions with their times (the site prints them as a transcript).
//
//   node scripts/record-demos.mjs [--only name,name] [--frames <dir>]
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChromium } from './lib/browser.mjs';
import { CAPTION_HEIGHT, director, installOverlay } from './lib/demo-overlay.mjs';
import {
  MEDIA_DIR,
  previewAsOf,
  previewDriver,
  quarterEndOnOrBefore,
  servePreview,
  shownDate,
} from './lib/preview.mjs';
import { serveStatic } from './lib/serve.mjs';
import { lightTokensCss } from './lib/tokens.mjs';

const OUT = join(MEDIA_DIR, 'videos');
const SIZE = { width: 1280, height: 720 };
const MAX_BYTES = 12 * 1024 * 1024;
const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? null : (process.argv[at + 1] ?? '');
};
const only = arg('--only') === null ? null : new Set(arg('--only').split(','));
const framesDir = arg('--frames');
const log = (line) => process.stdout.write(`${line}\n`);

const asOf = previewAsOf();
const quarter = quarterEndOnOrBefore(asOf);
const tokens = lightTokensCss();

/**
 * @typedef {ReturnType<typeof director>} Director
 * @typedef {ReturnType<typeof previewDriver>} Preview
 * @typedef {{ page: import('@playwright/test').Page, d: Director, p: Preview }} Stage
 */

/** The main navigation and the tab row of an area. */
const nav = (page, name) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });
const tab = (page, name) => page.locator('.pb-tabs').getByRole('link', { name, exact: true });
/** The card a table or a form sits in. */
const card = (locator) => locator.locator('xpath=ancestor::*[contains(@class, "pb-card")][1]');

/** The deal the pipeline recording follows: found and brought to prescreen in its setup. */
let stagedDealId = '';

/** Switches the acting user on camera, through the menu in the header. */
async function switchOnCamera({ page, d, p }, externalId) {
  await d.unring();
  await d.click(page.getByTestId('role-switcher'), 420);
  await d.click(
    page.getByRole('option', { name: new RegExp(p.user(externalId).displayName) }),
    250,
  );
  await page
    .getByTestId('current-user')
    .filter({ hasText: p.user(externalId).displayName })
    .waitFor();
  await p.settle();
  await d.wait(350);
}

const DEMOS = [
  {
    name: 'tour',
    title: 'A first look',
    subtitle: 'Sign in, the home page, the portfolio grid, a one-pager and the monitoring board.',
    summary:
      'A walk from the sign-in picker through the home page, the position grid, one deal and the quarterly monitoring board.',
    /** @param {Stage} stage */
    async setup({ p }) {
      // Documents indexed and a batch reviewed beforehand (through the preview's API, as the
      // users who hold the roles), so the monitoring board has every state to show.
      await p.send('ops.one', 'POST', '/api/v1/documents/index');
      await p.send('admin.one', 'PATCH', '/api/v1/flags/ai.extraction', {
        enabled: true,
        reason: 'Enabled for the demo recording',
      });
      await p.send('ops.one', 'POST', '/api/v1/expected-documents/generate', {
        periodEnd: quarter,
      });
      await p.send('ops.one', 'POST', '/api/v1/extraction/batches', {
        periodEnd: quarter,
        docType: 'doc_type.quarterly_financials',
      });
      const runs = (await p.read('ops.one', '/api/v1/extraction/runs?limit=200')).items;
      for (const run of runs.filter((r) => r.state === 'Succeeded').slice(0, 5)) {
        const path = `/api/v1/extraction/runs/${run.id}/commands`;
        await p.send('ops.one', 'POST', path, { command: 'acceptClean' });
        await p.send('ops.one', 'POST', path, {
          command: 'approve',
          reason: 'Reviewed against the synthetic report',
        });
      }
    },
    /** @param {Stage} stage */
    async run({ page, d, p }) {
      await d.say(
        'The prototype signs in with a picker of synthetic users. Each one holds a role.',
        3800,
      );
      await d.click(page.getByRole('button', { name: new RegExp(p.user('head.one').displayName) }));
      await page.getByTestId('home-tiles').waitFor();
      await p.settle();
      await d.say(
        'Home: invested capital, NAV and returns for the positions this user may see.',
        3800,
      );
      await d.ring(page.getByTestId('home-attention'));
      await d.say(
        'What needs attention comes first: watchlist flags and capital notices that are due.',
        4000,
      );
      await d.scrollTo(page.getByTestId('home-exposure'), 'center');
      await d.say('Exposure and the NAV trend, from Locked valuations only.', 3200);

      await d.scrollTop();
      await d.caption('The portfolio: every position in one grid.');
      await d.click(nav(page, 'Portfolio'));
      await page.getByTestId('portfolio-count').waitFor();
      await p.settle();
      await d.wait(1800);
      const investments = (await p.read('head.one', '/api/v1/investments?limit=200')).items;
      const featured =
        investments.find(
          (i) => i.isActive && i.dealType === 'deal_type.co_invest_equity' && i.navDate === quarter,
        ) ?? investments[0];
      await d.caption('Search, filter by deal type, or export the grid to CSV.');
      await d.type(page.getByLabel('Search'), featured.companyName.split(' ')[0], 1500);
      await d.poster();
      await d.caption('Opening a row shows the one-pager for that deal.');
      await d.click(page.getByTestId('portfolio-grid').getByText(featured.companyName).first());
      await page.getByTestId('detail-banner').waitFor();
      await p.settle();
      await d.ring(page.getByTestId('deal-tiles'));
      await d.say('The one-pager: invested capital, current NAV, gross MOIC and gross IRR.', 4000);
      await d.scrollTo(page.getByRole('table', { name: 'Financial performance' }), 'center');
      await d.say(
        'Financial performance for the latest quarter, with the prior year beside it when it is on record.',
        4200,
      );

      await d.scrollTop();
      await d.caption('Back to the portfolio, and on to the monitoring board.');
      await d.click(nav(page, 'Portfolio'));
      await d.click(tab(page, 'Monitoring'));
      await page.getByTestId('monitoring-board').waitFor();
      await p.settle();
      await d.ring(page.getByTestId('monitoring-tiles'));
      await d.say(
        'Monitoring: for each active position, whether the quarterly report is in, read and approved.',
        4600,
      );
      await d.scrollTo(page.getByRole('table', { name: 'Monitoring board' }), 'start');
      await d.say('Each row links to the report, the extraction run and the approval.', 3800);
    },
  },
  {
    name: 'valuation',
    title: 'A valuation, from draft to lock',
    subtitle:
      'Operations prepares, the deal team approves, an approver locks. Three different people.',
    summary:
      'Operations starts and prepares a valuation, the deal team approves it, an approver locks it, and the version screen shows the lock text and its hash.',
    /** @param {Stage} stage */
    async setup({ p }) {
      await p.signIn('ops.one');
      await p.go('/valuations');
      await p.page.getByTestId('missing-marks').waitFor();
    },
    /** @param {Stage} stage */
    async run({ page, d, p }) {
      const missingRow = page.getByTestId('missing-marks').getByRole('row').nth(1);
      const number = (await missingRow.getByRole('cell').nth(0).innerText()).trim();
      const company = (await missingRow.getByRole('cell').nth(1).innerText()).trim();
      const position = (await p.read('ops.one', '/api/v1/investments?limit=200')).items.find(
        (i) => i.investmentNumber === number,
      );
      const fairValue = (Math.round(Number(position.nav) * 1.04 * 100) / 100).toFixed(2);
      const label = `${company}, ${shownDate(quarter)} v1`;
      const status = page.getByTestId('valuation-action-status');
      const row = page
        .getByRole('table', { name: 'Valuations' })
        .getByRole('row')
        .filter({ hasText: number });

      await d.ring(page.getByTestId('missing-marks'));
      await d.say(
        'The valuation board. One active position has no mark for this quarter yet.',
        4200,
      );
      await d.unring();

      await d.caption('Operations starts a draft: the position, the method and the fair value.');
      await d.click(page.getByRole('button', { name: 'New valuation', exact: true }));
      const dialog = page.getByRole('dialog');
      await d.click(dialog.getByRole('combobox', { name: 'Investment' }), 450);
      await d.click(page.getByRole('option', { name: `${number} ${company}` }), 450);
      await d.click(dialog.getByRole('combobox', { name: 'Method' }), 450);
      await d.click(page.getByRole('option', { name: /sponsor mark/i }), 450);
      await d.type(dialog.getByLabel('Fair value (dollars)'), fairValue, 900);
      await d.click(dialog.getByRole('button', { name: 'Create draft', exact: true }));
      await status.filter({ hasText: 'Draft valuation created' }).waitFor();
      await p.settle();
      await d.bring(row);
      await d.wait(600);

      await d.caption('Operations prepares it.');
      await d.click(page.getByRole('button', { name: `Prepare, ${label}`, exact: true }));
      await status.filter({ hasText: 'is now Ops prepared' }).waitFor();
      await d.ring(row);
      await d.wait(700);

      await d.caption(
        'Next, the deal team. The person who prepared a valuation can never approve it.',
      );
      await switchOnCamera({ page, d, p }, 'deal.one');
      await d.click(nav(page, 'Valuations'));
      await row.waitFor();
      await p.settle();
      await d.bring(row);
      await d.click(page.getByRole('button', { name: `Deal team approve, ${label}`, exact: true }));
      await status.filter({ hasText: 'is now Deal team approved' }).waitFor();
      await d.ring(row);
      await d.wait(600);

      await d.caption('Last, an approver selects the version and locks it from the batch bar.');
      await switchOnCamera({ page, d, p }, 'head.one');
      await d.click(nav(page, 'Valuations'));
      await row.waitFor();
      await p.settle();
      await d.bring(row);
      await d.click(row.getByRole('checkbox'), 500);
      await d.click(
        page.getByTestId('valuation-batch-bar').getByRole('button', { name: /^Lock selected/ }),
      );
      await status.filter({ hasText: 'Lock on 1 version' }).waitFor();
      await p.settle();
      await d.ring(row);
      await d.wait(900);
      await d.unring();

      await d.caption('The version screen shows what the lock covers.');
      await d.click(row.getByRole('link', { name: shownDate(quarter) }));
      await page.getByTestId('valuation-lock-text').waitFor();
      await p.settle();
      await d.wait(300);
      await d.ring(page.getByTestId('valuation-lock'));
      await d.poster();
      await d.say(
        'The lock is a SHA-256 hash over the version, the method, its inputs and the fair value.',
        4600,
      );
      await d.ring(card(page.getByRole('table', { name: 'Approvals' })));
      await d.say('Three decisions by three different people.', 2900);
      await d.unring();
      await d.say(
        'Reports read Locked valuations only. A correction reopens one into a new version.',
        4200,
      );
    },
  },
  {
    name: 'capital-call',
    title: 'A capital call with a changed wire',
    subtitle:
      'Review, the trade ticket, the hold on a changed instruction, the callback and the release.',
    summary:
      'A capital call arrives with new wire instructions: operations reviews it and drafts the ticket, the release stays blocked until a second person verifies the change by callback, and a third person approves.',
    /** @param {Stage} stage */
    async setup({ p }) {
      await p.signIn('ops.one');
      await p.go('/capital-activity');
    },
    /** @param {Stage} stage */
    async run({ page, d, p }) {
      const notice = (await p.read('ops.one', '/api/v1/capital-notices?limit=200')).items.find(
        (n) => n.scenarioTag === 'wire_change',
      );
      const status = page.getByTestId('notice-action-status');
      const workflow = page.getByTestId('notice-workflow');
      const release = page.getByTestId('ticket-release');
      const openNotice = async () => {
        await p.go(`/capital-activity/${notice.id}`);
        await page.getByTestId('notice-banner').waitFor();
        await p.settle();
      };

      await d.say(
        'Capital activity: calls, distributions and payments, with alerts as due dates approach.',
        3700,
      );
      await d.caption('This capital call is due in two days and is marked Wire change.');
      await d.click(
        page.getByRole('table').first().getByRole('link', { name: notice.companyName }),
      );
      await page.getByTestId('notice-banner').waitFor();
      await p.settle();
      await d.ring(page.getByTestId('notice-alerts'));
      await d.say(
        'Two alerts: the wire instructions changed, and the notice presses for a quick payment.',
        4600,
      );
      await d.unring();

      await d.caption('Operations reviews the call and drafts the trade ticket.');
      await d.click(workflow.getByRole('button', { name: 'Review', exact: true }));
      await status.filter({ hasText: 'is now Reviewed' }).waitFor();
      await d.click(workflow.getByRole('button', { name: 'Draft ticket', exact: true }));
      const form = page.getByTestId('draft-ticket-form');
      await form.waitFor();
      await d.wait(600);
      await d.click(form.getByRole('button', { name: 'Draft ticket', exact: true }));
      await status.filter({ hasText: 'is now Ticket drafted' }).waitFor();
      await p.settle();
      await d.ring(release);
      await d.poster();
      await d.say(
        'The release is blocked. The wire changed inside the hold window, and a preparer cannot approve their own ticket.',
        5000,
      );
      await d.unring();

      await d.caption(
        'A second operations person opens the proposed instruction in the wire register.',
      );
      await switchOnCamera({ page, d, p }, 'ops.two');
      await p.go('/capital-activity/wires');
      const register = page.getByRole('table', { name: 'Wire instructions' });
      await register.waitFor();
      await p.settle();
      // The header row reads "Proposed by": the version waiting for its callback is a row with a link.
      const proposed = register
        .getByRole('row')
        .filter({ has: page.getByRole('link') })
        .filter({ hasText: 'Proposed' })
        .first();
      await d.click(proposed.getByRole('link').first());
      await page.getByTestId('wire-banner').waitFor();
      await p.settle();
      const callback = page.getByTestId('wire-callback-form');
      await d.bring(callback);
      await d.caption('They call back on a number sourced independently, and record the result.');
      await d.pick(page, 'Number source', 'Prior instruction on file');
      await d.pick(page, 'Result', 'Confirmed');
      await d.click(
        callback.getByRole('button', { name: 'Record callback and verify', exact: true }),
      );
      await page.getByTestId('wire-action-status').filter({ hasText: 'is now Verified' }).waitFor();
      await p.settle();
      await d.scrollTop();
      await d.ring(page.getByTestId('wire-banner'));
      await d.say('The new version is verified and active. The earlier one is superseded.', 3300);
      await d.unring();

      await d.caption(
        'Inside the hold window the release needs a third person: an approver who touched neither step.',
      );
      await switchOnCamera({ page, d, p }, 'head.one');
      await openNotice();
      await d.ring(release);
      await d.finishCaption();
      await d.unring();
      await d.click(workflow.getByRole('button', { name: 'Approve ticket', exact: true }));
      await status.filter({ hasText: 'is now Ticket approved' }).waitFor();
      await p.settle();
      await d.ring(page.getByTestId('ticket-panel'));
      await d.say(
        'The ticket is approved against the verified instruction. Bank details stay masked outside the wire register.',
        5200,
      );
      await d.unring();
    },
  },
  {
    name: 'deal',
    title: 'A deal, from pipeline to position',
    subtitle:
      'The stage board, the diligence gate, the committee decision and the closing checklist.',
    summary:
      'A deal passes the diligence gate, the investment committee and the closing checklist, and becomes a position in the portfolio.',
    /** @param {Stage} stage */
    async setup({ p }) {
      await p.signIn('deal.one');
      // The closing checklist receives its items against documents in the hub.
      await p.send('ops.one', 'POST', '/api/v1/documents/index');
      const sourced = (await p.read('deal.one', '/api/v1/opportunities?limit=200')).items.find(
        (o) =>
          o.stage === 'Sourced' &&
          o.targetCommitment !== null &&
          o.owner?.name === p.user('deal.one').displayName,
      );
      if (sourced === undefined)
        throw new Error('the preview has no sourced deal owned by the deal team user');
      // Screening and prescreen are two plain advances with no gate; the recording starts where
      // the gates do, with the deal at prescreen.
      for (const stage of ['Screening', 'Prescreen']) {
        const moved = await p.send(
          'deal.one',
          'POST',
          `/api/v1/opportunities/${sourced.id}/commands`,
          {
            command: 'advance',
          },
        );
        if (moved.stage !== stage) throw new Error(`the deal did not advance to ${stage}`);
      }
      stagedDealId = sourced.id;
      await p.go('/pipeline');
      await p.page.getByTestId(`opportunity-card-${sourced.id}`).waitFor();
    },
    /** @param {Stage} stage */
    async run({ page, d, p }) {
      const deal = (await p.read('deal.one', '/api/v1/opportunities?limit=200')).items.find(
        (o) => o.id === stagedDealId,
      );
      const documentId = (await p.read('ops.one', '/api/v1/documents?limit=200')).items[0].id;
      const path = `/api/v1/opportunities/${deal.id}`;
      const status = page.getByTestId('opportunity-action-status');
      const advance = page.getByRole('button', { name: `Advance, ${deal.name}`, exact: true });
      const gates = page.getByTestId('opportunity-gates');
      const openDeal = async () => {
        await p.go(`/pipeline/${deal.id}`);
        await page.getByTestId('opportunity-banner').waitFor();
        await p.settle();
      };
      const advanceTo = async (stage) => {
        await d.click(advance, 250);
        await status.filter({ hasText: `${deal.name} is now ${stage}` }).waitFor();
        await p.settle();
        await d.wait(300);
      };

      const cardLink = page
        .getByTestId(`opportunity-card-${deal.id}`)
        .getByRole('link', { name: deal.name });
      await d.bring(cardLink);
      await d.caption('The pipeline: every deal by stage. The deal team opens one at prescreen.');
      await d.wait(1700);
      await d.click(cardLink);
      await page.getByTestId('opportunity-banner').waitFor();
      await p.settle();
      await d.finishCaption();
      await d.caption('It advances into diligence, which opens the task list for the deal type.');
      await advanceTo('Diligence');
      const tasks = (await p.read('deal.one', path)).diligenceTasks;
      const required = tasks.filter((t) => t.requiredForIc);
      await d.ring(gates);
      await d.say('The gate: no investment committee while a required task is open.');
      await d.unring();

      await d.caption('The team completes each required task.');
      const first = required[0];
      await d.click(page.getByRole('button', { name: `Complete, ${first.title}`, exact: true }));
      await d.click(
        page.getByRole('dialog').getByRole('button', { name: 'Complete', exact: true }),
      );
      await status.filter({ hasText: `${first.title} is now Done` }).waitFor();
      // The other required tasks are completed with the same command the button sends.
      for (const task of required.slice(1))
        await p.send('deal.one', 'POST', `${path}/diligence-tasks/${task.id}/commands`, {
          command: 'complete',
        });
      await d.finishCaption();

      await d.caption(
        'With the gate clear, an approver takes it to committee and records the decision.',
      );
      await switchOnCamera({ page, d, p }, 'head.one');
      await openDeal();
      await d.ring(gates);
      await d.wait(700);
      await d.unring();
      await advanceTo('IC');
      const form = page.getByTestId('ic-decision-form');
      await d.fill(form.getByLabel('Decision date'), asOf, 250);
      await d.click(form.getByRole('combobox', { name: /^Decision/ }), 300);
      await d.click(page.getByRole('option', { name: 'Approved', exact: true }), 300);
      await d.click(form.getByRole('button', { name: 'Record decision', exact: true }));
      await status.filter({ hasText: 'IC decision recorded' }).waitFor();
      await p.settle();
      await advanceTo('Approved');

      await d.caption('Operations opens the closing: one close date, read by every report.');
      await switchOnCamera({ page, d, p }, 'ops.one');
      await openDeal();
      await d.click(advance, 420);
      const closingDialog = page.getByRole('dialog');
      await d.fill(closingDialog.getByLabel('Close date'), asOf, 600);
      await d.click(closingDialog.getByRole('button', { name: 'Open closing', exact: true }));
      await status.filter({ hasText: `${deal.name} is now Closing` }).waitFor();
      await p.settle();

      const closing = (await p.read('ops.one', path)).closing;
      await p.go(`/pipeline/${deal.id}/closing`);
      await page.getByTestId('closing-panel').waitFor();
      await p.settle();
      await d.ring(page.getByTestId('closing-blockers'));
      await d.poster();
      await d.say('Confirmation waits for every required document, and for allocations that tie.');
      await d.unring();
      // The items and the allocation line are recorded through the same commands the page sends.
      const detail = await p.read('ops.one', `/api/v1/closings/${closing.id}`);
      for (const item of detail.items.filter((i) => i.required && i.status === 'open'))
        await p.send(
          'ops.one',
          'POST',
          `/api/v1/closings/${closing.id}/items/${item.itemCode}/commands`,
          {
            command: 'receive',
            documentId,
          },
        );
      const vehicles = (await p.read('ops.one', '/api/v1/vehicles')).items;
      await p.send('ops.one', 'PUT', `${path}/allocations`, {
        allocations: [
          {
            vehicleId: vehicles[0].id,
            requested: deal.targetCommitment,
            received: deal.targetCommitment,
          },
        ],
      });
      await d.caption(
        'The documents are received and the allocation ties to the commitment exactly.',
      );
      await p.go(`/pipeline/${deal.id}`, { settle: false });
      await p.go(`/pipeline/${deal.id}/closing`);
      await page.getByTestId('closing-panel').waitFor();
      await p.settle();
      await d.ring(page.getByTestId('closing-items'));
      await d.wait(900);
      await d.unring();
      await d.click(page.getByTestId('closing-confirm'));
      await page
        .getByTestId('closing-action-status')
        .filter({ hasText: 'Closing confirmed' })
        .waitFor();
      await p.settle();
      await d.finishCaption();

      await d.caption('Confirmed, the deal closes and becomes a position.');
      await openDeal();
      await advanceTo('Closed and converted into a position');
      await d.click(
        page
          .getByTestId('opportunity-workflow')
          .getByRole('link', { name: 'open the deal workspace' }),
      );
      await page.getByTestId('detail-banner').waitFor();
      await p.settle();
      await d.ring(page.getByTestId('detail-banner'));
      await d.say(
        'The new position sits in the portfolio. It carries no figure yet: nothing is invented.',
        4400,
      );
      await d.unring();
    },
  },
  {
    name: 'documents',
    title: 'From a sponsor report to the record',
    subtitle: 'Indexing and tagging, the review queue, extraction with citations and approval.',
    summary:
      'Operations indexes the document store, a batch reads the quarterly reports, a reviewer checks a value against its page and approves, and the figures appear on the position with their source.',
    /** @param {Stage} stage */
    async setup({ p }) {
      await p.signIn('ops.one');
      // The extraction kill switch is off by default; a platform admin turns it on (audited in the API).
      await p.send('admin.one', 'PATCH', '/api/v1/flags/ai.extraction', {
        enabled: true,
        reason: 'Enabled for the demo recording',
      });
      await p.go('/documents');
      await p.page.getByRole('button', { name: 'Index documents' }).waitFor();
    },
    /** @param {Stage} stage */
    async run({ page, d, p }) {
      await d.caption('The document hub starts empty. Operations indexes the document store.');
      await d.wait(900);
      await d.click(page.getByRole('button', { name: 'Index documents' }), 300);
      await page
        .getByTestId('documents-action-status')
        .filter({ hasText: 'Indexed' })
        .waitFor({ timeout: 60_000 });
      const documents = page.getByRole('table', { name: 'Documents' });
      await documents.waitFor();
      await p.settle();
      await d.ring(documents);
      await d.say('Each file is hashed, tagged by a classifier and linked to its deal or fund.');
      await d.unring();

      await d.caption(
        'A tag below the confidence threshold waits in the review queue for a person.',
      );
      await d.click(tab(page, 'Review queue'));
      await page.getByTestId('review-queue').waitFor();
      await p.settle();
      await d.ring(page.getByTestId('review-queue'));
      await d.finishCaption();
      await d.unring();

      await d.caption('Extraction: a batch reads the financial reports of the quarter.');
      await d.click(tab(page, 'Extraction'));
      const batchForm = page.getByTestId('extraction-batch-form');
      await batchForm.getByLabel('Period end').waitFor();
      await p.settle();
      await d.fill(batchForm.getByLabel('Period end'), quarter, 400);
      await d.click(batchForm.getByRole('button', { name: 'Start extraction', exact: true }), 300);
      await page
        .getByTestId('extraction-action-status')
        .filter({ hasText: 'Batch started' })
        .waitFor({ timeout: 60_000 });
      await p.settle();
      await d.ring(page.getByTestId('extraction-runs'));
      await d.say('In the prototype a mock model answers. Each run waits for a reviewer.');
      await d.unring();

      const runs = (await p.read('ops.one', '/api/v1/extraction/runs?limit=200')).items.filter(
        (r) => r.state === 'Succeeded',
      );
      const run = runs.find((r) => r.counts.flagged > 0) ?? runs[0];
      const detail = await p.read('ops.one', `/api/v1/extraction/runs/${run.id}`);
      const revenue = detail.values.find((v) => v.field === 'revenue_ltm');
      await d.click(
        page.getByTestId(`extraction-run-${run.id}`).getByRole('link', { name: /^Review / }),
      );
      await page.getByTestId('run-fields').waitFor();
      await p.settle();
      await d.ring(page.getByTestId('run-fields'));
      await d.say('Every value in a run carries its page, a short quote and a confidence.');
      await d.unring();
      await d.caption(
        'Click a value to see where it was read: the page, with the quote highlighted.',
      );
      await d.click(
        page.getByRole('button', { name: `Show Revenue LTM on page ${revenue.page}`, exact: true }),
      );
      await d.scrollTo(page.getByTestId('run-page-drawing'), 'start');
      await d.scrollBy(-120);
      await d.ring(page.getByTestId('run-page-highlight').first());
      await d.poster();
      await d.finishCaption();
      await d.wait(200);
      await d.unring();

      await d.scrollTo(page.getByTestId('run-tiles'), 'center');
      await d.caption('Clean values are accepted in one go. Flagged ones are decided one by one.');
      await d.click(page.getByRole('button', { name: 'Accept clean values', exact: true }));
      await page.getByTestId('run-action-status').filter({ hasText: 'accepted' }).waitFor();
      await p.settle();
      await d.caption(
        'The reviewer approves with a reason. Nothing reaches the record before this.',
      );
      await d.click(page.getByRole('button', { name: 'Approve and promote', exact: true }), 420);
      const dialog = page.getByRole('dialog');
      await d.type(dialog.getByLabel('Reason'), 'Checked against the report', 400);
      await d.click(dialog.getByRole('button', { name: 'Approve and promote', exact: true }));
      await page.getByTestId('run-action-status').filter({ hasText: 'Approved' }).waitFor();
      await p.settle();
      await d.finishCaption();

      await d.caption('The deal team now reads the quarter on the position.');
      await switchOnCamera({ page, d, p }, 'deal.one');
      await p.go(`/portfolio/${run.investmentId}/performance`);
      const source = page.getByTestId(`performance-source-${quarter}`);
      await source.waitFor();
      await p.settle();
      await d.ring(source);
      await d.say(
        'The approved figures link back to the document and the page they came from.',
        4200,
      );
      await d.unring();
    },
  },
];

// ---- Recording ---------------------------------------------------------------------------------

const preview = await servePreview();
const browser = await launchChromium();
const work = mkdtempSync(join(tmpdir(), 'pb-site-videos-'));
if (only === null) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
if (framesDir !== null) mkdirSync(framesDir, { recursive: true });

/** @type {{ name: string, title: string, summary: string, steps: { at: number, text: string }[], poster: Buffer | null }[]} */
const recorded = [];
for (const demo of DEMOS) {
  if (only !== null && !only.has(demo.name)) continue;
  log(`recording ${demo.name}`);
  const context = await browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    // A screencast frame is written at least once at 25 frames a second, so anything that paints
    // faster than that plays back slowed. The app's own motion is parked; the overlay's is brief.
    reducedMotion: 'reduce',
    recordVideo: { dir: join(work, demo.name), size: SIZE },
  });
  await context.addInitScript(installOverlay, {
    tokens,
    title: demo.title,
    subtitle: demo.subtitle,
    captionHeight: CAPTION_HEIGHT,
  });
  // The preview guide on Home is for a reviewer of the preview; the recordings show the pages themselves.
  await context.addInitScript(() => {
    try {
      globalThis.sessionStorage.setItem('pb.previewGuide', 'hidden');
    } catch {
      // Storage blocked: the guide shows, which changes nothing a recording relies on.
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const p = { ...previewDriver(page, preview.origin), page };
  let frame = 0;
  const d = director(page, {
    debugFrame:
      framesDir === null
        ? undefined
        : async () => {
            frame += 1;
            await page.screenshot({
              path: join(framesDir, `${demo.name}-${String(frame).padStart(2, '0')}.png`),
            });
          },
  });
  const shownAt = Date.now();
  await p.open();
  await demo.setup({ page, d, p });
  await p.settle();
  // The title card stays up for at least three seconds while the app loads and is set up under it.
  await d.wait(Math.max(0, 3000 - (Date.now() - shownAt)));
  await d.showTitle(false);
  await d.wait(450);
  await d.showCursor(true);
  await demo.run({ page, d, p });
  await d.finishCaption();
  await d.wait(300);
  log(`  ${demo.name}: ${d.elapsed().toFixed(1)}s of wall time`);
  if (errors.length > 0) throw new Error(`${demo.name}: page errors: ${errors.join(' | ')}`);
  const video = page.video();
  await context.close();
  if (video === null) throw new Error(`${demo.name}: no recording was made`);
  renameSync(await video.path(), join(OUT, `${demo.name}.webm`));
  recorded.push({
    name: demo.name,
    title: demo.title,
    summary: demo.summary,
    steps: d.steps,
    poster: d.getPoster(),
  });
}
await preview.close();

// ---- Posters, durations and the manifest ---------------------------------------------------------

const media = await serveStatic(OUT);
const context = await browser.newContext({ viewport: SIZE });
const probe = await context.newPage();
await probe.goto(`${media.origin}/__blank`).catch(() => undefined);
await probe.setContent('<!doctype html><title>probe</title>');

async function posterWebp(png) {
  const base64 = await probe.evaluate(async (source) => {
    const blob = await (await globalThis.fetch(`data:image/png;base64,${source}`)).blob();
    const bitmap = await globalThis.createImageBitmap(blob);
    const canvas = new globalThis.OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.86 });
    const bytes = new Uint8Array(await out.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return globalThis.btoa(binary);
  }, png.toString('base64'));
  return Buffer.from(base64, 'base64');
}

/** The length the browser reads from the file: the proof that it is a playable recording. */
async function durationOf(file) {
  const seconds = await probe.evaluate(
    (src) =>
      new Promise((resolve, reject) => {
        const video = globalThis.document.createElement('video');
        video.preload = 'metadata';
        video.muted = true;
        video.addEventListener('error', () => reject(new Error(`cannot read ${src}`)));
        video.addEventListener('loadedmetadata', () => {
          if (Number.isFinite(video.duration)) {
            resolve(video.duration);
            return;
          }
          // A recording without a length in its header: seek to the end to learn it.
          video.addEventListener('durationchange', () => {
            if (Number.isFinite(video.duration)) resolve(video.duration);
          });
          video.currentTime = 1e7;
        });
        video.src = src;
      }),
    `${media.origin}/${file}`,
  );
  return Math.round(seconds * 10) / 10;
}

const previous = (() => {
  try {
    return JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')).videos ?? [];
  } catch {
    return [];
  }
})();
const entries = new Map(previous.map((v) => [v.name, v]));
let failed = false;
for (const item of recorded) {
  const file = `${item.name}.webm`;
  const bytes = statSync(join(OUT, file)).size;
  const seconds = await durationOf(file);
  if (item.poster === null) throw new Error(`${item.name}: the script took no poster frame`);
  writeFileSync(join(OUT, `${item.name}.webp`), await posterWebp(item.poster));
  entries.set(item.name, {
    name: item.name,
    title: item.title,
    summary: item.summary,
    file,
    poster: `${item.name}.webp`,
    width: SIZE.width,
    height: SIZE.height,
    seconds,
    bytes,
    steps: item.steps,
  });
  const megabytes = (bytes / 1024 / 1024).toFixed(1);
  log(`${item.name}: ${seconds}s, ${megabytes} MB, ${item.steps.length} captions`);
  if (bytes > MAX_BYTES) {
    log(`FAIL ${item.name}: ${megabytes} MB is over the 12 MB limit`);
    failed = true;
  }
}
const manifest = {
  generatedFrom: 'apps/web/dist-preview',
  asOf,
  format: 'video/webm',
  videos: DEMOS.map((demo) => entries.get(demo.name)).filter((v) => v !== undefined),
};
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await browser.close();
await media.close();
rmSync(work, { recursive: true, force: true });
log(`record-demos: ${recorded.length} recordings in ${OUT}`);
process.exit(failed ? 1 : 0);
