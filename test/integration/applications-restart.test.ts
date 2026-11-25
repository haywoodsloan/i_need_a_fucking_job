/**
 * What the tracker is for: the applications are still there after the computer was restarted.
 *
 * The server runs as its own process on a folder of applications, the way `npm start` runs it. It is then ended on
 * the spot, with no chance to tidy up, which is what a restart of Windows or a power cut does to it. A second process
 * started on the same folder must have every application as it was left, down to the last answer that was saved.
 *
 * The same real process is asked the two things that keep the tracker to its own computer: left alone, the server
 * does not answer at the address other computers use for this one, and a server told to answer other computers keeps
 * no applications at all.
 *
 * Accounts are off here, so no database is started. The folder for one is given all the same, so that a password
 * secret in this machine's server/.env could never bring the real database into a test.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { AddReply, ApplicationReply, ApplicationsReply } from '../../src/apply/api';
import type { Application } from '../../src/apply/model';
import { freePort, outsideAddress, startServerProcess, statusAt, type ServerProcess } from '../helpers/process';

const root = mkdtempSync(join(tmpdir(), 'applications-restart-test-'));
const dir = join(root, 'applications');
const outside = outsideAddress();
const running: ServerProcess[] = [];

async function start(settings: Record<string, string> = {}): Promise<ServerProcess> {
  const server = await startServerProcess(await freePort(), { AUTH_PEPPER: '', ACCOUNTS_DATA_DIR: join(root, 'accounts'), ALLOWED_ORIGINS: '', APPLICATIONS: '1', APPLICATIONS_DIR: dir, ...settings });
  running.push(server);
  return server;
}

afterEach(async () => {
  for (const server of running.splice(0)) await server.kill();
});

afterAll(() => {
  // Windows can take a moment to let go of files that were just closed.
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** A request the way an assistant's shell sends it: no Origin, no browser headers. */
async function ask<T>(server: ServerProcess, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${server.origin}${path}`, body === undefined ? { headers } : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

/** What the app's own page sends along. */
const page = (server: ServerProcess) => ({ Origin: server.origin, 'Sec-Fetch-Site': 'same-origin' });

describe('applications, across a server that was ended and started again', () => {
  it('are all there as they were left, and go on from there', { timeout: 120_000 }, async () => {
    const before = await start();
    expect(before.printed()).toContain(`applications: kept on this computer, in ${dir}`);

    // An assistant saves a posting and what it prepared for the form.
    const added = await ask<AddReply>(before, '/api/applications', {
      application: {
        job: { title: 'Staff Technical Writer', company: 'Globex', location: 'Remote, US', postingUrl: 'https://job-boards.greenhouse.io/globex/jobs/1234567', descriptionText: 'Write the docs.' },
        stage: 'drafting',
        form: {
          url: 'https://job-boards.greenhouse.io/globex/jobs/1234567#app',
          fields: [
            { id: 'first-name', label: 'First Name', kind: 'text', required: true, value: 'Jordan', status: 'filled', origin: 'form' },
            { id: 'why', label: 'Why Globex?', kind: 'longtext', required: true, value: 'A first draft.', status: 'draft' },
            { id: 'start', label: 'When can you start?', kind: 'text', required: true, value: '', status: 'ask' },
            { id: 'pledge', label: 'I wrote these answers myself', kind: 'checkbox', required: true, value: '', status: 'yours' },
          ],
        },
      },
    });
    expect(added.status).toBe(201);
    const id = added.body.application.id;
    // A second one, so that "every application" means more than one.
    expect((await ask<AddReply>(before, '/api/applications', { application: { job: { title: 'Senior Technical Writer', company: 'Initech', postingUrl: 'https://jobs.ashbyhq.com/initech/1' } } })).status).toBe(201);

    // The user rewrites the draft and answers the question on the app's page. The assistant marks it ready.
    const rewritten = await ask<ApplicationReply>(before, `/api/applications/${id}`, { by: 'user', changes: { fields: [{ id: 'why', value: 'My own words about Globex.' }, { id: 'start', value: 'Two weeks after an offer.' }] } }, page(before));
    expect(rewritten.status).toBe(200);
    const ready = await ask<ApplicationReply>(before, `/api/applications/${id}`, { changes: { stage: 'ready', note: 'Every question has an answer. The pledge is left for you.' } });
    expect(ready.status).toBe(200);
    const left: Application = ready.body.application;
    expect(left.revision).toBe(3);
    const listed = (await ask<ApplicationsReply>(before, '/api/applications')).body;

    // The computer restarts: the process is gone at once.
    await before.kill();
    expect(await statusAt('127.0.0.1', before.port, '/api/health')).toBeUndefined();
    // No half-written file is left in the folder, and each change left the version before it.
    expect(readdirSync(dir).sort()).toEqual([`${id}.json`, 'history', 'initech-senior-technical-writer.json']);
    expect(readdirSync(join(dir, 'history', id)).sort()).toEqual(['000001.json', '000002.json']);

    const after = await start();
    expect((await ask<ApplicationReply>(after, `/api/applications/${id}`)).body.application).toEqual(left);
    expect((await ask<ApplicationsReply>(after, '/api/applications')).body).toEqual(listed);
    // What the user wrote is still marked as theirs, and what is left for them is still left.
    const fields = Object.fromEntries(left.form!.fields.map((f) => [f.id, f]));
    expect(fields.why).toMatchObject({ value: 'My own words about Globex.', origin: 'user', status: 'filled' });
    expect(fields.start).toMatchObject({ value: 'Two weeks after an offer.', origin: 'user', status: 'filled' });
    expect(fields['first-name']).toMatchObject({ value: 'Jordan', origin: 'form' });
    expect(fields.pledge).toMatchObject({ value: '', status: 'yours' });
    expect(listed.applications.find((a) => a.id === id)).toMatchObject({ stage: 'ready', asks: 0, drafts: 0, yours: 1 });

    // An assistant that picks the work up again still cannot write over the user's words, and can go on otherwise.
    const refused = await ask<{ code: string }>(after, `/api/applications/${id}`, { changes: { fields: [{ id: 'why', value: 'Something else.' }] } });
    expect([refused.status, refused.body.code]).toEqual([403, 'refused']);
    const next = await ask<ApplicationReply>(after, `/api/applications/${id}`, { revision: left.revision, changes: { note: 'Picked up again after the restart.' } });
    expect(next.body.application).toMatchObject({ revision: 4, stage: 'ready' });
    expect(next.body.application.timeline.at(-1)).toMatchObject({ by: 'assistant', kind: 'note', text: 'Picked up again after the restart.' });
  });
});

describe('who can reach the applications of a running server', () => {
  it('is this computer only: nothing answers at the address other computers use', { timeout: 120_000 }, async () => {
    const server = await start();
    expect(await statusAt('127.0.0.1', server.port, '/api/applications')).toBe(200);
    // "localhost" works whichever of the two own addresses a program picks for it.
    expect(await statusAt('localhost', server.port, '/api/applications')).toBe(200);
    if (outside) {
      expect(await statusAt(outside, server.port, '/api/applications')).toBeUndefined();
      expect(await statusAt(outside, server.port, '/api/health')).toBeUndefined();
    }
    // A page of another site, opened in a browser on this computer, is turned away.
    const other = await ask<{ code: string }>(server, '/api/applications', undefined, { Origin: 'https://example.com', 'Sec-Fetch-Site': 'cross-site' });
    expect([other.status, other.body.code]).toEqual([403, 'bad_origin']);
  });

  it('is nobody, when the server is told to answer other computers', { timeout: 120_000 }, async () => {
    const elsewhere = join(root, 'never-made');
    const server = await start({ HOST: '0.0.0.0', APPLICATIONS_DIR: elsewhere });
    expect(server.printed()).toContain('listening: for every network connection, so other computers can reach it');
    expect(server.printed()).toContain('applications: off (HOST lets other computers reach this server, and applications have no sign-in)');
    if (outside) expect(await statusAt(outside, server.port, '/api/health')).toBe(200);
    expect((await ask<{ applications: boolean }>(server, '/api/health')).body.applications).toBe(false);
    expect((await ask<ApplicationsReply>(server, '/api/applications')).body).toEqual({ available: false, applications: [] });
    const refused = await ask<unknown>(server, '/api/applications', { application: { job: { title: 'Technical Writer', company: 'Example', postingUrl: 'https://example.com/jobs/1' } } });
    expect(refused.status).toBe(404);
    expect(existsSync(elsewhere)).toBe(false);
  });
});
