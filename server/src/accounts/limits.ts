/**
 * Two brakes on guessing and on overload, both in memory (the server is a single process).
 *
 *   Attempts   counts tries per key (an account, an address) inside a time window
 *   Slots      lets only a few password hashes run at once, since each one takes 64 MiB
 */

export class Attempts {
  private seen = new Map<string, number[]>();

  constructor(
    private now: () => number,
    private windowMs: number,
  ) {}

  /** How long `key` must wait before its next try, in milliseconds. 0 means it may go ahead. Does not count a try. */
  wait(key: string, max: number): number {
    const recent = this.recent(key);
    return recent.length >= max ? recent[recent.length - max] + this.windowMs - this.now() : 0;
  }

  /** Counts one try against `key`. */
  count(key: string): void {
    const recent = this.recent(key);
    recent.push(this.now());
    this.seen.set(key, recent);
    if (this.seen.size > 20_000) this.prune();
  }

  /** Forgets `key`, after a success. */
  clear(key: string): void {
    this.seen.delete(key);
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    return (this.seen.get(key) ?? []).filter((t) => t > cutoff);
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [key, times] of this.seen) if (!times.some((t) => t > cutoff)) this.seen.delete(key);
  }
}

/** Thrown when too many requests are already waiting for a slot. */
export class Busy extends Error {
  constructor() {
    super('Too many requests are waiting');
    this.name = 'Busy';
  }
}

export class Slots {
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private max: number,
    private maxWaiting: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) {
      if (this.waiting.length >= this.maxWaiting) throw new Busy();
      await new Promise<void>((go) => this.waiting.push(go)); // whoever finishes hands its slot over
    } else {
      this.running++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}
