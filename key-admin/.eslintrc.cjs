module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { project: './tsconfig.eslint.json', tsconfigRootDir: __dirname },
  plugins: ['@typescript-eslint', 'import', 'prettier'],
  extends: [
    'airbnb-base',
    'airbnb-typescript/base',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/typescript',
    'prettier',
    'plugin:prettier/recommended',
  ],
  rules: {
    'no-console': 'error',
    'prettier/prettier': 'error',
    'import/prefer-default-export': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    'import/extensions': ['error', 'ignorePackages', { ts: 'never', js: 'always' }],
    // ESM + NodeNext requires explicit .js extensions on relative imports
    'import/no-unresolved': 'off',
  },
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/', '.eslintrc.cjs', 'vitest.config.ts'],
};
