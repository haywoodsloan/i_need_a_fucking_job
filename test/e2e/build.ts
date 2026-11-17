/**
 * Builds the app once for the browser tests, into a temporary folder, and tells the tests where it is.
 *
 * It is a build of its own and not the repo's dist/ folder, so that nothing on the machine changes what is tested:
 * not a VITE_API_URL in the environment (CI sets one for the hosted demo), not a developer's .env.local, and not a
 * dist/ left over from an older version of the code.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The folder holding the app as built for the browser tests. */
    appDir: string;
  }
}

export default async function setup(project: TestProject) {
  const appDir = mkdtempSync(join(tmpdir(), 'job-hunt-e2e-app-'));
  for (const name of Object.keys(process.env)) if (name.startsWith('VITE_')) delete process.env[name];
  await build({
    root: fileURLToPath(new URL('../..', import.meta.url)),
    envDir: false,
    logLevel: 'warn',
    build: { outDir: appDir, emptyOutDir: true },
  });
  project.provide('appDir', appDir);
  // Windows can take a moment to let go of files that were just read.
  return () => rmSync(appDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
