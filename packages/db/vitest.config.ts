import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'db',
    include: ['src/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    // Each file opens its own in-process database; keep them isolated.
    fileParallelism: true,
  },
});
