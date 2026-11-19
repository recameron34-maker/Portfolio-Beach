import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'report-engine', include: ['src/**/*.test.ts'] },
});
