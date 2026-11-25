/**
 * A tracked job application: the job, where it stands, the questions of its form with what goes in each, and what
 * happened to it. docs/applications.md describes the tracker around it.
 *
 * The browser and the server both use this file, so it has no `node:` imports and no DOM.
 *
 * It also holds the line between the user's words and everyone else's
 * (docs/decisions/0021-an-answer-is-marked-with-who-wrote-it.md). Every answer says who wrote it:
 *
 *   user       typed by the user on the app's own page. Only this is the user's own words.
 *   assistant  written by an assistant working for the user, outside the app. A first draft, or a fact it filled in.
 *   form       read back from the live form by an assistant. The user may have typed it there.
 *
 * Nothing here turns an assistant's text into the user's. A change says who is making it (`by`), and a change made
 * by an assistant cannot replace the user's words or an answer the user accepted, cannot answer a question that is
 * left to the user on the form (a pledge, a consent, a demographic question, a file to attach), and cannot touch
 * the answers of an application that was sent.
 */
import type { Workplace } from '../jobs/types';

/** The marker and version of a file of applications (import and export). */
export const FILE_FORMAT = 'job-hunt-applications';
export const FILE_VERSION = 1;

/** The stages of docs/applications-plan.md, section 7.1. */
export const STAGES = ['saved', 'drafting', 'ready', 'submitting', 'submitted', 'in_review', 'assessment', 'interview', 'offer', 'rejected', 'withdrawn', 'closed', 'unknown'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  saved: 'Saved',
  drafting: 'Being prepared',
  ready: 'Ready for you to send',
  submitting: 'Being sent',
  submitted: 'Sent',
  in_review: 'In review',
  assessment: 'Assessment',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Not selected',
  withdrawn: 'Withdrawn',
  closed: 'Posting closed',
  unknown: 'Unknown, check on the site',
};

/** `open`: nothing was sent yet. `sent`: it is with the employer. `over`: it ended. */
export type StageGroup = 'open' | 'sent' | 'over';

const GROUP: Record<Stage, StageGroup> = {
  saved: 'open',
  drafting: 'open',
  ready: 'open',
  submitting: 'open',
  unknown: 'open',
  submitted: 'sent',
  in_review: 'sent',
  assessment: 'sent',
  interview: 'sent',
  offer: 'sent',
  rejected: 'over',
  withdrawn: 'over',
  closed: 'over',
};

export const stageGroup = (stage: Stage): StageGroup => GROUP[stage];

/** Who makes a change: the user on the app's own page, or an assistant working for them. */
export type Actor = 'user' | 'assistant';
/** Who set a stage or wrote a line of the timeline. `site` is kept for the day the app reads a stage from an employer's site. */
export type Setter = Actor | 'site';

export const FIELD_KINDS = ['text', 'longtext', 'choice', 'checkbox', 'file'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/**
 * `filled`  settled: this is what goes in the form.
 * `draft`   a first draft the user still reviews or rewrites.
 * `ask`     waits for an answer only the user knows. It is empty until they give one, on the page or to an assistant.
 * `yours`   only the user does this, on the form itself. Nobody else fills it.
 */
export const FIELD_STATUSES = ['filled', 'draft', 'ask', 'yours'] as const;
export type FieldStatus = (typeof FIELD_STATUSES)[number];

export const ORIGINS = ['user', 'assistant', 'form'] as const;
export type Origin = (typeof ORIGINS)[number];

/** One question of an application form. */
export interface FormField {
  /** Stable inside its application. */
  id: string;
  /** The question as the form words it. */
  label: string;
  kind: FieldKind;
  required: boolean;
  /** Exactly what is typed or picked in the form. Empty when nothing is. */
  value: string;
  /** Who wrote the value. Left out while the value is empty. */
  origin?: Origin;
  status: FieldStatus;
  /** When the user settled a draft without rewriting it. The text is still not theirs, and the page says so. */
  acceptedAt?: string;
  /** Where the value came from, or what to watch. */
  note?: string;
  /** When the value or the status last changed. */
  updatedAt?: string;
}

export interface ApplicationForm {
  /** Where the form is filled in. */
  url: string;
  /** What someone filling this form again has to know. */
  notes?: string;
  /** Every question, in the form's order. */
  fields: FormField[];
}

export interface TrackedListing {
  /** The board's name, as shown to the user. */
  via: string;
  url?: string;
}

/** The job as it was when it was saved. */
export interface TrackedJob {
  title: string;
  company: string;
  location?: string;
  workplace?: Workplace;
  /** The pay as the posting words it. */
  pay?: string;
  /** A date ("2026-11-17") or a full time. */
  postedAt?: string;
  postingUrl: string;
  /** Every place the posting was seen. */
  listings: TrackedListing[];
  /** From a job site, so hostile: it reaches the page only through `sanitizeHtml`. */
  descriptionHtml?: string;
  descriptionText?: string;
}

export interface TimelineEntry {
  at: string;
  by: Setter;
  kind: 'created' | 'stage' | 'note';
  /** With `stage`: the new stage, and the one it replaced. */
  stage?: Stage;
  from?: Stage;
  /** With `note`. */
  text?: string;
}

export interface Application {
  /** Lower-case letters, digits and single dashes. Also the name of the file the server keeps it in. */
  id: string;
  /** Goes up by one with every change. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  job: TrackedJob;
  stage: Stage;
  stageSetBy: Setter;
  /** When the stage first said the application was sent. */
  submittedAt?: string;
  form?: ApplicationForm;
  /** What happened, oldest first. */
  timeline: TimelineEntry[];
}

/** What a list of applications shows of one. */
export interface ApplicationSummary {
  id: string;
  revision: number;
  title: string;
  company: string;
  location?: string;
  postingUrl: string;
  stage: Stage;
  stageSetBy: Setter;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  /** How many questions the form has, and how many things are left for the user (see `leftForUser`). */
  fields: number;
  asks: number;
  drafts: number;
  yours: number;
}

/** A file of applications, as exported and imported. */
export interface ApplicationsFile {
  format: typeof FILE_FORMAT;
  version: typeof FILE_VERSION;
  exportedAt?: string;
  applications: unknown[];
}

export const LIMITS = {
  applications: 2000,
  fields: 300,
  timeline: 1000,
  listings: 30,
  /** Titles, company names and other one-line facts. */
  line: 300,
  label: 2000,
  value: 20_000,
  note: 2000,
  formNotes: 4000,
  description: 200_000,
  address: 2000,
} as const;

/**
 * `invalid`: what was sent is not an application or a change to one. `refused`: it is, but the one who sent it may
 * not make it. The message is a sentence for whoever sent it.
 */
export class ApplicationError extends Error {
  constructor(
    public code: 'invalid' | 'refused',
    message: string,
  ) {
    super(message);
    this.name = 'ApplicationError';
  }
}

const invalid = (message: string) => new ApplicationError('invalid', message);
const refused = (message: string) => new ApplicationError('refused', message);

type Raw = Record<string, unknown>;

function object(value: unknown, what: string): Raw {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(`${what} must be an object.`);
  return value as Raw;
}

/** Nothing is dropped in silence: a part this file does not know is named. */
function known(o: Raw, what: string, names: readonly string[]): void {
  const unknown = Object.keys(o).find((name) => !names.includes(name));
  if (unknown !== undefined) throw invalid(`${what} has a part this app does not know: "${unknown.slice(0, 60)}".`);
}

function list(value: unknown, what: string, max: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(`${what} must be a list.`);
  if (value.length > max) throw invalid(`${what} has more than ${max} entries.`);
  return value;
}

/** Text as it was typed. Only the line ends are made the same, the way a browser's text box gives them. */
function text(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string') throw invalid(`${what} must be text.`);
  const s = value.replace(/\r\n?/g, '\n');
  if (s.length > max) throw invalid(`${what} is longer than ${max} characters.`);
  return s;
}

/** A one-line fact, without the spaces around it. It may not be empty. */
function line(value: unknown, what: string, max: number = LIMITS.line): string {
  const s = text(value, what, max).trim();
  if (!s) throw invalid(`${what} is empty.`);
  return s;
}

const missing = (value: unknown) => value === undefined || value === null || value === '';

function oneOf<T extends string>(value: unknown, what: string, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw invalid(`${what} must be one of: ${choices.join(', ')}.`);
  return value as T;
}

function flag(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw invalid(`${what} must be true or false.`);
  return value;
}

/** An address a browser may open: http or https, and without a name and password in it. */
function webAddress(value: unknown, what: string): string {
  const s = line(value, what, LIMITS.address);
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw invalid(`${what} is not a web address.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid(`${what} must start with http:// or https://.`);
  if (url.username || url.password) throw invalid(`${what} must not hold a name or a password.`);
  return url.href;
}

function time(value: unknown, what: string): string {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) throw invalid(`${what} is not a time.`);
  return new Date(ms).toISOString();
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Names the routes use, and names Windows will not take for a file. */
const RESERVED = /^(?:export|import|con|prn|aux|nul|com\d|lpt\d)$/;
const ID_MAX = 80;

/** Whether a text can be the id of an application. */
export const isId = (value: unknown): value is string => typeof value === 'string' && value.length <= ID_MAX && ID.test(value) && !RESERVED.test(value);

/** "Staff Technical Writer, Docs & APIs" → "staff-technical-writer-docs-apis". */
export function slug(words: string): string {
  const s = words
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return s && !RESERVED.test(s) ? s : `application${s ? `-${s}` : ''}`;
}

/** An id for a job that no application has yet: "globex-staff-technical-writer", then "...-2". */
export function newId(job: Pick<TrackedJob, 'title' | 'company'>, taken: (id: string) => boolean): string {
  const base = slug(`${job.company} ${job.title}`);
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!taken(id)) return id;
  }
}

/**
 * What two addresses of one posting have in common. The host's case, "www.", a slash at the end, the part after
 * "#" and tracking parameters do not make a posting a different one.
 */
export function postingKey(address: string): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return address.trim();
  }
  const query = [...url.searchParams]
    .filter(([name]) => !/^(?:utm_.*|gh_src)$/i.test(name))
    .map(([name, value]) => `${name}=${value}`)
    .sort()
    .join('&');
  return `${url.host.toLowerCase().replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}${query ? `?${query}` : ''}`;
}

/** How far the labels in a record are believed: the server's own files, a file the user chose, or what an assistant sent. */
type Trust = 'stored' | Actor;

const JOB_PARTS = ['title', 'company', 'location', 'workplace', 'pay', 'postedAt', 'postingUrl', 'listings', 'descriptionHtml', 'descriptionText'] as const;

function readListings(value: unknown, what: string): TrackedListing[] {
  return list(value, what, LIMITS.listings).map((raw, i) => {
    const o = object(raw, `${what}[${i}]`);
    known(o, `${what}[${i}]`, ['via', 'url']);
    const url = missing(o.url) ? undefined : webAddress(o.url, `${what}[${i}].url`);
    return { via: line(o.via, `${what}[${i}].via`), ...(url ? { url } : {}) };
  });
}

function readPostedAt(value: unknown, what: string): string {
  const s = line(value, what, 40);
  if (Number.isNaN(Date.parse(s))) throw invalid(`${what} is not a date.`);
  return s;
}

/** The parts of a job that were given, checked. `whole` asks for the three every job has. */
function readJob(value: unknown, what: string, whole: boolean): Partial<TrackedJob> {
  const o = object(value, what);
  known(o, what, JOB_PARTS);
  const job: Partial<Record<keyof TrackedJob, unknown>> = {};
  for (const part of ['title', 'company'] as const) {
    if (o[part] !== undefined || whole) job[part] = line(o[part], `${what}.${part}`);
  }
  if (o.postingUrl !== undefined || whole) job.postingUrl = webAddress(o.postingUrl, `${what}.postingUrl`);
  // An optional part sent empty takes that part away.
  for (const part of ['location', 'pay'] as const) {
    if (o[part] !== undefined) job[part] = missing(o[part]) ? undefined : line(o[part], `${what}.${part}`);
  }
  if (o.workplace !== undefined) job.workplace = missing(o.workplace) ? undefined : oneOf(o.workplace, `${what}.workplace`, ['remote', 'hybrid', 'onsite'] as const);
  if (o.postedAt !== undefined) job.postedAt = missing(o.postedAt) ? undefined : readPostedAt(o.postedAt, `${what}.postedAt`);
  if (o.listings !== undefined || whole) job.listings = readListings(o.listings, `${what}.listings`);
  for (const part of ['descriptionHtml', 'descriptionText'] as const) {
    if (o[part] !== undefined) job[part] = missing(o[part]) ? undefined : text(o[part], `${what}.${part}`, LIMITS.description);
  }
  return job as Partial<TrackedJob>;
}

/** Leaves out the parts that hold nothing, so a record never says `"pay": undefined`. */
function tidy<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, value]) => value !== undefined)) as T;
}

const fieldId = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || value.length > ID_MAX || !ID.test(value)) throw invalid(`${what} must be lower-case letters, digits and single dashes, at most ${ID_MAX} characters.`);
  return value;
};

const FIELD_PARTS = ['id', 'label', 'kind', 'required', 'value', 'origin', 'status', 'acceptedAt', 'note', 'updatedAt'] as const;

/** A whole field, from a record: a stored one, an imported one, or a new application's. */
function readField(raw: unknown, what: string, trust: Trust): FormField {
  const o = object(raw, what);
  known(o, what, FIELD_PARTS);
  const value = o.value === undefined ? '' : text(o.value, `${what}.value`, LIMITS.value);
  const status = oneOf(o.status, `${what}.status`, FIELD_STATUSES);
  if (status === 'ask' && value !== '') throw invalid(`${what}: a question that waits for the user's answer is empty. With an answer in it, its status is filled or draft.`);
  // A value that does not say who wrote it gets the label that claims the least.
  let origin: Origin | undefined = value === '' ? undefined : o.origin === undefined ? 'assistant' : oneOf(o.origin, `${what}.origin`, ORIGINS);
  let acceptedAt = missing(o.acceptedAt) || origin === undefined || origin === 'user' || status !== 'filled' ? undefined : time(o.acceptedAt, `${what}.acceptedAt`);
  if (trust === 'assistant') {
    // An assistant cannot hand in the user's words, or the user's acceptance.
    if (origin === 'user') origin = 'assistant';
    acceptedAt = undefined;
    if (status === 'yours' && value !== '') throw refused(`${what}: a question that is left to the user stays empty. Only they answer it.`);
  }
  return tidy({
    id: fieldId(o.id, `${what}.id`),
    label: line(o.label, `${what}.label`, LIMITS.label),
    kind: o.kind === undefined ? 'text' : oneOf(o.kind, `${what}.kind`, FIELD_KINDS),
    required: o.required === undefined ? false : flag(o.required, `${what}.required`),
    value,
    origin,
    status,
    acceptedAt,
    note: missing(o.note) ? undefined : text(o.note, `${what}.note`, LIMITS.note).trim() || undefined,
    updatedAt: missing(o.updatedAt) ? undefined : time(o.updatedAt, `${what}.updatedAt`),
  });
}

function readForm(value: unknown, what: string, trust: Trust, fallbackUrl: string): ApplicationForm {
  const o = object(value, what);
  known(o, what, ['url', 'notes', 'fields']);
  const fields = list(o.fields, `${what}.fields`, LIMITS.fields).map((raw, i) => readField(raw, `${what}.fields[${i}]`, trust));
  const twice = fields.find((f, i) => fields.findIndex((g) => g.id === f.id) !== i);
  if (twice) throw invalid(`${what}.fields has two fields with the id "${twice.id}".`);
  return tidy({
    url: missing(o.url) ? fallbackUrl : webAddress(o.url, `${what}.url`),
    notes: missing(o.notes) ? undefined : text(o.notes, `${what}.notes`, LIMITS.formNotes).trim() || undefined,
    fields,
  });
}

const SETTERS = ['user', 'assistant', 'site'] as const;

function readTimeline(value: unknown, what: string, trust: Trust, max: number = LIMITS.timeline): TimelineEntry[] {
  const entries = list(value, what, max).map((raw, i): TimelineEntry => {
    const where = `${what}[${i}]`;
    const o = object(raw, where);
    known(o, where, ['at', 'by', 'kind', 'stage', 'from', 'text']);
    const at = time(o.at, `${where}.at`);
    // A line that does not say who wrote it, and every line an assistant hands in, is an assistant's.
    const by: Setter = trust === 'assistant' || o.by === undefined ? 'assistant' : oneOf(o.by, `${where}.by`, SETTERS);
    const kind = o.kind === undefined ? 'note' : oneOf(o.kind, `${where}.kind`, ['created', 'stage', 'note'] as const);
    if (kind === 'note') return { at, by, kind, text: line(o.text, `${where}.text`, LIMITS.note) };
    if (kind === 'stage') return tidy({ at, by, kind, stage: oneOf(o.stage, `${where}.stage`, STAGES), from: o.from === undefined ? undefined : oneOf(o.from, `${where}.from`, STAGES) });
    return { at, by, kind };
  });
  // Oldest first, and lines of the same moment stay in the order they came.
  return entries.map((entry, i) => ({ entry, i })).sort((a, b) => (a.entry.at < b.entry.at ? -1 : a.entry.at > b.entry.at ? 1 : a.i - b.i)).map(({ entry }) => entry);
}

const APPLICATION_PARTS = ['id', 'revision', 'createdAt', 'updatedAt', 'job', 'stage', 'stageSetBy', 'submittedAt', 'form', 'timeline'] as const;

/** A record the server kept, read back from its file. Every label in it is believed: the server wrote them. */
export function storedApplication(raw: unknown): Application {
  const o = object(raw, 'The record');
  known(o, 'The record', APPLICATION_PARTS);
  if (!isId(o.id)) throw invalid('The record has no usable id.');
  if (typeof o.revision !== 'number' || !Number.isInteger(o.revision) || o.revision < 1) throw invalid('The record has no revision number.');
  const job = readJob(o.job, 'job', true) as TrackedJob;
  const stage = oneOf(o.stage, 'stage', STAGES);
  return tidy({
    id: o.id,
    revision: o.revision,
    createdAt: time(o.createdAt, 'createdAt'),
    updatedAt: time(o.updatedAt, 'updatedAt'),
    job: tidy(job),
    stage,
    stageSetBy: oneOf(o.stageSetBy, 'stageSetBy', SETTERS),
    submittedAt: missing(o.submittedAt) ? undefined : time(o.submittedAt, 'submittedAt'),
    form: o.form === undefined ? undefined : readForm(o.form, 'form', 'stored', job.postingUrl),
    timeline: readTimeline(o.timeline, 'timeline', 'stored'),
  });
}

export interface NewApplicationOptions {
  by: Actor;
  now: Date;
  /** Whether an id is already in use. */
  taken: (id: string) => boolean;
  /** The record comes from a file and not from a request to add one application. */
  imported?: boolean;
}

/**
 * A new application, from what the page, an assistant or a file gave. It gets an id when it brings none, starts at
 * revision 1, and its timeline ends with a line saying who added it.
 *
 * Labels in it are believed only from the user: a file the user chose on the page keeps its "written by the user"
 * marks, which is how an export is put back. From an assistant, every such mark becomes "assistant".
 */
export function newApplication(raw: unknown, options: NewApplicationOptions): Application {
  const { by, taken } = options;
  const now = options.now.toISOString();
  const o = object(raw, 'The application');
  known(o, 'The application', APPLICATION_PARTS);
  const job = tidy(readJob(o.job, 'job', true) as TrackedJob);
  let id: string;
  if (missing(o.id)) id = newId(job, taken);
  else if (isId(o.id)) id = o.id;
  else throw invalid(`The id must be lower-case letters, digits and single dashes, at most ${ID_MAX} characters, and not a reserved name.`);
  const stage = o.stage === undefined ? 'saved' : oneOf(o.stage, 'stage', STAGES);
  // In a file, a stage that does not say who set it was set by whoever wrote the file: an assistant.
  const said = o.stageSetBy === undefined ? (options.imported ? 'assistant' : by) : oneOf(o.stageSetBy, 'stageSetBy', SETTERS);
  const sent = stageGroup(stage) === 'sent' ? (missing(o.submittedAt) ? now : time(o.submittedAt, 'submittedAt')) : undefined;
  return tidy({
    id,
    revision: 1,
    createdAt: missing(o.createdAt) ? now : time(o.createdAt, 'createdAt'),
    updatedAt: now,
    job,
    stage,
    stageSetBy: by === 'assistant' ? 'assistant' : said,
    submittedAt: sent,
    form: o.form === undefined ? undefined : readForm(o.form, 'form', by, job.postingUrl),
    // One line fewer than a record may hold, to leave room for the line that says who added it.
    timeline: [...readTimeline(o.timeline, 'timeline', by, LIMITS.timeline - 1), { at: now, by, kind: 'created' as const }],
  });
}

const CHANGE_PARTS = ['job', 'stage', 'form', 'fields', 'removeFields', 'note'] as const;
const FIELD_CHANGE_PARTS = ['id', 'label', 'kind', 'required', 'value', 'status', 'note', 'origin'] as const;

/** Whether an assistant must leave this answer as it is: the user wrote it, or settled it. */
const isUsers = (field: FormField) => field.origin === 'user' || field.acceptedAt !== undefined;

function changeField(old: FormField | undefined, raw: unknown, what: string, by: Actor, now: string): FormField {
  const o = object(raw, what);
  known(o, what, FIELD_CHANGE_PARTS);
  const id = fieldId(o.id, `${what}.id`);
  const name = `"${(old?.label ?? (typeof o.label === 'string' ? o.label : id)).slice(0, 80)}"`;
  // Only an assistant says where a value came from, and the only thing it can say is "the live form".
  const fromForm = o.origin === undefined ? false : by === 'assistant' && oneOf(o.origin, `${what}.origin`, ['form'] as const) === 'form';
  if (o.origin !== undefined && by === 'user') throw invalid(`${what}.origin: what the user saves on the page is the user's. It is not given an origin.`);

  const value = o.value === undefined ? (old?.value ?? '') : text(o.value, `${what}.value`, LIMITS.value);
  if (o.status === undefined && !old) throw invalid(`${what}.status is needed for a new field: ${FIELD_STATUSES.join(', ')}.`);
  let status = o.status === undefined ? old!.status : oneOf(o.status, `${what}.status`, FIELD_STATUSES);
  const valueChanged = value !== (old?.value ?? '');
  const statusChanged = status !== old?.status;

  if (by === 'assistant') {
    if (old && isUsers(old) && (valueChanged || statusChanged)) {
      throw refused(`${name} holds the user's own words, or an answer they accepted. An assistant cannot change it. Add a note to the application instead.`);
    }
    if (old?.origin === 'form' && ((valueChanged && !fromForm) || statusChanged)) {
      throw refused(`${name} was read from the live form, where the user may have typed it. An assistant can only replace it with a newer reading of the form ("origin": "form").`);
    }
    if (old?.status === 'yours' && statusChanged) throw refused(`${name} is left to the user. Only they can change that.`);
    if (status === 'yours' && value !== '' && (valueChanged || statusChanged)) {
      throw refused(`${name} is left to the user, so it stays empty. Send an empty value with the status "yours".`);
    }
  }

  const next: FormField = old ? { ...old } : { id, label: '', kind: 'text', required: false, value: '', status };
  if (o.label !== undefined || !old) next.label = line(o.label, `${what}.label`, LIMITS.label);
  if (o.kind !== undefined) next.kind = oneOf(o.kind, `${what}.kind`, FIELD_KINDS);
  if (o.required !== undefined) next.required = flag(o.required, `${what}.required`);
  if (o.note !== undefined) next.note = missing(o.note) ? undefined : text(o.note, `${what}.note`, LIMITS.note).trim() || undefined;

  if (valueChanged) {
    next.value = value;
    next.origin = value === '' ? undefined : by === 'user' ? 'user' : fromForm ? 'form' : 'assistant';
    next.acceptedAt = undefined;
    // Rewriting a draft settles it, and so does answering a question that waited for the user, unless they say otherwise.
    if (by === 'user' && o.status === undefined && value !== '' && (old?.status === 'draft' || old?.status === 'ask')) status = 'filled';
  }
  if (status === 'ask' && value !== '') throw invalid(`${name} waits for the user's answer, so it is empty. Send the answer with the status "filled" or "draft".`);
  next.status = status;
  if (by === 'user' && !valueChanged && old?.status === 'draft' && status === 'filled' && old.origin !== undefined && old.origin !== 'user') {
    // The user keeps a draft as it is. The words stay marked as someone else's, and the acceptance is marked too.
    next.acceptedAt = now;
  }
  if (status !== 'filled') next.acceptedAt = undefined;
  if (valueChanged || next.status !== old?.status) next.updatedAt = now;
  return tidy(next);
}

export interface ChangeOptions {
  by: Actor;
  now: Date;
}

/**
 * Applies a change to an application: any of `job` (the parts to replace), `stage`, `form` ({ url, notes }),
 * `fields` (answers to add or change, by id), `removeFields` (ids) and `note` (a line for the timeline).
 *
 * It is all or nothing: one part that is wrong or not allowed, and nothing changes. A change that changes nothing
 * returns the application as it was, with the same revision.
 */
export function changeApplication(app: Application, raw: unknown, options: ChangeOptions): Application {
  const { by } = options;
  const now = options.now.toISOString();
  const c = object(raw, 'The change');
  known(c, 'The change', CHANGE_PARTS);
  const next: Application = { ...app, job: { ...app.job }, timeline: [...app.timeline] };

  if (c.job !== undefined) next.job = tidy({ ...app.job, ...readJob(c.job, 'job', false) });

  const fieldChanges = list(c.fields, 'fields', LIMITS.fields);
  const removals = list(c.removeFields, 'removeFields', LIMITS.fields).map((id, i) => fieldId(id, `removeFields[${i}]`));
  if (c.form !== undefined || fieldChanges.length || removals.length) {
    if (by === 'assistant' && stageGroup(app.stage) !== 'open' && (fieldChanges.length || removals.length)) {
      throw refused(`This application is marked "${STAGE_LABEL[app.stage]}". Its answers are the record of what was sent, and an assistant cannot change them.`);
    }
    const form: ApplicationForm = app.form ? { ...app.form, fields: [...app.form.fields] } : { url: next.job.postingUrl, fields: [] };
    if (c.form !== undefined) {
      const f = object(c.form, 'form');
      known(f, 'form', ['url', 'notes']);
      if (f.url !== undefined) form.url = webAddress(f.url, 'form.url');
      if (f.notes !== undefined) form.notes = missing(f.notes) ? undefined : text(f.notes, 'form.notes', LIMITS.formNotes).trim() || undefined;
    }
    fieldChanges.forEach((raw, i) => {
      const id = fieldId(object(raw, `fields[${i}]`).id, `fields[${i}].id`);
      const at = form.fields.findIndex((f) => f.id === id);
      const changed = changeField(at < 0 ? undefined : form.fields[at], raw, `fields[${i}]`, by, now);
      if (at < 0) form.fields.push(changed);
      else form.fields[at] = changed;
    });
    for (const id of removals) {
      const old = form.fields.find((f) => f.id === id);
      if (!old) continue;
      if (by === 'assistant' && (isUsers(old) || old.origin === 'form' || old.status === 'yours')) {
        throw refused(`"${old.label.slice(0, 80)}" is the user's, or left to the user. An assistant cannot remove it.`);
      }
      form.fields = form.fields.filter((f) => f !== old);
    }
    if (form.fields.length > LIMITS.fields) throw invalid(`An application holds at most ${LIMITS.fields} fields.`);
    next.form = tidy(form);
  }

  if (c.stage !== undefined) {
    const stage = oneOf(c.stage, 'stage', STAGES);
    if (stage !== app.stage) {
      const from = stageGroup(app.stage);
      const to = stageGroup(stage);
      if (by === 'assistant' && from !== 'open' && to === 'open') {
        throw refused(`This application is marked "${STAGE_LABEL[app.stage]}". Only the user opens it again.`);
      }
      next.stage = stage;
      next.stageSetBy = by;
      if (to === 'sent' && !app.submittedAt) next.submittedAt = now;
      if (to === 'open') next.submittedAt = undefined;
      next.timeline.push({ at: now, by, kind: 'stage', stage, from: app.stage });
    }
  }

  if (c.note !== undefined) next.timeline.push({ at: now, by, kind: 'note', text: line(c.note, 'note', LIMITS.note) });
  if (next.timeline.length > app.timeline.length && next.timeline.length > LIMITS.timeline) throw invalid(`An application's timeline holds at most ${LIMITS.timeline} lines.`);

  const result = tidy(next);
  if (JSON.stringify(result) === JSON.stringify(app)) return app;
  return { ...result, revision: app.revision + 1, updatedAt: now };
}

export interface Left {
  /** Questions that wait for an answer only the user knows. */
  asks: FormField[];
  /** First drafts the user still reviews or rewrites. */
  drafts: FormField[];
  /** Required questions only the user answers, on the form itself. */
  yours: FormField[];
  /** The same, for questions the form does not require. */
  optional: FormField[];
}

/** What is left for the user before this application can be sent. Nothing, once it was sent or it ended. */
export function leftForUser(app: Application): Left {
  const fields = stageGroup(app.stage) === 'open' ? (app.form?.fields ?? []) : [];
  return {
    asks: fields.filter((f) => f.status === 'ask'),
    drafts: fields.filter((f) => f.status === 'draft'),
    yours: fields.filter((f) => f.status === 'yours' && f.required),
    optional: fields.filter((f) => f.status === 'yours' && !f.required),
  };
}

export function summarize(app: Application): ApplicationSummary {
  const left = leftForUser(app);
  return tidy({
    id: app.id,
    revision: app.revision,
    title: app.job.title,
    company: app.job.company,
    location: app.job.location,
    postingUrl: app.job.postingUrl,
    stage: app.stage,
    stageSetBy: app.stageSetBy,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    submittedAt: app.submittedAt,
    fields: app.form?.fields.length ?? 0,
    asks: left.asks.length,
    drafts: left.drafts.length,
    yours: left.yours.length,
  });
}

/** The applications as one file, for a backup or for moving them. */
export function toFile(applications: Application[], now: Date): ApplicationsFile {
  return { format: FILE_FORMAT, version: FILE_VERSION, exportedAt: now.toISOString(), applications };
}

/** The entries of a file of applications. Each one is read on its own afterwards, so one bad entry does not spoil the rest. */
export function fileEntries(raw: unknown): unknown[] {
  const o = object(raw, 'The file');
  if (o.format !== FILE_FORMAT) throw invalid(`This is not a file of applications from this app: it does not say "format": "${FILE_FORMAT}".`);
  if (o.version !== FILE_VERSION) throw invalid(`This file is version ${JSON.stringify(o.version)?.slice(0, 20)} of the format, and this app reads version ${FILE_VERSION}.`);
  known(o, 'The file', ['format', 'version', 'exportedAt', 'applications']);
  if (!Array.isArray(o.applications)) throw invalid('The file has no list of applications.');
  return o.applications;
}
