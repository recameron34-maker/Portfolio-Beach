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
  it('holds the two Phase 2 prompts at version 1 under their fixed ids', () => {
    expect(PROMPT_IDS).toEqual(['document_classifier', 'quarterly_extraction']);
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

  it('says what to do with no openings and no banned phrases', () => {
    const values = extractionPromptValues(schemas.quarterly_financials!, {
      requiredOpenings: {},
      bannedPhrases: [],
    });
    expect(values.highlight_rules).toBe('any opening; no phrase is banned.');
  });
});
