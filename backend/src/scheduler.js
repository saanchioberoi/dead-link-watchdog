const cron = require("node-cron");
const db = require("./db");
const { checkLink } = require("./checker");

function logEvent(linkId, type, detail) {
  db.prepare(
    "INSERT INTO events (link_id, type, detail) VALUES (?, ?, ?)"
  ).run(linkId, type, detail || null);
}

async function runDueChecks() {
  const dueLinks = db
    .prepare(
      `SELECT * FROM links
       WHERE last_checked_at IS NULL
          OR datetime(last_checked_at, '+' || check_interval_hours || ' hours') <= datetime('now')`
    )
    .all();

  if (dueLinks.length === 0) return;
  console.log(`[scheduler] Checking ${dueLinks.length} due link(s)...`);

  for (const link of dueLinks) {
    const result = await checkLink(link);
    const now = new Date().toISOString();

    db.prepare(
      `UPDATE links SET
         status = ?, last_checked_at = ?, last_hash = ?, last_snapshot_text = ?,
         last_archive_url = COALESCE(?, last_archive_url),
         last_archive_error = ?,
         last_ok_at = CASE WHEN ? = 'ok' THEN ? ELSE last_ok_at END
       WHERE id = ?`
    ).run(
      result.status,
      now,
      result.hash,
      result.snapshotText,
      result.archiveUrl,
      result.archiveError,
      result.status,
      now,
      link.id
    );

    logEvent(
      link.id,
      result.status === "ok" ? "checked" : result.status,
      result.status === "changed"
        ? `Content changed ~${Math.round(result.changeRatio * 100)}%`
        : result.error || null
    );

    if (result.archiveError) {
      logEvent(link.id, "archive_failed", result.archiveError);
    }

    if (result.status !== "ok") {
      // This is where a real deployment would send an email/push notification.
      console.log(`[scheduler] ALERT: ${link.url} is now "${result.status}"`);
    }
  }
}

function startScheduler() {
  // Runs every 15 minutes; each run only processes links whose interval has elapsed.
  cron.schedule("*/15 * * * *", () => {
    runDueChecks().catch((err) => console.error("[scheduler] error:", err));
  });
  // Also run once on boot so new links get an initial check quickly.
  runDueChecks().catch((err) => console.error("[scheduler] error:", err));
  console.log("[scheduler] Started — checking every 15 minutes for due links.");
}

module.exports = { startScheduler, runDueChecks };
