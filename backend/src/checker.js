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

async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
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
 * Submit a URL to the Wayback Machine's "Save Page Now 2" API so an
 * independent public archive exists even if our own DB/storage is lost.
 *
 * As of 2023+, archive.org's Save Page Now no longer reliably accepts
 * anonymous requests — it needs a free archive.org account's S3-style
 * API keys, sent as an "Authorization: LOW <access>:<secret>" header.
 * Get keys at https://archive.org/account/s3.php (free, instant) and
 * set them as ARCHIVE_ACCESS_KEY / ARCHIVE_SECRET_KEY env vars.
 *
 * Best-effort: failures here should never block the health check itself.
 */
const ARCHIVE_TIMEOUT_MS = 30000; // Save Page Now is often slow; give it more room than a normal fetch
const ARCHIVE_POLL_ATTEMPTS = 3;
const ARCHIVE_POLL_DELAY_MS = 4000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function archiveToWayback(url) {
  const accessKey = process.env.ARCHIVE_ACCESS_KEY;
  const secretKey = process.env.ARCHIVE_SECRET_KEY;

  if (!accessKey || !secretKey) {
    return {
      archiveUrl: null,
      error:
        "No archive.org API keys configured (set ARCHIVE_ACCESS_KEY / ARCHIVE_SECRET_KEY)",
    };
  }

  const authHeader = `LOW ${accessKey}:${secretKey}`;

  try {
    // Step 1: submit the save request. Returns a job_id to poll, not the
    // finished archive URL — Save Page Now is asynchronous.
    const submitRes = await fetchWithTimeout(
      "https://web.archive.org/save/",
      {
        method: "POST",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `url=${encodeURIComponent(url)}&skip_first_archive=1`,
      },
      ARCHIVE_TIMEOUT_MS
    );

    if (!submitRes.ok) {
      return { archiveUrl: null, error: `Wayback submit returned HTTP ${submitRes.status}` };
    }

    const submitData = await submitRes.json();
    if (submitData.status === "error") {
      return { archiveUrl: null, error: submitData.message || "Wayback rejected the request" };
    }

    const jobId = submitData.job_id;
    if (!jobId) {
      return { archiveUrl: null, error: "Wayback did not return a job id" };
    }

    // Step 2: poll job status a few times. If it finishes in time, we get
    // an exact snapshot URL; if not, we still link to the URL's capture
    // history so the person can check back once indexing catches up.
    for (let attempt = 0; attempt < ARCHIVE_POLL_ATTEMPTS; attempt++) {
      await sleep(ARCHIVE_POLL_DELAY_MS);
      const statusRes = await fetchWithTimeout(
        `https://web.archive.org/save/status/${jobId}`,
        { headers: { Authorization: authHeader, Accept: "application/json" } },
        ARCHIVE_TIMEOUT_MS
      );
      if (!statusRes.ok) continue;
      const statusData = await statusRes.json();

      if (statusData.status === "success") {
        const timestamp = statusData.timestamp;
        const originalUrl = statusData.original_url || url;
        return {
          archiveUrl: `https://web.archive.org/web/${timestamp}/${originalUrl}`,
          error: null,
        };
      }
      if (statusData.status === "error") {
        return { archiveUrl: null, error: statusData.message || "Wayback archive job failed" };
      }
      // status "pending" — keep polling
    }

    // Job queued successfully but didn't finish within our polling budget.
    // Link to the capture history page rather than guessing a timestamp.
    return {
      archiveUrl: `https://web.archive.org/web/*/${url}`,
      error: null,
    };
  } catch (err) {
    const reason = err.name === "AbortError" ? "Wayback request timed out" : err.message;
    return { archiveUrl: null, error: reason };
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
    archiveError: null,
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
      const archived = await archiveToWayback(link.url);
      if (archived.archiveUrl) result.archiveUrl = archived.archiveUrl;
      result.archiveError = archived.error;
    }

    return result;
  } catch (err) {
    result.status = "dead";
    result.error = err.message;
    return result;
  }
}

module.exports = { checkLink, extractReadableText, hashText, diffRatio };
