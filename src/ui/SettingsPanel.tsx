import { useEffect, useId, useMemo, useState } from 'react';
import { BOARDS } from '../jobs/boards';
import { INDUSTRIES, PLATFORM_LABEL, companyById, customCompany, searchCatalog } from '../jobs/catalog';
import { fetchHealth, type ClientSettings, type Health } from '../jobs/client';
import { Section, count } from './controls';
import { useStored } from './hooks';

interface Props {
  settings: ClientSettings;
  setSettings: (s: ClientSettings) => void;
  onClose: () => void;
}

type SectionId = 'boards' | 'companies' | 'direct' | 'server';

/** What the search server said when asked whether it is there. Nothing is asked while no server is set. */
type ServerCheck = { health: Health | null; error: string | null };

export function SettingsPanel({ settings, setSettings, onClose }: Props) {
  // Which sections are unfolded is kept, so the panel opens the way it was left. The job boards start unfolded.
  const [unfolded, setUnfolded] = useStored<SectionId[]>('settings-open:v1', ['boards']);
  const [check, setCheck] = useState<ServerCheck>({ health: null, error: null });
  const industriesId = useId();
  const set = (patch: Partial<ClientSettings>) => setSettings({ ...settings, ...patch });
  const toggle = (key: 'boards' | 'companies' | 'industries', id: string) => {
    const cur = new Set(settings[key]);
    if (cur.has(id)) cur.delete(id);
    else cur.add(id);
    set({ [key]: [...cur] });
  };
  const fold = (id: SectionId) => ({
    open: unfolded.includes(id),
    onToggle: () => setUnfolded(unfolded.includes(id) ? unfolded.filter((x) => x !== id) : [...unfolded, id]),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Asked here and not in the section, so that the section's heading can say how the server is while it is folded.
  const { apiUrl } = settings;
  useEffect(() => {
    setCheck({ health: null, error: null });
    if (!apiUrl) return;
    let live = true;
    fetchHealth(apiUrl)
      .then((health) => live && setCheck({ health, error: null }))
      .catch((e) => live && setCheck({ health: null, error: (e as Error).message }));
    return () => {
      live = false;
    };
  }, [apiUrl]);

  // What each section's heading says about what is chosen inside it.
  const some = (n: number, one: string, many: string) => (n ? [count(n, one, many)] : []);
  const boardsOn = BOARDS.filter((b) => settings.boards.includes(b.id)).length;
  const industriesOn = INDUSTRIES.filter((i) => settings.industries.includes(i)).length;
  const chosen = [...some(settings.companies.length, 'company', 'companies'), ...some(industriesOn, 'industry', 'industries')].join(', ') || 'None chosen';
  const server = !apiUrl
    ? ({ summary: 'Not set. Most job boards are unavailable.', tone: 'warn' } as const)
    : check.error
      ? ({ summary: "Can't reach the server", tone: 'bad' } as const)
      : { summary: check.health ? 'Connected' : 'Checking…' };

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

        <Section title="Job boards" summary={`${boardsOn} of ${BOARDS.length} selected`} {...fold('boards')}>
          <p>Ordered by how much each is used for roles paying about $50k a year or more.</p>
          <div className="options noted">
            {BOARDS.map((b) => (
              <label key={b.id} className="option">
                <input type="checkbox" checked={settings.boards.includes(b.id)} onChange={() => toggle('boards', b.id)} />
                <span className="option-name">{b.name}</span> <span className="option-note">{b.blurb}</span>
              </label>
            ))}
          </div>
        </Section>

        <Section title="Companies and industries" badge="Experimental" summary={chosen} {...fold('companies')}>
          <p>Search specific employers directly through the hiring system they use.</p>
          <h4>Companies</h4>
          <p>Type any company. Known ones are matched from the catalog, and others are looked up automatically.</p>
          <CompanyCombo selected={settings.companies} onAdd={(id) => !settings.companies.includes(id) && set({ companies: [...settings.companies, id] })} />
          {settings.companies.length > 0 && (
            <ul className="picked" aria-label="Companies to search">
              {settings.companies.map((id) => {
                const c = companyById(id);
                const name = c?.name ?? id.replace(/^custom:/, '');
                return (
                  <li key={id}>
                    <span className="picked-name">{name}</span>{' '}
                    <span className="picked-note">{c ? PLATFORM_LABEL[c.platform] : 'Looked up automatically'}</span>
                    <button type="button" className="btn ghost small" aria-label={`Remove ${name}`} onClick={() => toggle('companies', id)}>
                      ✕
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <h4 id={industriesId}>Industries</h4>
          <p>Include every catalog employer in an industry.</p>
          <div className="options two" role="group" aria-labelledby={industriesId}>
            {INDUSTRIES.map((i) => (
              <label key={i} className="option">
                <input type="checkbox" checked={settings.industries.includes(i)} onChange={() => toggle('industries', i)} />
                <span className="option-name">{i}</span>
              </label>
            ))}
          </div>
        </Section>

        <Section title="Direct site access" badge="Experimental" summary={settings.allowScraping ? 'On' : 'Off'} {...fold('direct')}>
          <p>
            Also read LinkedIn's and Indeed's public, logged-out pages from the search server. This finds more listings, but those sites may
            block the server at any time. No account is ever used.
          </p>
          <div className="options">
            <label className="option">
              <input type="checkbox" checked={settings.allowScraping} onChange={(e) => set({ allowScraping: e.target.checked })} />
              <span className="option-name">Use direct site access when the server supports it</span>
            </label>
          </div>
        </Section>

        <Section title="Search server" summary={server.summary} tone={server.tone} {...fold('server')}>
          <ServerFields apiUrl={apiUrl} setApiUrl={(url) => set({ apiUrl: url })} check={check} />
        </Section>
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
        className="control"
        role="combobox"
        aria-label="Add a company"
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
              <span className="plat">{o.hint}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ServerFields({ apiUrl, setApiUrl, check }: { apiUrl: string; setApiUrl: (s: string) => void; check: ServerCheck }) {
  const [draft, setDraft] = useState(apiUrl);
  const { health, error } = check;
  return (
    <>
      <p>LinkedIn, Indeed, Glassdoor, ZipRecruiter, Workday and USAJOBS results come through the search server. Without it, only a few company boards can be reached.</p>
      <div className="field-row">
        <input className="control" aria-label="Search server URL" placeholder="https://your-search-server.example" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button className="btn" onClick={() => setApiUrl(draft.trim())}>
          Save
        </button>
      </div>
      {!apiUrl && <div className="notice">No search server set. Most job boards are unavailable until one is connected.</div>}
      {error && <div className="notice bad">Can't reach the server: {error}</div>}
      {health && (
        <div className="notice ok">
          Connected. Google for Jobs: {health.sources.googleJobs ?? 'no key set'} · USAJOBS: {health.sources.usajobs ? 'on' : 'no key set'} · LinkedIn
          pages: {health.sources.linkedinGuest ? 'on' : 'off'} · Indeed browser: {health.sources.playwright ? 'on' : 'off'}
        </div>
      )}
    </>
  );
}
