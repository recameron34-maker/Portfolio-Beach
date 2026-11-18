import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_END, DOCUMENT_START, INPUT_TEMPLATE } from './input.js';
import {
  DATA_BOUNDARY_RULES,
  PROMPTS,
  PROMPT_IDS,
  UNIVERSAL_RULES,
  extractionPromptValues,
  promptRef,
  renderSystemPrompt,
} from './registry.js';
import { loadExtractionSchemas } from './schema.js';
import { highlightStyleFrom } from './validate.js';

const EM_DASH = String.fromCharCode(0x2014);
const root = new URL('../../../', import.meta.url);
const schemas = loadExtractionSchemas(
  JSON.parse(readFileSync(new URL('config/extraction_schema.json', root), 'utf8')),
);
const style = highlightStyleFrom(
  JSON.parse(readFileSync(new URL('config/style.json', root), 'utf8')),
);

describe('prompt registry (docs/07, SEC-8.3)', () => {
  it('holds the two Phase 2 prompts and the statement prompt at version 1 under their fixed ids', () => {
    expect(PROMPT_IDS).toEqual([
      'document_classifier',
      'quarterly_extraction',
      'capital_account_extraction',
    ]);
    expect(promptRef('capital_account_extraction')).toEqual({
      promptId: 'capital_account_extraction',
      promptVersion: '1',
    });
    expect(promptRef('document_classifier')).toEqual({
      promptId: 'document_classifier',
      promptVersion: '1',
    });
    expect(promptRef('quarterly_extraction')).toEqual({
      promptId: 'quarterly_extraction',
      promptVersion: '1',
    });
    for (const id of PROMPT_IDS) {
      expect(PROMPTS[id].id).toBe(id);
      expect(PROMPTS[id].version).toMatch(/^\d+$/);
      expect(PROMPTS[id].purpose.length).toBeGreaterThan(10);
      expect(PROMPTS[id].inputTemplate).toBe(INPUT_TEMPLATE);
    }
  });

  it('every system prompt carries the seven universal rules and the data boundary wording, with no em dash', () => {
    expect(UNIVERSAL_RULES).toHaveLength(7);
    expect(DATA_BOUNDARY_RULES).toHaveLength(3);
    for (const id of PROMPT_IDS) {
      const text = PROMPTS[id].systemPrompt;
      for (const rule of UNIVERSAL_RULES) expect(text).toContain(rule);
      for (const rule of DATA_BOUNDARY_RULES) expect(text).toContain(rule);
      expect(text).toContain(DOCUMENT_START);
      expect(text).toContain(DOCUMENT_END);
      expect(text).toContain('No tools are available');
      expect(text).toContain('Never invent numbers');
      expect(text).not.toContain(EM_DASH);
    }
  });

  it('renders the classifier prompt as is and refuses a placeholder it does not have', () => {
    expect(renderSystemPrompt('document_classifier')).toBe(
      PROMPTS.document_classifier.systemPrompt,
    );
    expect(() => renderSystemPrompt('document_classifier', { field_list: 'x' })).toThrow(
      /no placeholder named field_list/,
    );
  });

  it('renders the extraction prompt from the schema and the style, and refuses a half-filled one', () => {
    const values = extractionPromptValues(schemas.quarterly_financials!, style);
    const text = renderSystemPrompt('quarterly_extraction', values);
    expect(text).not.toContain('{{');
    expect(text).toContain(
      '- revenue_ltm: Revenue LTM (money, required; unit USD, USD_K, USD_M, USD_B)',
    );
    expect(text).toContain('- headcount: Headcount (count; unit COUNT)');
    expect(text).toContain('write 3 business highlight bullets');
    expect(text).toContain('bullet 1 opens with "LTM revenue"');
    expect(text).toContain(`never use "${style.bannedPhrases[0]}"`);
    expect(() => renderSystemPrompt('quarterly_extraction', { bullets: '3' })).toThrow(
      /needs a value for placeholder field_list/,
    );
  });

  it('renders the statement prompt from its schema alone: the quarterly task with its own first and last lines', () => {
    const schema = schemas.capital_account_statement!;
    const values = extractionPromptValues(schema, style);
    expect(Object.keys(values)).toEqual(['field_list']);
    const text = renderSystemPrompt('capital_account_extraction', values);
    expect(text).not.toContain('{{');
    expect(text).toContain(
      'Extract the fields listed below from the capital account statement, for the period it states. When it lists several investor accounts, read the totals for the four commitment lines and answer null for the five balance lines. Answer our share only when the balance lines are for the whole vehicle and the statement gives our share of it. When the balance lines are for the whole vehicle and the statement gives neither our share nor our own account, answer null for the five balance lines. If the statement is not in US dollars, answer null for every money line.',
    );
    expect(text).toContain('- period_end: Period end (date, required; unit DATE)');
    expect(text).toContain(
      '- ending_capital_balance: Ending capital balance (money; unit USD, USD_K, USD_M, USD_B)',
    );
    expect(text).toContain('- investor_share_pct: Our share of the vehicle (percent; unit PCT)');
    expect(text).toContain('Write no highlights and no commentary.');
    expect(text).not.toContain('business highlight bullets');
    // Everything between the first and the last line of the task is the quarterly task's own.
    const middle = (id: 'quarterly_extraction' | 'capital_account_extraction'): string[] => {
      const lines = PROMPTS[id].systemPrompt.split('\n');
      const from = lines.indexOf('Task:');
      const to = lines.indexOf('Output:');
      return lines.slice(from + 2, to - 2);
    };
    expect(middle('capital_account_extraction')).toEqual(middle('quarterly_extraction'));
    expect(middle('quarterly_extraction')).toHaveLength(5);
    // The two prompts ask for the same JSON shape.
    const output = (id: 'quarterly_extraction' | 'capital_account_extraction'): string =>
      PROMPTS[id].systemPrompt.split('Output:\n')[1] ?? '';
    expect(output('capital_account_extraction')).toBe(output('quarterly_extraction'));
    expect(() => renderSystemPrompt('capital_account_extraction', { bullets: '0' })).toThrow(
      /no placeholder named bullets/,
    );
  });

  it('says what to do with no openings and no banned phrases', () => {
    const values = extractionPromptValues(schemas.quarterly_financials!, {
      requiredOpenings: {},
      bannedPhrases: [],
    });
    expect(values.highlight_rules).toBe('any opening; no phrase is banned.');
  });
});
