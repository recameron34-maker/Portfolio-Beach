import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'calc',
    include: ['src/**/*.test.ts'],
    testTimeout: 20000,
    coverage: { thresholds: { branches: 100, lines: 100, functions: 100, statements: 100 } },
  },
});
