/** The two brakes on the account routes: a count of tries per key in a time window, and a cap on password hashes running at once. */
import { describe, expect, it } from 'vitest';
import { Attempts, Busy, Slots } from '../../server/src/accounts/limits';

const MINUTE = 60_000;

function attempts(windowMs = 15 * MINUTE) {
  let clock = 1_000_000;
  const limiter = new Attempts(() => clock, windowMs);
  return { limiter, advance: (ms: number) => (clock += ms) };
}

describe('counting tries', () => {
  it('lets a key try up to the limit, then says how long it must wait', () => {
    const { limiter, advance } = attempts();
    for (let i = 0; i < 3; i++) {
      expect(limiter.wait('account:1', 3)).toBe(0);
      limiter.count('account:1');
      advance(MINUTE);
    }
    // Three tries at 0, 1 and 2 minutes. At 3 minutes the first one still has 12 of its 15 minutes to run.
    expect(limiter.wait('account:1', 3)).toBe(12 * MINUTE);
  });

  it('lets the key try again as soon as its oldest try has left the window', () => {
    const { limiter, advance } = attempts();
    limiter.count('a');
    advance(5 * MINUTE);
    limiter.count('a');
    expect(limiter.wait('a', 2)).toBe(10 * MINUTE);
    advance(10 * MINUTE - 1);
    expect(limiter.wait('a', 2)).toBe(1);
    advance(1);
    expect(limiter.wait('a', 2)).toBe(0);
  });

  it('does not count a try when it is only asked how long to wait', () => {
    const { limiter } = attempts();
    for (let i = 0; i < 50; i++) limiter.wait('a', 1);
    expect(limiter.wait('a', 1)).toBe(0);
  });

  it('counts each key on its own, and forgets a key that is cleared', () => {
    const { limiter } = attempts();
    limiter.count('account:1');
    limiter.count('address:203.0.113.9');
    expect(limiter.wait('account:1', 1)).toBeGreaterThan(0);
    expect(limiter.wait('account:2', 1)).toBe(0);

    limiter.clear('account:1');
    expect(limiter.wait('account:1', 1)).toBe(0);
    expect(limiter.wait('address:203.0.113.9', 1)).toBeGreaterThan(0);
  });

  it('holds a larger limit against the same tries, so two limits can share one count', () => {
    const { limiter } = attempts();
    for (let i = 0; i < 5; i++) limiter.count('a');
    expect(limiter.wait('a', 5)).toBeGreaterThan(0);
    expect(limiter.wait('a', 6)).toBe(0);
  });

  it('drops keys whose tries have all expired, so an attacker cannot grow it without end', () => {
    const { limiter, advance } = attempts();
    for (let i = 0; i < 20_000; i++) limiter.count(`address:${i}`);
    advance(15 * MINUTE + 1);
    limiter.count('one more');
    const remembered = (limiter as unknown as { seen: Map<string, number[]> }).seen;
    expect([...remembered.keys()]).toEqual(['one more']);
  });
});

describe('running only a few at once', () => {
  /** A task that runs until it is told to finish. */
  function task(log: string[], name: string) {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const run = async () => {
      log.push(`${name} started`);
      await done;
      log.push(`${name} finished`);
      return name;
    };
    return { run, finish };
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('starts the first ones at once and makes the rest wait their turn, in order', async () => {
    const slots = new Slots(2, 10);
    const log: string[] = [];
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((name) => task(log, name));
    const results = [a, b, c, d].map((t) => slots.run(t.run));
    await settle();
    expect(log).toEqual(['a started', 'b started']);

    a.finish();
    await settle();
    expect(log).toEqual(['a started', 'b started', 'a finished', 'c started']);

    b.finish();
    c.finish();
    d.finish();
    expect(await Promise.all(results)).toEqual(['a', 'b', 'c', 'd']);
    expect(log.filter((l) => l.endsWith('started'))).toEqual(['a started', 'b started', 'c started', 'd started']);
  });

  it('turns a request away when too many are already waiting', async () => {
    const slots = new Slots(1, 1);
    const log: string[] = [];
    const [a, b] = [task(log, 'a'), task(log, 'b')];
    const first = slots.run(a.run);
    const second = slots.run(b.run);

    await expect(slots.run(async () => 'c')).rejects.toBeInstanceOf(Busy);

    a.finish();
    b.finish();
    await Promise.all([first, second]);
    // With the queue empty again, the next one is let in.
    await expect(slots.run(async () => 'd')).resolves.toBe('d');
  });

  it('frees the slot of a task that fails', async () => {
    const slots = new Slots(1, 0);
    await expect(
      slots.run(async () => {
        throw new Error('hash failed');
      }),
    ).rejects.toThrow('hash failed');
    await expect(slots.run(async () => 'next')).resolves.toBe('next');
  });
});
