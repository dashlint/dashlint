import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // descriptors/stubs mirror upstream declarations (including their `any`); they are checked by
    // test/unit/descriptors instead.
    ignores: [
      'dist/**',
      'coverage/**',
      'test/golden/**',
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
