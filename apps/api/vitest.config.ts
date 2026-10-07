import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// NestJS relies on legacy decorators with emitted metadata; esbuild cannot emit it, swc can.
export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    name: 'api',
    include: ['src/**/*.test.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
