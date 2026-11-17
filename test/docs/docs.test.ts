/**
 * Keeps the documentation pointing at things that exist.
 *
 * Most of the work here is done by agents that start with no memory and believe what they read. A doc that names a
 * file, a heading or a command that is gone sends the next one the wrong way. So this reads AGENTS.md, the root
 * README and everything in docs/, and fails when a pointer is dead. docs/README.md, "What the test checks", lists the
 * rules for people.
 *
 * It cannot tell whether a sentence is true. It only catches a pointer that leads nowhere.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Folders that running the app or its tools makes. They are not part of the repository, so they are not read. */
const NOT_READ = new Set(['.git', 'node_modules', 'dist', 'coverage', '.data']);

/** Paths a doc may name although they are not in the repository: they appear on a machine that runs the app. */
const MADE_ON_A_MACHINE = ['dist', 'coverage', 'node_modules', 'server/.env', 'server/.data', 'server/tiers.local.mjs'];

/** Every file and folder in the repository, as a path from the root with forward slashes. */
function everythingUnder(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (NOT_READ.has(entry.name)) continue;
    const path = join(dir, entry.name);
    found.push(relative(ROOT, path).split(sep).join('/'));
    if (entry.isDirectory()) everythingUnder(path, found);
  }
  return found;
}

const REPO = everythingUnder(ROOT);
const IN_REPO = new Set(REPO);
const TOP_LEVEL = new Set(REPO.filter((path) => !path.includes('/')));

const read = (path: string) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');

const DOCS = ['AGENTS.md', 'README.md', ...REPO.filter((path) => path.startsWith('docs/') && path.endsWith('.md'))].sort();
const RECORDS = DOCS.filter((doc) => /^docs\/decisions\/\d{4}-/.test(doc) && !doc.endsWith('0000-template.md'));

const scriptsOf = (path: string) => Object.keys((JSON.parse(read(path)) as { scripts: Record<string, string> }).scripts);
const SCRIPTS = new Set([...scriptsOf('package.json'), ...scriptsOf('server/package.json')]);

// ---------------------------------------------------------------------------------------------------------------
// Reading markdown
// ---------------------------------------------------------------------------------------------------------------

const withoutComments = (markdown: string) => markdown.replace(/<!--[\s\S]*?-->/g, '');

/** The text outside fenced code blocks, where a `#` starts a heading and `[a](b)` is a link. */
const prose = (markdown: string) => withoutComments(markdown).replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, '');

const codeSpans = (markdown: string) => [...prose(markdown).matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);

interface Link {
  text: string;
  target: string;
}

function linksIn(markdown: string): Link[] {
  // Linking is what a doc does outside of code. `[a](b)` in backticks is an example of a link, not one.
  const outsideCode = prose(markdown).replace(/`[^`\n]+`/g, '');
  return [...outsideCode.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)].map((m) => ({ text: m[1], target: m[2] }));
}

const headingsIn = (markdown: string, level = '#{1,6}') =>
  [...prose(markdown).matchAll(new RegExp(`^(${level}) +(.+?) *$`, 'gm'))].map((m) => m[2]);

/** The address GitHub gives a heading: `## 4.6 As built in Step 0` is `#46-as-built-in-step-0`. */
function anchorOf(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Every anchor a file offers. A heading that repeats gets `-1`, `-2` and so on, as on GitHub. */
function anchorsIn(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  for (const heading of headingsIn(markdown)) {
    const anchor = anchorOf(heading);
    const count = seen.get(anchor) ?? 0;
    seen.set(anchor, count + 1);
    anchors.add(count ? `${anchor}-${count}` : anchor);
  }
  return anchors;
}

/** One section of a doc: from its `## Heading` to the next heading of that level, or the end. */
function section(markdown: string, heading: string): string {
  const from = markdown.indexOf(`\n## ${heading}\n`);
  if (from < 0) return '';
  const to = markdown.indexOf('\n## ', from + 1);
  return markdown.slice(from, to < 0 ? undefined : to);
}

// ---------------------------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------------------------

/** Links that lead to a file that is not there, or to a heading that is not in it. Web links are not followed. */
function deadLinks(doc: string, markdown: string): string[] {
  const problems: string[] = [];
  for (const { text, target } of linksIn(markdown)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const [path, anchor] = target.split('#') as [string, string | undefined];
    // No path means a heading in this same doc.
    const file = path ? posix.normalize(posix.join(posix.dirname(doc), path)).replace(/\/$/, '') : doc;
    const shown = `[${text}](${target})`;
    if (path && !IN_REPO.has(file)) {
      problems.push(`${doc}: ${shown} points at ${file}, which does not exist`);
    } else if (anchor !== undefined && file.endsWith('.md') && !anchorsIn(path ? read(file) : markdown).has(anchor)) {
      problems.push(`${doc}: ${shown} points at a heading that is not in ${file}`);
    }
  }
  return problems;
}

const KNOWN_KIND_OF_FILE = /\.(ts|tsx|mjs|json|md|yml|toml|html|css|txt)$/;

/**
 * Is this piece of code a path that should exist, and does not?
 *
 * Only what is clearly a path is judged: `server/src/app.ts`, `accounts/`, `aggregate.test.ts`. A pattern
 * (`src/**`), a placeholder (`test/server/<name>.test.ts`), a route on the server (`/api/search`), a setting or a
 * command is left alone. To name something that does not exist yet, put a `<placeholder>` in it.
 */
function isMissingPath(code: string): boolean {
  if (!/^[\w.\-/\\]+$/.test(code) || /^(\/|\.\.?\/)/.test(code)) return false;
  const path = code.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!path) return false;
  const isFolder = /[/\\]$/.test(code);
  const anywhere = [...REPO, ...MADE_ON_A_MACHINE];
  const existsSomewhere = () => anywhere.some((known) => known === path || known.endsWith(`/${path}`));
  if (MADE_ON_A_MACHINE.some((made) => path === made || path.startsWith(`${made}/`))) return false;
  // From the root: it has to be exactly there.
  if (path.includes('/') && TOP_LEVEL.has(path.split('/')[0])) return !IN_REPO.has(path);
  // A folder, or a file by its name alone (`accounts/`, `adapters/ats.ts`, `parse.ts`): it has to be somewhere.
  if (isFolder || (KNOWN_KIND_OF_FILE.test(path) && /^\w/.test(path))) return !existsSomewhere();
  return false;
}

function deadPaths(doc: string, markdown: string): string[] {
  return [...new Set(codeSpans(markdown))]
    .filter(isMissingPath)
    .map((code) => `${doc}: \`${code}\` is not in the repository. Fix the path, or write a <placeholder> into it if it is an example.`);
}

function deadCommands(doc: string, markdown: string): string[] {
  const named = [...withoutComments(markdown).matchAll(/npm run\s+([a-z][\w:-]*)/g)].map((m) => m[1]);
  return [...new Set(named)]
    .filter((script) => !SCRIPTS.has(script))
    .map((script) => `${doc}: "npm run ${script}" names a script that is in neither package.json nor server/package.json`);
}

/**
 * The part of a doc whose paths and commands must exist today.
 *
 * History is exempt: a work log entry and the body of a decision say what was true on their day, and are not
 * rewritten when a file moves. A plan is exempt because it names what is still to come. Their links are checked
 * like any others, and so is "In the code" at the end of a decision, which is kept pointing at where it lives now.
 */
function whatMustExistToday(doc: string, markdown: string): string {
  if (doc === 'docs/worklog.md' || doc === 'docs/applications-plan.md' || doc.endsWith('0000-template.md')) return '';
  if (RECORDS.includes(doc)) return section(markdown, 'In the code');
  return markdown;
}

const allProblems = (check: (doc: string, markdown: string) => string[]) => DOCS.flatMap((doc) => check(doc, read(doc)));

// ---------------------------------------------------------------------------------------------------------------

describe('the docs point at things that exist', () => {
  it('finds the docs, and enough in them to be worth checking', () => {
    expect(DOCS).toEqual(expect.arrayContaining(['AGENTS.md', 'README.md', 'docs/README.md', 'docs/status.md', 'docs/worklog.md']));
    expect(RECORDS.length).toBeGreaterThan(10);
    // A check that reads nothing passes every time. These fail if the reading of markdown ever breaks.
    expect(DOCS.flatMap((doc) => linksIn(read(doc))).length).toBeGreaterThan(100);
    expect(DOCS.flatMap((doc) => codeSpans(read(doc))).length).toBeGreaterThan(300);
  });

  it('every link leads to a file that exists, and to a heading that is in it', () => {
    expect(allProblems(deadLinks)).toEqual([]);
  });

  it('every path in backticks exists', () => {
    expect(allProblems((doc, markdown) => deadPaths(doc, whatMustExistToday(doc, markdown)))).toEqual([]);
  });

  it('every "npm run" names a script that exists', () => {
    expect(allProblems((doc, markdown) => deadCommands(doc, whatMustExistToday(doc, markdown)))).toEqual([]);
  });

  it('a doc with a Contents line lists every one of its sections there', () => {
    const problems = DOCS.flatMap((doc) => {
      const markdown = read(doc);
      const contents = /^Contents: [\s\S]*?(?=\n\n)/m.exec(prose(markdown))?.[0];
      if (!contents) return [];
      const listed = new Set(linksIn(contents).map((link) => link.target.replace(/^#/, '')));
      return headingsIn(markdown, '##')
        .filter((heading) => !listed.has(anchorOf(heading)))
        .map((heading) => `${doc}: the Contents line leaves out "${heading}"`);
    });
    expect(problems).toEqual([]);
  });
});

describe('the entry point', () => {
  it('AGENTS.md stays short enough to be read in full at the start of every session', () => {
    // When this fails, move a detail out into docs/ and link to it. Do not raise the number.
    expect(read('AGENTS.md').trimEnd().split('\n').length).toBeLessThanOrEqual(120);
  });

  it('CLAUDE.md loads AGENTS.md and holds nothing of its own', () => {
    expect(read('CLAUDE.md').trim()).toBe('@AGENTS.md');
  });

  it('docs/README.md lists every doc', () => {
    const listed = new Set(linksIn(read('docs/README.md')).map((link) => posix.normalize(posix.join('docs', link.target.split('#')[0]))));
    const expected = DOCS.filter((doc) => /^docs\/[^/]+\.md$/.test(doc) && doc !== 'docs/README.md');
    expect(expected.filter((doc) => !listed.has(doc))).toEqual([]);
    expect([...listed]).toEqual(expect.arrayContaining(['AGENTS.md', 'README.md', 'docs/decisions/README.md']));
  });
});

describe('the decision records', () => {
  const INDEX = 'docs/decisions/README.md';
  const numberOf = (doc: string) => posix.basename(doc).slice(0, 4);

  it('are numbered from 0001 without a gap, and named in lower case with dashes', () => {
    expect(RECORDS.map(numberOf)).toEqual(RECORDS.map((_, i) => String(i + 1).padStart(4, '0')));
    for (const doc of RECORDS) expect(posix.basename(doc)).toMatch(/^\d{4}(-[a-z0-9]+)+\.md$/);
  });

  it.each(RECORDS)('%s has its title, status, date, who decided, and the four sections', (doc) => {
    const markdown = read(doc);
    expect(markdown.split('\n')[0]).toMatch(new RegExp(`^# ${numberOf(doc)}\\. \\S`));
    expect(markdown).toMatch(/^- \*\*Status:\*\* (Accepted|Replaced by \[\d{4}\]\(\d{4}-[a-z0-9-]+\.md\))$/m);
    expect(markdown).toMatch(/^- \*\*Date:\*\* \d{4}-\d{2}-\d{2}( \(.+\))?$/m);
    expect(markdown).toMatch(/^- \*\*Decided by:\*\* \S/m);
    expect(headingsIn(markdown, '##')).toEqual(['Context', 'Decision', 'Consequences', 'In the code']);
  });

  it('are all in the index, in order, under the title and date they carry', () => {
    const rows = [...read(INDEX).matchAll(/^\| \[(\d{4})\]\(([^)]+)\) \| (.+?) \| (\d{4}-\d{2}-\d{2}) \| .+ \|$/gm)].map((m) => ({
      doc: `docs/decisions/${m[2]}`,
      title: m[3],
      date: m[4],
    }));
    const records = RECORDS.map((doc) => {
      const markdown = read(doc);
      return { doc, title: markdown.split('\n')[0].replace(/^# \d{4}\. /, ''), date: /\*\*Date:\*\* (\S+)/.exec(markdown)?.[1] };
    });
    expect(rows).toEqual(records);
  });
});

describe('the work log and the status page', () => {
  const entryDates = () => headingsIn(read('docs/worklog.md'), '##').map((heading) => /^(\d{4}-\d{2}-\d{2}): \S/.exec(heading)?.[1]);

  it('every entry in the work log starts with its date, newest first', () => {
    const dates = entryDates();
    expect(dates.length).toBeGreaterThan(0);
    expect(dates).not.toContain(undefined);
    for (const date of dates) expect(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(date);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('the status page has the sections other docs link to', () => {
    expect(headingsIn(read('docs/status.md'), '##')).toEqual(expect.arrayContaining(['Built', 'Next', 'Waiting on Sloan', 'Known gaps']));
  });

  it('the status page is at least as new as the newest entry in the work log', () => {
    // When this fails: read docs/status.md through, make it true again, and set its date.
    const updated = /^\*\*Last updated: (\d{4}-\d{2}-\d{2})\.\*\*$/m.exec(read('docs/status.md'))?.[1];
    const newest = entryDates()[0]!;
    expect(updated, 'docs/status.md needs a line "**Last updated: YYYY-MM-DD.**"').toBeDefined();
    expect(updated! >= newest, `docs/status.md was last updated ${updated}, and the work log has an entry from ${newest}`).toBe(true);
  });
});

/** The checks are code too. These make sure they can fail. */
describe('the checks themselves', () => {
  it('give a heading the address GitHub gives it', () => {
    expect(anchorOf('Waiting on Sloan')).toBe('waiting-on-sloan');
    expect(anchorOf('4.6 As built in Step 0')).toBe('46-as-built-in-step-0');
    expect(anchorOf('`src/jobs/`: job search (browser and server)')).toBe('srcjobs-job-search-browser-and-server');
    expect(anchorOf('"The database is in use"')).toBe('the-database-is-in-use');
    expect([...anchorsIn('# A\n\n## Same\n\n## Same\n')]).toEqual(['a', 'same', 'same-1']);
  });

  it('do not take what is inside a code block for a heading or a link', () => {
    const markdown = '# Title\n\n```bash\n# not a heading\n[a](nowhere.md)\n```\n\n`[b](nowhere.md)` <!-- [c](nowhere.md) -->\n';
    expect(headingsIn(markdown)).toEqual(['Title']);
    expect(linksIn(markdown)).toEqual([]);
  });

  it('find a link to a missing file and a link to a missing heading, and leave web links alone', () => {
    const markdown = '# Here\n\n[a](nowhere.md) [b](status.md#nowhere) [c](#nowhere) [d](#here) [e](status.md#built) [f](https://example.com/x#y)';
    expect(deadLinks('docs/sample.md', markdown)).toEqual([
      'docs/sample.md: [a](nowhere.md) points at docs/nowhere.md, which does not exist',
      'docs/sample.md: [b](status.md#nowhere) points at a heading that is not in docs/status.md',
      'docs/sample.md: [c](#nowhere) points at a heading that is not in docs/sample.md',
    ]);
  });

  it('find a path that is not there, by its full path, its folder or its name alone', () => {
    const missing = ['src/jobs/nowhere.ts', 'server/src/nowhere/', 'nowhere/', 'nowhere.test.ts', 'adapters/nowhere.ts', 'docs\\nowhere.md'];
    expect(missing.filter((code) => !isMissingPath(code))).toEqual([]);
  });

  it('accept a path that is there, and what is made on a machine that runs the app', () => {
    const there = ['src/jobs/aggregate.ts', 'server/src/accounts/', 'accounts/', 'adapters/ats.ts', 'aggregate.test.ts', 'AGENTS.md', 'docs'];
    const made = ['server/.env', 'server\\.env', 'server/.data/pg.lock', 'dist/', 'coverage/index.html', 'tiers.local.mjs'];
    expect([...there, ...made].filter(isMissingPath)).toEqual([]);
  });

  it('leave alone what is not a path: patterns, placeholders, routes, settings, commands', () => {
    const notPaths = ['src/**/*.test.ts', 'test/server/<name>.test.ts', '/api/search', './tiers.local.mjs', 'npm run nowhere', 'text/html'];
    expect([...notPaths, 'AUTH_PEPPER', 'resume:v1', 'localStorage', '.env', 'pdf.js', 'v1.2'].filter(isMissingPath)).toEqual([]);
  });

  it('find a command that names no script', () => {
    expect(deadCommands('docs/sample.md', 'Run `npm run nowhere`, then `npm run check` and `npm run smoke --prefix server`.')).toEqual([
      'docs/sample.md: "npm run nowhere" names a script that is in neither package.json nor server/package.json',
    ]);
  });

  it('check a decision and the work log for dead links only, except "In the code"', () => {
    const record = '# 0001. Title\n\n## Context\n\n`src/gone.ts` was there then.\n\n## In the code\n\n- `src/gone.ts`\n';
    expect(deadPaths(RECORDS[0], whatMustExistToday(RECORDS[0], record))).toHaveLength(1);
    expect(whatMustExistToday(RECORDS[0], record)).not.toContain('was there then');
    expect(whatMustExistToday('docs/worklog.md', '`src/gone.ts`')).toBe('');
    expect(whatMustExistToday('docs/testing.md', '`src/gone.ts`')).toBe('`src/gone.ts`');
  });
});
