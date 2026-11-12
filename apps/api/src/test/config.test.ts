import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { problemDetails } from '@pb/contracts';
import { dealStageMachine } from '@pb/workflows';
import {
  configDecimal,
  configInteger,
  configIntegerByName,
  configString,
  configStringList,
} from '../common/definitions.js';
import { ProblemError } from '../common/problem.js';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

const MISSING_TOLERANCE =
  'config/definitions.json is missing a usable priorYearPeriodEndToleranceDays';

/** The repo's config folder, the one the harness serves (composition.ts loads the same files). */
const CONFIG_DIR = fileURLToPath(new URL('../../../../config/', import.meta.url));
const readConfig = (fileName: string): unknown =>
  JSON.parse(readFileSync(join(CONFIG_DIR, fileName), 'utf8'));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The deal_type codes of the taxonomy (migration 0002), the keys a diligence template may carry. */
const DEAL_TYPES = [
  'deal_type.co_invest_equity',
  'deal_type.cv_single_asset',
  'deal_type.cv_multi_asset',
  'deal_type.primary_fund',
  'deal_type.private_credit',
];

/** The diligence_workstream codes of the taxonomy (migration 0013). */
const WORKSTREAMS = [
  'commercial',
  'financial',
  'legal',
  'tax',
  'esg',
  'operational',
  'references',
  'sponsor',
].map((w) => `diligence_workstream.${w}`);

describe('config readers: a missing or malformed key is a configuration problem', () => {
  const problemOf = (read: () => unknown): ProblemError => {
    try {
      read();
    } catch (error) {
      if (error instanceof ProblemError) return error;
      throw error;
    }
    throw new Error('expected a configuration problem');
  };

  it('reads whole numbers of zero or more and names the key otherwise', () => {
    expect(configInteger(7, 'k')).toBe(7);
    expect(configInteger(0, 'k')).toBe(0);
    for (const bad of [undefined, null, -1, 7.5, '7', Number.NaN]) {
      const problem = problemOf(() => configInteger(bad, 'priorYearPeriodEndToleranceDays'));
      expect(problem.getStatus()).toBe(500);
      expect(problem.code).toBe('configuration');
      expect(problem.message).toBe(MISSING_TOLERANCE);
    }
  });

  it('reads labels and templates as strings with text in them, never anything else', () => {
    expect(configString('NM', 'irr.displayShortPeriodAs')).toBe('NM');
    expect(configString('Carried at {lockedPeriodEnd}.', 'k')).toBe(
      'Carried at {lockedPeriodEnd}.',
    );
    for (const bad of [undefined, null, '', '   ', 7, {}, ['NM']]) {
      const problem = problemOf(() => configString(bad, 'reporting.noValuationFootnote'));
      expect(problem.getStatus()).toBe(500);
      expect(problem.code).toBe('configuration');
      expect(problem.message).toBe(
        'config/definitions.json is missing a usable reporting.noValuationFootnote',
      );
    }
  });

  it('reads decimals from numbers and decimal strings, never from anything else', () => {
    expect(configDecimal(6, 'k').toString()).toBe('6');
    expect(configDecimal(0.15, 'k').toString()).toBe('0.15');
    expect(configDecimal('0.2', 'k').toString()).toBe('0.2');
    for (const bad of [undefined, null, '1e3', 'abc', Number.POSITIVE_INFINITY, {}]) {
      expect(problemOf(() => configDecimal(bad, 'watchlist.markdownPct')).code).toBe(
        'configuration',
      );
    }
  });

  it('reads a list of phrases as strings with text in them, never empty or anything else', () => {
    expect(configStringList(['urgent', 'same day'], 'k')).toEqual(['urgent', 'same day']);
    for (const bad of [
      undefined,
      null,
      [],
      ['urgent', ''],
      ['urgent', '  '],
      ['urgent', 7],
      'urgent',
      {},
    ]) {
      const problem = problemOf(() => configStringList(bad, 'capitalActivity.urgencyPhrases'));
      expect(problem.getStatus()).toBe(500);
      expect(problem.code).toBe('configuration');
      expect(problem.message).toBe(
        'config/definitions.json is missing a usable capitalActivity.urgencyPhrases',
      );
    }
  });

  it('reads whole numbers by name and names the entry that is wrong', () => {
    expect(configIntegerByName({ Sourced: 30, IC: 0 }, 'k')).toEqual({ Sourced: 30, IC: 0 });
    for (const bad of [undefined, null, {}, [], 7, '30']) {
      const problem = problemOf(() => configIntegerByName(bad, 'pipeline.stageAgingDays'));
      expect(problem.code).toBe('configuration');
      expect(problem.message).toBe(
        'config/definitions.json is missing a usable pipeline.stageAgingDays',
      );
    }
    for (const bad of [{ Sourced: -1 }, { Sourced: 7.5 }, { Sourced: '30' }, { Sourced: null }]) {
      const problem = problemOf(() => configIntegerByName(bad, 'pipeline.stageAgingDays'));
      expect(problem.code).toBe('configuration');
      expect(problem.message).toBe(
        'config/definitions.json is missing a usable pipeline.stageAgingDays.Sourced',
      );
    }
  });
});

describe('the Phase 3 control settings in config (decision 0013)', () => {
  it('definitions.json carries the urgency phrases, the due-soon window and the hold days', () => {
    const definitions = readConfig('definitions.json');
    if (!isRecord(definitions) || !isRecord(definitions.capitalActivity))
      throw new Error('capitalActivity block missing');
    const capital = definitions.capitalActivity;
    const phrases = configStringList(capital.urgencyPhrases, 'capitalActivity.urgencyPhrases');
    expect(phrases).toContain('urgent');
    expect(phrases).toContain('within 24 hours');
    // Matched case-insensitively, so the config keeps them lower case and without duplicates.
    expect(phrases).toEqual(phrases.map((p) => p.toLowerCase()));
    expect(new Set(phrases).size).toBe(phrases.length);
    expect(configInteger(capital.dueSoonBusinessDays, 'capitalActivity.dueSoonBusinessDays')).toBe(
      2,
    );
    expect(configInteger(capital.wireChangeHoldDays, 'capitalActivity.wireChangeHoldDays')).toBe(
      30,
    );
  });

  it('definitions.json gives an aging in days for every live pipeline stage, and only those', () => {
    const definitions = readConfig('definitions.json');
    if (!isRecord(definitions) || !isRecord(definitions.pipeline))
      throw new Error('pipeline block missing');
    const aging = configIntegerByName(
      definitions.pipeline.stageAgingDays,
      'pipeline.stageAgingDays',
    );
    const live = dealStageMachine.states.filter((s) => s !== 'Closed' && s !== 'Passed');
    expect(Object.keys(aging)).toEqual(live);
    for (const stage of live) expect(aging[stage], stage).toBeGreaterThan(0);
  });

  it('closing_checklist.json names the five required documents of docs/04 M8 with unique codes', () => {
    const checklist = readConfig('closing_checklist.json');
    if (!isRecord(checklist) || !Array.isArray(checklist.items)) throw new Error('items missing');
    const items = checklist.items.map((item: unknown) => {
      if (!isRecord(item)) throw new Error('an item is not an object');
      expect(item.code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(configString(item.label, 'closing_checklist.items.label')).toBe(item.label);
      expect(typeof item.required).toBe('boolean');
      return { code: item.code as string, required: item.required as boolean };
    });
    expect(new Set(items.map((i) => i.code)).size).toBe(items.length);
    expect(items.filter((i) => i.required).map((i) => i.code)).toEqual([
      'signed_documents',
      'cap_table',
      'funds_flow',
      'wire_confirmation',
      'consents',
    ]);
    expect(items.some((i) => !i.required)).toBe(true);
  });

  it('diligence_templates.json covers every deal type of the taxonomy, with a default, in known workstreams', () => {
    const config = readConfig('diligence_templates.json');
    if (!isRecord(config) || !isRecord(config.templates) || !Array.isArray(config.default))
      throw new Error('templates or default missing');
    expect(Object.keys(config.templates).sort()).toEqual([...DEAL_TYPES].sort());
    const checkTasks = (tasks: unknown, name: string): void => {
      if (!Array.isArray(tasks) || tasks.length === 0) throw new Error(`${name} has no tasks`);
      let requiredForIc = 0;
      for (const task of tasks) {
        if (!isRecord(task)) throw new Error(`${name} has a task that is not an object`);
        expect(WORKSTREAMS, `${name} workstream`).toContain(task.workstream);
        expect(configString(task.title, `${name}.title`)).toBe(task.title);
        expect(typeof task.requiredForIc, `${name} requiredForIc`).toBe('boolean');
        if (task.requiredForIc === true) requiredForIc += 1;
      }
      // Every template gates the IC on at least one task, so Diligence > IC means something.
      expect(requiredForIc, `${name} tasks required for IC`).toBeGreaterThan(0);
    };
    for (const [dealType, tasks] of Object.entries(config.templates)) checkTasks(tasks, dealType);
    checkTasks(config.default, 'default');
  });
});

describe('an API whose config lacks priorYearPeriodEndToleranceDays', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ withoutDefinitions: ['priorYearPeriodEndToleranceDays'] });
  });
  afterAll(async () => {
    await h.close();
  });

  const investmentId = (): string => h.dataset.investments[0]!.id;

  it('answers the investment detail with a 500 configuration problem and audits nothing', async () => {
    expect(h.runtime.definitions.priorYearPeriodEndToleranceDays).toBeUndefined();
    const res = await h
      .http()
      .get(`/api/v1/investments/${investmentId()}?asOf=${h.dataset.asOf}`)
      .set('authorization', h.as('viewer'))
      .set('x-request-id', 'req-config-detail-1')
      .expect(500);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    const problem = problemDetails.parse(res.body);
    expect(problem.type).toBe('https://portfolio-beach.example/problems/configuration');
    expect(problem.status).toBe(500);
    expect(problem.detail).toBe(MISSING_TOLERANCE);
    expect(problem.request_id).toBe('req-config-detail-1');
    // Nothing was disclosed, so no sensitive read is on record.
    const audit = await h.runtime.db.query<{ n: number }>(
      "select count(*)::int as n from audit.event where request_id = 'req-config-detail-1'",
    );
    expect(audit[0]?.n).toBe(0);
  });

  it('fails every read the tolerance drives, never with a default, and serves the rest', async () => {
    const get = (path: string): ReturnType<ReturnType<Harness['http']>['get']> =>
      h.http().get(path).set('authorization', h.as('viewer'));
    const vehicleId = h.dataset.investments[0]!.vehicleId;
    for (const path of [
      `/api/v1/investments/${investmentId()}/performance`,
      `/api/v1/vehicles/${vehicleId}`,
      '/api/v1/analytics/summary',
      '/api/v1/monitoring/watchlist',
      '/api/v1/reports/weekly',
      '/api/v1/valuations',
    ]) {
      const res = await get(path).expect(500);
      expect(problemDetails.parse(res.body).detail, path).toBe(MISSING_TOLERANCE);
    }
    // The grid needs no tolerance and still answers; walls and 404s are unaffected.
    await get('/api/v1/investments?limit=5').expect(200);
    await get('/api/v1/investments/not-a-uuid').expect(404);
  });
});

/**
 * The weekly report reads every setting through the readers: without the reporting block or the
 * IRR display label it answers a 500 that names the key, where it used to fall back to numbers and
 * sentences written in code.
 */
describe.each([
  ['reporting', 'reporting.weeklyMoversCount'],
  ['irr', 'irr.displayShortPeriodAs'],
])('an API whose config lacks %s', (dropped, key) => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ withoutDefinitions: [dropped] });
  });
  afterAll(async () => {
    await h.close();
  });

  it('answers the weekly report with a 500 configuration problem naming the key', async () => {
    const res = await h
      .http()
      .get('/api/v1/reports/weekly')
      .set('authorization', h.as('viewer'))
      .expect(500);
    const problem = problemDetails.parse(res.body);
    expect(problem.type).toBe('https://portfolio-beach.example/problems/configuration');
    expect(problem.detail).toBe(`config/definitions.json is missing a usable ${key}`);
    // Views that do not read the key still answer.
    await h
      .http()
      .get('/api/v1/analytics/summary')
      .set('authorization', h.as('viewer'))
      .expect(200);
  });
});
