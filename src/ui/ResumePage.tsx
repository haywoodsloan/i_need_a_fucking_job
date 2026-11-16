import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deleteFile, getFile, putFile } from '../lib/storage';
import { ACCEPTED, fileToSource, loadPdfjs } from '../resume/load';
import {
  checkIntegrity,
  listFields,
  reviewStats,
  sourceCoverage,
  textOfSpans,
  toApplicationProfile,
  updateField,
  type Field,
  type FieldRef,
  type ParsedResume,
  type Span,
} from '../resume/model';
import { parseResume } from '../resume/parse';

interface Props {
  resume: ParsedResume | null;
  setResume: (r: ParsedResume | null) => void;
}

export function ResumePage({ resume, setResume }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const { source, bytes } = await fileToSource(file);
      if (resume) await deleteFile(resume.source.sha256);
      await putFile(source.sha256, bytes);
      setResume(parseResume(source));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!resume) return <Dropzone onFile={onFile} busy={busy} error={error} />;
  return (
    <Review
      resume={resume}
      setResume={setResume}
      onReplace={onFile}
      onRemove={() => {
        void deleteFile(resume.source.sha256);
        setResume(null);
      }}
      error={error}
    />
  );
}

function Dropzone({ onFile, busy, error }: { onFile: (f: File) => void; busy: boolean; error: string | null }) {
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <main>
      <div
        className={`dropzone${drag ? ' drag' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files[0];
          if (f) onFile(f);
        }}
      >
        <h2>Add your resume</h2>
        <p className="muted" style={{ margin: 0, maxWidth: 460 }}>
          We break it into contact details, experience, education and skills, then show you exactly where each piece came from so you can confirm
          it. Applications only ever use your own words, exactly as written.
        </p>
        <button className="btn primary" onClick={() => input.current?.click()} disabled={busy}>
          {busy ? 'Reading…' : 'Choose a file'}
        </button>
        <span className="small muted">PDF, DOCX or TXT. It stays in this browser and is never uploaded.</span>
        {error && <div className="notice bad">{error}</div>}
        <input ref={input} type="file" accept={ACCEPTED} hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      </div>
    </main>
  );
}

type GroupKind = 'contact' | 'experience' | 'education' | 'skills' | 'other';
const groupKind = (path: (string | number)[]): GroupKind => {
  const head = path[0];
  return head === 'contact' || head === 'experience' || head === 'education' || head === 'skills' ? head : 'other';
};
const DOT: Record<GroupKind, string> = {
  contact: 'var(--contact-strong)',
  experience: 'var(--exp-strong)',
  education: 'var(--edu-strong)',
  skills: 'var(--skill-strong)',
  other: 'var(--other-strong)',
};

const HEADING = -2;
const NONE = -1;

function Review(props: { resume: ParsedResume; setResume: (r: ParsedResume) => void; onReplace: (f: File) => void; onRemove: () => void; error: string | null }) {
  const { resume, setResume, onReplace, onRemove, error } = props;
  const refs = useMemo(() => listFields(resume), [resume]);
  const [activeId, setActiveId] = useState<string | null>(refs[0]?.field.id ?? null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [view, setView] = useState<'page' | 'text'>(resume.source.kind === 'pdf' ? 'page' : 'text');
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setBytes(null);
    if (resume.source.kind === 'pdf') void getFile(resume.source.sha256).then((b) => live && setBytes(b ?? null));
    return () => {
      live = false;
    };
  }, [resume.source.sha256, resume.source.kind]);

  const stats = useMemo(() => reviewStats(resume), [resume]);
  const coverage = useMemo(() => sourceCoverage(resume), [resume]);
  const problems = useMemo(() => checkIntegrity(resume), [resume]);

  /** For each source character: index into refs, HEADING, or NONE. */
  const owner = useMemo(() => {
    const o = new Int32Array(resume.source.text.length).fill(NONE);
    resume.sections.forEach((s) => s.heading?.spans.forEach((sp) => o.fill(HEADING, sp.start, sp.end)));
    refs.forEach((r, i) => r.field.spans.forEach((sp) => o.fill(i, sp.start, sp.end)));
    return o;
  }, [resume, refs]);

  const patch = useCallback((ref: FieldRef, p: Partial<Field>) => setResume(updateField(resume, ref.path, p)), [resume, setResume]);

  const move = useCallback(
    (delta: number, onlyPending = false) => {
      const i = refs.findIndex((r) => r.field.id === activeId);
      for (let k = 1; k <= refs.length; k++) {
        const next = refs[(i + delta * k + refs.length * k) % refs.length];
        if (!onlyPending || next.field.status === 'pending') {
          setActiveId(next.field.id);
          return;
        }
      }
    },
    [refs, activeId],
  );

  const setStatus = useCallback(
    (ref: FieldRef, status: Field['status'], advance = false) => {
      patch(ref, { status: ref.field.status === status ? 'pending' : status });
      if (advance) move(1);
    },
    [patch, move],
  );

  // Keyboard review: j/k move, v verify, x reject, e edit, n next unreviewed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
      const ref = refs.find((r) => r.field.id === activeId);
      const k = e.key.toLowerCase();
      if (k === 'j' || e.key === 'ArrowDown') move(1);
      else if (k === 'k' || e.key === 'ArrowUp') move(-1);
      else if (k === 'n') move(1, true);
      else if (ref && (k === 'v' || e.key === 'Enter')) setStatus(ref, 'verified', ref.field.status !== 'verified');
      else if (ref && k === 'x') setStatus(ref, 'rejected', ref.field.status !== 'rejected');
      else if (ref && k === 'e') setEditingId(ref.field.id);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [refs, activeId, move, setStatus]);

  // Keep the active field visible in both panes.
  useEffect(() => {
    if (!activeId || !root.current) return;
    root.current.querySelectorAll(`[data-field="${CSS.escape(activeId)}"]`).forEach((el) => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }, [activeId, view]);

  const useSelection = (span: Span) => {
    const ref = refs.find((r) => r.field.id === activeId);
    if (!ref) return;
    const text = resume.source.text;
    let { start, end } = span;
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (end <= start) return;
    // One span per line, so wrapped selections stay verbatim line by line.
    const spans = resume.source.lines
      .map((l) => ({ start: Math.max(l.start, start), end: Math.min(l.end, end) }))
      .filter((s) => s.end > s.start);
    patch(ref, { spans, value: textOfSpans(text, spans), origin: 'source', status: 'verified' });
  };

  const groups = useMemo(() => {
    const out: { name: string; kind: GroupKind; refs: FieldRef[] }[] = [];
    for (const r of refs) {
      const last = out[out.length - 1];
      if (last && last.name === r.group) last.refs.push(r);
      else out.push({ name: r.group, kind: groupKind(r.path), refs: [r] });
    }
    return out;
  }, [refs]);

  const verifyGroup = (g: FieldRef[]) => {
    let next = resume;
    for (const r of g) if (r.field.status === 'pending') next = updateField(next, r.path, { status: 'verified' });
    setResume(next);
  };

  const exportProfile = () => {
    const blob = new Blob([JSON.stringify(toApplicationProfile(resume), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${resume.label}-verified.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const activeRef = refs.find((r) => r.field.id === activeId);
  const pct = (n: number) => `${stats.total ? (n / stats.total) * 100 : 0}%`;

  return (
    <main className="review" ref={root}>
      <div className="review-bar">
        <strong>{resume.source.fileName}</strong>
        <span className="progress" title={`${stats.verified} confirmed, ${stats.rejected} removed, ${stats.pending} to review`}>
          <span style={{ width: pct(stats.verified), background: 'var(--ok)' }} />
          <span style={{ width: pct(stats.rejected), background: 'var(--bad)' }} />
        </span>
        <span className="small">
          {stats.verified + stats.rejected} of {stats.total} reviewed
        </span>
        <span className="small muted" title="Share of the resume's text that ended up in a field. Text with a wavy underline was not captured.">
          {Math.round(coverage * 100)}% of text captured
        </span>
        <span className={`small ${problems.length ? '' : 'muted'}`} style={problems.length ? { color: 'var(--bad)' } : undefined} title={problems.map((p) => `${p.label}: ${p.reason}`).join('\n')}>
          {problems.length ? `${problems.length} fields differ from the source` : 'Every field matches the source word for word'}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn small" onClick={() => move(1, true)} disabled={!stats.pending}>
          Next to review <span className="kbd">N</span>
        </button>
        <button className="btn small" onClick={exportProfile} disabled={problems.length > 0} title="Download the confirmed fields as JSON">
          Export confirmed
        </button>
        <button className="btn small" onClick={() => fileInput.current?.click()}>
          Replace
        </button>
        <button className="btn small" onClick={() => confirm('Remove this resume from this browser?') && onRemove()}>
          Remove
        </button>
        <input ref={fileInput} type="file" accept={ACCEPTED} hidden onChange={(e) => e.target.files?.[0] && onReplace(e.target.files[0])} />
      </div>
      {error && <div className="notice bad" style={{ margin: '0 20px 10px' }}>{error}</div>}
      <div className="review-body">
        <section className="pane" aria-label="Original resume">
          <div className="pane-head">
            <strong>Your resume</strong>
            {resume.source.kind === 'pdf' && (
              <span className="chips" style={{ margin: 0 }}>
                <button className="chip" aria-pressed={view === 'page'} onClick={() => setView('page')}>
                  Page
                </button>
                <button className="chip" aria-pressed={view === 'text'} onClick={() => setView('text')}>
                  Text
                </button>
              </span>
            )}
          </div>
          <div className="pane-body">
            {view === 'page' && resume.source.kind === 'pdf' ? (
              bytes ? (
                <PdfView resume={resume} bytes={bytes} refs={refs} owner={owner} activeId={activeId} setActiveId={setActiveId} />
              ) : (
                <div className="empty">
                  The original file isn't stored in this browser any more.
                  <br />
                  <button className="btn small" onClick={() => setView('text')}>
                    Show text view
                  </button>
                </div>
              )
            ) : (
              <TextView resume={resume} refs={refs} owner={owner} activeId={activeId} setActiveId={setActiveId} activeLabel={activeRef?.label} onUseSelection={useSelection} />
            )}
          </div>
        </section>

        <section className="pane" aria-label="Extracted fields">
          <div className="pane-head">
            <strong>What we read</strong>
            <span className="small muted">
              <span className="kbd">J</span> <span className="kbd">K</span> move · <span className="kbd">V</span> confirm · <span className="kbd">X</span> remove ·{' '}
              <span className="kbd">E</span> edit
            </span>
          </div>
          <div className="pane-body fields">
            {groups.map((g) => (
              <div key={g.name}>
                <div className="group-head">
                  <h3 style={{ ['--dot' as string]: DOT[g.kind] }}>{g.name}</h3>
                  {g.refs.some((r) => r.field.status === 'pending') && (
                    <button className="btn small ghost" onClick={() => verifyGroup(g.refs)}>
                      Confirm all
                    </button>
                  )}
                </div>
                {g.refs.map((r) => (
                  <FieldRow
                    key={r.field.id}
                    r={r}
                    active={r.field.id === activeId}
                    editing={r.field.id === editingId}
                    onFocus={() => setActiveId(r.field.id)}
                    onStatus={(s) => setStatus(r, s)}
                    onEdit={() => setEditingId(r.field.id)}
                    onSave={(value) => {
                      setEditingId(null);
                      if (value !== null && value.trim() && value.trim() !== r.field.value) {
                        patch(r, { value: value.trim(), origin: 'user', spans: [], status: 'verified' });
                      }
                    }}
                  />
                ))}
              </div>
            ))}
            {!refs.length && <div className="empty">Nothing could be read from this file. Try the Text view to see what was extracted.</div>}
          </div>
        </section>
      </div>
    </main>
  );
}

function FieldRow(props: {
  r: FieldRef;
  active: boolean;
  editing: boolean;
  onFocus: () => void;
  onStatus: (s: Field['status']) => void;
  onEdit: () => void;
  onSave: (value: string | null) => void;
}) {
  const { r, active, editing, onFocus, onStatus, onEdit, onSave } = props;
  const f = r.field;
  const conf = f.confidence >= 0.85 ? 'hi' : f.confidence >= 0.6 ? 'mid' : 'lo';
  const short = r.label.includes(' · ') ? r.label.split(' · ').slice(1).join(' · ') : r.label;
  return (
    <div className={`field${active ? ' active' : ''}${f.status === 'rejected' ? ' rejected' : ''}`} data-field={f.id} onClick={onFocus}>
      <div className="label">
        <span className={`conf ${conf}`} title={conf === 'hi' ? 'Confident' : conf === 'mid' ? 'Worth a look' : 'Check this one'} />
        {short}
        {f.origin === 'user' && <span className="tag-user" title="You typed this; it doesn't come from the file">typed</span>}
      </div>
      <div className="value">
        {editing ? (
          <textarea
            autoFocus
            defaultValue={f.value}
            onBlur={(e) => onSave(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onSave(null);
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSave((e.target as HTMLTextAreaElement).value);
              }
            }}
          />
        ) : (
          f.value
        )}
      </div>
      <div className="actions">
        <button className="v" aria-pressed={f.status === 'verified'} aria-label="Confirm" title="Confirm (V)" onClick={(e) => (e.stopPropagation(), onFocus(), onStatus('verified'))}>
          ✓
        </button>
        <button className="r" aria-pressed={f.status === 'rejected'} aria-label="Remove" title="Remove (X)" onClick={(e) => (e.stopPropagation(), onFocus(), onStatus('rejected'))}>
          ✕
        </button>
        <button aria-label="Edit" title="Type a correction (E)" onClick={(e) => (e.stopPropagation(), onFocus(), onEdit())}>
          ✎
        </button>
      </div>
    </div>
  );
}

interface ViewProps {
  resume: ParsedResume;
  refs: FieldRef[];
  owner: Int32Array;
  activeId: string | null;
  setActiveId: (id: string) => void;
}

function TextView(props: ViewProps & { activeLabel?: string; onUseSelection: (s: Span) => void }) {
  const { resume, refs, owner, activeId, setActiveId, activeLabel, onUseSelection } = props;
  const text = resume.source.text;
  const pre = useRef<HTMLPreElement>(null);
  const [sel, setSel] = useState<{ span: Span; x: number; y: number } | null>(null);

  const segments = useMemo(() => {
    const out: { start: number; end: number; o: number }[] = [];
    let start = 0;
    for (let i = 1; i <= text.length; i++) {
      if (i === text.length || owner[i] !== owner[start]) {
        out.push({ start, end: i, o: owner[start] });
        start = i;
      }
    }
    return out;
  }, [text, owner]);

  const onMouseUp = () => {
    const s = window.getSelection();
    if (!s || s.isCollapsed || !pre.current || !s.rangeCount) return setSel(null);
    const range = s.getRangeAt(0);
    const a = offsetOf(range.startContainer, range.startOffset);
    const b = offsetOf(range.endContainer, range.endOffset);
    if (a === undefined || b === undefined || b <= a) return setSel(null);
    const rect = range.getBoundingClientRect();
    setSel({ span: { start: a, end: b }, x: rect.left, y: rect.bottom + 6 });
  };

  return (
    <>
      <pre className="source-text" ref={pre} onMouseUp={onMouseUp}>
        {segments.map((s) => {
          const str = text.slice(s.start, s.end);
          if (s.o === HEADING) {
            return (
              <span key={s.start} data-start={s.start} className="heading">
                {str}
              </span>
            );
          }
          if (s.o === NONE) {
            const blank = !/[A-Za-z0-9]/.test(str);
            return (
              <span key={s.start} data-start={s.start} className={blank ? undefined : 'unassigned'} title={blank ? undefined : 'Not captured in any field'}>
                {str}
              </span>
            );
          }
          const r = refs[s.o];
          return (
            <span
              key={s.start}
              data-start={s.start}
              data-field={r.field.id}
              className={`seg g-${groupKind(r.path)}${r.field.id === activeId ? ' active' : ''}${r.field.status === 'rejected' ? ' rejected' : ''}`}
              title={r.label}
              onClick={() => window.getSelection()?.isCollapsed !== false && setActiveId(r.field.id)}
            >
              {str}
            </span>
          );
        })}
      </pre>
      {sel && activeLabel && (
        <div className="selection-pop" style={{ left: Math.max(8, sel.x), top: sel.y }}>
          Use this text for <strong>{activeLabel}</strong>
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              onUseSelection(sel.span);
              window.getSelection()?.removeAllRanges();
              setSel(null);
            }}
          >
            Use
          </button>
        </div>
      )}
    </>
  );
}

/** Document offset of a DOM selection endpoint inside the text view. */
function offsetOf(node: Node, offset: number): number | undefined {
  const el = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element))?.closest('[data-start]') as HTMLElement | null;
  if (!el) return undefined;
  const base = Number(el.dataset.start);
  return node.nodeType === Node.TEXT_NODE ? base + offset : base + (offset > 0 ? (el.textContent?.length ?? 0) : 0);
}

function PdfView({ resume, bytes, refs, owner, activeId, setActiveId }: ViewProps & { bytes: ArrayBuffer }) {
  const pages = resume.source.pages ?? [];
  const items = resume.source.items ?? [];
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);

  /**
   * One highlight per run of characters with the same owner. A single PDF
   * text run can hold several fields ("Title, Company"), so runs are split
   * proportionally by character position.
   */
  const rects = useMemo(() => {
    const text = resume.source.text;
    const out: { key: string; page: number; o: number; x: number; y: number; w: number; h: number }[] = [];
    for (const it of items) {
      const len = it.end - it.start;
      let runStart = it.start;
      for (let i = it.start + 1; i <= it.end; i++) {
        if (i < it.end && owner[i] === owner[runStart]) continue;
        const o = owner[runStart];
        const hasText = /[A-Za-z0-9]/.test(text.slice(runStart, i));
        if (o !== HEADING && (o >= 0 || hasText)) {
          out.push({
            key: `${it.start}:${runStart}`,
            page: it.page,
            o,
            x: it.box.x + (it.box.w * (runStart - it.start)) / len,
            y: it.box.y,
            w: (it.box.w * (i - runStart)) / len,
            h: it.box.h,
          });
        }
        runStart = i;
      }
    }
    return out;
  }, [items, owner, resume.source.text]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pdfjs = await loadPdfjs();
      const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
      for (let p = 1; p <= doc.numPages && !cancelled; p++) {
        const canvas = canvases.current[p - 1];
        if (!canvas) continue;
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale: 2 });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  return (
    <div className="pdf-pages">
      {pages.map((pg, pi) => (
        <div key={pi} className="pdf-page" style={{ width: '100%', maxWidth: 820, aspectRatio: `${pg.width} / ${pg.height}` }}>
          <canvas ref={(el) => void (canvases.current[pi] = el)} />
          {rects
            .filter((it) => it.page === pi)
            .map((it) => {
              const r = it.o >= 0 ? refs[it.o] : undefined;
              const style = {
                left: `${(it.x / pg.width) * 100}%`,
                top: `${(it.y / pg.height) * 100}%`,
                width: `${(it.w / pg.width) * 100}%`,
                height: `${((it.h * 1.15) / pg.height) * 100}%`,
              };
              if (!r) return <div key={it.key} className="hl unassigned" style={style} title="Not captured in any field" />;
              if (r.field.status === 'rejected') return null;
              return (
                <div
                  key={it.key}
                  className={`hl g-${groupKind(r.path)}${r.field.id === activeId ? ' active' : ''}`}
                  data-field={r.field.id}
                  style={style}
                  title={r.label}
                  onClick={() => setActiveId(r.field.id)}
                />
              );
            })}
        </div>
      ))}
    </div>
  );
}
