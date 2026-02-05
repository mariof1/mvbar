import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends('next/core-web-vitals'),
  {
    ignores: ['.next/**', 'node_modules/**'],
  },
  {
    rules: {
      // Using native img elements intentionally - the app serves dynamic album art
      // and doesn't benefit from Next.js Image optimization in this use case
      '@next/next/no-img-element': 'off',
    },
  },
];

export default eslintConfig;
