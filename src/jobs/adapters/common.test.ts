/** The helpers every job source shares. Filtering by role words and reading a typed place are also covered in jobs.test.ts. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../types';
import { BlockedError, SourceError, decodeHtml, getJson, guessWorkplace, htmlToText, iso, matchesQuery, normalizePeriod, parsePlace } from './common';

afterEach(() => {
  vi.useRealTimers();
});

describe('asking a job source for JSON', () => {
  it('returns the answer, and lets the search be cancelled', async () => {
    const asked: (RequestInit | undefined)[] = [];
    const fetch: FetchLike = async (_url, init) => {
      asked.push(init);
      return Response.json({ jobs: [1, 2] });
    };
    const cancel = new AbortController();
    expect(await getJson({ fetch, env: {}, signal: cancel.signal }, 'https://api.example.com/jobs', { headers: { Accept: 'application/json' } })).toEqual({ jobs: [1, 2] });
    expect(asked[0]).toEqual({ headers: { Accept: 'application/json' }, signal: cancel.signal });
  });

  it('fails with the name of the service and the status it answered', async () => {
    const fetch: FetchLike = async () => new Response('slow down', { status: 429 });
    const failure = await getJson({ fetch, env: {} }, 'https://api.example.com/jobs?key=secret').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SourceError);
    expect(failure).toMatchObject({ message: 'api.example.com answered 429', status: 429 });
    // The address can carry a key. It is not part of what is reported.
    expect((failure as Error).message).not.toContain('secret');
  });
});

describe('a site turning the server away', () => {
  it('is its own kind of failure, naming the site and the status', () => {
    const blocked = new BlockedError('www.linkedin.com', 999);
    expect(blocked).toBeInstanceOf(SourceError);
    expect(blocked).toMatchObject({ host: 'www.linkedin.com', status: 999, message: 'www.linkedin.com turned this server away as automated traffic (999)' });
    expect(new BlockedError('example.com').message).toBe('example.com turned this server away as automated traffic');
  });
});

describe('the plain text of a description', () => {
  it('keeps the words, one line per paragraph and one bullet per list item', () => {
    const html = '<h2>About the role</h2><p>You will <b>plan</b> routes.</p><ul><li>Fly planes</li><li>Train pilots</li></ul><div>Apply<br>today</div>';
    expect(htmlToText(html)).toBe('About the role\nYou will plan routes.\n\n• Fly planes\n\n• Train pilots\n\nApply\ntoday');
  });

  it('drops scripts and styles together with what is inside them', () => {
    expect(htmlToText('<style>p { color: red }</style><p>Hello</p><script>alert("x")</script>')).toBe('Hello');
  });

  it('turns character codes into characters and squeezes runs of spaces and empty lines', () => {
    expect(htmlToText('<p>R&amp;D   &nbsp;lead</p><p></p><p></p><p></p><p>caf&#233; &#x2014; bar</p>')).toBe('R&D lead\n\ncafé — bar');
  });

  it('decodes character codes once, so text that spells a code stays text', () => {
    expect(decodeHtml('&lt;b&gt; &quot;x&quot; &#39;y&#39; &apos;z&apos; &amp;')).toBe('<b> "x" \'y\' \'z\' &');
    expect(decodeHtml('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
    expect(decodeHtml('&#128640; &#x1F680;')).toBe('🚀 🚀');
  });
});

describe('guessing where the work is done', () => {
  it.each([
    [['Remote'], 'remote'],
    [['Austin, TX', 'Work from home'], 'remote'],
    [['WFH - US'], 'remote'],
    [['Anywhere in the US'], 'remote'],
    [['Hybrid (Austin, TX)'], 'hybrid'],
    // A posting that says both is a hybrid one: it has an office to come to.
    [['Remote', 'Hybrid'], 'hybrid'],
    [['On-site'], 'onsite'],
    [['Onsite, Dallas'], 'onsite'],
    [['In-office 5 days'], 'onsite'],
    [['Austin, TX'], undefined],
    [['Remoteness Analyst'], undefined],
    [[undefined, null, ''], undefined],
  ] as const)('%j is %s', (hints, expected) => {
    expect(guessWorkplace(...hints)).toBe(expected);
  });
});

describe('the period a salary is paid for', () => {
  it.each([
    ['hour', 'hour'],
    ['HOURLY', 'hour'],
    ['PH', 'hour'],
    ['per hour', 'hour'],
    ['day', 'day'],
    ['daily', 'day'],
    ['week', 'week'],
    ['Weekly', 'week'],
    ['month', 'month'],
    ['MONTHLY', 'month'],
    ['year', 'year'],
    ['yearly', 'year'],
    ['annual', 'year'],
    ['PA', 'year'],
    ['per year', 'year'],
    ['one-time', undefined],
    ['', undefined],
    [undefined, undefined],
    [null, undefined],
  ] as const)('%j is %s', (text, expected) => {
    expect(normalizePeriod(text)).toBe(expected);
  });
});

describe('a time as a job source gives it', () => {
  it('becomes an ISO date, whether it came as text, seconds or milliseconds', () => {
    expect(iso('2026-11-16T12:00:00Z')).toBe('2026-11-16T12:00:00.000Z');
    expect(iso(1_763_294_400)).toBe('2025-11-16T12:00:00.000Z');
    expect(iso(1_763_294_400_000)).toBe('2025-11-16T12:00:00.000Z');
  });

  it('is left out when there is none or it cannot be read', () => {
    expect(iso(undefined)).toBeUndefined();
    expect(iso(null)).toBeUndefined();
    expect(iso('')).toBeUndefined();
    expect(iso('next Tuesday')).toBeUndefined();
  });
});

describe('a place as typed', () => {
  it('keeps a hyphenated or many-word city, and reads only the first part after the comma as the state', () => {
    expect(parsePlace('winston-salem, nc')).toEqual({ city: 'Winston-Salem', stateCode: 'NC', stateName: 'North Carolina' });
    expect(parsePlace('salt   lake city,UT, USA')).toEqual({ city: 'Salt Lake City', stateCode: 'UT', stateName: 'Utah' });
  });

  it('does not take the last word of a city for a state', () => {
    expect(parsePlace('Fond du Lac')).toEqual({ city: 'Fond Du Lac' });
    expect(parsePlace('Remote')).toEqual({ city: 'Remote' });
  });
});

describe('keeping only the postings a search asked for', () => {
  const job = { title: 'Software Engineer', location: 'Austin, TX', workplace: 'onsite' as const, postedAt: '2026-11-10T12:00:00Z' };

  it('drops postings older than the search allows, and keeps those with no date', () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-17T12:00:00Z') });
    expect(matchesQuery(job, { role: 'engineer', postedWithinDays: 7 })).toBe(true);
    expect(matchesQuery(job, { role: 'engineer', postedWithinDays: 3 })).toBe(false);
    expect(matchesQuery({ ...job, postedAt: undefined }, { role: 'engineer', postedWithinDays: 3 })).toBe(true);
  });

  it('keeps remote postings whatever place was typed', () => {
    expect(matchesQuery({ ...job, location: 'Remote (US)', workplace: 'remote' }, { role: 'engineer', location: 'Denver, CO' })).toBe(true);
    expect(matchesQuery({ ...job, location: 'Remote - United States', workplace: undefined }, { role: 'engineer', location: 'Denver, CO' })).toBe(true);
    // A posting that does not say where it is cannot be ruled out by place.
    expect(matchesQuery({ ...job, location: undefined }, { role: 'engineer', location: 'Denver, CO' })).toBe(true);
  });

  it('does not filter by place at all in a remote-only search', () => {
    expect(matchesQuery({ ...job, workplace: undefined }, { role: 'engineer', location: 'Denver, CO', workplace: ['remote'] })).toBe(true);
    expect(matchesQuery({ ...job, workplace: undefined }, { role: 'engineer', location: 'Denver, CO', workplace: ['remote', 'hybrid'] })).toBe(false);
  });

  it('keeps a posting that does not say how the work is done, whatever kinds were asked for', () => {
    expect(matchesQuery({ ...job, workplace: undefined }, { role: 'engineer', workplace: ['hybrid'] })).toBe(true);
    expect(matchesQuery(job, { role: 'engineer', workplace: ['hybrid', 'onsite'] })).toBe(true);
  });

  it('keeps everything when no role was typed, or only filler words', () => {
    expect(matchesQuery(job, { role: '' })).toBe(true);
    expect(matchesQuery(job, { role: 'of the' })).toBe(true);
  });
});
