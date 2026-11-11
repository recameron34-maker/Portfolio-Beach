import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/api', 'apps/web', 'apps/site', 'tools/*'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**', 'apps/*/src/**', 'tools/*/src/**'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/fixtures/**'],
    },
  },
});
