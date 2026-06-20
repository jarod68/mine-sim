const js = require('@eslint/js');
const globals = require('globals');

// Pragmatic, low-noise rules: catch real bugs (undefined refs, dead code) without
// bikeshedding style (Prettier territory). Unused vars are warnings and respect a
// leading-underscore convention for intentional placeholders.
const rules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-constant-condition': ['error', { checkLoops: false }],
  'prefer-const': 'warn',
  'no-var': 'error',
};

module.exports = [
  { ignores: ['node_modules/**', 'coverage/**', 'dist/**'] },

  // Server + game logic + Node scripts (load test, screenshots): CommonJS on Node.
  {
    files: ['server/**/*.js', 'game/**/*.js', 'scripts/**/*.js', 'test/load/**/*.js', 'server.js', 'admin.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node } },
    rules,
  },

  // Client: browser ES modules.
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.browser } },
    rules,
  },

  // Unit tests: ES modules, Node + browser (happy-dom) globals.
  {
    files: ['test/unit/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
    rules: { ...rules, 'no-unused-vars': 'off' },
  },

  // Visual tests (Playwright): ES modules on Node, with browser globals available
  // inside page.evaluate callbacks.
  {
    files: ['test/visual/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
    rules: { ...rules, 'no-unused-vars': 'off' },
  },
];
