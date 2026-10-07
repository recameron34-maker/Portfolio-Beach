import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'synthetic',
    include: ['src/**/*.test.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
