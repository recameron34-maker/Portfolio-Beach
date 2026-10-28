import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONTROLS_DEFAULTS,
  closingChecklistFrom,
  controlsConfig,
  controlsOf,
  digitString,
  diligenceTemplateFor,
  diligenceTemplatesFrom,
  splitByOwnership,
} from './controls.js';
import { Rng } from './prng.js';

const configFile = (name: string): unknown => {
  const url = new URL(`../../../config/${name}`, import.meta.url);
  return existsSync(url) ? (JSON.parse(readFileSync(url, 'utf8')) as unknown) : undefined;
};

describe('the controls configuration the generator reads (CLAUDE.md rule 9)', () => {
  it('reads the committed files, or the documented defaults for a file that is not there yet', () => {
    const config = controlsConfig();
    const checklist = configFile('closing_checklist.json');
    expect(config.closingChecklist).toEqual(
      checklist === undefined
        ? CONTROLS_DEFAULTS.closingChecklist
        : closingChecklistFrom(checklist),
    );
    const templates = configFile('diligence_templates.json');
    expect(config.diligenceTemplates).toEqual(
      templates === undefined
        ? CONTROLS_DEFAULTS.diligenceTemplates
        : diligenceTemplatesFrom(templates),
    );
    // The required documents of docs/04 M8 and the co-investment template of the Phase 3 brief.
    expect(config.closingChecklist.filter((i) => i.required).map((i) => i.code)).toEqual(
      expect.arrayContaining([
        'signed_documents',
        'cap_table',
        'funds_flow',
        'wire_confirmation',
        'consents',
      ]),
    );
    expect(config.diligenceTemplates.templates['deal_type.co_invest_equity']).toHaveLength(6);
    expect(config.stageAgingDays.Diligence).toBeGreaterThan(0);
    const overridden = controlsConfig({
      closingChecklist: [{ code: 'x', label: 'X', required: true }],
    });
    expect(overridden.closingChecklist).toEqual([{ code: 'x', label: 'X', required: true }]);
    expect(overridden.diligenceTemplates).toEqual(config.diligenceTemplates);
  });

  it('stops on a file that is present but unusable, naming it', () => {
    expect(() => closingChecklistFrom({ items: [] })).toThrow('config/closing_checklist.json');
    expect(() => closingChecklistFrom({ items: [{ code: 'a', label: 'A' }] })).toThrow('items[0]');
    expect(() =>
      closingChecklistFrom({
        items: [
          { code: 'a', label: 'A', required: true },
          { code: 'a', label: 'B', required: false },
        ],
      }),
    ).toThrow('unique');
    expect(() => diligenceTemplatesFrom({ templates: {} })).toThrow(
      'config/diligence_templates.json',
    );
    expect(() =>
      diligenceTemplatesFrom({
        templates: { 'deal_type.x': [{ workstream: 'other.x', title: 'T', requiredForIc: true }] },
        default: [],
      }),
    ).toThrow('diligence_workstream');
    expect(() => diligenceTemplatesFrom({ templates: { 'sector.x': [] }, default: [] })).toThrow(
      'deal_type',
    );
  });

  it('picks the template for a deal type and falls back to the default', () => {
    const t = CONTROLS_DEFAULTS.diligenceTemplates;
    expect(diligenceTemplateFor('deal_type.co_invest_equity', t)).toBe(
      t.templates['deal_type.co_invest_equity'],
    );
    expect(diligenceTemplateFor('deal_type.unknown', t)).toBe(t.default);
    for (const tasks of [...Object.values(t.templates), t.default]) {
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks.some((x) => x.requiredForIc)).toBe(true);
      for (const x of tasks) expect(x.workstream.startsWith('diligence_workstream.')).toBe(true);
    }
  });
});

describe('the allocation split and the synthetic account digits', () => {
  it('splits an amount by ownership so the lines sum exactly, the last line taking the rounding remainder', () => {
    const thirds = splitByOwnership('100.00', [
      { key: 'a', pct: '0.33333333' },
      { key: 'b', pct: '0.33333333' },
      { key: 'c', pct: '0.33333334' },
    ]);
    expect(thirds).toEqual([
      { key: 'a', amount: '33.33' },
      { key: 'b', amount: '33.33' },
      { key: 'c', amount: '33.34' },
    ]);
    const exact = splitByOwnership('50000000.00', [
      { key: 'a', pct: '0.45' },
      { key: 'b', pct: '0.30' },
      { key: 'c', pct: '0.25' },
    ]);
    expect(exact.map((l) => l.amount)).toEqual(['22500000.00', '15000000.00', '12500000.00']);
    expect(splitByOwnership('10.00', [{ key: 'only', pct: '1' }])).toEqual([
      { key: 'only', amount: '10.00' },
    ]);
  });

  it('draws digit strings of the asked length from the seeded generator', () => {
    const a = digitString(new Rng(7), 10);
    expect(a).toMatch(/^\d{10}$/);
    expect(digitString(new Rng(7), 10)).toBe(a);
    expect(digitString(new Rng(8), 9)).toMatch(/^\d{9}$/);
  });

  it('reads the control arrays a dataset carries and treats a missing one as empty', () => {
    expect(controlsOf({ opportunities: [{ id: 'x' }], closings: 'no' }).opportunities).toEqual([
      { id: 'x' },
    ]);
    expect(controlsOf({ closings: 'no' }).closings).toEqual([]);
    expect(controlsOf(null).tradeTickets).toEqual([]);
  });
});
