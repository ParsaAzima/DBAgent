// ESLint flat config for DBAgent (ESLint v9+).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'dbagent-out/**', '*.db', '*.sqlite*'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // DBAgent runs untrusted-ish SQL tool args; keep these as warnings, not noise.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
      // Re-throws add context; attaching `cause` everywhere is noise.
      'preserve-caught-error': 'off',
    },
  },
);
