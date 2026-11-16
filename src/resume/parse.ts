/**
 * Deterministic, rule-based resume parser.
 *
 * It never rewrites text: every field is a span of SourceDocument.text. When
 * the parser is unsure which slot a piece of text belongs in, it still keeps
 * the verbatim text and lowers the confidence so the review screen puts it
 * first. No AI or network call is involved.
 */
import { findDate } from './dates';
import {
  SCHEMA_VERSION,
  normalizeWs,
  type ContactInfo,
  type DateRangeField,
  type EducationEntry,
  type ExperienceEntry,
  type Field,
  type ParsedResume,
  type ResumeSection,
  type SectionKind,
  type SkillGroup,
  type SourceDocument,
  type SourceLine,
  type Span,
} from './model';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const HEADINGS: Record<Exclude<SectionKind, 'other'>, string[]> = {
  summary: [
    'summary', 'professional summary', 'career summary', 'executive summary', 'profile', 'professional profile',
    'about', 'about me', 'objective', 'career objective', 'overview', 'summary of qualifications', 'qualifications',
  ],
  experience: [
    'experience', 'work experience', 'professional experience', 'employment', 'employment history', 'work history',
    'career history', 'relevant experience', 'professional history', 'experience highlights', 'industry experience',
  ],
  education: ['education', 'academic background', 'education and training', 'academics', 'education and certifications'],
  skills: [
    'skills', 'technical skills', 'core competencies', 'competencies', 'technologies', 'skills and tools', 'tools',
    'areas of expertise', 'expertise', 'key skills', 'core skills', 'skills and technologies', 'technical proficiencies',
    'tech stack', 'skills and abilities', 'skills and interests',
  ],
  projects: ['projects', 'personal projects', 'selected projects', 'key projects', 'side projects', 'academic projects'],
  certifications: ['certifications', 'certificates', 'licenses', 'licenses and certifications', 'certifications and licenses', 'training'],
  awards: ['awards', 'honors', 'honors and awards', 'awards and honors', 'achievements', 'accomplishments'],
  volunteer: ['volunteer', 'volunteering', 'volunteer experience', 'community involvement', 'community service'],
  publications: ['publications', 'papers', 'presentations', 'publications and presentations', 'patents'],
  languages: ['languages', 'spoken languages'],
  interests: ['interests', 'hobbies', 'hobbies and interests'],
  leadership: ['leadership', 'leadership experience', 'activities', 'extracurricular activities', 'affiliations', 'memberships', 'professional affiliations'],
  references: ['references'],
};

const HEADING_LOOKUP = new Map<string, SectionKind>();
for (const [kind, words] of Object.entries(HEADINGS)) {
  for (const w of words) HEADING_LOOKUP.set(w, kind as SectionKind);
}

const TITLE_WORDS =
  /\b(engineer|developer|manager|director|analyst|designer|architect|consultant|specialist|intern|internship|lead|head|officer|administrator|coordinator|associate|assistant|scientist|researcher|technician|representative|executive|president|vp|founder|co-founder|cofounder|owner|partner|supervisor|programmer|strategist|advisor|accountant|teacher|instructor|professor|nurse|writer|editor|recruiter|agent|clerk|operator|mechanic|pilot|principal|staff|fellow|contractor|freelance|freelancer|sre|devops|cto|ceo|cfo|coo|cio|product owner|scrum master|tutor|volunteer|member|chair|captain|planner|producer|attorney|paralegal|counsel|therapist|pharmacist|physician|electrician|inspector|controller|auditor|buyer|cashier|server|bartender|driver)\b/i;

const COMPANY_HINT =
  /\b(inc\.?|llc|l\.l\.c\.|corp\.?|corporation|ltd\.?|limited|co\.|company|group|labs?|technologies|technology|systems|solutions|software|bank|partners|holdings|ventures|studios?|agency|consulting|university|college|hospital|health|airlines?|aerospace|federal|department|government|navy|army|air force|institute|foundation|services)\b/i;

const INSTITUTION_HINT = /\b(university|college|institute|school|academy|polytechnic|conservatory|universidad|université|universität|bootcamp)\b|\bU\.?\s?of\b/i;

const DEGREE_RE =
  /\b(Bachelor(?:'s)?(?: of [A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?)?|Master(?:'s)?(?: of [A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?)?|Associate(?:'s)?(?: of [A-Z][A-Za-z]+)?|Doctor(?:ate)?(?: of [A-Z][A-Za-z]+)?|Ph\.?\s?D\.?|B\.?\s?S\.?(?:c\.?)?|B\.?\s?A\.?|M\.?\s?S\.?(?:c\.?)?|M\.?\s?A\.?|MBA|M\.?B\.?A\.?|B\.?\s?Eng\.?|M\.?\s?Eng\.?|BBA|B\.?F\.?A\.?|M\.?F\.?A\.?|J\.?D\.?|M\.?D\.?|A\.?A\.?S?\.?|A\.?S\.?|High School Diploma|Diploma|GED|Certificate)(?=$|[\s,.;:|(])/;

const GPA_RE = /\bGPA[:\s]*([0-4](?:\.\d{1,3})?)(?:\s*\/\s*[0-9.]+)?|\b([0-4]\.\d{1,3})\s*\/\s*4(?:\.0+)?\s*GPA?/i;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?:\s*(?:x|ext\.?)\s*\d+)?/;
const URL_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com|github\.com|gitlab\.com|bitbucket\.org|behance\.net|dribbble\.com|medium\.com|stackoverflow\.com|twitter\.com|x\.com|[A-Za-z0-9-]+\.(?:dev|io|me|com|net|org|app|co|ai|design|page|site))(?:\/[^\s|,;•]*)?/i;
const STATE =
  'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|ON|BC|AB|QC';
const LOCATION_RE = new RegExp(
  `(?:\\b[A-Z][A-Za-z.'\\-]+(?:\\s[A-Z][A-Za-z.'\\-]+){0,3},\\s*(?:${STATE})\\b(?:\\s+\\d{5})?|\\b[A-Z][A-Za-z.'\\-]+(?:\\s[A-Z][A-Za-z.'\\-]+){0,2},\\s*[A-Z][a-z]+(?:\\s[A-Z][a-z]+)?\\b|\\b(?:Remote|Hybrid|On-?site)(?:\\s*\\([^)]*\\))?)`,
);

const LOCATION_END_RE = new RegExp(`(?:${LOCATION_RE.source})$`);

const BULLET_RE = /^(\s*)([•●▪■◦‣∙·○◆◇►▸➢➤✓✔\-–—*+]|\d{1,2}[.)])\s+/;

// Splits header-ish lines into tokens: pipes, bullets, dashes with spaces, wide gaps, tabs.
const SEP_RE = /\s+[|•·◦▪]\s+|\s*\|\s*|\s+[—–]\s+|\s+-\s+|\s{3,}|\t+/g;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

let idCounter = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}${(idCounter++).toString(36)}`;

interface Ctx {
  doc: SourceDocument;
  text: string;
}

function field(ctx: Ctx, id: string, spans: Span[], confidence = 0.9, trim: (s: Span) => Span = trimSpan(ctx.text)): Field {
  const clean = spans.map(trim).filter((s) => s.end > s.start);
  return {
    id,
    value: normalizeWs(clean.map((s) => ctx.text.slice(s.start, s.end)).join(' ')),
    spans: clean,
    origin: 'source',
    status: 'pending',
    confidence,
  };
}

/** Shrink a span so it doesn't start/end with whitespace or separator punctuation. */
const trimSpan = (text: string) => (s: Span): Span => {
  let { start, end } = s;
  while (start < end && /[\s|•·,;:–—\-]/.test(text[start])) start++;
  while (end > start && /[\s|•·,;:–—\-]/.test(text[end - 1])) end--;
  // Keep a closing parenthesis/period that belongs to the text, e.g. "Inc." or "(Remote)".
  return { start, end };
};

const trimWs = (text: string) => (s: Span): Span => {
  let { start, end } = s;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { start, end };
};

interface Token extends Span {
  text: string;
}

/** Split [start, end) of the document into tokens on separators. */
function tokenize(text: string, start: number, end: number, sep: RegExp = SEP_RE): Token[] {
  const slice = text.slice(start, end);
  const out: Token[] = [];
  let last = 0;
  const re = new RegExp(sep.source, 'g');
  for (let m = re.exec(slice); m; m = re.exec(slice)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    pushTok(out, text, start + last, start + m.index);
    last = m.index + m[0].length;
  }
  pushTok(out, text, start + last, end);
  return out;
}

function pushTok(out: Token[], text: string, s: number, e: number) {
  const t = trimSpan(text)({ start: s, end: e });
  if (t.end > t.start) out.push({ ...t, text: text.slice(t.start, t.end) });
}

/** Remove sub-spans (absolute offsets) from a token list, re-trimming the leftovers. */
function subtract(text: string, toks: Token[], cut: Span): Token[] {
  const out: Token[] = [];
  for (const t of toks) {
    if (cut.end <= t.start || cut.start >= t.end) {
      out.push(t);
      continue;
    }
    pushTok(out, text, t.start, Math.max(t.start, cut.start));
    pushTok(out, text, Math.min(t.end, cut.end), t.end);
  }
  return out.filter((t) => /[A-Za-z0-9]/.test(t.text));
}

function headingKind(line: string): SectionKind | undefined {
  const t = line
    .trim()
    .replace(/[:：]$/, '')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  if (!t || t.length > 45) return undefined;
  const direct = HEADING_LOOKUP.get(t);
  if (direct) return direct;
  // Letter-spaced headings like "E X P E R I E N C E".
  const squashed = t.replace(/(?<=\b\w) (?=\w\b)/g, '');
  const sq = HEADING_LOOKUP.get(squashed);
  if (sq) return sq;
  // ALL CAPS short heading containing a known keyword, e.g. "RELEVANT WORK EXPERIENCE".
  const raw = line.trim().replace(/[:：]$/, '');
  if (raw === raw.toUpperCase() && /[A-Z]/.test(raw) && raw.split(/\s+/).length <= 5) {
    for (const [w, k] of HEADING_LOOKUP) {
      if (w.split(' ').length === 1 && new RegExp(`\\b${w}\\b`).test(t)) return k;
    }
  }
  return undefined;
}

/** "Skills: Python, Go" — a heading followed by content on the same line. */
function inlineHeading(line: string): { kind: SectionKind; contentOffset: number } | undefined {
  const m = line.match(/^\s*([A-Za-z &/]{3,40}?)\s*[:：]\s+(\S.*)$/);
  if (!m) return undefined;
  const kind = headingKind(m[1]);
  if (!kind) return undefined;
  return { kind, contentOffset: line.length - m[2].length };
}

// ---------------------------------------------------------------------------
// Line model used by section parsers
// ---------------------------------------------------------------------------

interface PLine extends SourceLine {
  /** Start of the content after any bullet marker. */
  contentStart: number;
  bullet: boolean;
  str: string;
}

function toPLines(ctx: Ctx, lines: SourceLine[]): PLine[] {
  return lines.map((l) => {
    const str = ctx.text.slice(l.start, l.end);
    const m = str.match(BULLET_RE);
    return { ...l, str, bullet: !!m, contentStart: l.start + (m ? m[0].length : 0) };
  });
}

const nonEmpty = (l: PLine) => l.str.trim().length > 0;

/**
 * Groups a bullet line with its wrapped continuation lines (common in PDFs,
 * where one bullet spans several visual lines).
 */
function isContinuation(prev: PLine, line: PLine, bulletX?: number): boolean {
  if (line.bullet) return false;
  const s = line.str.trim();
  if (!s) return false;
  if (/^[a-z(&,]/.test(s)) return true;
  if (findDate(s)) return false;
  if (bulletX !== undefined && line.box && prev.box) {
    // Wrapped text is indented past the bullet glyph.
    return line.box.x > bulletX + 4;
  }
  const prevEnd = prev.str.trim().slice(-1);
  return !/[.!?;:]/.test(prevEnd) && s.length > 30 && /[.]$/.test(s);
}

/** A bullet (or paragraph) and its continuation lines as one multi-span field. */
function collectParagraphs(ctx: Ctx, lines: PLine[], idPrefix: string): Field[] {
  const out: Field[] = [];
  let cur: PLine[] = [];
  let bulletX: number | undefined;
  const flush = () => {
    if (cur.length) {
      // Sentences keep their punctuation: only surrounding whitespace is trimmed.
      out.push(field(ctx, `${idPrefix}.${out.length}`, cur.map((l) => ({ start: l.contentStart, end: l.end })), 0.9, trimWs(ctx.text)));
    }
    cur = [];
  };
  for (const l of lines) {
    if (!nonEmpty(l)) {
      flush();
      continue;
    }
    if (cur.length && isContinuation(cur[cur.length - 1], l, bulletX)) {
      cur.push(l);
      continue;
    }
    flush();
    cur = [l];
    bulletX = l.bullet && l.box ? l.box.x : undefined;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface RawSection {
  kind: SectionKind;
  heading?: Span;
  span: Span;
  body: SourceLine[];
}

function splitSections(ctx: Ctx): { header: SourceLine[]; sections: RawSection[] } {
  const header: SourceLine[] = [];
  const sections: RawSection[] = [];
  let cur: RawSection | undefined;
  for (const line of ctx.doc.lines) {
    const str = ctx.text.slice(line.start, line.end);
    const kind = headingKind(str);
    // Inside a skills section, "Languages: Go, Python" is a skill category, not a new section.
    const inline = kind || cur?.kind === 'skills' ? undefined : inlineHeading(str);
    if (kind || inline) {
      if (cur) sections.push(cur);
      const k = (kind ?? inline!.kind) as SectionKind;
      const headingEnd = inline ? line.start + inline.contentOffset : line.end;
      cur = { kind: k, heading: trimSpan(ctx.text)({ start: line.start, end: headingEnd }), span: { start: line.start, end: line.end }, body: [] };
      if (inline) cur.body.push({ ...line, start: line.start + inline.contentOffset });
      continue;
    }
    if (cur) {
      cur.body.push(line);
      cur.span.end = line.end;
    } else header.push(line);
  }
  if (cur) sections.push(cur);
  return { header, sections };
}

// ---------------------------------------------------------------------------
// Contact block
// ---------------------------------------------------------------------------

function parseContact(ctx: Ctx, header: SourceLine[], summaryOut: Field[]): ContactInfo {
  const contact: ContactInfo = { links: [] };
  const leftovers: Token[] = [];
  const plines = toPLines(ctx, header).filter(nonEmpty);
  for (const l of plines) {
    let toks = tokenize(ctx.text, l.contentStart, l.end, /\s+[|•·◦▪]\s+|\s*\|\s*|\s{3,}|\t+|\s+[—–]\s+/g);
    for (const tok of [...toks]) {
      const take = (re: RegExp, key: 'email' | 'phone') => {
        const m = tok.text.match(re);
        if (!m || contact[key]) return;
        const s = tok.start + m.index!;
        contact[key] = field(ctx, `contact.${key}`, [{ start: s, end: s + m[0].length }], 0.98);
        toks = subtract(ctx.text, toks, { start: s, end: s + m[0].length });
      };
      take(EMAIL_RE, 'email');
      take(PHONE_RE, 'phone');
    }
    for (const tok of [...toks]) {
      const m = tok.text.match(URL_RE);
      if (m && !EMAIL_RE.test(tok.text)) {
        const s = tok.start + m.index!;
        contact.links.push(field(ctx, `contact.links.${contact.links.length}`, [{ start: s, end: s + m[0].length }], 0.95));
        toks = subtract(ctx.text, toks, { start: s, end: s + m[0].length });
      }
    }
    if (!contact.location) {
      for (const tok of toks) {
        const m = tok.text.match(LOCATION_RE);
        if (m && m[0].length >= tok.text.length - 6) {
          const s = tok.start + m.index!;
          contact.location = field(ctx, 'contact.location', [{ start: s, end: s + m[0].length }], 0.85);
          toks = subtract(ctx.text, toks, { start: s, end: s + m[0].length });
          break;
        }
      }
    }
    leftovers.push(...toks);
  }
  // Name: first short leftover that looks like a person's name.
  const nameIdx = leftovers.findIndex((t) => /^[\p{L}][\p{L}.'’-]*(?:\s+[\p{L}][\p{L}.'’-]*){0,4}$/u.test(t.text) && t.text.length <= 50);
  if (nameIdx >= 0) {
    const t = leftovers.splice(nameIdx, 1)[0];
    contact.name = field(ctx, 'contact.name', [t], nameIdx === 0 ? 0.95 : 0.6);
  }
  // A short leftover line is usually a headline ("Senior Software Engineer").
  const headIdx = leftovers.findIndex((t) => t.text.length <= 80 && !/[.!?]$/.test(t.text));
  if (headIdx >= 0) {
    contact.headline = field(ctx, 'contact.headline', [leftovers.splice(headIdx, 1)[0]], 0.6);
  }
  // Anything long left in the header is an un-headed summary paragraph.
  for (const t of leftovers) summaryOut.push(field(ctx, `summary.${summaryOut.length}`, [t], 0.5));
  return contact;
}

// ---------------------------------------------------------------------------
// Experience
// ---------------------------------------------------------------------------

function dateField(ctx: Ctx, id: string, lineStart: number, str: string): { f: DateRangeField; span: Span } | undefined {
  const d = findDate(str);
  if (!d) return undefined;
  const span = { start: lineStart + d.start, end: lineStart + d.end };
  const f: DateRangeField = { ...field(ctx, id, [span], d.isRange ? 0.95 : 0.8), start: d.from, end: d.to, current: d.current };
  return { f, span };
}

/** Group lines into entries: a run of header lines followed by its bullets. */
function groupEntries(lines: PLine[]): { head: PLine[]; body: PLine[] }[] {
  const entries: { head: PLine[]; body: PLine[] }[] = [];
  let cur: { head: PLine[]; body: PLine[] } | undefined;
  let bulletX: number | undefined;
  for (const l of lines) {
    if (!nonEmpty(l)) continue;
    if (l.bullet) {
      if (!cur) cur = { head: [], body: [] };
      cur.body.push(l);
      bulletX = l.box?.x;
      continue;
    }
    if (cur && cur.body.length && isContinuation(cur.body[cur.body.length - 1], l, bulletX)) {
      cur.body.push(l);
      continue;
    }
    // Long sentence-like lines after the dated header are descriptions, not headers.
    if (cur && cur.head.some((h) => findDate(h.str)) && (l.str.trim().length > 90 || (/[.]$/.test(l.str.trim()) && l.str.trim().length > 60)) && !findDate(l.str)) {
      cur.body.push(l);
      continue;
    }
    if (!cur || cur.body.length) {
      if (cur) entries.push(cur);
      cur = { head: [l], body: [] };
      continue;
    }
    // Second dated line in a header block starts a new entry (stacked roles).
    if (findDate(l.str) && cur.head.some((h) => findDate(h.str)) && cur.head.length >= 2) {
      entries.push(cur);
      cur = { head: [l], body: [] };
      continue;
    }
    cur.head.push(l);
  }
  if (cur) entries.push(cur);
  return entries;
}

function parseExperience(ctx: Ctx, body: SourceLine[], idx: { n: number }): ExperienceEntry[] {
  const out: ExperienceEntry[] = [];
  for (const { head, body: bl } of groupEntries(toPLines(ctx, body))) {
    const i = idx.n++;
    const entry: ExperienceEntry = { id: uid('exp'), bullets: [] };
    let toks: Token[] = [];
    for (const h of head) {
      let ltoks = tokenize(ctx.text, h.contentStart, h.end);
      if (!entry.dates) {
        const d = dateField(ctx, `experience.${i}.dates`, h.start, h.str);
        if (d) {
          entry.dates = d.f;
          ltoks = subtract(ctx.text, ltoks, d.span);
        }
      }
      // Pull "Title at Company" apart.
      ltoks = ltoks.flatMap((t) => {
        const m = t.text.match(/^(.+?)\s+(?:at|@)\s+(.+)$/);
        if (!m) return [t];
        return tokenize(ctx.text, t.start, t.end, /\s+(?:at|@)\s+/g);
      });
      toks.push(...ltoks);
    }
    // Location tokens.
    for (const t of [...toks]) {
      const m = t.text.match(LOCATION_RE);
      if (m && m[0].length >= t.text.length - 2 && !entry.location && !TITLE_WORDS.test(t.text)) {
        entry.location = field(ctx, `experience.${i}.location`, [t], 0.8);
        toks = toks.filter((x) => x !== t);
      } else if (!entry.location && LOCATION_END_RE.test(t.text)) {
        // "Acme Corp, Austin, TX"
        const em = t.text.match(LOCATION_END_RE)!;
        if (!/,\s*$/.test(t.text.slice(0, em.index))) continue;
        const s = t.start + em.index!;
        const m = em;
        entry.location = field(ctx, `experience.${i}.location`, [{ start: s, end: s + m[0].length }], 0.75);
        toks = subtract(ctx.text, toks, { start: s, end: s + m[0].length });
      }
    }
    // If one token contains "Title, Company", split on the comma.
    if (toks.length === 1 && toks[0].text.includes(', ')) {
      const parts = tokenize(ctx.text, toks[0].start, toks[0].end, /,\s+/g);
      if (parts.length === 2 && parts.some((p) => TITLE_WORDS.test(p.text))) toks = parts;
    }
    const titleTok = toks.find((t) => TITLE_WORDS.test(t.text) && !COMPANY_HINT.test(t.text)) ?? toks.find((t) => TITLE_WORDS.test(t.text));
    if (titleTok) {
      entry.title = field(ctx, `experience.${i}.title`, [titleTok], 0.85);
      toks = toks.filter((t) => t !== titleTok);
    }
    const companyTok = toks.find((t) => COMPANY_HINT.test(t.text)) ?? toks[0];
    if (companyTok) {
      entry.company = field(ctx, `experience.${i}.company`, [companyTok], COMPANY_HINT.test(companyTok.text) ? 0.85 : 0.6);
      toks = toks.filter((t) => t !== companyTok);
    }
    if (!entry.title && toks[0]) {
      entry.title = field(ctx, `experience.${i}.title`, [toks[0]], 0.5);
      toks = toks.slice(1);
    }
    // Stacked roles under one employer: reuse the previous entry's company span.
    if (!entry.company && entry.title && out.length && out[out.length - 1].company) {
      const prev = out[out.length - 1].company!;
      entry.company = { ...field(ctx, `experience.${i}.company`, prev.spans, 0.6) };
    }
    // Any header text not assigned to a slot stays visible as a bullet-like field.
    const extras = toks.map((t, j) => field(ctx, `experience.${i}.extra.${j}`, [t], 0.4));
    entry.bullets = [...extras, ...collectParagraphs(ctx, bl, `experience.${i}.bullets`)];
    entry.bullets.forEach((b, j) => (b.id = `experience.${i}.bullets.${j}`));
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Education
// ---------------------------------------------------------------------------

function parseEducation(ctx: Ctx, body: SourceLine[], idx: { n: number }): EducationEntry[] {
  const out: EducationEntry[] = [];
  let cur: EducationEntry | undefined;
  const lines = toPLines(ctx, body).filter(nonEmpty);
  const start = () => {
    const i = idx.n++;
    cur = { id: uid('edu'), details: [] };
    out.push(cur);
    return i;
  };
  let i = -1;
  const detailLines: { entry: EducationEntry; i: number; lines: PLine[] }[] = [];
  for (const l of lines) {
    let toks = tokenize(ctx.text, l.contentStart, l.end);
    const hasInst = toks.some((t) => INSTITUTION_HINT.test(t.text));
    const hasDeg = toks.some((t) => DEGREE_RE.test(t.text));
    if (!cur || (hasInst && cur.institution) || (hasDeg && cur.degree && !hasInst)) i = start();
    const e = cur!;
    if (l.bullet || (!hasInst && !hasDeg && !findDate(l.str) && !GPA_RE.test(l.str) && (e.institution || e.degree))) {
      let d = detailLines.find((x) => x.entry === e);
      if (!d) detailLines.push((d = { entry: e, i, lines: [] }));
      d.lines.push(l);
      continue;
    }
    if (!e.dates) {
      const d = dateField(ctx, `education.${i}.dates`, l.start, l.str);
      if (d) {
        e.dates = d.f;
        toks = subtract(ctx.text, toks, d.span);
      }
    }
    if (!e.gpa) {
      const m = l.str.match(GPA_RE);
      if (m) {
        const s = l.start + m.index!;
        e.gpa = field(ctx, `education.${i}.gpa`, [{ start: s, end: s + m[0].length }], 0.95);
        toks = subtract(ctx.text, toks, { start: s, end: s + m[0].length });
      }
    }
    for (const t of toks) {
      if (!e.institution && INSTITUTION_HINT.test(t.text)) {
        e.institution = field(ctx, `education.${i}.institution`, [t], 0.9);
        continue;
      }
      const dm = t.text.match(DEGREE_RE);
      if (!e.degree && dm) {
        const ds = t.start + dm.index!;
        // "B.S. in Computer Science" / "Bachelor of Science, Computer Science"
        const rest = ctx.text.slice(ds + dm[0].length, t.end);
        const fm = rest.match(/^\s*(?:in|of|,|-|–|—|:)\s*(.+)$/);
        if (fm) {
          e.degree = field(ctx, `education.${i}.degree`, [{ start: ds, end: ds + dm[0].length }], 0.9);
          const fs = t.end - fm[1].length;
          e.fieldOfStudy = field(ctx, `education.${i}.fieldOfStudy`, [{ start: fs, end: t.end }], 0.8);
        } else {
          e.degree = field(ctx, `education.${i}.degree`, [t], 0.85);
        }
        continue;
      }
      if (!e.location && LOCATION_RE.test(t.text) && t.text.match(LOCATION_RE)![0].length >= t.text.length - 2) {
        e.location = field(ctx, `education.${i}.location`, [t], 0.75);
        continue;
      }
      if (e.degree && !e.fieldOfStudy && !/\d/.test(t.text)) {
        e.fieldOfStudy = field(ctx, `education.${i}.fieldOfStudy`, [t], 0.6);
        continue;
      }
      if (!e.institution) {
        e.institution = field(ctx, `education.${i}.institution`, [t], 0.5);
        continue;
      }
      e.details.push(field(ctx, `education.${i}.details.${e.details.length}`, [t], 0.4));
    }
  }
  for (const d of detailLines) {
    const paras = collectParagraphs(ctx, d.lines, `education.${d.i}.details`);
    d.entry.details.push(...paras);
    d.entry.details.forEach((f, j) => (f.id = `education.${d.i}.details.${j}`));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** Split on , ; | • but not inside parentheses: "C++ (STL, Boost), Go". */
function splitList(text: string, start: number, end: number): Token[] {
  const out: Token[] = [];
  let depth = 0;
  let last = start;
  for (let p = start; p < end; p++) {
    const ch = text[p];
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth) depth--;
    else if (!depth && /[,;|•·▪]/.test(ch)) {
      pushTok(out, text, last, p);
      last = p + 1;
    } else if (!depth && /\s/.test(ch) && /^\s{3,}/.test(text.slice(p, p + 3))) {
      pushTok(out, text, last, p);
      while (p + 1 < end && /\s/.test(text[p + 1])) p++;
      last = p + 1;
    }
  }
  pushTok(out, text, last, end);
  return out;
}

function parseSkills(ctx: Ctx, body: SourceLine[], idx: { n: number }): SkillGroup[] {
  const groups: SkillGroup[] = [];
  let loose: SkillGroup | undefined;
  for (const l of toPLines(ctx, body).filter(nonEmpty)) {
    const content = ctx.text.slice(l.contentStart, l.end);
    const m = content.match(/^([^:,;]{2,40}?)\s*:\s*(.+)$/);
    if (m) {
      const i = idx.n++;
      const catStart = l.contentStart;
      const itemsStart = l.end - m[2].length;
      const g: SkillGroup = {
        id: uid('skill'),
        category: field(ctx, `skills.${i}.category`, [{ start: catStart, end: catStart + m[1].length }], 0.9),
        items: splitList(ctx.text, itemsStart, l.end).map((t, j) => field(ctx, `skills.${i}.items.${j}`, [t], 0.9)),
      };
      groups.push(g);
      loose = undefined;
      continue;
    }
    if (!loose) {
      const i = idx.n++;
      loose = { id: uid('skill'), items: [] };
      (loose as SkillGroup & { _i?: number })._i = i;
      groups.push(loose);
    }
    const gi = (loose as SkillGroup & { _i?: number })._i!;
    for (const t of splitList(ctx.text, l.contentStart, l.end)) {
      loose.items.push(field(ctx, `skills.${gi}.items.${loose.items.length}`, [t], t.text.length > 60 ? 0.5 : 0.85));
    }
  }
  groups.forEach((g) => delete (g as SkillGroup & { _i?: number })._i);
  return groups;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parseResume(doc: SourceDocument): ParsedResume {
  const ctx: Ctx = { doc, text: doc.text };
  const { header, sections: raw } = splitSections(ctx);
  const summary: Field[] = [];
  const contact = parseContact(ctx, header, summary);
  const experience: ExperienceEntry[] = [];
  const education: EducationEntry[] = [];
  const skills: SkillGroup[] = [];
  const sections: ResumeSection[] = [];
  const counters = { exp: { n: 0 }, edu: { n: 0 }, skill: { n: 0 } };

  raw.forEach((s, si) => {
    const section: ResumeSection = {
      id: uid('sec'),
      kind: s.kind,
      heading: s.heading ? field(ctx, `sections.${si}.heading`, [s.heading], 0.95) : undefined,
      span: s.span,
      items: [],
    };
    switch (s.kind) {
      case 'summary':
        summary.push(...collectParagraphs(ctx, toPLines(ctx, s.body), 'summary'));
        break;
      case 'experience':
      case 'volunteer':
      case 'leadership':
        if (s.kind === 'experience' || groupEntries(toPLines(ctx, s.body)).some((e) => e.head.some((h) => findDate(h.str)))) {
          if (s.kind === 'experience') experience.push(...parseExperience(ctx, s.body, counters.exp));
          else section.items = collectParagraphs(ctx, toPLines(ctx, s.body), `sections.${si}.items`);
        } else section.items = collectParagraphs(ctx, toPLines(ctx, s.body), `sections.${si}.items`);
        break;
      case 'education':
        education.push(...parseEducation(ctx, s.body, counters.edu));
        break;
      case 'skills':
        skills.push(...parseSkills(ctx, s.body, counters.skill));
        break;
      default:
        section.items = collectParagraphs(ctx, toPLines(ctx, s.body), `sections.${si}.items`);
    }
    sections.push(section);
  });
  summary.forEach((f, i) => (f.id = `summary.${i}`));

  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: uid('resume'),
    label: doc.fileName.replace(/\.[^.]+$/, ''),
    source: doc,
    contact,
    summary,
    experience,
    education,
    skills,
    sections,
    createdAt: now,
    updatedAt: now,
  };
}
