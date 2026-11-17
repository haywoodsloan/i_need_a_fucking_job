/**
 * The database schema, as an ordered list of changes. A change that has shipped is never edited: add a new one.
 *
 * Times are always passed in by the server and never taken from the database clock, so tests can control them.
 * docs/accounts.md says what each column is for.
 */
import type { Migration } from './db';

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'accounts',
    sql: `
      create table users (
        id uuid primary key,
        email text not null unique,
        role text not null check (role in ('user', 'admin')),
        created_at timestamptz not null,
        kdf jsonb not null,
        salt bytea not null,
        pepper_version integer not null,
        verifier bytea not null,
        password_changed_at timestamptz not null,
        vault_generation integer not null,
        vault_by_password bytea not null,
        recovery_salt bytea not null,
        vault_by_recovery bytea not null
      );

      create table invites (
        id uuid primary key,
        code_hash bytea not null unique,
        kind text not null check (kind in ('invite', 'reset')),
        email text not null,
        role text not null check (role in ('user', 'admin')),
        created_at timestamptz not null,
        expires_at timestamptz not null,
        used_at timestamptz
      );
      create index invites_email on invites (email);

      create table sessions (
        sid bytea primary key,
        public_id uuid not null unique,
        user_id uuid not null references users (id) on delete cascade,
        created_at timestamptz not null,
        last_seen_at timestamptz not null,
        expires_at timestamptz not null,
        user_agent text not null,
        vault_by_session bytea,
        vault_expires_at timestamptz
      );
      create index sessions_user on sessions (user_id);

      create table audit_log (
        id bigint generated always as identity primary key,
        at timestamptz not null,
        user_id uuid,
        event text not null,
        detail jsonb not null
      );
      create index audit_log_user on audit_log (user_id, at)
    `,
  },
];
