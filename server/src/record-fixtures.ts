/**
 * Records what the live job sources answer, for the tests to replay (test/fixtures/sources/*.json).
 *
 * Run it from a machine that can reach the job sites, like the smoke test:
 *
 *   npm run fixtures:record                  every source this machine has what it needs for
 *   npm run fixtures:record -- lever ashby   only these
 *
 * Each source runs one search ("software engineer" near Austin, TX) through the same fetch pipeline the server uses,
 * so requests are paced and a bot check is reported, not worked around. What comes back is cut down to a few
 * postings with shortened descriptions, replayed once to prove the cassette works offline, and only then written.
 * Sources that need a key or a flag (server/.env) are skipped without one. Request headers are never stored and API
 * keys in addresses are blanked, so a cassette is safe to commit. Read the diff before you commit it all the same:
 * it is other people's text.
 *
 * docs/testing.md, "Recorded answers from job sources", has the when and why.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { FetchLike } from '../../src/jobs/types';
import { CASSETTE_DIR, recording, replay, type Cassette } from '../../test/helpers/cassette';
import { LIVE_QUERY, SOURCES, postingProblems, type SourcePlan } from '../../test/helpers/sources';
import { buildPipeline } from './tiers';

type Env = Record<string, string | undefined>;

/** Postings kept per answer: enough to see the filter keep some and drop one. */
const KEEP_MATCHING = 3;
const KEEP_OTHER = 1;
const MAX_TEXT = 1500;

const TITLE_KEYS = ['title', 'text', 'name', 'position', 'job_title', 'PositionTitle'];

function titleOf(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const o = item as Record<string, unknown>;
  const inner = (o.MatchedObjectDescriptor ?? o) as Record<string, unknown>;
  for (const k of TITLE_KEYS) if (typeof inner[k] === 'string') return inner[k] as string;
  return undefined;
}

/** Long text (descriptions) cut to a readable length, everywhere inside a value. */
function shorten(value: unknown): unknown {
  if (typeof value === 'string') return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  if (Array.isArray(value)) return value.map(shorten);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v)]));
  return value;
}

/**
 * Cuts the list of postings in an answer down to a few: some whose title has the role's words, and one that does
 * not, so the source's own filter still has something to drop. Rows without a title (Remote OK's legal notice) stay.
 */
export function trimAnswer(json: unknown, listPath: string[] | undefined, role: string): unknown {
  if (!listPath) return shorten(json);
  const words = role.toLowerCase().split(/\s+/).filter(Boolean);
  const cut = (list: unknown[]) => {
    let matching = 0;
    let other = 0;
    return list.filter((item) => {
      const title = titleOf(item)?.toLowerCase();
      if (title === undefined) return true;
      if (words.every((w) => title.includes(w))) return matching++ < KEEP_MATCHING;
      return other++ < KEEP_OTHER;
    });
  };
  const walk = (node: unknown, path: string[]): unknown => {
    if (!path.length) return Array.isArray(node) ? cut(node) : node;
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    const [head, ...rest] = path;
    return { ...(node as Record<string, unknown>), [head]: walk((node as Record<string, unknown>)[head], rest) };
  };
  return shorten(walk(json, listPath));
}

const today = () => new Date().toISOString().slice(0, 10);

/** Placeholders stored in place of real settings, so a replay has what the source checks for and nothing secret. */
const placeholderEnv = (plan: SourcePlan): Record<string, string> | undefined =>
  plan.needs?.length ? Object.fromEntries(plan.needs.map((k) => [k, k.startsWith('ENABLE_') ? '1' : k.endsWith('USER_AGENT') ? 'someone@example.com' : 'REDACTED'])) : undefined;

/** Runs one source's search against `network` and returns the cassette, after proving it replays. */
export async function recordSource(plan: SourcePlan, network: FetchLike, env: Env, origin: Cassette['origin'] = 'recorded', options: unknown = plan.liveOptions?.(), note?: string): Promise<Cassette> {
  const query = LIVE_QUERY;
  const tape = recording(network, { json: (json) => trimAnswer(json, plan.listPath, query.role), text: plan.trimPage && ((html, request) => plan.trimPage!(html, request.url)) });
  const jobs = await plan.search(query, { fetch: tape, env }, options);
  if (!jobs.length) throw new Error('the search returned no postings, so there is nothing worth keeping. Try another board in test/helpers/sources.ts.');
  if (plan.detail) await plan.detail(jobs[0], { fetch: tape, env }, options);

  const cassette: Cassette = {
    source: plan.name,
    origin,
    date: today(),
    ...(note ? { note } : {}),
    search: { query, ...(options !== undefined ? { options } : {}), ...(placeholderEnv(plan) ? { env: placeholderEnv(plan) } : {}) },
    exchanges: tape.exchanges,
  };

  // Prove it before it is written: the same search, from the cassette alone, with the stored placeholders.
  const again = await plan.search(query, { fetch: replay(cassette), env: cassette.search.env ?? {} }, options);
  const problems = again.flatMap((j) => postingProblems(j, plan.sourceId));
  if (again.length !== jobs.length) problems.push(`the replay returned ${again.length} postings, the live search ${jobs.length}`);
  if (problems.length) throw new Error(`the recording does not replay cleanly:\n  ${problems.join('\n  ')}`);
  return cassette;
}

export function writeCassette(cassette: Cassette): string {
  const file = `${CASSETTE_DIR}${cassette.source}.json`;
  writeFileSync(file, `${JSON.stringify(cassette, null, 2)}\n`);
  return file;
}

async function main() {
  await import('./env'); // keys and flags from server/.env. Loaded here, not at the top, so importing this file changes nothing.
  const env = process.env as Env;
  const asked = process.argv.slice(2);
  const unknown = asked.filter((n) => !SOURCES.some((s) => s.name === n));
  if (unknown.length) {
    console.error(`Unknown source: ${unknown.join(', ')}. Known: ${SOURCES.map((s) => s.name).join(', ')}.`);
    process.exit(2);
  }
  const plans = SOURCES.filter((s) => !asked.length || asked.includes(s.name));
  // No cache: a recording must be what the service says now.
  const pipeline = await buildPipeline({ ...env, CACHE_SECONDS: '0' });
  let failed = 0;
  for (const plan of plans) {
    const missing = (plan.needs ?? []).filter((k) => !env[k]);
    if (missing.length) {
      console.log(`SKIPPED  ${plan.name}: needs ${missing.join(', ')} in server/.env`);
      continue;
    }
    try {
      const cassette = await recordSource(plan, pipeline.fetch, env);
      console.log(`RECORDED ${plan.name}: ${cassette.exchanges.length} request${cassette.exchanges.length === 1 ? '' : 's'} → ${writeCassette(cassette)}`);
    } catch (e) {
      failed++;
      console.log(`FAILED   ${plan.name}: ${(e as Error).message}`);
    }
  }
  await pipeline.close();
  console.log('\nNow run "npm test", read the diff of test/fixtures/sources/, and commit it.');
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
