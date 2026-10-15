import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'pdf', include: ['src/**/*.test.ts'] },
});
