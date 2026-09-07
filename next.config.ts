import type { NextConfig } from 'next';

/**
 * Playwright and the serverless Chromium binary must never be bundled by
 * Next.js: they load native code and resolve their own on-disk assets at
 * runtime. Next.js already auto-externalizes these, but declaring them keeps
 * the intent explicit and survives changes to the built-in list.
 *
 * `outputFileTracingIncludes` forces the standalone/serverless trace to carry
 * the Chromium brotli payload for the routes that actually launch a browser.
 */
const nextConfig: NextConfig = {
  serverExternalPackages: [
    'playwright',
    'playwright-core',
    '@sparticuz/chromium',
  ],
  outputFileTracingIncludes: {
    '/api/convert': ['./node_modules/@sparticuz/chromium/**'],
    '/api/session/**': ['./node_modules/@sparticuz/chromium/**'],
  },
};

export default nextConfig;
