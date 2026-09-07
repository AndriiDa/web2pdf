// Next.js 16 ships native flat-config exports, so no FlatCompat shim is needed.
import coreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const config = [
  ...(Array.isArray(coreWebVitals) ? coreWebVitals : [coreWebVitals]),
  ...(Array.isArray(nextTypescript) ? nextTypescript : [nextTypescript]),
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // In-page scripts run inside the target website's realm, where `document`
    // and `window` are ambient and Next's image rules do not apply.
    files: ['src/browser/**/scripts/**/*.ts'],
    rules: {
      '@next/next/no-img-element': 'off',
    },
  },
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'test-results/**',
      'playwright-report/**',
      'next-env.d.ts',
    ],
  },
];

export default config;
