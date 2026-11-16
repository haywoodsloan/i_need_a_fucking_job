/**
 * Puts the fetch pipeline together from the environment, so the server, the smoke test and the catalog check all
 * reach job sources the same way.
 *
 *   cache → http → browser (ENABLE_BROWSER_TIER) → your own tiers (FETCH_TIERS_MODULE)
 *
 * Both optional tiers are off by default. docs/fetch-tiers.md has the details.
 */
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserTier, playwrightLoader } from './browser';
import { createFetcher, type Fetcher, type FetchTier } from './fetcher';

type Env = Record<string, string | undefined>;

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

/**
 * Loads extra tiers from the module named by FETCH_TIERS_MODULE (a path, relative to server/). The module exports
 * `tiers`, or a default export, holding an array of FetchTier or a function that returns one. See
 * server/tiers.example.mjs.
 */
export async function loadCustomTiers(env: Env, baseDir = SERVER_DIR): Promise<FetchTier[]> {
  const spec = env.FETCH_TIERS_MODULE?.trim();
  if (!spec) return [];
  const file = resolve(baseDir, spec);
  let mod: { tiers?: unknown; default?: unknown };
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (e) {
    throw new Error(`FETCH_TIERS_MODULE: could not load ${file}: ${(e as Error).message}`);
  }
  const exported = mod.tiers ?? mod.default;
  const tiers = typeof exported === 'function' ? await exported(env) : exported;
  const valid = Array.isArray(tiers) && tiers.every((t) => t && typeof t.name === 'string' && t.name && typeof t.fetch === 'function');
  if (!valid) throw new Error(`FETCH_TIERS_MODULE: ${file} must export \`tiers\`: an array of { name, fetch } (or a function returning one)`);
  const taken = new Set(['cache', 'http', 'browser']);
  for (const t of tiers as FetchTier[]) {
    if (taken.has(t.name)) throw new Error(`FETCH_TIERS_MODULE: the tier name "${t.name}" is already used`);
    taken.add(t.name);
  }
  return tiers as FetchTier[];
}

export interface Pipeline {
  fetch: Fetcher;
  /** Shuts down what the tiers started (the browser). */
  close(): Promise<void>;
}

export async function buildPipeline(env: Env): Promise<Pipeline> {
  const tiers: FetchTier[] = [];
  const closers: (() => Promise<void>)[] = [];
  if (env.ENABLE_BROWSER_TIER) {
    const loader = playwrightLoader(env);
    tiers.push(browserTier(loader));
    closers.push(() => loader.close());
  }
  tiers.push(...(await loadCustomTiers(env)));
  const fetch = createFetcher({
    cacheMs: Number(env.CACHE_SECONDS ?? 600) * 1000,
    cacheMaxBytes: Number(env.FETCH_CACHE_MB ?? 128) * 1048576,
    tiers,
  });
  return { fetch, close: async () => void (await Promise.allSettled(closers.map((c) => c()))) };
}
