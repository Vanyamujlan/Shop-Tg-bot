import { stripTypeScriptTypes } from 'node:module';
import * as espree from 'espree';
import firebaseRulesPlugin from '@firebase/eslint-plugin-security-rules';

const tsStripParser = {
  meta: {
    name: 'ts-strip-parser',
    version: '1.0.0',
  },
  parseForESLint(code, options = {}) {
    let stripped = stripTypeScriptTypes(code, { mode: 'transform' });
    if (!/\bvar\b/.test(code)) {
      stripped = stripped
        .replace(/\bvar\s+([A-Za-z0-9_$]+)/g, 'const $1 = {}')
        .replace(/\|\|\s*\(\s*[A-Za-z0-9_$]+\s*=\s*\{\s*\}\s*\)/g, '');
    }
    const ast = espree.parse(stripped, {
      ecmaVersion: options.ecmaVersion || 2024,
      sourceType: options.sourceType || 'module',
      loc: true,
      range: true,
      raw: true,
      tokens: true,
      comment: true,
    });
    return {
      ast,
      services: {},
      scopeManager: null,
      visitorKeys: espree.VisitorKeys,
    };
  },
};

export default [
  {
    ignores: ['dist/**/*', 'build/**/*', 'node_modules/**/*', '.data/**/*'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsStripParser,
      ecmaVersion: 2024,
      sourceType: 'module',
    },
    rules: {
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-unreachable': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  firebaseRulesPlugin.configs['flat/recommended'],
];
