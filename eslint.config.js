import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    files: ['tests/**/*.ts', 'scripts/**/*.ts', 'packages/testkit/src/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      'eslint.config.js',
      'scripts/**/*.mjs',
      'packages/runtime/bin/*.js',
      'openapi.fixture.json',
    ],
  },
  prettier,
);
