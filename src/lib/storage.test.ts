// @vitest-environment jsdom
/** What the app keeps in the browser: small settings in localStorage, the original resume file in IndexedDB. */
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteFile, getFile, loadJson, putFile, saveJson } from './storage';

beforeEach(() => {
  localStorage.clear();
  // jsdom has no IndexedDB. Each test gets an empty in-memory one.
  vi.stubGlobal('indexedDB', new IDBFactory());
});

const bytes = (...values: number[]) => new Uint8Array(values).buffer;
const read = (buffer: ArrayBuffer | undefined) => (buffer ? [...new Uint8Array(buffer)] : undefined);

describe('small settings kept in the browser', () => {
  it('come back as they were saved', () => {
    saveJson('search-settings:v1', { boards: ['linkedin'], allowScraping: false });
    expect(loadJson('search-settings:v1', null)).toEqual({ boards: ['linkedin'], allowScraping: false });
  });

  it('fall back to the default when nothing is saved, or when what is saved cannot be read', () => {
    expect(loadJson('missing', { boards: [] })).toEqual({ boards: [] });
    localStorage.setItem('broken', '{"boards": [');
    expect(loadJson('broken', 'default')).toBe('default');
  });

  it('are removed by saving undefined', () => {
    saveJson('resume:v1', { id: 'r1' });
    saveJson('resume:v1', undefined);
    expect(localStorage.getItem('resume:v1')).toBeNull();
    expect(loadJson('resume:v1', 'none')).toBe('none');
  });

  it('do not stop the app when the browser refuses to store or read them', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    expect(() => saveJson('k', { a: 1 })).not.toThrow();

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(loadJson('k', 'default')).toBe('default');
  });
});

describe('the original resume file kept in the browser', () => {
  it('comes back byte for byte', async () => {
    await putFile('resume-file', bytes(37, 80, 68, 70, 0, 255));
    expect(read(await getFile('resume-file'))).toEqual([37, 80, 68, 70, 0, 255]);
  });

  it('is replaced by a newer file under the same key, and kept apart from other keys', async () => {
    await putFile('a', bytes(1));
    await putFile('b', bytes(2));
    await putFile('a', bytes(3, 4));
    expect(read(await getFile('a'))).toEqual([3, 4]);
    expect(read(await getFile('b'))).toEqual([2]);
  });

  it('is gone after it is deleted', async () => {
    await putFile('resume-file', bytes(1, 2, 3));
    await deleteFile('resume-file');
    expect(await getFile('resume-file')).toBeUndefined();
    // Deleting what is not there is not an error.
    await expect(deleteFile('never-stored')).resolves.toBeUndefined();
  });

  it('is simply not there, without an error, in a browser that has no IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(putFile('resume-file', bytes(1))).resolves.toBeUndefined();
    expect(await getFile('resume-file')).toBeUndefined();
    await expect(deleteFile('resume-file')).resolves.toBeUndefined();
  });
});
