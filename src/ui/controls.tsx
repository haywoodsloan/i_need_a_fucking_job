/**
 * The controls the search box, the results and the settings panel share.
 *
 * Search options are shown as labelled fields, lists and sections that fold away, never as a cloud of pills to
 * switch on and off (docs/decisions/0018-search-options-are-fields-and-lists-not-pills.md). Each control here is
 * built from a native button or checkbox, so the keyboard and a screen reader get it without extra work.
 */
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';

/** "1 job", "2 jobs", "1 company", "3 companies". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Closes something that floats over the page once the user turns away from it: a press or a focus anywhere outside
 * `inside`, or the Escape key.
 */
export function useDismiss(inside: RefObject<HTMLElement | null>, active: boolean, dismiss: (by: 'escape' | 'away') => void) {
  const latest = useRef(dismiss);
  useEffect(() => {
    latest.current = dismiss;
  });
  useEffect(() => {
    if (!active) return;
    const away = (e: Event) => {
      if (e.target instanceof Node && !inside.current?.contains(e.target)) latest.current('away');
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape closes what is on top and nothing behind it, so it is caught before anything else hears it.
      e.stopPropagation();
      latest.current('escape');
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('focusin', away);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('focusin', away);
      document.removeEventListener('keydown', key, true);
    };
  }, [inside, active]);
}

/**
 * A field that holds any number of choices from a short list. It looks like the dropdowns next to it and says what
 * is chosen. Pressing it opens the list, as checkboxes.
 */
export function MultiSelect<T extends string>(props: {
  label: string;
  /** What the field says while nothing is chosen. */
  empty: string;
  choices: readonly (readonly [value: T, label: string])[];
  chosen: readonly T[];
  /** Called with the new choices, in the order the list shows them. */
  onChange: (chosen: T[]) => void;
}) {
  const { label, empty, choices, chosen, onChange } = props;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const said = choices.filter(([value]) => chosen.includes(value)).map(([, text]) => text);

  useDismiss(root, open, (by) => {
    setOpen(false);
    if (by === 'escape') button.current?.focus();
  });

  const flip = (value: T) => onChange(choices.map(([v]) => v).filter((v) => (v === value) !== chosen.includes(v)));

  return (
    <div className="filter" ref={root}>
      <span className="filter-label" id={`${id}-label`}>
        {label}
      </span>
      <button
        type="button"
        ref={button}
        className="control dropdown"
        aria-expanded={open}
        aria-controls={open ? `${id}-choices` : undefined}
        aria-labelledby={`${id}-label ${id}-value`}
        onClick={() => setOpen(!open)}
      >
        <span id={`${id}-value`}>{said.join(', ') || empty}</span>
      </button>
      {open && (
        <div className="menu" id={`${id}-choices`} role="group" aria-labelledby={`${id}-label`}>
          {choices.map(([value, text]) => (
            <label key={value}>
              <input
                type="checkbox"
                checked={chosen.includes(value)}
                onChange={() => flip(value)}
                onKeyDown={(e) => {
                  // Enter picks, as it does in any list of choices. Left alone, it would send the form around this.
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  flip(value);
                }}
              />
              {text}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A part of a page that folds away under its heading. The heading stays, and says in a few words what is inside, so
 * a folded part still tells its state.
 */
export function Section(props: {
  title: string;
  /** A short mark after the title, like "Experimental". */
  badge?: string;
  /** What is chosen inside, in a few words. */
  summary: string;
  /** Colours the summary when it is a warning or a fault. */
  tone?: 'warn' | 'bad';
  open: boolean;
  onToggle: () => void;
  /** The level of its heading, where the page around it is not the settings panel. Left out: 3. */
  level?: 2 | 3;
  children: ReactNode;
}) {
  const { title, badge, summary, tone, open, onToggle, children } = props;
  const id = useId();
  const Heading = props.level === 2 ? 'h2' : 'h3';
  return (
    <section className="panel">
      <Heading>
        <button type="button" className="panel-head" aria-expanded={open} aria-controls={open ? id : undefined} onClick={onToggle}>
          <span className="panel-title">
            {title} {badge && <span className="badge">{badge}</span>}
          </span>{' '}
          <span className={`panel-summary${tone ? ` ${tone}` : ''}`}>{summary}</span>
          <Chevron />
        </button>
      </Heading>
      {open && (
        <div className="panel-body" id={id}>
          {children}
        </div>
      )}
    </section>
  );
}

/** Points down. The styles turn it over when what it belongs to is open. */
export function Chevron() {
  return (
    <svg className="chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
