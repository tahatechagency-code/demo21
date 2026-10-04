import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // e2e/ and e2e-live/ hold Playwright specs (`pnpm test:e2e`, `pnpm test:e2e:live`), not vitest tests.
    exclude: ['**/node_modules/**', '**/e2e/**', '**/e2e-live/**', '**/.next/**'],
  },
  resolve: {
    alias: {
      'server-only': path.resolve(__dirname, 'src/test/server-only-stub.ts'),
    },
  },
});
