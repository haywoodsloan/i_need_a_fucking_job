/**
 * The folder the applications are kept in (server/src/applications/store.ts): what is in it after each kind of
 * change, that nothing in it is ever lost or half written, and that a file it cannot read is left alone.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryStore } from '../../server/src/applications/records';
import { KEPT_VERSIONS, fileStore } from '../../server/src/applications/store';
import { changeApplication, newApplication, type Application } from '../../src/apply/model';

const NOW = new Date('2026-11-24T22:00:00.000Z');
let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'applications-store-test-'));
  // The folder itself does not exist yet: the store makes it.
  dir = join(root, 'applications');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function application(id: string, extra: Record<string, unknown> = {}): Application {
  return newApplication({ id, job: { title: 'Technical Writer', company: 'Example', postingUrl: `https://example.com/jobs/${id}` }, ...extra }, { by: 'assistant', now: NOW, taken: () => false });
}

const noted = (app: Application, note: string) => changeApplication(app, { note }, { by: 'user', now: NOW });
const files = (folder = dir) => (existsSync(folder) ? readdirSync(folder).sort() : []);
const fail = (code: string) => Object.assign(new Error(code), { code });

describe('the folder of applications', () => {
  it('holds nothing, and does not exist, until the first application is saved', async () => {
    const store = fileStore(dir);
    expect(store.where).toBe(dir);
    expect(await store.transaction((r) => ({ all: r.all(), unreadable: r.unreadable(), got: r.get('globex'), taken: r.taken('globex') }))).toEqual({ all: [], unreadable: [], got: undefined, taken: false });
    expect(existsSync(dir)).toBe(false);
  });

  it('keeps each application as one readable file, and reads it back as it was', async () => {
    const store = fileStore(dir);
    const globex = application('globex', { form: { fields: [{ id: 'name', label: 'Name', value: 'Jordan', status: 'filled' }] } });
    const initech = application('initech');
    await store.transaction((r) => {
      r.put(initech);
      r.put(globex);
      // Inside the same piece of work, what was just saved is already there.
      expect(r.get('globex')).toEqual(globex);
      expect(r.taken('initech')).toBe(true);
    });
    expect(files()).toEqual(['globex.json', 'initech.json']);
    const text = readFileSync(join(dir, 'globex.json'), 'utf8');
    expect(JSON.parse(text)).toEqual(globex);
    // Laid out for a person to read, and ending with a line end like any text file.
    expect(text.startsWith('{\n  "id": "globex",\n')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);

    // Another store on the same folder, as after a restart of the server, finds the same records, in the order of their ids.
    const again = fileStore(dir);
    expect(await again.transaction((r) => r.all())).toEqual([globex, initech]);
    expect(await again.transaction((r) => r.get('initech'))).toEqual(initech);
  });

  it('keeps the version before each change, the newest thirty of them', async () => {
    const store = fileStore(dir);
    let app = application('globex');
    await store.transaction((r) => r.put(app));
    expect(files(join(dir, 'history'))).toEqual([]);
    for (let n = 1; n <= KEPT_VERSIONS + 5; n++) {
      app = noted(app, `Note ${n}`);
      await store.transaction((r) => r.put(app));
    }
    const kept = files(join(dir, 'history', 'globex'));
    expect(kept).toHaveLength(KEPT_VERSIONS);
    // Revision 36 is the file itself. The thirty before it are kept, and the oldest five are gone.
    expect(kept[0]).toBe('000006.json');
    expect(kept.at(-1)).toBe('000035.json');
    expect(JSON.parse(readFileSync(join(dir, 'history', 'globex', '000035.json'), 'utf8')).timeline.at(-1).text).toBe('Note 34');
    expect(JSON.parse(readFileSync(join(dir, 'globex.json'), 'utf8')).revision).toBe(36);
  });

  it('moves a removed application aside with its history, where it can be found again', async () => {
    const store = fileStore(dir, { now: () => new Date('2026-11-25T10:30:15.123Z') });
    const app = application('globex');
    await store.transaction((r) => r.put(app));
    await store.transaction((r) => r.put(noted(app, 'One change')));
    await store.transaction((r) => {
      r.remove('globex');
      r.remove('never-there');
      expect(r.get('globex')).toBeUndefined();
      expect(r.taken('globex')).toBe(false);
    });
    expect(files()).toEqual(['history', 'removed']);
    expect(files(join(dir, 'history'))).toEqual([]);
    expect(files(join(dir, 'removed'))).toEqual(['globex.2026-11-25T10-30-15-123Z.history', 'globex.2026-11-25T10-30-15-123Z.json']);
    expect(JSON.parse(readFileSync(join(dir, 'removed', 'globex.2026-11-25T10-30-15-123Z.json'), 'utf8')).timeline.at(-1).text).toBe('One change');
    expect(await store.transaction((r) => r.all())).toEqual([]);

    // The id is free again, and the new application starts a history of its own.
    await store.transaction((r) => r.put(application('globex')));
    expect(files(join(dir, 'history'))).toEqual([]);
  });

  it('counts a file put back or corrected by hand at once', async () => {
    const store = fileStore(dir);
    const app = application('globex');
    await store.transaction((r) => r.put(app));
    const edited = { ...app, job: { ...app.job, title: 'Edited by hand' } };
    writeFileSync(join(dir, 'globex.json'), JSON.stringify(edited));
    writeFileSync(join(dir, 'initech.json'), JSON.stringify(application('initech')));
    expect((await store.transaction((r) => r.all())).map((a) => [a.id, a.job.title])).toEqual([
      ['globex', 'Edited by hand'],
      ['initech', 'Technical Writer'],
    ]);
  });

  it('reports a file it cannot read, leaves it alone, and never gives its name to another application', async () => {
    const store = fileStore(dir);
    await store.transaction((r) => r.put(application('good')));
    writeFileSync(join(dir, 'broken.json'), '{ "id": "broken", ');
    writeFileSync(join(dir, 'wrong-shape.json'), JSON.stringify({ id: 'wrong-shape', revision: 1 }));
    writeFileSync(join(dir, 'renamed.json'), JSON.stringify(application('original-name')));
    writeFileSync(join(dir, 'Not An Id.json'), JSON.stringify(application('x')));
    // What is not a .json file is nobody's business: notes, a folder, a half-written file from a crash.
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    writeFileSync(join(dir, 'good.json.1234-abcd.tmp'), '{');
    mkdirSync(join(dir, 'folder.json'));

    const { all, unreadable } = await store.transaction((r) => ({ all: r.all(), unreadable: r.unreadable() }));
    expect(all.map((a) => a.id)).toEqual(['good']);
    expect(Object.fromEntries(unreadable.map((u) => [u.file, u.why]))).toEqual({
      'Not An Id.json': 'Its name is not the id of an application.',
      'broken.json': 'It is not valid JSON.',
      'folder.json': expect.stringContaining('EISDIR'),
      'renamed.json': 'It says it is "original-name", which is not its file name.',
      'wrong-shape.json': expect.stringContaining('job must be an object'),
    });

    await store.transaction((r) => {
      expect(r.taken('broken')).toBe(true);
      expect(r.get('broken')).toBeUndefined();
      expect(() => r.put(application('broken'))).toThrow('broken.json is in the folder and cannot be read, so it is not replaced.');
    });
    expect(readFileSync(join(dir, 'broken.json'), 'utf8')).toBe('{ "id": "broken", ');
  });

  it('replaces a file in one step, so a failure leaves the old version whole and no scraps behind', async () => {
    const tried: string[] = [];
    const store = fileStore(dir, {
      rename: (from) => {
        tried.push(from);
        throw fail('ENOSPC');
      },
    });
    const first = application('globex');
    // The very first save fails: nothing is left in the folder.
    await expect(store.transaction((r) => r.put(first))).rejects.toThrow('ENOSPC');
    expect(files()).toEqual([]);
    expect(tried).toHaveLength(1);
    expect(tried[0]).toMatch(/globex\.json\.\d+-[0-9a-f]{8}\.tmp$/);

    await fileStore(dir).transaction((r) => r.put(first));
    await expect(store.transaction((r) => r.put(noted(first, 'Lost')))).rejects.toThrow('ENOSPC');
    expect(files()).toEqual(['globex.json', 'history']);
    expect(JSON.parse(readFileSync(join(dir, 'globex.json'), 'utf8'))).toEqual(first);
  });

  it('tries again when another program holds the file for a moment, as happens on Windows', async () => {
    const waits: number[] = [];
    let failures = 3;
    const real = fileStore(dir);
    const store = fileStore(dir, {
      pause: (ms) => waits.push(ms),
      rename: (from, to) => {
        if (failures-- > 0) throw fail(['EPERM', 'EBUSY', 'EACCES'][failures]);
        // The real step, through a store that has it.
        writeFileSync(to, readFileSync(from));
        rmSync(from);
      },
    });
    await store.transaction((r) => r.put(application('globex')));
    expect(waits).toEqual([40, 80, 160]);
    expect((await real.transaction((r) => r.all())).map((a) => a.id)).toEqual(['globex']);

    // It does not try for ever.
    const stuck = fileStore(dir, {
      pause: (ms) => waits.push(ms),
      rename: () => {
        throw fail('EBUSY');
      },
    });
    waits.length = 0;
    await expect(stuck.transaction((r) => r.put(application('initech')))).rejects.toThrow('EBUSY');
    expect(waits).toHaveLength(5);
    expect(files()).toEqual(['globex.json']);
  });

  it('waits for real between tries when nothing else is given', async () => {
    let failures = 1;
    const store = fileStore(dir, {
      rename: (from, to) => {
        if (failures-- > 0) throw fail('EBUSY');
        writeFileSync(to, readFileSync(from));
        rmSync(from);
      },
    });
    const started = Date.now();
    await store.transaction((r) => r.put(application('globex')));
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(files()).toEqual(['globex.json']);
  });

  it('passes on a failure of the folder itself', async () => {
    // A file where the folder should be.
    writeFileSync(dir, 'not a folder');
    await expect(fileStore(dir).transaction((r) => r.all())).rejects.toThrow(/ENOTDIR/);
  });
});

describe('the records kept in memory, for tests', () => {
  it('answer the way the folder does', async () => {
    const initech = application('initech');
    const store = memoryStore([initech]);
    expect(store.where).toBe('memory');
    const globex = application('globex');
    await store.transaction((r) => {
      r.put(globex);
      expect(r.get('globex')).toEqual(globex);
      expect(r.taken('globex')).toBe(true);
      expect(r.taken('zenith')).toBe(false);
      expect(r.get('zenith')).toBeUndefined();
    });
    // In the order of their ids, like the files of a folder.
    expect(await store.transaction((r) => r.all())).toEqual([globex, initech]);
    expect(await store.transaction((r) => r.unreadable())).toEqual([]);
    store.unreadable.push({ file: 'broken.json', why: 'It is not valid JSON.' });
    expect(await store.transaction((r) => r.unreadable())).toEqual([{ file: 'broken.json', why: 'It is not valid JSON.' }]);

    await store.transaction((r) => r.remove('initech'));
    expect([...store.applications.keys()]).toEqual(['globex']);
  });

  it('hand out copies, so that nothing changes a record by holding on to it', async () => {
    const initech = application('initech');
    const store = memoryStore([initech]);
    initech.job.title = 'Changed outside';
    const read = await store.transaction((r) => r.get('initech')!);
    expect(read.job.title).toBe('Technical Writer');
    read.job.title = 'Changed after reading';
    const next = application('globex');
    await store.transaction((r) => r.put(next));
    next.job.title = 'Changed after saving';
    expect((await store.transaction((r) => r.all())).map((a) => a.job.title)).toEqual(['Technical Writer', 'Technical Writer']);
  });
});
