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

// Ordered schema migrations. Append only — never edit or reorder an entry that
// has shipped, or databases created by an earlier release will disagree with
// ones created by a later one. `PRAGMA user_version` records how many have been
// applied, so a self-hoster's /data volume converges on the current schema
// whichever release it was created by.
//
// Migration 1 is deliberately `if not exists`: volumes created before
// migrations existed already have these tables at user_version 0, and this
// makes them adopt the sequence as a no-op rather than needing a special case.
const MIGRATIONS: string[] = [
  // 1 — initial schema (everything that shipped before migrations existed).
  `
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
  `,
];

// Copy the database aside before the first schema change is applied to it, so a
// migration that goes wrong on someone's production volume is recoverable by
// swapping the file back rather than by restoring a backup they may not have.
// Checkpointing first folds the WAL into the main file, which is what makes a
// plain file copy a complete one.
function backupBeforeMigrating(db: Database.Database, dbPath: string, from: number): void {
  const dest = `${dbPath}.bak-v${from}`;
  db.pragma("wal_checkpoint(TRUNCATE)");
  fs.copyFileSync(dbPath, dest);
  console.log(`[local] backed up ${path.basename(dbPath)} to ${path.basename(dest)} before migrating`);
}

function migrate(db: Database.Database, dbPath: string, isNewDb: boolean): void {
  const current = db.pragma("user_version", { simple: true }) as number;

  if (current > MIGRATIONS.length) {
    // The volume was last used by a newer release. Running the older schema
    // against it would half-work and corrupt data in ways that surface much
    // later, so refuse instead — downgrades are not supported.
    throw new Error(
      `[local] ${dbPath} is at schema version ${current}, but this build only knows ` +
        `${MIGRATIONS.length}. It was created by a newer version of Presio; ` +
        `upgrade the image back, or start from a fresh data directory.`,
    );
  }

  if (current === MIGRATIONS.length) return;

  if (!isNewDb) backupBeforeMigrating(db, dbPath, current);

  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version];
    // Each step commits with its own user_version bump, so an interrupted
    // upgrade resumes at the right place rather than replaying applied steps.
    db.exec(`begin; ${sql}; pragma user_version = ${version + 1}; commit;`);
    if (!isNewDb) console.log(`[local] applied schema migration ${version + 1}`);
  }
}

export function openLocalDb(): Database.Database {
  const dbPath = localDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const isNewDb = !fs.existsSync(dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  migrate(db, dbPath, isNewDb);
  return db;
}
