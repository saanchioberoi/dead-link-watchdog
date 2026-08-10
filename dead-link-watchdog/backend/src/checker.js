const crypto = require("crypto");
const fetch = require("node-fetch");

const FETCH_TIMEOUT_MS = 15000;
const CHANGE_THRESHOLD = 0.15; // fraction of content that must differ to count as "changed"

/**
 * Strip a raw HTML string down to readable text.
 * Not a full readability engine, but removes script/style/nav noise
 * so we're not diffing on ads, timestamps, or tracking pixels.
 */
function extractReadableText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Rough similarity between two text blobs using word-level Jaccard distance.
 * Cheap, no external deps, good enough to filter out "a few words changed"
 * from "this is basically a different page."
 */
function diffRatio(oldText, newText) {
  if (!oldText) return 1;
  const a = new Set(oldText.toLowerCase().split(/\W+/).filter(Boolean));
  const b = new Set(newText.toLowerCase().split(/\W+/).filter(Boolean));
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  const union = new Set([...a, ...b]).size;
  const similarity = union === 0 ? 1 : shared / union;
  return 1 - similarity; // 0 = identical, 1 = completely different
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...opts,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "DeadLinkWatchdog/1.0 (+personal knowledge base link monitor)",
        ...(opts.headers || {}),
      },
    });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Ping the Wayback Machine's "Save Page Now" endpoint so an independent
 * public archive exists even if our own DB/storage is lost.
 * Best-effort: failures here should never block the health check itself.
 */
async function archiveToWayback(url) {
  try {
    const res = await fetchWithTimeout(
      `https://web.archive.org/save/${encodeURIComponent(url)}`,
      { method: "GET" }
    );
    if (res.ok) {
      return `https://web.archive.org/web/${Date.now()}/${url}`;
    }
    return null;
  } catch {
    return null; // archiving is a bonus, not a blocker
  }
}

/**
 * Check a single link: is it alive, and has its content meaningfully changed
 * since the last snapshot we stored?
 */
async function checkLink(link) {
  const result = {
    status: "unknown",
    httpStatus: null,
    finalUrl: link.url,
    hash: link.last_hash,
    snapshotText: link.last_snapshot_text,
    changeRatio: 0,
    archiveUrl: link.last_archive_url,
    error: null,
  };

  try {
    const res = await fetchWithTimeout(link.url);
    result.httpStatus = res.status;
    result.finalUrl = res.url || link.url;

    if (!res.ok) {
      result.status = "dead";
      return result;
    }

    const html = await res.text();
    const text = extractReadableText(html).slice(0, 20000); // cap stored size
    const newHash = hashText(text);

    if (!link.last_hash) {
      // first time we've ever seen this page
      result.status = "ok";
    } else if (newHash === link.last_hash) {
      result.status = "ok";
    } else {
      const ratio = diffRatio(link.last_snapshot_text || "", text);
      result.changeRatio = ratio;
      result.status = ratio >= CHANGE_THRESHOLD ? "changed" : "ok";
    }

    result.hash = newHash;
    result.snapshotText = text;

    // Only spend an archive call when something is new or different,
    // to avoid hammering the Wayback API for unchanged pages.
    if (result.status !== "ok" || !link.last_archive_url) {
      const archiveUrl = await archiveToWayback(link.url);
      if (archiveUrl) result.archiveUrl = archiveUrl;
    }

    return result;
  } catch (err) {
    result.status = "dead";
    result.error = err.message;
    return result;
  }
}

module.exports = { checkLink, extractReadableText, hashText, diffRatio };
