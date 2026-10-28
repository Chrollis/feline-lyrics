import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettierConfig from 'eslint-config-prettier/flat';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
    globalIgnores([
        '**/node_modules/**',
        '**/out/**',
        '**/dist/**',
        'reference/**',
        'cache/**',
        'output/**',
        'python/**',
        '**/pytest-cache-files-*/',
        '**/__pycache__/**',
    ]),
    js.configs.recommended,
    tseslint.configs.recommended,
    {
        files: [
            '**/*.{js,mjs,cjs}',
            'apps/desktop/src/main/**/*.{ts,tsx}',
            'apps/desktop/src/preload/**/*.{ts,tsx}',
            'packages/**/*.{ts,tsx}',
        ],
        languageOptions: {
            globals: globals.node,
        },
    },
    {
        files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
        ...reactHooks.configs.flat['recommended-latest'],
    },
    {
        files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
        languageOptions: {
            globals: globals.browser,
        },
    },
    prettierConfig,
);
