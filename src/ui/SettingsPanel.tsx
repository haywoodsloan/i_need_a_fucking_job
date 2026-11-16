import { useEffect, useMemo, useState } from 'react';
import { BOARDS } from '../jobs/boards';
import { INDUSTRIES, PLATFORM_LABEL, companyById, customCompany, isCustomCompany, searchCatalog } from '../jobs/catalog';
import { fetchHealth, type ClientSettings, type Health } from '../jobs/client';

interface Props {
  settings: ClientSettings;
  setSettings: (s: ClientSettings) => void;
  onClose: () => void;
}

export function SettingsPanel({ settings, setSettings, onClose }: Props) {
  const set = (patch: Partial<ClientSettings>) => setSettings({ ...settings, ...patch });
  const toggle = (key: 'boards' | 'companies' | 'industries', id: string) => {
    const cur = new Set(settings[key]);
    if (cur.has(id)) cur.delete(id);
    else cur.add(id);
    set({ [key]: [...cur] });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Search settings" aria-modal="true">
        <header>
          <h2>Where to search</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </header>

        <section>
          <h3>Job boards</h3>
          <p>Ordered by how much each is used for roles paying about $50k a year or more.</p>
          <div className="board-list">
            {BOARDS.map((b) => (
              <label key={b.id}>
                <input type="checkbox" checked={settings.boards.includes(b.id)} onChange={() => toggle('boards', b.id)} />
                <span>
                  <div>{b.name}</div>
                  <div className="blurb">{b.blurb}</div>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section>
          <h3>
            Companies and industries <span className="badge">Experimental</span>
          </h3>
          <p>
            Search specific employers directly through the hiring system they use. Type any company: known ones are matched from the catalog,
            and others are looked up automatically.
          </p>
          <CompanyCombo selected={settings.companies} onAdd={(id) => !settings.companies.includes(id) && set({ companies: [...settings.companies, id] })} />
          <div className="chips">
            {settings.companies.map((id) => {
              const c = companyById(id);
              const name = c?.name ?? id.replace(/^custom:/, '');
              return (
                <span className="chip" key={id} title={c ? PLATFORM_LABEL[c.platform] : 'Looked up automatically'}>
                  {name}
                  <span className="muted small">{c ? PLATFORM_LABEL[c.platform].split(' ')[0] : 'auto'}</span>
                  <button className="x" aria-label={`Remove ${name}`} onClick={() => toggle('companies', id)}>
                    ✕
                  </button>
                </span>
              );
            })}
          </div>
          <p style={{ marginTop: 14 }}>Or include every catalog employer in an industry:</p>
          <div className="chips">
            {INDUSTRIES.map((i) => (
              <button key={i} className="chip" aria-pressed={settings.industries.includes(i)} onClick={() => toggle('industries', i)}>
                {i}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3>
            Direct site access <span className="badge">Experimental</span>
          </h3>
          <p>
            Also read LinkedIn's and Indeed's public, logged-out pages from the search server. This finds more listings, but those sites may
            block the server at any time. No account is ever used.
          </p>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={settings.allowScraping} onChange={(e) => set({ allowScraping: e.target.checked })} />
            Use direct site access when the server supports it
          </label>
        </section>

        <ServerSection apiUrl={settings.apiUrl} setApiUrl={(apiUrl) => set({ apiUrl })} />
      </aside>
    </>
  );
}

function CompanyCombo({ selected, onAdd }: { selected: string[]; onAdd: (id: string) => void }) {
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const options = useMemo(() => {
    const found = searchCatalog(text).filter((c) => !selected.includes(c.id));
    const opts: { id: string; name: string; hint: string }[] = found.map((c) => ({
      id: c.id,
      name: c.name,
      hint: `${c.industries[0]} · ${PLATFORM_LABEL[c.platform]}`,
    }));
    const typed = text.trim();
    if (typed.length >= 2 && !found.some((c) => c.name.toLowerCase() === typed.toLowerCase())) {
      opts.push({ id: customCompany(typed), name: `Add "${typed}"`, hint: 'look up automatically' });
    }
    return opts;
  }, [text, selected]);

  const pick = (id: string) => {
    onAdd(id);
    setText('');
    setOpen(false);
  };

  return (
    <div className="combo">
      <input
        role="combobox"
        aria-expanded={open && options.length > 0}
        aria-controls="company-options"
        aria-autocomplete="list"
        placeholder="Company or industry, e.g. Boeing, FAA, aviation"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(options.length - 1, a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === 'Enter' && options[active]) {
            e.preventDefault();
            pick(options[active].id);
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {open && options.length > 0 && (
        <ul id="company-options" role="listbox">
          {options.map((o, i) => (
            <li key={o.id} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onMouseDown={(e) => (e.preventDefault(), pick(o.id))}>
              <span>{o.name}</span>
              <span className="plat">{isCustomCompany(o.id) ? o.hint : o.hint}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ServerSection({ apiUrl, setApiUrl }: { apiUrl: string; setApiUrl: (s: string) => void }) {
  const [draft, setDraft] = useState(apiUrl);
  const [health, setHealth] = useState<Health | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setHealth(null);
    setErr(null);
    if (!apiUrl) return;
    let live = true;
    fetchHealth(apiUrl)
      .then((h) => live && setHealth(h))
      .catch((e) => live && setErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [apiUrl]);

  return (
    <section>
      <h3>Search server</h3>
      <p>LinkedIn, Indeed, Glassdoor, ZipRecruiter, Workday and USAJOBS results come through the search server. Without it, only a few company boards can be reached.</p>
      <div className="field-row">
        <input aria-label="Search server URL" placeholder="https://your-search-server.example" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button className="btn" onClick={() => setApiUrl(draft.trim())}>
          Save
        </button>
      </div>
      <div style={{ marginTop: 10 }}>
        {!apiUrl && <div className="notice">No search server set. Most job boards are unavailable until one is connected.</div>}
        {err && <div className="notice bad">Can't reach the server: {err}</div>}
        {health && (
          <div className="notice ok">
            Connected. Google for Jobs: {health.sources.googleJobs ?? 'no key set'} · USAJOBS: {health.sources.usajobs ? 'on' : 'no key set'} · LinkedIn
            pages: {health.sources.linkedinGuest ? 'on' : 'off'} · Indeed browser: {health.sources.playwright ? 'on' : 'off'}
          </div>
        )}
      </div>
    </section>
  );
}
