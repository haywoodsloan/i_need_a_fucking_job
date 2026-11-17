/**
 * Job search backend: the process. It reads the environment, starts what the server needs, and listens.
 * What the server does with each request is in app.ts.
 *
 * Secrets live only in this process's environment (see server/.env.example).
 * Nothing about the user's resume is ever sent here.
 */
import './env';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { allowedOrigins, createApp } from './app';
import { closeBrowser, indeedBrowser } from './indeed';
import { loadApp } from './static';
import { buildPipeline } from './tiers';

const env = process.env as Record<string, string | undefined>;
const PORT = Number(env.PORT ?? 8787);

// Every outbound request goes through the fetch pipeline: cache, paced and retried HTTP, then any optional tiers.
// See docs/fetch-tiers.md.
const pipeline = await buildPipeline(env);
const fetcher = pipeline.fetch;

// Accounts are off until `npm run admin -- setup` has given this server its password secret. Until then none of
// their code or packages is loaded, so the search server runs exactly as it did before accounts existed.
const accounts = env.AUTH_PEPPER ? await startAccounts() : undefined;

async function startAccounts() {
  try {
    const { readAccountsConfig, startAccounts } = await import('./accounts/index');
    return await startAccounts(readAccountsConfig(env)!);
  } catch (e) {
    const name = (e as Error).name;
    if ((e as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') console.error('Accounts need packages that are not installed yet. Run "npm install" in server/ and start again.');
    else if (name === 'DatabaseInUse') console.error(`${(e as Error).message} Stop it first. If nothing of this app is running, delete the file server/.data/pg.lock and start again.`);
    else console.error(name === 'ConfigError' ? (e as Error).message : e);
    process.exit(1);
  }
}

// The built app, when this server is asked to serve it as well. `npm run local` leaves this off: Vite serves the app.
const builtApp = env.SERVE_APP === '1' || process.argv.includes('--serve-app') ? serveApp() : undefined;

function serveApp() {
  try {
    return loadApp(fileURLToPath(new URL('../../dist', import.meta.url)), { accounts: !!accounts, https: accounts?.config.secureCookies });
  } catch (e) {
    console.error((e as Error).name === 'NoBuiltApp' ? (e as Error).message : e);
    process.exit(1);
  }
}

const server = createServer(createApp({ env, fetch: fetcher, accounts, builtApp, extra: { 'indeed-browser': indeedBrowser } }));

server.listen(PORT, () => {
  console.log(`job search backend on :${PORT} (fetch tiers: ${fetcher.tiers.join(' → ')})`);
  console.log(accounts ? `accounts: on, for the app at ${accounts.config.origins.join(' or ')}` : 'accounts: off (turn them on with: npm run admin -- setup <your email>)');
  if (builtApp) console.log(`app: the built app (${builtApp.paths.length} files from dist/) is served at http://localhost:${PORT}`);
  if (!allowedOrigins(env).length) console.warn('ALLOWED_ORIGINS is not set: accepting requests from any origin');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await closeBrowser().catch(() => {});
    await pipeline.close();
    await accounts?.close().catch(() => {});
    process.exit(0);
  });
}
