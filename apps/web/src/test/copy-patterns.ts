/*
 * What page copy may never carry (docs/06 section 6), shared by the two guards: the source scan
 * (lib/copy-guard.test.ts) and the rendered-text check (pages/rendered-copy.test.tsx).
 *
 * REFERENCE: a document path ("docs/18"), a control number ("SEC-12.3"), a module or phase
 * ("(M8)", "M8 will", "Phase 4"), a configuration file or key in brackets ("(config/...)",
 * "(config)", "config/definitions.json"), a section number in brackets ("(section 12)"), the
 * build guide (CLAUDE.md) and a build command ("pnpm dev").
 */
export const REFERENCE =
  /docs\/\d{2}|SEC-\d+|\(M\d{1,2}\)|\bM\d{1,2} (?:in|will|brings)\b|\bPhase \d\b|\(config [a-z]|config\/[\w-]+\.json|\(config\)|\(section \d+\)|CLAUDE\.md|pnpm (?:dev|build)/;

/** Folders of the build a page should never name, wherever they sit in a sentence. */
export const BUILD_PATHS = /CLAUDE\.md|config\/|packages\//;
