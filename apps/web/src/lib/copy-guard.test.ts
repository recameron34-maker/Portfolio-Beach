import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REFERENCE } from '../test/copy-patterns.js';
import { withoutReferences } from './references.js';

/*
 * What a person reads on a page never cites the build guide (docs/06 section 3): no "docs/18
 * section 4", no control number ("SEC-12.3"), no module or phase number ("M8", "Phase 4"), no
 * configuration file or key ("config/definitions.json", "(config)"), no "(section 12)", no
 * CLAUDE.md and no build command. Those belong in comments, tests, documents and pull requests.
 * This test reads the source of the pages, components and their helpers and fails on a line of
 * code that carries one; comments and import statements are free to cite whatever they like.
 * pages/rendered-copy.test.tsx reads the rendered pages for the same patterns.
 *
 * The preview's simulated API (src/preview) is left out: it repeats the API's refusals word for
 * word, references and all, and the page removes them when it shows one (lib/references.ts).
 */

/** The web app's src folder, whether the tests run from the repository root or from apps/web. */
const SRC = [resolve('apps/web/src'), resolve('src')].find((dir) =>
  existsSync(join(dir, 'pages', 'Home.tsx')),
);
if (SRC === undefined)
  throw new Error('the web source folder was not found from the working directory');
const ROOT: string = SRC;
const FOLDERS = ['pages', 'components', 'app', 'lib'];
const SKIP = /\.test\.tsx?$|test-fixtures|test-support|[\\/]test[\\/]|copy-guard|references\.ts$/;

/*
 * Lines the guard lets through, each named with the words that let it through. One only:
 * lib/assistant.ts keeps MOCK_ASSISTANT_LINE, which names the configuration key that picks the
 * mock model, because lib/assistant.test.ts reads it. No page shows it any more: the assistant
 * page renders its own sentence (pages/assistants/Assistants.tsx), and
 * pages/rendered-copy.test.tsx fails if the page goes back to the constant. A test below fails
 * when the line goes, so the exception cannot outlive it.
 */
const EXCEPTIONS: { file: string; text: string }[] = [
  { file: 'lib/assistant.ts', text: 'config/definitions.json agentModels.default' },
];

function excepted(file: string, text: string): boolean {
  const path = relative(ROOT, file).split('\\').join('/');
  return EXCEPTIONS.some((e) => e.file === path && text.includes(e.text));
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return /\.tsx?$/.test(name) && !SKIP.test(path) ? [path] : [];
  });
}

/** The lines of a file that are code: block comments, doc comments and line comments are dropped. */
function codeLines(source: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let inBlock = false;
  source.split('\n').forEach((raw, index) => {
    const trimmed = raw.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      return;
    }
    if (trimmed.startsWith('/*') || trimmed.startsWith('{/*')) {
      if (!trimmed.includes('*/')) inBlock = true;
      return;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    // An import names a file for the bundler, not for the reader: several pages import config.
    if (/^import\s/.test(trimmed)) return;
    // A comment after code on the same line is not copy either.
    const comment = raw.search(/\s\/\/\s/);
    out.push({ line: index + 1, text: comment < 0 ? raw : raw.slice(0, comment) });
  });
  return out;
}

describe('page copy', () => {
  it('never cites the build guide: no document path, control number, module or phase', () => {
    const found: string[] = [];
    for (const folder of FOLDERS) {
      for (const file of filesUnder(join(SRC, folder))) {
        for (const { line, text } of codeLines(readFileSync(file, 'utf8'))) {
          if (REFERENCE.test(text) && !excepted(file, text))
            found.push(`${relative(SRC, file)}:${line}: ${text.trim()}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('lets through only lines that still exist, one exception at a time', () => {
    for (const exception of EXCEPTIONS) {
      const source = readFileSync(join(SRC, exception.file), 'utf8');
      const matches = codeLines(source).filter(
        ({ text }) => text.includes(exception.text) && REFERENCE.test(text),
      );
      expect(matches, `${exception.file}: ${exception.text}`).toHaveLength(1);
    }
  });

  it('catches a configuration file, a section number, the guide and a build command', () => {
    for (const text of [
      'Thresholds (config/definitions.json)',
      'a schedule from the defaults (config).',
      'Advance only once the deal has closed (section 12).',
      'never straight to production records (CLAUDE.md rule 5).',
      'Run pnpm dev to see it.',
    ])
      expect(REFERENCE.test(text), text).toBe(true);
    for (const text of [
      'Monitoring thresholds',
      'Configured by operations',
      'Section 4 of the report',
    ])
      expect(REFERENCE.test(text), text).toBe(false);
  });

  it('reads enough files to mean something', () => {
    const count = FOLDERS.reduce((n, folder) => n + filesUnder(join(SRC, folder)).length, 0);
    expect(count).toBeGreaterThan(100);
  });

  it('removes a reference from a sentence the API wrote, and nothing else', () => {
    expect(withoutReferences('the wire instruction is not verified (SEC-12.2)')).toBe(
      'the wire instruction is not verified',
    );
    expect(withoutReferences('a required closing document is missing (M8)')).toBe(
      'a required closing document is missing',
    );
    expect(withoutReferences('Short by $0.5M (two lines)')).toBe('Short by $0.5M (two lines)');
  });
});
