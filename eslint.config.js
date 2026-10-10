import js from '@eslint/js';
import globals from 'globals';

const gjsGlobals = {
    imports: 'readonly',
    log: 'readonly',
    print: 'readonly',
    TextEncoder: 'readonly',
    TextDecoder: 'readonly',
    ARGV: 'readonly',
};

export default [
    {
        ignores: ['dist/**', 'node_modules/**'],
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.es2022,
                console: 'readonly',
                global: 'readonly',
                ...gjsGlobals,
                globalThis: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
        },
    },
];
