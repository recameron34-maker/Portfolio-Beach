import { defineConfig } from 'vitest/config';

// One project: the unit tests and the gold-set eval (src/evals/gold.eval.test.ts) run together
// under `pnpm test`; `pnpm test:evals` runs the eval alone through a file name filter, because a
// package config cannot declare a second project of its own (the root config lists the projects).
export default defineConfig({
  test: { name: 'ai', include: ['src/**/*.test.ts'] },
});
