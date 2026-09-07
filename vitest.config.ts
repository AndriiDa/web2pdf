import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    // Unit tests only: everything under src/core must run without a browser.
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
