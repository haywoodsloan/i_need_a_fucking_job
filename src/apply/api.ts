/**
 * The routes of the application tracker as the browser and the server both see them: what is sent and what comes
 * back. The server's side is server/src/applications/http.ts, the page's side is client.ts in this folder.
 * docs/applications.md describes the routes for anyone who calls them by hand.
 */
import type { Actor, Application, ApplicationSummary, FieldKind, FieldStatus, Stage, TrackedJob } from './model';

/** A file in the tracker's folder that is not a readable application. It is left alone and named, never replaced. */
export interface UnreadableFile {
  file: string;
  why: string;
}

/** GET /api/applications */
export interface ApplicationsReply {
  /** False when this server keeps no applications (see docs/applications.md, "Where the tracker is on"). */
  available: boolean;
  applications: ApplicationSummary[];
  unreadable?: UnreadableFile[];
}

/** GET /api/applications/<id>, and POST /api/applications/<id> */
export interface ApplicationReply {
  application: Application;
}

/** POST /api/applications */
export interface AddRequest {
  /** Who is adding it. Left out, it is an assistant: only the app's own page says `user`. */
  by?: Actor;
  application: unknown;
}

export interface AddReply {
  application: Application;
  /** True when this posting was tracked already. Nothing was added, and `application` is the one that was there. */
  existed: boolean;
}

/** A change to one answer, or a new question. Only the parts that are sent change. */
export interface FieldChange {
  id: string;
  /** Needed for a new question. */
  label?: string;
  kind?: FieldKind;
  required?: boolean;
  value?: string;
  /** Needed for a new question. */
  status?: FieldStatus;
  note?: string;
  /** Only from an assistant, and only "form": the value was read back from the live form. */
  origin?: 'form';
}

/** What a change may hold. `changeApplication` in model.ts reads it, and says what each part does. */
export interface Changes {
  /** The parts of the job to replace. */
  job?: Partial<TrackedJob>;
  stage?: Stage;
  form?: { url?: string; notes?: string };
  /** Answers to add or change, by id. */
  fields?: FieldChange[];
  /** Ids of questions to take out. */
  removeFields?: string[];
  /** A line for the application's history. */
  note?: string;
}

/** POST /api/applications/<id> */
export interface ChangeRequest {
  by?: Actor;
  /** The revision the change was made against. Given, the change is refused when the application moved on since. */
  revision?: number;
  /** A `Changes`. The server reads it strictly, so it is typed as unknown there. */
  changes: unknown;
}

/** POST /api/applications/<id>/remove */
export interface RemoveRequest {
  by: 'user';
}

/** POST /api/applications/import */
export interface ImportRequest {
  by?: Actor;
  file: unknown;
}

export interface ImportReply {
  /** The ids of the applications that were added. */
  added: string[];
  /** The entries that were not, each with the reason. */
  skipped: { what: string; why: string }[];
}

export type TrackerErrorCode =
  /** The request is not one this route understands. */
  | 'bad_request'
  /** What was sent is not an application, or not a change to one. */
  | 'invalid'
  /** The change is one its sender may not make: see the rules in model.ts. */
  | 'refused'
  /** The application changed since the revision the request named. The reply carries it as it is now. */
  | 'changed'
  /** An application with this id exists already. */
  | 'exists'
  /** The tracker holds as many applications as it takes. */
  | 'full'
  | 'not_found'
  /** The request did not come from the computer the server runs on. */
  | 'not_local'
  /** The request came from a page that is not the app's own. */
  | 'bad_origin'
  | 'server_error';

/** Every failed reply has this body. `error` is a sentence that can be shown as it is. */
export interface TrackerErrorReply {
  error: string;
  code: TrackerErrorCode;
  /** With `changed`. */
  application?: Application;
}
