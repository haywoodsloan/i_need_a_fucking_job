/**
 * The routes of the application tracker (server/src/applications/http.ts), without a socket: what each one
 * answers, who may make which change, and that only the computer the server runs on, and only the app's own page,
 * is answered at all.
 *
 * The records are real files in a temporary folder. The rules for one record are tested on their own in
 * src/apply/model.test.ts.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTrackerHttp, type TrackerReply } from '../../server/src/applications/http';
import { fileStore, type ApplicationStore, type Records } from '../../server/src/applications/store';
import type { AddReply, ApplicationReply, ApplicationsReply, ImportReply, TrackerErrorReply } from '../../src/apply/api';
import { FILE_FORMAT, LIMITS, type Application, type ApplicationsFile } from '../../src/apply/model';

let root: string;
let dir: string;
let clock: number;
let errors: [string, unknown][];
let http: ReturnType<typeof createTrackerHttp>;

const HERE = 'localhost:8787';
const PAGE = { origin: `http://${HERE}`, 'sec-fetch-site': 'same-origin' };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'applications-test-'));
  dir = join(root, 'applications');
  clock = Date.UTC(2026, 10, 24, 22, 0, 0);
  errors = [];
  http = tracker(fileStore(dir, { now: () => new Date(clock) }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function tracker(store: ApplicationStore) {
  return createTrackerHttp({ store, now: () => new Date(clock), logError: (message, e) => errors.push([message, e]) });
}

interface Sent {
  headers?: Record<string, string | undefined>;
  address?: string;
}

/** A request as a program on this computer sends it: no page behind it. */
function send(method: string, path: string, body?: unknown, o: Sent = {}): Promise<TrackerReply> {
  const headers: Record<string, string | undefined> = { host: HERE, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...o.headers };
  return http.handle({ method, path, headers, body, address: 'address' in o ? o.address : '127.0.0.1' });
}
const get = (path: string, o?: Sent) => send('GET', path, undefined, o);
const post = (path: string, body: unknown, o?: Sent) => send('POST', path, body, o);
/** A request as the app's own page sends it. */
const fromPage = (path: string, body: unknown) => post(path, body, { headers: PAGE });

const failure = (reply: TrackerReply) => reply.body as TrackerErrorReply;

const JOB = { title: 'Staff Technical Writer', company: 'Globex', postingUrl: 'https://job-boards.greenhouse.io/globex/jobs/1234567' };
const FIELDS = [
  { id: 'first-name', label: 'First Name', kind: 'text', required: true, value: 'Jordan', status: 'filled' },
  { id: 'why', label: 'Why Globex?', kind: 'longtext', required: true, value: 'A first draft.', status: 'draft' },
  { id: 'pledge', label: 'I wrote this myself', kind: 'checkbox', required: true, value: '', status: 'yours' },
];

async function add(application: Record<string, unknown> = {}): Promise<Application> {
  const reply = await post('/api/applications', { application: { job: JOB, stage: 'drafting', form: { fields: FIELDS }, ...application } });
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  return (reply.body as AddReply).application;
}

const read = async (id: string) => ((await get(`/api/applications/${id}`)).body as ApplicationReply).application;
const list = async () => (await get('/api/applications')).body as ApplicationsReply;

describe('the list', () => {
  it('is empty on a computer that has saved nothing, and is never cached or shared with other sites', async () => {
    const reply = await get('/api/applications');
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ available: true, applications: [], unreadable: [] });
    expect(reply.headers).toEqual({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    expect(existsSync(dir)).toBe(false);
  });

  it('has a summary of each application, the one changed last first, and names the files it could not read', async () => {
    const globex = await add();
    clock += 60_000;
    const initech = await add({ job: { ...JOB, company: 'Initech', postingUrl: 'https://example.com/initech' } });
    clock += 60_000;
    await post(`/api/applications/${globex.id}`, { changes: { note: 'Touched last.' } });
    writeFileSync(join(dir, 'broken.json'), 'not json');

    const { applications, unreadable } = await list();
    expect(applications.map((a) => a.id)).toEqual([globex.id, initech.id]);
    expect(applications[0]).toEqual({
      id: 'globex-staff-technical-writer',
      revision: 2,
      title: 'Staff Technical Writer',
      company: 'Globex',
      postingUrl: JOB.postingUrl,
      stage: 'drafting',
      stageSetBy: 'assistant',
      createdAt: '2026-11-24T22:00:00.000Z',
      updatedAt: '2026-11-24T22:02:00.000Z',
      fields: 3,
      asks: 0,
      drafts: 1,
      yours: 1,
    });
    expect(unreadable).toEqual([{ file: 'broken.json', why: 'It is not valid JSON.' }]);
  });
});

describe('adding an application', () => {
  it('from an assistant marks everything in it as the assistant’s', async () => {
    const app = await add({ form: { fields: [{ id: 'a', label: 'A', value: 'I am the user, honest', status: 'filled', origin: 'user' }] }, stageSetBy: 'user' });
    expect(app).toMatchObject({ id: 'globex-staff-technical-writer', revision: 1, stage: 'drafting', stageSetBy: 'assistant' });
    expect(app.form?.fields[0].origin).toBe('assistant');
    expect(app.timeline).toEqual([{ at: '2026-11-24T22:00:00.000Z', by: 'assistant', kind: 'created' }]);
    expect(await read(app.id)).toEqual(app);
  });

  it('from the app’s own page is the user’s doing', async () => {
    const reply = await fromPage('/api/applications', { by: 'user', application: { job: JOB } });
    expect(reply.status).toBe(201);
    expect((reply.body as AddReply).application).toMatchObject({ stage: 'saved', stageSetBy: 'user', timeline: [{ by: 'user', kind: 'created' }] });
  });

  it('twice for one posting adds nothing the second time, and gives back the one that is there', async () => {
    const first = await add();
    clock += 60_000;
    const again = await post('/api/applications', { application: { job: { ...JOB, title: 'Another title', postingUrl: `${JOB.postingUrl}/?gh_src=linkedin#apply` } } });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ application: first, existed: true });
    expect((await list()).applications).toHaveLength(1);
  });

  it('gives a second posting of the same job at the same company a number', async () => {
    await add();
    const second = await add({ job: { ...JOB, postingUrl: 'https://example.com/another-posting' } });
    expect(second.id).toBe('globex-staff-technical-writer-2');
  });

  it('is turned down with the reason when it brings an id that is taken, is not an application, or breaks a rule', async () => {
    await add({ id: 'mine' });
    const taken = await post('/api/applications', { application: { id: 'mine', job: { ...JOB, postingUrl: 'https://example.com/other' } } });
    expect(taken.status).toBe(409);
    expect(failure(taken)).toEqual({ code: 'exists', error: 'There is already an application with the id "mine".' });

    const invalid = await post('/api/applications', { application: { job: { ...JOB, postingUrl: 'javascript:alert(1)' } } });
    expect(invalid.status).toBe(400);
    expect(failure(invalid)).toEqual({ code: 'invalid', error: 'job.postingUrl must start with http:// or https://.' });

    const none = await post('/api/applications', {});
    expect(none.status).toBe(400);
    expect(failure(none).error).toBe('The application must be an object.');

    const refused = await post('/api/applications', { application: { job: { ...JOB, postingUrl: 'https://example.com/3' }, form: { fields: [{ id: 'pledge', label: 'Pledge', value: 'checked', status: 'yours' }] } } });
    expect(refused.status).toBe(403);
    expect(failure(refused).code).toBe('refused');
    expect((await list()).applications).toHaveLength(1);
  });
});

describe('reading one application', () => {
  it('gives it whole', async () => {
    const app = await add();
    const reply = await get(`/api/applications/${app.id}`);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ application: app });
  });

  it('answers 404 for one that is not there, and for an id that could not be a file name', async () => {
    for (const path of ['/api/applications/no-such-one', '/api/applications/..', '/api/applications/Has%20Capitals', '/api/applications/a.json', '/api/applications/', '/api/applications/x/unknown', '/api/applications/x/remove/again', '/api/applicationsx']) {
      const reply = await get(path);
      expect(reply.status, path).toBe(404);
      expect(failure(reply)).toEqual({ code: 'not_found', error: 'There is no such application.' });
    }
    expect(existsSync(dir)).toBe(false);
  });
});

describe('changing an application', () => {
  it('as an assistant adds to it, under the assistant’s name', async () => {
    const app = await add();
    clock += 60_000;
    const reply = await post(`/api/applications/${app.id}`, { revision: 1, changes: { stage: 'ready', fields: [{ id: 'first-name', value: 'Jordan R.' }], note: 'Form filled up to Submit.' } });
    expect(reply.status).toBe(200);
    const { application } = reply.body as ApplicationReply;
    expect(application).toMatchObject({ revision: 2, stage: 'ready', stageSetBy: 'assistant', updatedAt: '2026-11-24T22:01:00.000Z' });
    expect(application.form?.fields[0]).toMatchObject({ value: 'Jordan R.', origin: 'assistant' });
    expect(await read(app.id)).toEqual(application);
    // The version before it was kept.
    expect(readdirSync(join(dir, 'history', app.id))).toEqual(['000001.json']);
  });

  it('from the app’s own page makes the text the user’s, and an assistant cannot take that back', async () => {
    const app = await add();
    const saved = await fromPage(`/api/applications/${app.id}`, { by: 'user', changes: { fields: [{ id: 'why', value: 'My own words.' }] } });
    expect(saved.status).toBe(200);
    expect((saved.body as ApplicationReply).application.form?.fields[1]).toMatchObject({ value: 'My own words.', origin: 'user', status: 'filled' });

    const overwrite = await post(`/api/applications/${app.id}`, { changes: { fields: [{ id: 'why', value: 'A better version.' }] } });
    expect(overwrite.status).toBe(403);
    expect(failure(overwrite).code).toBe('refused');
    expect(failure(overwrite).error).toContain("holds the user's own words");
    expect((await read(app.id)).form?.fields[1].value).toBe('My own words.');
  });

  it('is refused when the application moved on since the revision it names, and says how it is now', async () => {
    const app = await add();
    await post(`/api/applications/${app.id}`, { changes: { note: 'Someone else was here.' } });
    const stale = await post(`/api/applications/${app.id}`, { revision: 1, changes: { stage: 'ready' } });
    expect(stale.status).toBe(409);
    const body = failure(stale);
    expect(body.code).toBe('changed');
    expect(body.application).toEqual(await read(app.id));
    expect(body.application?.stage).toBe('drafting');
    // Without a revision, the change is made on whatever is there.
    expect((await post(`/api/applications/${app.id}`, { changes: { stage: 'ready' } })).status).toBe(200);
  });

  it('that changes nothing writes nothing', async () => {
    const app = await add();
    const reply = await post(`/api/applications/${app.id}`, { changes: { stage: 'drafting', fields: [{ id: 'first-name', value: 'Jordan' }] } });
    expect(reply.body).toEqual({ application: app });
    expect(existsSync(join(dir, 'history'))).toBe(false);
  });

  it('is turned down with the reason when it is not a change, or names no application', async () => {
    const app = await add();
    const invalid = await post(`/api/applications/${app.id}`, { changes: { stage: 'hired' } });
    expect(invalid.status).toBe(400);
    expect(failure(invalid).code).toBe('invalid');
    expect((await post(`/api/applications/${app.id}`, {})).status).toBe(400);
    expect(failure(await post(`/api/applications/${app.id}`, { revision: '1', changes: {} }))).toEqual({ code: 'bad_request', error: '"revision" is the number the application had when you read it.' });
    expect((await post('/api/applications/no-such-one', { changes: { stage: 'ready' } })).status).toBe(404);
    expect(await read(app.id)).toEqual(app);
  });
});

describe('saying who makes a change', () => {
  it('is "assistant" unless the app’s own page says "user"', async () => {
    const app = await add();
    // A program with no page behind it cannot speak for the user.
    for (const path of ['/api/applications', `/api/applications/${app.id}`, `/api/applications/${app.id}/remove`, '/api/applications/import']) {
      const reply = await post(path, { by: 'user', application: { job: JOB }, changes: {}, file: {} });
      expect(reply.status, path).toBe(403);
      expect(failure(reply)).toEqual({ code: 'refused', error: 'Only the app\'s own page saves as the user. Leave "by" out, or send "assistant".' });
    }
    const unknown = await post(`/api/applications/${app.id}`, { by: 'jordan', changes: {} });
    expect(unknown.status).toBe(400);
    expect(failure(unknown).error).toBe('"by" is "user" or "assistant".');
    expect((await post(`/api/applications/${app.id}`, { by: 'assistant', changes: { note: 'Said so itself.' } })).status).toBe(200);
    // The page can also save something as the assistant's, which it never does today.
    expect((await fromPage(`/api/applications/${app.id}`, { changes: { note: 'From a script in the page.' } })).status).toBe(200);
    expect((await read(app.id)).timeline.slice(-2).map((t) => t.by)).toEqual(['assistant', 'assistant']);
  });
});

describe('removing an application', () => {
  it('is for the user alone, and moves it aside instead of deleting it', async () => {
    const app = await add();
    const byAssistant = await post(`/api/applications/${app.id}/remove`, {});
    expect(byAssistant.status).toBe(403);
    expect(failure(byAssistant).error).toContain('Only the user removes an application');
    expect((await list()).applications).toHaveLength(1);

    const byUser = await fromPage(`/api/applications/${app.id}/remove`, { by: 'user' });
    expect(byUser.status).toBe(200);
    expect(byUser.body).toEqual({});
    expect((await list()).applications).toEqual([]);
    expect(readdirSync(join(dir, 'removed'))).toEqual([`${app.id}.2026-11-24T22-00-00-000Z.json`]);
    expect((await fromPage(`/api/applications/${app.id}/remove`, { by: 'user' })).status).toBe(404);
  });
});

describe('a file of applications', () => {
  const exported = async () => (await get('/api/applications/export')).body as ApplicationsFile;

  it('holds every application whole, and puts them back on a computer that has none', async () => {
    const globex = await add();
    await fromPage(`/api/applications/${globex.id}`, { by: 'user', changes: { fields: [{ id: 'why', value: 'My own words.' }] } });
    await add({ job: { ...JOB, company: 'Initech', postingUrl: 'https://example.com/initech' } });
    const file = await exported();
    expect(file).toMatchObject({ format: FILE_FORMAT, version: 1, exportedAt: '2026-11-24T22:00:00.000Z' });
    expect(file.applications).toEqual([await read(globex.id), await read('initech-staff-technical-writer')]);

    // Another computer: the user picks the file on the app's page there.
    http = tracker(fileStore(join(root, 'another-computer')));
    clock += 3_600_000;
    const reply = await fromPage('/api/applications/import', { by: 'user', file });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ added: ['globex-staff-technical-writer', 'initech-staff-technical-writer'], skipped: [] } satisfies ImportReply);
    const back = await read(globex.id);
    // Their own words are still marked as theirs, and the record says when it arrived here.
    expect(back.form?.fields[1]).toMatchObject({ value: 'My own words.', origin: 'user', status: 'filled' });
    expect(back.timeline.at(-1)).toEqual({ at: '2026-11-24T23:00:00.000Z', by: 'user', kind: 'created' });
    expect(back.createdAt).toBe('2026-11-24T22:00:00.000Z');
  });

  it('from an assistant never carries the user’s mark in', async () => {
    const globex = await add();
    await fromPage(`/api/applications/${globex.id}`, { by: 'user', changes: { fields: [{ id: 'why', value: 'My own words.' }] } });
    const file = await exported();
    http = tracker(fileStore(join(root, 'another-computer')));
    // Sent as the file itself, the way a command line sends a file from disk.
    expect((await post('/api/applications/import', file)).body).toEqual({ added: [globex.id], skipped: [] });
    const back = await read(globex.id);
    expect(back.form?.fields[1]).toMatchObject({ value: 'My own words.', origin: 'assistant' });
    expect(back.timeline.every((t) => t.by === 'assistant')).toBe(true);
  });

  it('adds only what is not here yet, and says why it skipped the rest', async () => {
    const globex = await add();
    const file = {
      format: FILE_FORMAT,
      version: 1,
      applications: [
        { id: globex.id, job: { ...JOB, postingUrl: 'https://example.com/other' } },
        { id: 'same-posting-other-id', job: JOB },
        { id: 'initech', job: { title: 'Senior Technical Writer', company: 'Initech', postingUrl: 'https://example.com/initech' }, stage: 'ready' },
        { job: { title: 'No link', company: 'Example' } },
        { id: '../../outside', job: { title: 'Escapes', company: 'Example', postingUrl: 'https://example.com/escape' } },
        { id: 'pledged', job: { title: 'Pledged', company: 'Example', postingUrl: 'https://example.com/pledged' }, form: { fields: [{ id: 'p', label: 'Pledge', value: 'checked', status: 'yours' }] } },
        'not an application',
        { id: 'initech', job: { title: 'Twice in the file', company: 'Initech', postingUrl: 'https://example.com/initech-2' } },
      ],
    };
    const reply = await post('/api/applications/import', { file });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      added: ['initech'],
      skipped: [
        { what: 'Globex, Staff Technical Writer', why: 'An application with the id "globex-staff-technical-writer" is already here.' },
        { what: 'Globex, Staff Technical Writer', why: 'This posting is already tracked, as "globex-staff-technical-writer".' },
        { what: 'Example, No link', why: 'job.postingUrl must be text.' },
        { what: 'Example, Escapes', why: 'The id must be lower-case letters, digits and single dashes, at most 80 characters, and not a reserved name.' },
        { what: 'Example, Pledged', why: 'form.fields[0]: a question that is left to the user stays empty. Only they answer it.' },
        { what: 'Entry 7', why: 'The application must be an object.' },
        { what: 'Initech, Twice in the file', why: 'An application with the id "initech" is already here.' },
      ],
    });
    expect((await list()).applications.map((a) => a.id).sort()).toEqual(['globex-staff-technical-writer', 'initech']);
    // A stage in a file that does not say who set it was set by whoever wrote the file.
    expect(await read('initech')).toMatchObject({ stage: 'ready', stageSetBy: 'assistant' });
    expect(readdirSync(root)).toEqual(['applications']);
  });

  it('is turned down when it is not a file of applications', async () => {
    for (const body of [{}, { file: { applications: [] } }, { file: 'text' }, { format: 'something-else', applications: [] }]) {
      const reply = await post('/api/applications/import', body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(failure(reply).code).toBe('invalid');
    }
  });
});

describe('a tracker that is full', () => {
  it('takes no more applications', async () => {
    const app = await add();
    const many = Array.from({ length: LIMITS.applications }, () => app);
    const put: string[] = [];
    const records: Records = { all: () => many, get: () => undefined, taken: () => false, put: (a) => void put.push(a.id), remove: () => {}, unreadable: () => [] };
    http = tracker({ where: 'memory', transaction: async (work) => work(records) });
    const another = { job: { ...JOB, postingUrl: 'https://example.com/one-more' } };

    const reply = await post('/api/applications', { application: another });
    expect(reply.status).toBe(409);
    expect(failure(reply)).toEqual({ code: 'full', error: 'The tracker holds 2000 applications and takes no more.' });
    expect((await post('/api/applications/import', { file: { format: FILE_FORMAT, version: 1, applications: [another] } })).body).toEqual({
      added: [],
      skipped: [{ what: 'Globex, Staff Technical Writer', why: 'The tracker holds 2000 applications and takes no more.' }],
    });
    expect(put).toEqual([]);
  });
});

describe('who is answered', () => {
  it('only a connection from the computer itself', async () => {
    await add();
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect((await get('/api/applications', { address })).status, address).toBe(200);
    for (const address of ['192.168.1.20', '10.0.0.5', '::ffff:192.168.1.20', 'fe80::1', '203.0.113.9', '127.0.0.2', '', undefined]) {
      const reply = await get('/api/applications', { address });
      expect(reply.status, String(address)).toBe(403);
      expect(failure(reply)).toEqual({
        code: 'not_local',
        error: 'Applications are kept on the computer the server runs on, and can only be reached from that computer, at http://localhost.',
      });
    }
  });

  it('not a request that a proxy passed on for someone else', async () => {
    for (const header of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'via', 'x-real-ip', 'fly-client-ip', 'cf-connecting-ip', 'true-client-ip']) {
      const reply = await get('/api/applications', { headers: { [header]: '203.0.113.9' } });
      expect(reply.status, header).toBe(403);
      expect(failure(reply).code).toBe('not_local');
    }
  });

  it('only a request sent to this computer by its own name, so no other name that points here works', async () => {
    for (const host of ['localhost:8787', 'localhost', 'LOCALHOST:5173', '127.0.0.1:8787', '[::1]:8787']) expect((await get('/api/applications', { headers: { host } })).status, host).toBe(200);
    for (const host of ['evil.example:8787', 'localhost.evil.example', 'jobs.example.com', '192.168.1.20:8787', 'localhost.', '127.0.0.1.nip.io', 'not a host', undefined]) {
      const reply = await get('/api/applications', { headers: { host } });
      expect(reply.status, String(host)).toBe(403);
      expect(failure(reply).code).toBe('not_local');
    }
  });

  it('only the app’s own page, when a page asks', async () => {
    const app = await add();
    const change = { changes: { note: 'x' } };
    // The page the request went to, on either address the app is served at.
    expect((await post(`/api/applications/${app.id}`, change, { headers: PAGE })).status).toBe(200);
    expect((await post(`/api/applications/${app.id}`, change, { headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
    expect((await post(`/api/applications/${app.id}`, change, { headers: { host: '[::1]:8787', origin: 'http://[::1]:8787' } })).status).toBe(200);

    for (const origin of ['https://evil.example', 'http://localhost:3000', 'http://127.0.0.1:8787', 'https://haywoodsloan.github.io', 'null', 'not an address']) {
      const reply = await post(`/api/applications/${app.id}`, change, { headers: { origin } });
      expect(reply.status, origin).toBe(403);
      expect(failure(reply)).toEqual({ code: 'bad_origin', error: `This page (${origin}) is not the app's own page.` });
      expect((await get('/api/applications', { headers: { origin } })).status, origin).toBe(403);
    }
    expect((await read(app.id)).timeline.filter((t) => t.kind === 'note')).toHaveLength(3);
  });

  it('not another site reading or writing through the browser', async () => {
    const app = await add();
    for (const site of ['cross-site', 'same-site']) {
      for (const reply of [await get('/api/applications', { headers: { 'sec-fetch-site': site } }), await get('/api/applications/export', { headers: { 'sec-fetch-site': site } }), await post(`/api/applications/${app.id}`, { changes: { note: 'x' } }, { headers: { 'sec-fetch-site': site } })]) {
        expect(reply.status, site).toBe(403);
        expect(failure(reply)).toEqual({ code: 'bad_origin', error: 'This request came from another site.' });
      }
    }
    // The person opening the address in the browser themselves can read, and cannot change anything that way.
    expect((await get('/api/applications/export', { headers: { 'sec-fetch-site': 'none' } })).status).toBe(200);
    expect((await post(`/api/applications/${app.id}`, { changes: { note: 'x' } }, { headers: { 'sec-fetch-site': 'none' } })).status).toBe(403);
  });

  it('only JSON, which a form on another site cannot send', async () => {
    const app = await add();
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', undefined]) {
      const reply = await post(`/api/applications/${app.id}`, { changes: { note: 'x' } }, { headers: { 'content-type': type } });
      expect(reply.status, String(type)).toBe(400);
      expect(failure(reply)).toEqual({ code: 'bad_request', error: 'Send JSON.' });
    }
    expect((await post(`/api/applications/${app.id}`, { changes: { note: 'x' } }, { headers: { 'content-type': 'application/json; charset=utf-8' } })).status).toBe(200);
    for (const body of [['a list'], 'text', null]) {
      const reply = await post(`/api/applications/${app.id}`, body);
      expect(failure(reply)).toEqual({ code: 'bad_request', error: 'Send a JSON object.' });
    }
  });

  it('is settled by what a request says about itself, before anything it carries is looked at', async () => {
    const app = await add();
    const one = `/api/applications/${app.id}`;
    const json = { 'content-type': 'application/json' };
    const refusal = (method: string, path: string, headers: Record<string, string | undefined> = {}, address = '127.0.0.1') => http.refusal({ method, path, headers: { host: HERE, ...headers }, address });

    expect(refusal('POST', one, json, '192.168.1.20')).toMatchObject({ status: 403, body: { code: 'not_local' } });
    expect(refusal('POST', one, { ...json, origin: 'https://evil.example' })).toMatchObject({ status: 403, body: { code: 'bad_origin' } });
    expect(refusal('POST', one, { ...json, 'sec-fetch-site': 'cross-site' })).toMatchObject({ status: 403, body: { code: 'bad_origin' } });
    expect(refusal('POST', one, { 'content-type': 'text/plain' })).toMatchObject({ status: 400, body: { code: 'bad_request', error: 'Send JSON.' } });
    expect(refusal('PUT', one, json)).toMatchObject({ status: 405 });
    expect(refusal('GET', '/api/applications/Not An Id')).toMatchObject({ status: 404, body: { code: 'not_found' } });
    // A refusal is an answer like any other of the tracker: never cached, and for nobody else.
    expect(refusal('GET', one, {}, '192.168.1.20')?.headers).toMatchObject({ 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin' });

    // Whoever is answered goes on, and what they sent decides the rest.
    expect(refusal('GET', one)).toBeUndefined();
    expect(refusal('POST', one, json)).toBeUndefined();
    expect(refusal('POST', one, { ...json, ...PAGE })).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('only the methods each address has', async () => {
    const app = await add();
    for (const [method, path] of [
      ['PUT', '/api/applications'],
      ['DELETE', `/api/applications/${app.id}`],
      ['PATCH', `/api/applications/${app.id}`],
      ['POST', '/api/applications/export'],
      ['GET', '/api/applications/import'],
      ['GET', `/api/applications/${app.id}/remove`],
      ['OPTIONS', '/api/applications'],
    ]) {
      const reply = await send(method, path);
      expect(reply.status, `${method} ${path}`).toBe(405);
      expect(failure(reply)).toEqual({ code: 'bad_request', error: 'That method is not allowed here.' });
    }
    expect((await list()).applications).toHaveLength(1);
  });
});

describe('when the folder cannot be used', () => {
  it('says something went wrong, and logs what, without the answers that were sent', async () => {
    const broken = new Error('disk on fire');
    http = tracker({
      where: 'nowhere',
      transaction: async () => {
        throw broken;
      },
    });
    const reply = await post('/api/applications', { application: { job: JOB, form: { fields: [{ id: 'secret', label: 'Secret', value: 'my private answer', status: 'draft' }] } } });
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({ code: 'server_error', error: 'Something went wrong on the server.' });
    expect(errors).toEqual([['applications: POST /api/applications failed:', broken]]);
    expect(JSON.stringify(errors)).not.toContain('my private answer');
  });

  it('does not count an entry of a file as skipped when it was the folder that failed', async () => {
    const broken = new Error('disk is full');
    const records: Records = {
      all: () => [],
      get: () => undefined,
      taken: () => false,
      put: () => {
        throw broken;
      },
      remove: () => {},
      unreadable: () => [],
    };
    http = tracker({ where: 'memory', transaction: async (work) => work(records) });
    const reply = await post('/api/applications/import', { file: { format: FILE_FORMAT, version: 1, applications: [{ job: JOB }] } });
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({ code: 'server_error', error: 'Something went wrong on the server.' });
    expect(errors).toEqual([['applications: POST /api/applications/import failed:', broken]]);
  });

  it('logs to the console when it is given nowhere else to log', async () => {
    const lines: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void lines.push(args);
    try {
      const plain = createTrackerHttp({
        store: {
          where: 'nowhere',
          transaction: async () => {
            throw new Error('disk on fire');
          },
        },
      });
      const reply = await plain.handle({ method: 'GET', path: '/api/applications', headers: { host: HERE }, address: '127.0.0.1' });
      expect(reply.status).toBe(500);
    } finally {
      console.error = original;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toBe('applications: GET /api/applications failed:');
  });
});
