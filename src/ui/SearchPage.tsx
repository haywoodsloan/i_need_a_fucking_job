import { useEffect, useMemo, useRef, useState } from 'react';
import { APP_NAME } from '../App';
import { DEFAULT_SETTINGS, fetchJobDetail, searchJobs, type ClientSettings } from '../jobs/client';
import type { JobPosting, JobQuery, SearchResponse, Workplace } from '../jobs/types';
import type { ParsedResume } from '../resume/model';
import { useStored } from './hooks';
import { sanitizeHtml, termsRegex, textToHtml } from './sanitize';
import { SettingsPanel } from './SettingsPanel';

const DISTANCES = [5, 10, 25, 50, 100];
const POSTED: [number | undefined, string][] = [
  [undefined, 'Any time'],
  [1, 'Past 24 hours'],
  [3, 'Past 3 days'],
  [7, 'Past week'],
  [30, 'Past month'],
];
const WORKPLACES: [Workplace, string][] = [
  ['remote', 'Remote'],
  ['hybrid', 'Hybrid'],
  ['onsite', 'On-site'],
];

export function SearchPage({ resume }: { resume: ParsedResume | null }) {
  const [settings, setSettings] = useStored<ClientSettings>('search-settings:v1', DEFAULT_SETTINGS);
  const [query, setQuery] = useStored<JobQuery>('last-query:v1', { role: '', distanceMiles: 25, workplace: [] });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const run = async () => {
    if (!query.role.trim()) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setLoading(true);
    setError(null);
    try {
      const r = await searchJobs({ ...query, role: query.role.trim() }, settings, ac.signal);
      if (ac.signal.aborted) return;
      setResult(r);
      setSelected(r.jobs[0]?.id ?? null);
    } catch (e) {
      if (!ac.signal.aborted) setError((e as Error).message);
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  };

  const bar = (
    <div className="search-row">
      <SearchBox query={query} setQuery={setQuery} onSubmit={run} loading={loading} />
      <button className="icon-btn" aria-label="Search settings" title="Where to search" onClick={() => setSettingsOpen(true)}>
        <GearIcon />
      </button>
    </div>
  );

  const drawer = settingsOpen && <SettingsPanel settings={settings} setSettings={setSettings} onClose={() => setSettingsOpen(false)} />;

  if (!result && !loading && !error) {
    return (
      <main className="search-home">
        <h1>{APP_NAME}</h1>
        {bar}
        {drawer}
      </main>
    );
  }

  return (
    <main className="results-page">
      <div className="results-head">
        {bar}
        {result && <SourceStrip result={result} />}
      </div>
      {error && <div className="empty">Search failed: {error}</div>}
      {loading && !result && <div className="empty">Searching…</div>}
      {result && (
        <Results result={result} selected={selected} setSelected={setSelected} resume={resume} apiUrl={settings.apiUrl} loading={loading} />
      )}
      {drawer}
    </main>
  );
}

function SearchBox(props: { query: JobQuery; setQuery: (q: JobQuery) => void; onSubmit: () => void; loading: boolean }) {
  const { query, setQuery, onSubmit, loading } = props;
  const expanded = query.role.length > 0;
  const remoteOnly = query.workplace?.length === 1 && query.workplace[0] === 'remote';
  const toggleWp = (w: Workplace) => {
    const cur = new Set(query.workplace ?? []);
    if (cur.has(w)) cur.delete(w);
    else cur.add(w);
    setQuery({ ...query, workplace: [...cur] });
  };
  return (
    <form
      className={`search-box${expanded ? ' expanded' : ''}`}
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="search-main">
        <SearchIcon />
        <input
          aria-label="Role"
          placeholder="What type of role are you looking for?"
          value={query.role}
          onChange={(e) => setQuery({ ...query, role: e.target.value })}
          autoFocus
        />
        {expanded && (
          <button className="btn primary small" type="submit" disabled={loading}>
            {loading ? 'Searching…' : 'Search'}
          </button>
        )}
      </div>
      {expanded && (
        <div className="search-extra">
          <label>
            Location
            <input
              placeholder={remoteOnly ? 'Anywhere' : 'City, state or ZIP'}
              value={query.location ?? ''}
              disabled={remoteOnly}
              onChange={(e) => setQuery({ ...query, location: e.target.value })}
            />
          </label>
          <label>
            Within
            <select
              value={query.distanceMiles ?? 25}
              disabled={remoteOnly || !query.location}
              onChange={(e) => setQuery({ ...query, distanceMiles: +e.target.value })}
            >
              {DISTANCES.map((d) => (
                <option key={d} value={d}>
                  {d} mi
                </option>
              ))}
            </select>
          </label>
          <div className="seg" role="group" aria-label="Workplace">
            {WORKPLACES.map(([w, label]) => (
              <button type="button" key={w} aria-pressed={!!query.workplace?.includes(w)} onClick={() => toggleWp(w)}>
                {label}
              </button>
            ))}
          </div>
          <label>
            <span className="sr-only">Posted</span>
            <select
              value={query.postedWithinDays ?? ''}
              onChange={(e) => setQuery({ ...query, postedWithinDays: e.target.value ? +e.target.value : undefined })}
            >
              {POSTED.map(([v, label]) => (
                <option key={label} value={v ?? ''}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </form>
  );
}

function SourceStrip({ result }: { result: SearchResponse }) {
  return (
    <div className="source-strip" aria-label="Sources searched">
      {result.sources.map((s) => (
        <span
          key={s.sourceId}
          className={`source-pill ${s.ok ? 'ok' : s.error ? 'err' : ''}`}
          title={s.error ?? s.skipped ?? `${s.count} jobs in ${s.ms} ms`}
        >
          {s.label}: {s.ok ? s.count : s.error ? 'error' : 'off'}
        </span>
      ))}
    </div>
  );
}

function Results(props: {
  result: SearchResponse;
  selected: string | null;
  setSelected: (id: string | null) => void;
  resume: ParsedResume | null;
  apiUrl: string;
  loading: boolean;
}) {
  const { result, selected, setSelected, resume, apiUrl, loading } = props;
  const job = result.jobs.find((j) => j.id === selected);
  if (!result.jobs.length) {
    const skipped = result.sources.filter((s) => s.skipped);
    return (
      <div className="empty">
        No jobs found{loading ? ' yet' : ''}.
        {skipped.length > 0 && (
          <p className="small">
            {skipped.length} source{skipped.length > 1 ? 's were' : ' was'} skipped: {skipped.map((s) => `${s.label} (${s.skipped})`).join('; ')}.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="results-body">
      <div className="job-list" role="listbox" aria-label={`${result.jobs.length} jobs`}>
        <div className="small muted">{result.jobs.length} jobs</div>
        {result.jobs.map((j) => (
          <button key={j.id} className="job-card" role="option" aria-selected={j.id === selected} onClick={() => setSelected(j.id)}>
            {j.companyLogo ? <img className="logo" src={j.companyLogo} alt="" loading="lazy" /> : <span className="logo">{j.company[0]}</span>}
            <span>
              <div className="title">{j.title}</div>
              <div className="meta">
                {j.company}
                {j.location ? ` · ${j.location}` : ''}
              </div>
              <div className="meta">{[workplaceLabel(j), salaryLabel(j), ago(j.postedAt)].filter(Boolean).join(' · ')}</div>
              <div className="vias">on {j.listings.map((l) => l.via).join(', ')}</div>
            </span>
          </button>
        ))}
      </div>
      {job && <JobDetail key={job.id} job={job} resume={resume} apiUrl={apiUrl} onClose={() => setSelected(null)} />}
    </div>
  );
}

function JobDetail({ job, resume, apiUrl, onClose }: { job: JobPosting; resume: ParsedResume | null; apiUrl: string; onClose: () => void }) {
  const [extra, setExtra] = useState<Partial<JobPosting> | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  useEffect(() => {
    if (!job.descriptionPartial || !apiUrl) return;
    let live = true;
    fetchJobDetail(job.id, apiUrl)
      .then((d) => live && setExtra(d))
      .catch((e) => live && setDetailError((e as Error).message));
    return () => {
      live = false;
    };
  }, [job.id, job.descriptionPartial, apiUrl]);

  const skills = useMemo(() => {
    if (!resume) return [];
    // "AWS (Lambda, SQS)" should match "AWS", "Lambda" and "SQS" in a posting.
    return resume.skills
      .flatMap((g) => g.items.filter((i) => i.status !== 'rejected').map((i) => i.value))
      .flatMap((v) => (/[()]/.test(v) ? v.split(/[(),]/) : [v]))
      .map((v) => v.trim())
      .filter(Boolean);
  }, [resume]);
  const re = useMemo(() => termsRegex(skills), [skills]);
  const html = extra?.descriptionHtml ?? job.descriptionHtml;
  const text = extra?.descriptionText ?? job.descriptionText;
  const body = useMemo(() => (html ? sanitizeHtml(html, re) : text ? textToHtml(text, re) : ''), [html, text, re]);
  const matched = useMemo(() => {
    if (!re) return [];
    const plain = (text ?? html ?? '').toLowerCase();
    return skills.filter((s) => termsRegex([s])!.test(plain));
  }, [re, skills, text, html]);

  return (
    <article className="job-detail open" aria-label={job.title}>
      <button className="btn ghost small" onClick={onClose} style={{ float: 'right' }} aria-label="Close">
        ✕
      </button>
      <h2>{job.title}</h2>
      <div className="facts">
        <strong>{job.company}</strong>
        {job.location && <span>{job.location}</span>}
        {workplaceLabel(job) && <span>{workplaceLabel(job)}</span>}
        {(extra?.employmentType ?? job.employmentType) && <span>{extra?.employmentType ?? job.employmentType}</span>}
        {salaryLabel(job) && <span>{salaryLabel(job)}</span>}
        {job.postedAt && <span>Posted {ago(job.postedAt)}</span>}
      </div>
      {resume && skills.length > 0 && (
        <p className="small">
          {matched.length ? (
            <>
              <strong>{matched.length}</strong> of your resume skills appear in this posting (highlighted).
            </>
          ) : (
            <span className="muted">None of your resume skills appear in this posting by name.</span>
          )}
        </p>
      )}
      {body ? <div className="desc" dangerouslySetInnerHTML={{ __html: body }} /> : <p className="muted">No description provided by this source.</p>}
      {job.descriptionPartial && !extra && (
        <p className="small muted">{apiUrl ? (detailError ? `Couldn't load the full description: ${detailError}` : 'Loading full description…') : 'Showing a summary. Connect the search server to load full descriptions.'}</p>
      )}
      <div className="listed">
        <div className="muted">Also listed on</div>
        {job.listings.map((l) => (
          <div key={l.via + l.url}>
            {l.via}{' '}
            <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="small">
              original posting
            </a>
          </div>
        ))}
      </div>
    </article>
  );
}

function workplaceLabel(j: JobPosting) {
  return j.workplace ? { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' }[j.workplace] : '';
}

function salaryLabel(j: JobPosting) {
  const s = j.salary;
  if (!s) return '';
  if (s.min || s.max) {
    const fmt = (n: number) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`);
    const range = s.min && s.max && s.min !== s.max ? `${fmt(s.min)}–${fmt(s.max)}` : fmt((s.min ?? s.max)!);
    return `${range}${s.period && s.period !== 'year' ? `/${s.period}` : ''}`;
  }
  return s.text ?? '';
}

function ago(iso?: string) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  return `${Math.floor(days / 30)} mo ago`;
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ color: 'var(--muted)', flex: 'none' }}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}
