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
  eslintConfigPrettier,
);
