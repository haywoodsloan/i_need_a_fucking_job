/**
 * The application tracker over real HTTP on this machine, inside the whole server (server/src/app.ts): that its
 * routes are reached before the search routes' CORS headers, how much a request may carry, and that the records
 * are still there for a server started later on the same folder.
 *
 * What each route answers and whom it answers is tested without a socket in test/server/applications.test.ts.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { startApplications } from '../../server/src/applications/index';
import type { AddReply, ApplicationReply, ApplicationsReply } from '../../src/apply/api';
import { FILE_FORMAT } from '../../src/apply/model';
import { startTestServer, type TestServer } from '../helpers/server';

const root = mkdtempSync(join(tmpdir(), 'applications-server-test-'));
const JOB = { title: 'Staff Technical Writer', company: 'Globex', postingUrl: 'https://job-boards.greenhouse.io/globex/jobs/1234567' };
const nothing = async () => new Response('not found', { status: 404 });

const servers: TestServer[] = [];
let folders = 0;

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A server that keeps applications in `dir`, or one that keeps none. */
async function start(dir: string | false = join(root, `folder-${++folders}`)): Promise<TestServer> {
  const server = await startTestServer({ network: nothing, env: { ALLOWED_ORIGINS: 'https://haywoodsloan.github.io' }, applications: dir === false ? undefined : startApplications({ dir }) });
  servers.push(server);
  return server;
}

/** What a page of the app sends along, when the app is served by this server. */
const page = (s: TestServer) => ({ Origin: s.url, 'Sec-Fetch-Site': 'same-origin' });

describe('a server that keeps applications', () => {
  it('says so, and takes one from an assistant and a change to it from the page', async () => {
    const s = await start();
    expect((await s.get('/api/health')).json()).toMatchObject({ ok: true, applications: true });

    const added = await s.post('/api/applications', { application: { job: JOB, stage: 'drafting', form: { fields: [{ id: 'why', label: 'Why Globex?', kind: 'longtext', required: true, value: 'A first draft.', status: 'draft' }] } } });
    expect(added.status).toBe(201);
    expect(added.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(added.headers['cache-control']).toBe('no-store');
    const { application } = added.json<AddReply>();

    const saved = await s.post(`/api/applications/${application.id}`, { by: 'user', changes: { fields: [{ id: 'why', value: 'My own words.' }] } }, page(s));
    expect(saved.status).toBe(200);
    expect(saved.json<ApplicationReply>().application.form?.fields[0]).toMatchObject({ value: 'My own words.', origin: 'user', status: 'filled' });

    const list = (await s.get('/api/applications')).json<ApplicationsReply>();
    expect(list.available).toBe(true);
    expect(list.applications.map((a) => [a.id, a.revision, a.drafts])).toEqual([['globex-staff-technical-writer', 2, 0]]);
  });

  it('never tells a browser that another site may read it, even a site the search routes allow', async () => {
    const s = await start();
    await s.post('/api/applications', { application: { job: JOB } });
    // The search routes answer the demo's address with CORS headers.
    const search = await s.get('/api/health', { Origin: 'https://haywoodsloan.github.io' });
    expect(search.headers['access-control-allow-origin']).toBe('https://haywoodsloan.github.io');

    for (const path of ['/api/applications', '/api/applications/export', '/api/applications/globex-staff-technical-writer']) {
      const reply = await s.get(path, { Origin: 'https://haywoodsloan.github.io', 'Sec-Fetch-Site': 'cross-site' });
      expect(reply.status, path).toBe(403);
      expect(reply.json().code).toBe('bad_origin');
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
      expect(reply.text).not.toContain('Globex');
    }
    // The question a browser asks before it lets another site send JSON gets no permission.
    const preflight = await s.send('OPTIONS', '/api/applications', undefined, { Origin: 'https://haywoodsloan.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' });
    expect(preflight.status).toBe(405);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(preflight.headers['access-control-allow-methods']).toBeUndefined();
    // Its own page gets no CORS headers either: it needs none.
    expect((await s.get('/api/applications', page(s))).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('gives the export laid out for reading, and takes it back as a file', async () => {
    const s = await start();
    await s.post('/api/applications', { application: { job: JOB } });
    const exported = await s.get('/api/applications/export');
    expect(exported.status).toBe(200);
    expect(exported.text.startsWith(`{\n  "format": "${FILE_FORMAT}",\n  "version": 1,\n`)).toBe(true);

    const other = await start();
    const imported = await other.send('POST', '/api/applications/import', exported.text, { 'Content-Type': 'application/json' });
    expect(imported.json()).toEqual({ added: ['globex-staff-technical-writer'], skipped: [] });
  });

  it('turns down a request that is not JSON, and one that is too large for what it is', async () => {
    const s = await start();
    const { application } = (await s.post('/api/applications', { application: { job: JOB } })).json<AddReply>();

    const broken = await s.send('POST', '/api/applications', '{ "application": ', { 'Content-Type': 'application/json' });
    expect(broken.status).toBe(400);
    expect(broken.json()).toEqual({ code: 'bad_request', error: 'That request is not valid JSON.' });
    // Nothing at all was sent: that is an empty object, which is no application.
    const empty = await s.send('POST', '/api/applications', undefined, { 'Content-Type': 'application/json' });
    expect(empty.status).toBe(400);
    expect(empty.json()).toEqual({ code: 'invalid', error: 'The application must be an object.' });

    // More than a change may carry, and less than a file of applications may.
    const padding = 'x'.repeat(5 * 1024 * 1024);
    const large = await s.post(`/api/applications/${application.id}`, { changes: { note: 'x' }, padding });
    expect(large.status).toBe(413);
    expect(large.json()).toEqual({ code: 'bad_request', error: 'That request is too large.' });
    const file = await s.post('/api/applications/import', { file: { format: FILE_FORMAT, version: 1, applications: [] }, padding });
    expect(file.status).toBe(200);
    expect(s.errors).toEqual([]);
  });

  it('turns down a request from another site by its headers alone, whatever it carries', async () => {
    const s = await start();
    // What a page of another site can send here without asking first: text that is not JSON, and any amount of it.
    const fromOutside = { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'text/plain' };
    const broken = await s.send('POST', '/api/applications', '{ "application": ', fromOutside);
    expect(broken.status).toBe(403);
    expect(broken.json().code).toBe('bad_origin');
    // More than the tracker takes for anything. It is not kept and not read as JSON, so it is not "too large" either.
    const huge = await s.send('POST', '/api/applications/import', 'x'.repeat(40 * 1024 * 1024), fromOutside);
    expect(huge.status).toBe(403);
    expect(huge.json().code).toBe('bad_origin');
    // The server is still there for its own page afterwards.
    expect((await s.get('/api/applications', page(s))).status).toBe(200);
    expect(s.errors).toEqual([]);
  });

  it('moves an application the user removes into a folder of its own, where it can be found again', async () => {
    const dir = join(root, 'with-one-removed');
    const s = await start(dir);
    const { application } = (await s.post('/api/applications', { application: { job: JOB } })).json<AddReply>();
    expect((await s.post(`/api/applications/${application.id}/remove`, { by: 'user' }, page(s))).status).toBe(200);
    expect((await s.get('/api/applications')).json<ApplicationsReply>().applications).toEqual([]);
    expect(readdirSync(dir)).toEqual(['removed']);
    const [file] = readdirSync(join(dir, 'removed'));
    expect(file).toMatch(/^globex-staff-technical-writer\.\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/);
  });

  it('answers that something went wrong, and says what in its log, when the tracker itself fails', async () => {
    const failed = new Error('the disk is gone');
    const server = await startTestServer({
      network: nothing,
      applications: {
        owns: (path) => path.startsWith('/api/applications'),
        handle: async () => {
          throw failed;
        },
      },
    });
    servers.push(server);
    const reply = await server.get('/api/applications');
    expect(reply.status).toBe(500);
    expect(reply.json()).toEqual({ error: 'Something went wrong on the server.' });
    expect(server.errors).toEqual([failed]);
  });

  it('still has every application, and its history, when a server is started on the same folder later', async () => {
    const dir = join(root, 'kept');
    const before = await start(dir);
    const { application } = (await before.post('/api/applications', { application: { job: JOB, stage: 'drafting', form: { fields: [{ id: 'why', label: 'Why Globex?', value: 'A first draft.', status: 'draft' }] } } })).json<AddReply>();
    await before.post(`/api/applications/${application.id}`, { by: 'user', changes: { fields: [{ id: 'why', value: 'My own words.' }], note: 'Rewritten before the restart.' } }, page(before));
    const whole = (await before.get(`/api/applications/${application.id}`)).json<ApplicationReply>().application;
    await before.close();
    servers.length = 0;

    const after = await start(dir);
    expect((await after.get(`/api/applications/${application.id}`)).json<ApplicationReply>().application).toEqual(whole);
    expect(whole.form?.fields[0]).toMatchObject({ value: 'My own words.', origin: 'user' });
    expect(whole.timeline.map((t) => t.kind)).toEqual(['created', 'note']);
    // And it goes on from there.
    const next = await after.post(`/api/applications/${application.id}`, { revision: whole.revision, changes: { stage: 'ready' } });
    expect(next.json<ApplicationReply>().application).toMatchObject({ revision: 3, stage: 'ready' });
  });
});

describe('a server that keeps no applications', () => {
  it('says so where the page asks, and has no other tracker address', async () => {
    const s = await start(false);
    expect((await s.get('/api/health')).json()).toMatchObject({ ok: true, applications: false });
    const list = await s.get('/api/applications');
    expect(list.status).toBe(200);
    expect(list.json()).toEqual({ available: false, applications: [] });
    expect(list.headers['access-control-allow-origin']).toBeUndefined();
    // An assistant that tries to save one there is not told it worked.
    expect((await s.post('/api/applications', { application: { job: JOB } })).status).toBe(404);
    expect((await s.get('/api/applications/export')).status).toBe(404);
    expect((await s.post('/api/applications/import', { file: {} })).status).toBe(404);
    expect((await s.get('/api/applications/globex-staff-technical-writer')).status).toBe(404);
  });
});
