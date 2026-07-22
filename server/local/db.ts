// SQLite-backed replacement for the `sessions` + `newsletter_signups` tables
// dbschema.sql creates in Postgres. Timestamps are stored as
// strftime('%Y-%m-%dT%H:%M:%fZ', ...) so they're byte-identical in format to
// JS's Date#toISOString() — the route code compares expires_at against
// `new Date().toISOString()` as plain text, so the two need to sort the same way.
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { localDbPath } from "./paths.js";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const NOW_PLUS_24H = "strftime('%Y-%m-%dT%H:%M:%fZ','now','+24 hours')";

const SCHEMA = `
create table if not exists sessions (
  id text primary key,
  pdf_path text not null default '',
  pdf_url text not null default '',
  filename text not null,
  total_slides integer not null,
  current_slide integer not null default 1,
  controller_token text not null,
  passphrase text not null,
  note_prefix text not null default 'note:',
  local integer not null default 0,
  user_id text,
  status text not null default 'active',
  created_at text not null default (${NOW}),
  expires_at text not null default (${NOW_PLUS_24H})
);

create index if not exists idx_sessions_expires_at on sessions (expires_at);

create table if not exists newsletter_signups (
  email text primary key,
  created_at text not null default (${NOW})
);
`;

export function openLocalDb(): Database.Database {
  const dbPath = localDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}
