import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    testTimeout: 30_000,
    server: { deps: { inline: ['@indigo-labs/dexter'] } },
  },
});
