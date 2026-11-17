/**
 * The browser tests: `npm run test:e2e`. They are kept out of `npm test` because they need a browser and a build
 * of the app. docs/testing.md, "In a real browser", says what they cover and how to give them a browser.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.ts'],
    environment: 'node',
    // Builds the app once, before any test file runs.
    globalSetup: ['test/e2e/build.ts'],
    // The server side of these tests may not reach the network either. The browser is cut off inside the tests.
    setupFiles: ['test/setup/network.ts'],
    // A cold browser start and the first sign-in (the password hash is at full cost here) take a few seconds.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
