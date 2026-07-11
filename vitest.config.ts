import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `tests/worker*.test.ts` only run under the Workers runtime pool
    // (`vitest.workers.config.ts` / `npm run worker:test`), which provides
    // the virtual `cloudflare:test` module they import.
    exclude: [...configDefaults.exclude, 'tests/worker.test.ts', 'tests/worker-cache.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
