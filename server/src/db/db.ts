/**
 * The database the signed-in features use.
 *
 * Everything is written against the small `Db` interface below, in plain Postgres SQL. Locally the driver is
 * PGlite: real Postgres compiled to WebAssembly, running inside this Node process and keeping its files in a
 * folder, so there is nothing to install. A hosted deployment gets a driver for a normal Postgres server behind the
 * same interface.
 *
 * PGlite is one process only, and nothing stops a second process from opening the same folder and corrupting it.
 * So whoever opens a folder first takes a lock file next to it, and `npm run admin` commands that find the server
 * holding the lock go through the server instead (see accounts/cli.ts).
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

export type Row = Record<string, unknown>;

export interface Db {
  /** Runs one statement and returns its rows. Binary columns come back as Buffers, timestamps as Dates. */
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs one statement and returns how many rows it changed. */
  run(sql: string, params?: unknown[]): Promise<number>;
  /** Runs `fn` in a transaction: everything it does is kept, or nothing is if it throws. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Postgres error codes this code reacts to. */
export const UNIQUE_VIOLATION = '23505';
export const errorCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

interface Runner {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
}

const toBuffers = <T>(rows: T[]): T[] => {
  for (const row of rows as Row[]) {
    for (const k in row) {
      const v = row[k];
      if (v instanceof Uint8Array && !Buffer.isBuffer(v)) row[k] = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    }
  }
  return rows;
};

function wrap(runner: Runner, tx: Db['tx'], close: Db['close']): Db {
  return {
    query: async <T>(sql: string, params?: unknown[]) => toBuffers((await runner.query<T>(sql, params)).rows),
    run: async (sql, params) => (await runner.query(sql, params)).affectedRows ?? 0,
    tx,
    close,
  };
}

export interface OpenOptions {
  /** Folder for the database files. Left out, the database lives in memory and is gone when closed (tests). */
  dir?: string;
  /** Written into the lock file, so another process can tell who holds the folder and how to reach it. */
  holder?: LockHolder;
}

export interface LockHolder {
  pid: number;
  role: 'server' | 'admin';
  /** The port the server listens on, for admin commands that have to go through it. */
  port?: number;
}

/** Thrown when another live process already has the database folder open. */
export class DatabaseInUse extends Error {
  constructor(public holder: LockHolder) {
    super(`The database is in use by ${holder.role === 'server' ? 'the running server' : 'another admin command'} (process ${holder.pid}).`);
    this.name = 'DatabaseInUse';
  }
}

export const lockPath = (dir: string) => `${dir}.lock`;

/** What the lock file says, whether or not the process it names is still there. Undefined when it cannot be read. */
function lockOwner(dir: string): LockHolder | undefined {
  try {
    const holder = JSON.parse(readFileSync(lockPath(dir), 'utf8')) as LockHolder;
    return typeof holder?.pid === 'number' ? holder : undefined;
  } catch {
    return undefined;
  }
}

/** The live process that holds the folder, if there is one. */
export function readLock(dir: string): LockHolder | undefined {
  const holder = lockOwner(dir);
  return holder && alive(holder.pid) ? holder : undefined;
}

const pause = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // it exists, we just may not signal it
  }
}

function takeLock(dir: string, holder: LockHolder): () => void {
  const file = lockPath(dir);
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(file, 'wx'); // fails if the file is already there
      try {
        writeSync(fd, JSON.stringify(holder));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 10) throw e;
      const current = readLock(dir);
      if (current && current.pid !== holder.pid) throw new DatabaseInUse(current);
      // Nobody alive is named in it. A file that cannot be read yet may have been created this instant by a
      // process that has not written its name: look again shortly before treating it as left behind.
      if (!lockOwner(dir) && attempt < 5) {
        pause(40);
        continue;
      }
      rmSync(file, { force: true }); // left behind by a process that is gone
    }
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    rmSync(file, { force: true });
  };
  process.on('exit', release);
  return release;
}

export async function openDb(o: OpenOptions = {}): Promise<Db> {
  const release = o.dir ? takeLock(o.dir, o.holder ?? { pid: process.pid, role: 'admin' }) : () => {};
  let pg: PGlite;
  try {
    if (o.dir) mkdirSync(o.dir, { recursive: true });
    pg = new PGlite(o.dir);
    await pg.waitReady;
  } catch (e) {
    release();
    throw e;
  }
  const close = async () => {
    try {
      if (!pg.closed) await pg.close();
    } finally {
      release();
    }
  };
  const tx: Db['tx'] = (fn) =>
    pg.transaction((t) =>
      fn(
        wrap(
          t,
          () => {
            throw new Error('Transactions cannot be nested');
          },
          async () => {},
        ),
      ),
    );
  return wrap(pg, tx, close);
}

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Applies every migration that has not run yet, in order, each in its own transaction. */
export async function migrate(db: Db, migrations: Migration[]): Promise<number[]> {
  await db.run('create table if not exists schema_migrations (version integer primary key, name text not null, applied_at timestamptz not null)');
  const done = new Set((await db.query<{ version: number }>('select version from schema_migrations')).map((r) => r.version));
  const applied: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (done.has(m.version)) continue;
    await db.tx(async (t) => {
      for (const statement of splitStatements(m.sql)) await t.run(statement);
      await t.run('insert into schema_migrations (version, name, applied_at) values ($1, $2, $3)', [m.version, m.name, new Date()]);
    });
    applied.push(m.version);
  }
  return applied;
}

/** Migrations here are plain DDL with no semicolons inside strings, so splitting on them is enough. */
const splitStatements = (sql: string) =>
  sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
