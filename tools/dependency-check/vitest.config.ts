import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'dependency-check',
    include: ['src/**/*.test.mjs'],
  },
});
