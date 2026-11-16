/**
 * Resume data model.
 *
 * Core rule: every value that comes from the resume is a *verbatim* slice of
 * the source document. Each field keeps the character spans it was taken from,
 * so the UI can show exactly where it came from and `checkIntegrity` can prove
 * that nothing was paraphrased, generated, or silently altered.
 *
 * The only other way a value can get into a field is the user typing it
 * themselves (origin: 'user'). Nothing in this app ever writes words on the
 * user's behalf.
 *
 * The shape is designed to be reused by the future resume builder (which will
 * produce a SourceDocument of its own) and by automated applying (which reads
 * only verified fields via `toApplicationProfile`).
 */

export const SCHEMA_VERSION = 1;

/** Half-open [start, end) character range into SourceDocument.text. */
export interface Span {
  start: number;
  end: number;
}

/** Rectangle in PDF page units (scale 1), origin at the page's top-left. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SourceLine extends Span {
  page?: number;
  box?: Box;
}

/** A positioned run of text in a PDF, used to highlight spans on the page image. */
export interface SourceItem extends Span {
  page: number;
  box: Box;
}

export type SourceKind = 'pdf' | 'docx' | 'text';

export interface SourceDocument {
  fileName: string;
  mimeType: string;
  kind: SourceKind;
  /** Full extracted text. Lines are separated by "\n". */
  text: string;
  lines: SourceLine[];
  /** PDF only: page sizes and positioned text runs. */
  pages?: { width: number; height: number }[];
  items?: SourceItem[];
  /** SHA-256 of the original file bytes, to detect a changed upload. */
  sha256: string;
  importedAt: string;
}

/** 'source' = verbatim from the document; 'user' = typed by the user. */
export type FieldOrigin = 'source' | 'user';
export type ReviewStatus = 'pending' | 'verified' | 'rejected';

export interface Field {
  id: string;
  value: string;
  /** Where the value came from. Empty only when origin is 'user'. */
  spans: Span[];
  origin: FieldOrigin;
  status: ReviewStatus;
  /** Parser's confidence (0..1) that the value is in the right slot. */
  confidence: number;
}

export interface PartialDate {
  year: number;
  /** 1-12 when the source gives a month or season. */
  month?: number;
}

/**
 * A date range keeps the verbatim text as the field value, plus a structured
 * reading of it for forms that need month/year pickers. The structured part
 * is derived from the verbatim text and never shown as the user's words.
 */
export interface DateRangeField extends Field {
  start?: PartialDate;
  end?: PartialDate;
  current?: boolean;
}

export interface ContactInfo {
  name?: Field;
  headline?: Field;
  email?: Field;
  phone?: Field;
  location?: Field;
  links: Field[];
}

export interface ExperienceEntry {
  id: string;
  title?: Field;
  company?: Field;
  location?: Field;
  dates?: DateRangeField;
  bullets: Field[];
}

export interface EducationEntry {
  id: string;
  institution?: Field;
  degree?: Field;
  fieldOfStudy?: Field;
  location?: Field;
  dates?: DateRangeField;
  gpa?: Field;
  details: Field[];
}

export interface SkillGroup {
  id: string;
  category?: Field;
  items: Field[];
}

export type SectionKind =
  | 'summary'
  | 'experience'
  | 'education'
  | 'skills'
  | 'projects'
  | 'certifications'
  | 'awards'
  | 'volunteer'
  | 'publications'
  | 'languages'
  | 'interests'
  | 'leadership'
  | 'references'
  | 'other';

export interface ResumeSection {
  id: string;
  kind: SectionKind;
  heading?: Field;
  /** Whole section, heading included. */
  span: Span;
  /**
   * Line-level fields for sections without a dedicated structure
   * (projects, certifications, awards, ...). Empty for structured kinds.
   */
  items: Field[];
}

export interface ParsedResume {
  schemaVersion: number;
  id: string;
  label: string;
  source: SourceDocument;
  contact: ContactInfo;
  summary: Field[];
  experience: ExperienceEntry[];
  education: EducationEntry[];
  skills: SkillGroup[];
  sections: ResumeSection[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers shared by parser, UI and tests
// ---------------------------------------------------------------------------

export const normalizeWs = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The verbatim text a set of spans points at, whitespace-normalized. */
export function textOfSpans(text: string, spans: Span[]): string {
  return normalizeWs(spans.map((s) => text.slice(s.start, s.end)).join(' '));
}

export interface FieldRef {
  field: Field;
  /** Human label, e.g. "Experience 2 · Title". */
  label: string;
  group: string;
  /** Path used to update the field immutably. */
  path: (string | number)[];
}

/** Every field in display order, with labels and paths. */
export function listFields(r: ParsedResume): FieldRef[] {
  const out: FieldRef[] = [];
  const add = (field: Field | undefined, label: string, group: string, path: (string | number)[]) => {
    if (field) out.push({ field, label, group, path });
  };
  const c = r.contact;
  add(c.name, 'Name', 'Contact', ['contact', 'name']);
  add(c.headline, 'Headline', 'Contact', ['contact', 'headline']);
  add(c.email, 'Email', 'Contact', ['contact', 'email']);
  add(c.phone, 'Phone', 'Contact', ['contact', 'phone']);
  add(c.location, 'Location', 'Contact', ['contact', 'location']);
  c.links.forEach((f, i) => add(f, `Link ${i + 1}`, 'Contact', ['contact', 'links', i]));
  r.summary.forEach((f, i) => add(f, `Summary ${i + 1}`, 'Summary', ['summary', i]));
  r.experience.forEach((e, i) => {
    const g = `Experience ${i + 1}`;
    const p = ['experience', i];
    add(e.title, `${g} · Title`, g, [...p, 'title']);
    add(e.company, `${g} · Company`, g, [...p, 'company']);
    add(e.location, `${g} · Location`, g, [...p, 'location']);
    add(e.dates, `${g} · Dates`, g, [...p, 'dates']);
    e.bullets.forEach((b, j) => add(b, `${g} · Bullet ${j + 1}`, g, [...p, 'bullets', j]));
  });
  r.education.forEach((e, i) => {
    const g = `Education ${i + 1}`;
    const p = ['education', i];
    add(e.institution, `${g} · Institution`, g, [...p, 'institution']);
    add(e.degree, `${g} · Degree`, g, [...p, 'degree']);
    add(e.fieldOfStudy, `${g} · Field of study`, g, [...p, 'fieldOfStudy']);
    add(e.location, `${g} · Location`, g, [...p, 'location']);
    add(e.dates, `${g} · Dates`, g, [...p, 'dates']);
    add(e.gpa, `${g} · GPA`, g, [...p, 'gpa']);
    e.details.forEach((d, j) => add(d, `${g} · Detail ${j + 1}`, g, [...p, 'details', j]));
  });
  r.skills.forEach((s, i) => {
    const g = s.category ? `Skills · ${s.category.value}` : `Skills ${i + 1}`;
    add(s.category, `${g} · Category`, g, ['skills', i, 'category']);
    s.items.forEach((f, j) => add(f, `${g} · ${j + 1}`, g, ['skills', i, 'items', j]));
  });
  r.sections.forEach((s, i) => {
    if (!s.items.length) return;
    const g = s.heading?.value ?? s.kind;
    s.items.forEach((f, j) => add(f, `${g} · ${j + 1}`, g, ['sections', i, 'items', j]));
  });
  return out;
}

/** Immutable update of one field addressed by a FieldRef path. */
export function updateField(r: ParsedResume, path: (string | number)[], patch: Partial<Field>): ParsedResume {
  const setIn = (obj: unknown, i: number): unknown => {
    if (i === path.length) return { ...(obj as Field), ...patch };
    const key = path[i];
    if (Array.isArray(obj)) {
      const copy = obj.slice();
      copy[key as number] = setIn(copy[key as number], i + 1);
      return copy;
    }
    const o = obj as Record<string, unknown>;
    return { ...o, [key]: setIn(o[key as string], i + 1) };
  };
  return { ...(setIn(r, 0) as ParsedResume), updatedAt: new Date().toISOString() };
}

export interface IntegrityProblem {
  fieldId: string;
  label: string;
  reason: string;
}

/**
 * Proves every source-origin field is exactly the text at its spans.
 * Anything that fails here must never be submitted in an application.
 */
export function checkIntegrity(r: ParsedResume): IntegrityProblem[] {
  const problems: IntegrityProblem[] = [];
  const len = r.source.text.length;
  for (const { field, label } of listFields(r)) {
    if (field.origin === 'user') continue;
    if (!field.spans.length) {
      problems.push({ fieldId: field.id, label, reason: 'No source location recorded' });
      continue;
    }
    if (field.spans.some((s) => s.start < 0 || s.end > len || s.start >= s.end)) {
      problems.push({ fieldId: field.id, label, reason: 'Source location is out of range' });
      continue;
    }
    const expected = textOfSpans(r.source.text, field.spans);
    if (normalizeWs(field.value) !== expected) {
      problems.push({ fieldId: field.id, label, reason: `Value differs from source text "${expected}"` });
    }
  }
  return problems;
}

export interface ReviewStats {
  total: number;
  verified: number;
  rejected: number;
  pending: number;
  userEdited: number;
}

export function reviewStats(r: ParsedResume): ReviewStats {
  const fields = listFields(r).map((f) => f.field);
  return {
    total: fields.length,
    verified: fields.filter((f) => f.status === 'verified').length,
    rejected: fields.filter((f) => f.status === 'rejected').length,
    pending: fields.filter((f) => f.status === 'pending').length,
    userEdited: fields.filter((f) => f.origin === 'user').length,
  };
}

/** Share of non-whitespace source characters covered by at least one field or heading. */
export function sourceCoverage(r: ParsedResume): number {
  const text = r.source.text;
  const covered = new Uint8Array(text.length);
  const mark = (s: Span) => covered.fill(1, s.start, s.end);
  listFields(r).forEach(({ field }) => field.status !== 'rejected' && field.spans.forEach(mark));
  r.sections.forEach((s) => s.heading?.spans.forEach(mark));
  let total = 0;
  let hit = 0;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i]) || /[•●▪■◦‣∙·|,;:–—\-*►➢✓]/.test(text[i])) continue;
    total++;
    if (covered[i]) hit++;
  }
  return total ? hit / total : 1;
}

/**
 * The data automated applying is allowed to use: only verified fields, and
 * only if the whole resume passes the integrity check.
 */
export function toApplicationProfile(r: ParsedResume) {
  const problems = checkIntegrity(r);
  if (problems.length) {
    throw new Error(`Resume failed integrity check: ${problems.map((p) => p.label).join(', ')}`);
  }
  const v = (f?: Field) => (f && f.status === 'verified' ? f.value : undefined);
  const vs = (fs: Field[]) => fs.filter((f) => f.status === 'verified').map((f) => f.value);
  const d = (f?: DateRangeField) =>
    f && f.status === 'verified' ? { text: f.value, start: f.start, end: f.end, current: f.current } : undefined;
  return {
    resumeId: r.id,
    sourceSha256: r.source.sha256,
    contact: {
      name: v(r.contact.name),
      headline: v(r.contact.headline),
      email: v(r.contact.email),
      phone: v(r.contact.phone),
      location: v(r.contact.location),
      links: vs(r.contact.links),
    },
    summary: vs(r.summary),
    experience: r.experience.map((e) => ({
      title: v(e.title),
      company: v(e.company),
      location: v(e.location),
      dates: d(e.dates),
      bullets: vs(e.bullets),
    })),
    education: r.education.map((e) => ({
      institution: v(e.institution),
      degree: v(e.degree),
      fieldOfStudy: v(e.fieldOfStudy),
      location: v(e.location),
      dates: d(e.dates),
      gpa: v(e.gpa),
      details: vs(e.details),
    })),
    skills: r.skills.map((s) => ({ category: v(s.category), items: vs(s.items) })),
    otherSections: r.sections
      .filter((s) => s.items.length)
      .map((s) => ({ kind: s.kind, heading: v(s.heading) ?? s.heading?.value, items: vs(s.items) })),
  };
}

export type ApplicationProfile = ReturnType<typeof toApplicationProfile>;
