import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // descriptors/stubs mirror upstream declarations (including their `any`); they are checked by
    // test/unit/descriptors instead. The crash fixture's generated files are made to overflow a
    // parser's stack.
    ignores: [
      'dist/**',
      'coverage/**',
      '.stryker-tmp/**',
      'reports/**',
      'test/golden/**',
      'test/fixtures/extract/posthog-js/crash/src/deep-*.ts',
      'src/formats/generated/**',
      'src/descriptors/generated/**',
      'descriptors/stubs/**',
    ],
  },
  ...tseslint.configs.strict,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // The untyped-client fixtures are about code that holds the SDK client in `any` (ADR-045).
    files: ['test/fixtures/extract/*/untyped-*/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      // untyped-edges imports a namespace member with `import x = Ns.member` (T10.2).
      '@typescript-eslint/no-namespace': 'off',
      'prefer-const': 'off',
    },
  },
  {
    // The wrapper edge fixture is about overloads and values the tracer cannot type (T10.2).
    files: ['test/fixtures/extract/posthog-js/wrappers-edges/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/unified-signatures': 'off',
    },
  },
  eslintConfigPrettier,
);
