/**
 * What the tracker's routes need from wherever the applications are kept. store.ts keeps them as files on the
 * computer the server runs on. `memoryStore` here keeps them only as long as the program runs, which is for tests
 * and for nothing else.
 *
 * This file has no `node:` imports, and neither has http.ts: the tests of the app's pages run the real routes over
 * records in memory (src/testing/fakeTracker.ts), where there is no Node.
 */
import type { UnreadableFile } from '../../../src/apply/api';
import type { Application } from '../../../src/apply/model';

export interface Records {
  /** Every application that can be read, in the order of their ids. */
  all(): Application[];
  get(id: string): Application | undefined;
  /** Whether an id is in use, also by a file that cannot be read. */
  taken(id: string): boolean;
  /** Adds an application, or replaces the one with its id. */
  put(app: Application): void;
  remove(id: string): void;
  /** The files in the folder that are not readable applications. */
  unreadable(): UnreadableFile[];
}

export interface ApplicationStore {
  /** Where the records are, for the server's log. */
  where: string;
  /** One piece of work on the records. Nothing else touches them until it has ended. */
  transaction<T>(work: (records: Records) => T): Promise<T>;
}

export interface MemoryStore extends ApplicationStore {
  /** The records themselves, for a test to look at or to change behind the routes' back. */
  applications: Map<string, Application>;
  /** What the store reports as files it cannot read. */
  unreadable: UnreadableFile[];
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Records that are gone when the program ends. For tests. */
export function memoryStore(start: Application[] = []): MemoryStore {
  // A copy goes in and a copy comes out, the way a file would give it: nothing outside can change a record by
  // holding on to it.
  const applications = new Map(start.map((app) => [app.id, copy(app)]));
  const unreadable: UnreadableFile[] = [];
  const records: Records = {
    // No two have the same id, so one of them always comes first.
    all: () => [...applications.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map(copy),
    get: (id) => {
      const app = applications.get(id);
      return app && copy(app);
    },
    taken: (id) => applications.has(id),
    put: (app) => void applications.set(app.id, copy(app)),
    remove: (id) => void applications.delete(id),
    unreadable: () => unreadable,
  };
  return { where: 'memory', applications, unreadable, transaction: async (work) => work(records) };
}
