import { useEffect, useState, useCallback } from "react";

const STATUS_STYLES = {
  ok: { label: "Alive", color: "#1a7f37", bg: "#dafbe1" },
  changed: { label: "Content changed", color: "#9a6700", bg: "#fff8c5" },
  dead: { label: "Dead / unreachable", color: "#cf222e", bg: "#ffebe9" },
  unknown: { label: "Not checked yet", color: "#57606a", bg: "#f0f1f2" },
};

function StatusBadge({ status }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.unknown;
  return (
    <span
      style={{
        color: s.color,
        background: s.bg,
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {s.label}
    </span>
  );
}

function timeAgo(iso) {
  if (!iso) return "never";
  // last_checked_at is stored as a full ISO string (already includes Z),
  // so it should be parsed as-is rather than appending another Z.
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function App() {
  const [links, setLinks] = useState([]);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingId, setCheckingId] = useState(null);
  const [error, setError] = useState("");

  const loadLinks = useCallback(async () => {
    const res = await fetch("/api/links");
    setLinks(await res.json());
  }, []);

  useEffect(() => {
    loadLinks();
    const interval = setInterval(loadLinks, 30000); // refresh every 30s
    return () => clearInterval(interval);
  }, [loadLinks]);

  async function addLink(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, title }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to add link");
      setUrl("");
      setTitle("");
      await loadLinks();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function checkNow(id) {
    setCheckingId(id);
    try {
      await fetch(`/api/links/${id}/check`, { method: "POST" });
      await loadLinks();
    } finally {
      setCheckingId(null);
    }
  }

  async function removeLink(id) {
    await fetch(`/api/links/${id}`, { method: "DELETE" });
    await loadLinks();
  }

  return (
    <div
      style={{
        maxWidth: 780,
        margin: "0 auto",
        padding: "40px 20px",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        color: "#1f2328",
      }}
    >
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>🕸️ Dead Link Watchdog</h1>
      <p style={{ color: "#57606a", marginTop: 0, marginBottom: 28 }}>
        Watches your saved links, detects when they die or change, and
        archives them to the Wayback Machine before it's too late.
      </p>

      <form
        onSubmit={addLink}
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 8,
          flexWrap: "wrap",
        }}
      >
        <input
          type="url"
          required
          placeholder="https://example.com/article"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{
            flex: "2 1 260px",
            padding: "8px 12px",
            border: "1px solid #d0d7de",
            borderRadius: 6,
            fontSize: 14,
          }}
        />
        <input
          type="text"
          placeholder="Title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={{
            flex: "1 1 160px",
            padding: "8px 12px",
            border: "1px solid #d0d7de",
            borderRadius: 6,
            fontSize: 14,
          }}
        />
        <button
          type="submit"
          disabled={loading}
          style={{
            padding: "8px 18px",
            background: "#1f883d",
            color: "white",
            border: "none",
            borderRadius: 6,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {loading ? "Adding..." : "Watch link"}
        </button>
      </form>
      {error && <p style={{ color: "#cf222e", marginTop: 4 }}>{error}</p>}

      <div style={{ marginTop: 28 }}>
        {links.length === 0 && (
          <p style={{ color: "#57606a" }}>
            No links watched yet — add one above to get started.
          </p>
        )}
        {links.map((link) => (
          <div
            key={link.id}
            style={{
              border: "1px solid #d0d7de",
              borderRadius: 8,
              padding: 14,
              marginBottom: 10,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 600,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {link.title || link.url}
              </div>
              <a
                href={link.url}
                target="_blank"
                rel="noreferrer"
                style={{
                  fontSize: 13,
                  color: "#57606a",
                  textDecoration: "none",
                }}
              >
                {link.url}
              </a>
              <div style={{ fontSize: 12, color: "#8b949e", marginTop: 4 }}>
                Checked {timeAgo(link.lastCheckedAt)}
                {link.lastArchiveUrl && (
                  <>
                    {" · "}
                    <a
                      href={link.lastArchiveUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      view archive
                    </a>
                  </>
                )}
                {!link.lastArchiveUrl && link.lastArchiveError && (
                  <span style={{ color: "#cf222e" }}>
                    {" · archive failed: "}
                    {link.lastArchiveError}
                  </span>
                )}
              </div>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexShrink: 0,
              }}
            >
              <StatusBadge status={link.status} />
              <button
                onClick={() => checkNow(link.id)}
                disabled={checkingId === link.id}
                style={{
                  padding: "6px 12px",
                  border: "1px solid #d0d7de",
                  borderRadius: 6,
                  background: "white",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                {checkingId === link.id ? "Checking…" : "Check now"}
              </button>
              <button
                onClick={() => removeLink(link.id)}
                style={{
                  padding: "6px 10px",
                  border: "none",
                  background: "transparent",
                  color: "#cf222e",
                  cursor: "pointer",
                  fontSize: 13,
                }}
                title="Stop watching"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
