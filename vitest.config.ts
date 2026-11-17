/**
 * How the tests run. docs/testing.md explains the layers and when to use each.
 *
 * `npm test` runs every project below. A browser end-to-end run has its own config (vitest.e2e.config.ts), because it
 * needs the built app and a real browser.
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // Starting the embedded database takes a second or two. The defaults (5 and 10 seconds) are too close to that
      // on a slow machine.
      testTimeout: 30_000,
      hookTimeout: 30_000,

      // Every test starts from a clean slate: spies are put back, call counts are cleared, and anything a test swapped
      // into the globals or the environment is taken out again.
      clearMocks: true,
      restoreMocks: true,
      unstubGlobals: true,
      unstubEnvs: true,

      // No test may talk to the real network (test/setup/network.ts).
      setupFiles: ['test/setup/network.ts'],

      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            environment: 'node',
            include: ['src/**/*.test.ts', 'test/server/**/*.test.ts', 'test/sources/**/*.test.ts', 'test/docs/**/*.test.ts'],
          },
        },
        {
          extends: true,
          test: {
            name: 'ui',
            environment: 'jsdom',
            include: ['src/**/*.test.tsx'],
            setupFiles: ['src/testing/setup.ts'],
          },
        },
        {
          extends: true,
          test: {
            name: 'integration',
            environment: 'node',
            include: ['test/integration/**/*.test.ts'],
          },
        },
      ],

      coverage: {
        provider: 'v8',
        include: ['src/**/*.{ts,tsx}', 'server/src/**/*.ts'],
        exclude: [
          '**/*.test.{ts,tsx}',
          '**/*.test-payloads.ts',
          '**/*.d.ts',
          'src/testing/**',
          // Only wiring: the page's entry point, and files that hold types and no code.
          'src/main.tsx',
          'src/jobs/types.ts',
          // Tested, but as separate processes, where this report cannot see them (test/integration/server-start.test.ts
          // and admin-cli.test.ts). Counting them as 0% would say the opposite of the truth.
          'server/src/index.ts',
          'server/src/env.ts',
          'server/src/admin.ts',
          'server/src/accounts/cli.ts',
          // Run by hand against the live sites, never by the tests (docs/testing.md, "What is not tested").
          'server/src/smoke.ts',
          'server/src/check-catalog.ts',
          // The older Indeed browser route. It needs a real browser on a real site, and it is not being extended
          // (docs/decisions/0007-no-bot-check-bypass.md).
          'server/src/indeed.ts',
        ],
        reporter: ['text-summary', 'html', 'lcov', 'json-summary'],
        reportsDirectory: 'coverage',
        // A floor, not a target: `npm run test:coverage` fails when a change leaves more code untested than before.
        // The numbers sit a little under what the suite reaches. Raise them when coverage goes up, and do not
        // lower them to get a change through (docs/testing.md, "Coverage").
        thresholds: {
          statements: 93,
          branches: 88,
          functions: 92,
          lines: 94,
          // Where a mistake costs the most, every line and function is run by a test: passwords, sessions and
          // keys, the barrier between a job site's HTML and the page, and the rule that a resume field is the
          // file's exact words.
          'server/src/accounts/{crypto,keys,service,http,limits}.ts': { lines: 100, functions: 100 },
          'src/ui/sanitize.ts': { lines: 100, functions: 100 },
          'src/resume/model.ts': { lines: 100, functions: 100 },
        },
      },
    },
  }),
);
