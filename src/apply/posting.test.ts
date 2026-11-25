import { describe, expect, it } from 'vitest';
import type { JobPosting } from '../jobs/types';
import { LIMITS, newApplication, summarize } from './model';
import { applicationFor, payText, postingAddress, trackedAs } from './posting';

const job = (over: Partial<JobPosting> = {}): JobPosting => ({
  id: 'greenhouse:acme:1',
  title: 'Technical Writer',
  company: 'Acme',
  location: 'Remote, US',
  workplace: 'remote',
  postedAt: '2026-11-17T09:00:00.000Z',
  salary: { min: 120_000, max: 150_000, currency: 'USD', period: 'year' },
  descriptionHtml: '<p>Write the <b>docs</b>.</p>',
  descriptionText: 'Write the docs.',
  listings: [
    { sourceId: 'greenhouse', via: 'Acme', url: 'https://boards.greenhouse.io/acme/jobs/1' },
    { sourceId: 'linkedin', via: 'LinkedIn', url: 'https://www.linkedin.com/jobs/view/42', applyUrl: 'https://www.linkedin.com/jobs/view/42/apply' },
  ],
  ...over,
});

/** What the tracker makes of it, with the real rules. */
const tracked = (posting: JobPosting) => newApplication(applicationFor(posting), { by: 'user', now: new Date('2026-11-24T15:00:00.000Z'), taken: () => false });

describe('saving a job from the search results', () => {
  it('copies the facts of the posting as the search gave them', () => {
    expect(applicationFor(job())).toEqual({
      job: {
        title: 'Technical Writer',
        company: 'Acme',
        location: 'Remote, US',
        workplace: 'remote',
        pay: '$120,000 to $150,000 a year',
        postedAt: '2026-11-17T09:00:00.000Z',
        postingUrl: 'https://boards.greenhouse.io/acme/jobs/1',
        listings: [
          { via: 'Acme', url: 'https://boards.greenhouse.io/acme/jobs/1' },
          { via: 'LinkedIn', url: 'https://www.linkedin.com/jobs/view/42' },
        ],
        descriptionHtml: '<p>Write the <b>docs</b>.</p>',
        descriptionText: 'Write the docs.',
      },
    });
  });

  it('gives the tracker something it takes, as a saved application with no form yet', () => {
    const app = tracked(job());
    expect(app).toMatchObject({ id: 'acme-technical-writer', stage: 'saved', stageSetBy: 'user', revision: 1 });
    expect(app.form).toBeUndefined();
    expect(app.timeline).toEqual([{ at: '2026-11-24T15:00:00.000Z', by: 'user', kind: 'created' }]);
  });

  it('leaves out what the search did not give, and what the tracker would not take', () => {
    const bare = applicationFor(job({ location: '  ', workplace: undefined, postedAt: 'last week', salary: undefined, descriptionHtml: undefined, descriptionText: undefined }));
    expect(bare).toEqual({ job: { title: 'Technical Writer', company: 'Acme', postingUrl: 'https://boards.greenhouse.io/acme/jobs/1', listings: expect.any(Array) } });
    // A posting longer than the tracker takes is not cut in half.
    const long = applicationFor(job({ descriptionHtml: 'x'.repeat(LIMITS.description + 1) }));
    expect(long?.job.descriptionHtml).toBeUndefined();
    expect(long?.job.descriptionText).toBe('Write the docs.');
    expect(applicationFor(job({ descriptionText: 'x'.repeat(LIMITS.description + 1) }))?.job.descriptionText).toBeUndefined();
    // A title longer than a line is cut to a line.
    expect(applicationFor(job({ title: `  ${'Technical Writer '.repeat(40)}` }))?.job.title).toHaveLength(LIMITS.line);
    expect(() => tracked(job({ title: 'T'.repeat(500), company: 'C'.repeat(500), location: 'L'.repeat(500) }))).not.toThrow();
  });

  it('keeps a listing with no usable address by name, and takes the first usable address as the posting', () => {
    const odd = job({
      listings: [
        { sourceId: 'a', via: 'A board', url: 'javascript:alert(1)' },
        { sourceId: 'b', via: 'With a password', url: 'https://user:secret@example.com/jobs/1' },
        { sourceId: 'c', via: '  ', url: 'https://example.com/unnamed' },
        { sourceId: 'd', via: 'Example', url: 'https://example.com/jobs/1' },
      ],
    });
    expect(postingAddress(odd)).toBe('https://example.com/unnamed');
    expect(applicationFor(odd)?.job.listings).toEqual([{ via: 'A board' }, { via: 'With a password' }, { via: 'Example', url: 'https://example.com/jobs/1' }]);
    expect(() => tracked(odd)).not.toThrow();
  });

  it('keeps no more places than the tracker takes', () => {
    const many = job({ listings: Array.from({ length: LIMITS.listings + 5 }, (_, i) => ({ sourceId: `s${i}`, via: `Board ${i}`, url: `https://example.com/jobs/${i}` })) });
    expect(applicationFor(many)?.job.listings).toHaveLength(LIMITS.listings);
    expect(() => tracked(many)).not.toThrow();
  });

  it('cannot save a job with no title, no company or no address', () => {
    expect(applicationFor(job({ title: '  ' }))).toBeUndefined();
    expect(applicationFor(job({ company: '' }))).toBeUndefined();
    expect(applicationFor(job({ listings: [] }))).toBeUndefined();
    expect(applicationFor(job({ listings: [{ sourceId: 'x', via: 'X', url: 'not an address' }] }))).toBeUndefined();
  });
});

describe('the pay, in words', () => {
  it('is the posting’s own wording when it gave one', () => {
    expect(payText({ text: '  $60 to $70 an hour, depending on experience ', min: 60, max: 70 })).toBe('$60 to $70 an hour, depending on experience');
  });

  it('is written out from the numbers otherwise', () => {
    expect(payText({ min: 120_000, max: 150_000, currency: 'USD', period: 'year' })).toBe('$120,000 to $150,000 a year');
    expect(payText({ min: 55, period: 'hour' })).toBe('$55 an hour');
    expect(payText({ max: 9000, currency: 'EUR', period: 'month' })).toBe('€9,000 a month');
    expect(payText({ min: 100_000, max: 100_000 })).toBe('$100,000');
    // A currency the browser has no name for is given as the posting gave it.
    expect(payText({ min: 5000, currency: 'not a currency' })).toBe('5,000 not a currency');
  });

  it('is nothing when the posting says nothing', () => {
    expect(payText(undefined)).toBeUndefined();
    expect(payText({})).toBeUndefined();
    expect(payText({ text: '   ', currency: 'USD' })).toBeUndefined();
  });
});

describe('knowing that a job is tracked already', () => {
  const applications = [summarize(tracked(job()))];

  it('finds it by any place the job is listed, however the address is written', () => {
    expect(trackedAs(job(), applications)?.id).toBe('acme-technical-writer');
    // The same posting, reached through another board that lists the first one's address too.
    const viaOther = job({ listings: [{ sourceId: 'x', via: 'X', url: 'https://example.com/other' }, { sourceId: 'greenhouse', via: 'Acme', url: 'https://BOARDS.greenhouse.io/acme/jobs/1/?utm_source=x#apply' }] });
    expect(trackedAs(viaOther, applications)?.id).toBe('acme-technical-writer');
  });

  it('does not take another job for it', () => {
    expect(trackedAs(job({ listings: [{ sourceId: 'greenhouse', via: 'Acme', url: 'https://boards.greenhouse.io/acme/jobs/2' }] }), applications)).toBeUndefined();
    expect(trackedAs(job({ listings: [{ sourceId: 'x', via: 'X', url: 'not an address' }] }), applications)).toBeUndefined();
    expect(trackedAs(job(), [])).toBeUndefined();
  });
});
