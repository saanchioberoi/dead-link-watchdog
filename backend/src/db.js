const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "..", "watchdog.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'unknown',   -- unknown | ok | changed | dead
    last_checked_at TEXT,
    last_ok_at TEXT,
    last_hash TEXT,
    last_snapshot_text TEXT,
    last_archive_url TEXT,
    last_archive_error TEXT,
    check_interval_hours INTEGER NOT NULL DEFAULT 168, -- weekly by default
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id INTEGER NOT NULL,
    type TEXT NOT NULL,     -- checked | changed | dead | recovered | archived
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE
  );
`);

// Safe migration: if this file already existed from before last_archive_error
// was added, ALTER it in rather than requiring a manual DB reset.
try {
  db.exec("ALTER TABLE links ADD COLUMN last_archive_error TEXT");
} catch {
  // column already exists — nothing to do
}

module.exports = db;
