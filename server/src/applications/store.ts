/**
 * Where the tracked applications are kept: one JSON file for each, in a folder on the computer the server runs on.
 *
 *   <folder>/<id>.json                      the application as it is now
 *   <folder>/history/<id>/<revision>.json   the versions before it, the newest thirty
 *   <folder>/removed/<id>.<time>.json       an application that was removed, with its history next to it
 *
 * The files are plain, readable text, and they are the record: the server reads them again for every request, so a
 * file that was put back or corrected by hand counts at once. This code never deletes an application: a removed
 * one is moved aside. The only files it deletes are versions older than the newest thirty. A file that cannot be
 * read is reported and left alone, never replaced.
 *
 * A file is replaced in one step (written whole under another name, then renamed over the old one), so a crash or
 * a power cut in the middle leaves the old version or the new one, never half of each.
 *
 * Everything that reads or writes the records goes through `transaction`. The work in it is done without a pause,
 * so two requests can never mix. A later store, say a database for a hosted copy, can sit behind the same two
 * interfaces, which are in records.ts (docs/decisions/0020-applications-are-kept-by-the-server-on-its-own-computer.md).
 */
import { randomBytes } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UnreadableFile } from '../../../src/apply/api';
import { isId, storedApplication, type Application } from '../../../src/apply/model';
import type { ApplicationStore } from './records';

export type { ApplicationStore, Records } from './records';

export interface FileStoreOptions {
  now?: () => Date;
  /** For tests: the step that puts a written file in place, and the wait before that step is tried again. */
  rename?: (from: string, to: string) => void;
  pause?: (ms: number) => void;
}

/** How many earlier versions of one application are kept. */
export const KEPT_VERSIONS = 30;

/** What Windows answers while another program (a virus scanner, a backup, an editor) holds the file for a moment. */
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const TRIES = 6;

const wait = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function fileStore(dir: string, o: FileStoreOptions = {}): ApplicationStore {
  const now = o.now ?? (() => new Date());
  const rename = o.rename ?? renameSync;
  const pause = o.pause ?? wait;
  const fileOf = (id: string) => join(dir, `${id}.json`);

  function moveInto(from: string, to: string) {
    for (let attempt = 1; ; attempt++) {
      try {
        return rename(from, to);
      } catch (e) {
        if (attempt >= TRIES || !BUSY.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
        pause(20 * 2 ** attempt);
      }
    }
  }

  function writeWhole(file: string, text: string) {
    const draft = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    const fd = openSync(draft, 'wx');
    try {
      writeFileSync(fd, text);
      // On the disk, and not only on its way there, before it takes the old file's place.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      moveInto(draft, file);
    } catch (e) {
      rmSync(draft, { force: true });
      throw e;
    }
  }

  function keepVersion(previous: Application) {
    const folder = join(dir, 'history', previous.id);
    mkdirSync(folder, { recursive: true });
    copyFileSync(fileOf(previous.id), join(folder, `${String(previous.revision).padStart(6, '0')}.json`));
    const versions = readdirSync(folder).filter((name) => /^\d+\.json$/.test(name)).sort();
    for (const old of versions.slice(0, Math.max(0, versions.length - KEPT_VERSIONS))) rmSync(join(folder, old), { force: true });
  }

  function readAll() {
    const apps = new Map<string, Application>();
    const unreadable: UnreadableFile[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(dir).sort();
    } catch (e) {
      // No folder yet: nothing was ever saved. It is made with the first application.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      try {
        if (!isId(id)) throw new Error('Its name is not the id of an application.');
        const app = storedApplication(JSON.parse(readFileSync(join(dir, name), 'utf8')));
        if (app.id !== id) throw new Error(`It says it is "${app.id}", which is not its file name.`);
        apps.set(id, app);
      } catch (e) {
        unreadable.push({ file: name, why: e instanceof SyntaxError ? 'It is not valid JSON.' : (e as Error).message });
      }
    }
    return { apps, unreadable };
  }

  return {
    where: dir,
    transaction: async (work) => {
      const { apps, unreadable } = readAll();
      return work({
        all: () => [...apps.values()],
        get: (id) => apps.get(id),
        taken: (id) => apps.has(id) || existsSync(fileOf(id)),
        unreadable: () => unreadable,
        put(app) {
          const previous = apps.get(app.id);
          if (!previous && existsSync(fileOf(app.id))) throw new Error(`${app.id}.json is in the folder and cannot be read, so it is not replaced.`);
          mkdirSync(dir, { recursive: true });
          if (previous) keepVersion(previous);
          writeWhole(fileOf(app.id), `${JSON.stringify(app, null, 2)}\n`);
          apps.set(app.id, app);
        },
        remove(id) {
          if (!apps.has(id)) return;
          const stamp = now().toISOString().replace(/[:.]/g, '-');
          mkdirSync(join(dir, 'removed'), { recursive: true });
          moveInto(fileOf(id), join(dir, 'removed', `${id}.${stamp}.json`));
          apps.delete(id);
          // Its earlier versions go with it, so that a new application with the same id starts a history of its own.
          if (existsSync(join(dir, 'history', id))) moveInto(join(dir, 'history', id), join(dir, 'removed', `${id}.${stamp}.history`));
        },
      });
    },
  };
}
