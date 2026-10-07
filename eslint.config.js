// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

/**
 * Domain packages hold financial logic. They may not read the wall clock, use randomness or
 * floating-point parsing: money and dates are injected (docs/17 sections 4 and 5).
 */
const domainGlobs = [
  'packages/calc/src/**/*.ts',
  'packages/workflows/src/**/*.ts',
  'packages/validation/src/**/*.ts',
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '.bundle/**',
      '.synthetic/**',
      '.pglite/**',
      'apps/worker-py/**',
      'apps/web/dist/**',
      'apps/web/dist-types/**',
      'apps/web/playwright-report/**',
      'apps/web/test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            '*.config.ts',
            'packages/*/*.config.ts',
            'apps/*/*.config.ts',
            'tools/*/*.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: domainGlobs,
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'Domain code never reads the wall clock. Inject a Clock (docs/17 section 4).',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Domain code never reads the wall clock. Inject a Clock (docs/17 section 4).',
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: 'Domain code is deterministic. No randomness (docs/08 section 1).',
        },
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'Money and rates are Decimals, never floats (docs/17 section 4).',
        },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs', '**/*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
