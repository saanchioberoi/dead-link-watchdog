const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const db = require("./db");
const { checkLink } = require("./checker");
const { startScheduler } = require("./scheduler");

const app = express();
app.use(cors());
app.use(express.json());

function logEvent(linkId, type, detail) {
  db.prepare(
    "INSERT INTO events (link_id, type, detail) VALUES (?, ?, ?)"
  ).run(linkId, type, detail || null);
}

function serializeLink(row) {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    lastOkAt: row.last_ok_at,
    lastArchiveUrl: row.last_archive_url,
    lastArchiveError: row.last_archive_error,
    checkIntervalHours: row.check_interval_hours,
    createdAt: row.created_at,
  };
}

// List all links
app.get("/api/links", (req, res) => {
  const rows = db.prepare("SELECT * FROM links ORDER BY created_at DESC").all();
  res.json(rows.map(serializeLink));
});

// Add a new link
app.post("/api/links", (req, res) => {
  const { url, title, checkIntervalHours } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "A valid http(s) URL is required." });
  }
  try {
    const stmt = db.prepare(
      "INSERT INTO links (url, title, check_interval_hours) VALUES (?, ?, ?)"
    );
    const info = stmt.run(url.trim(), title || null, checkIntervalHours || 168);
    const row = db.prepare("SELECT * FROM links WHERE id = ?").get(info.lastInsertRowid);
    res.status(201).json(serializeLink(row));
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "That URL is already being watched." });
    }
    res.status(500).json({ error: "Could not save link." });
  }
});

// Delete a link
app.delete("/api/links/:id", (req, res) => {
  db.prepare("DELETE FROM links WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// Get event history for a link
app.get("/api/links/:id/events", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM events WHERE link_id = ? ORDER BY created_at DESC LIMIT 50")
    .all(req.params.id);
  res.json(rows);
});

// Manually trigger a check right now
app.post("/api/links/:id/check", async (req, res) => {
  const link = db.prepare("SELECT * FROM links WHERE id = ?").get(req.params.id);
  if (!link) return res.status(404).json({ error: "Link not found." });

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

  const updated = db.prepare("SELECT * FROM links WHERE id = ?").get(link.id);
  res.json(serializeLink(updated));
});

// Serve the built frontend (frontend/dist) if it exists, so the whole app
// can deploy as a single web service instead of two separate ones.
const FRONTEND_DIST = path.join(__dirname, "..", "..", "frontend", "dist");
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST));
  app.get("*", (req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, "index.html"));
  });
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Dead Link Watchdog API running on http://localhost:${PORT}`);
  startScheduler(); // begin periodic background checks
});
