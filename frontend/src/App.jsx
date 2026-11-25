import React, { useEffect, useState } from "react";

const API = import.meta.env.VITE_API_URL || "";

export default function App() {
  const [urlInput, setUrlInput] = useState("");
  const [customCode, setCustomCode] = useState("");
  const [links, setLinks] = useState([]);
  const [selectedCode, setSelectedCode] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [warmStatus, setWarmStatus] = useState("");

  async function apiFetch(path, options = {}) {
    const res = await fetch(`${API}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    if (res.status === 204) return null;
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function refreshLinks() {
    const data = await apiFetch("/api/links");
    const list = data.links || [];
    setLinks(list);
    if (!selectedCode && list.length > 0) {
      setSelectedCode(list[0].short_code);
    }
  }

  async function loadAnalytics(code) {
    if (!code) return;
    const data = await apiFetch(`/api/links/${code}/analytics`);
    setAnalytics(data);
  }

  useEffect(() => {
    refreshLinks();
  }, []);

  useEffect(() => {
    if (selectedCode) loadAnalytics(selectedCode);
  }, [selectedCode]);

  const handleShorten = async (e) => {
    e.preventDefault();
    setErrorMsg("");
    try {
      const payload = { url: urlInput.trim() };
      if (customCode.trim()) payload.customCode = customCode.trim();
      const d = await apiFetch("/api/links", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setUrlInput("");
      setCustomCode("");
      await refreshLinks();
      setSelectedCode(d.link.short_code);
    } catch (err) {
      setErrorMsg(err.message);
    }
  };

  const warmTopLinks = async () => {
    const summary = await apiFetch("/api/links/cache/warm-top", { method: "POST" });
    setWarmStatus(`Cached top ${summary.cachedCount} of ${summary.total} links in Redis`);
    await refreshLinks();
  };

  const maxDaily = Math.max(1, ...(analytics?.daily || []).map((d) => d.clicks));
  const maxDevice = Math.max(1, ...(analytics?.devices || []).map((d) => d.clicks));

  return (
    <div className="container">
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 26 }}>LinkPulse Shortener & Analytics</h1>
          <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 4 }}>
            Base62 short codes · Redis top-20% hot-link cache · Token-bucket rate limiting · PostgreSQL daily/weekly analytics
          </div>
        </div>
        <button className="btn secondary" onClick={warmTopLinks}>Warm Top-20% Cache</button>
      </header>

      {warmStatus && <p style={{ color: "var(--accent)", fontSize: 13 }}>{warmStatus}</p>}
      {errorMsg && <p style={{ color: "#f87171", fontSize: 13 }}>{errorMsg}</p>}

      <form onSubmit={handleShorten} className="card" style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 18 }}>
        <input
          style={{ flex: 2, minWidth: 260 }}
          type="url"
          placeholder="https://example.com/your/long/destination/url"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          required
        />
        <input
          style={{ flex: 1, minWidth: 160 }}
          placeholder="Optional alias (e.g. launch-25)"
          value={customCode}
          onChange={(e) => setCustomCode(e.target.value)}
        />
        <button className="btn" type="submit">Shorten URL</button>
      </form>

      <div className="grid-two">
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Shortened Links ({links.length})</h3>
          {links.length === 0 ? (
            <p style={{ color: "var(--muted)", fontSize: 14 }}>Create your first Base62 short link above.</p>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {links.map((link) => (
                <div
                  key={link.id}
                  onClick={() => setSelectedCode(link.short_code)}
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    border: `1px solid ${selectedCode === link.short_code ? "var(--accent)" : "var(--border)"}`,
                    cursor: "pointer",
                    background: "#0d1426",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <strong>/{link.short_code}</strong>
                    <div style={{ display: "flex", gap: 6 }}>
                      {link.is_hot && <span className="badge hot">HOT CACHE</span>}
                      <span className="badge">{link.click_count} clicks</span>
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4, wordBreak: "break-all" }}>
                    {link.original_url}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <h3 style={{ marginTop: 0 }}>
            Click Analytics {analytics ? `— /${analytics.link.short_code}` : ""}
          </h3>
          {analytics ? (
            <div style={{ display: "grid", gap: 18 }}>
              <div style={{ display: "flex", gap: 16 }}>
                <div className="card" style={{ flex: 1, padding: 12 }}>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>Total Clicks</div>
                  <strong style={{ fontSize: 22 }}>{analytics.link.click_count}</strong>
                </div>
                <div className="card" style={{ flex: 1, padding: 12 }}>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>Cache Tier</div>
                  <strong style={{ fontSize: 18 }}>{analytics.link.is_hot ? "Hot (Redis)" : "Standard (PG)"}</strong>
                </div>
              </div>

              <div>
                <h4 style={{ margin: "0 0 8px" }}>Device Breakdown</h4>
                {analytics.devices.length === 0 ? (
                  <p style={{ color: "var(--muted)", fontSize: 13 }}>No clicks recorded yet.</p>
                ) : (
                  analytics.devices.map((d) => (
                    <div key={d.device_type} className="bar-row">
                      <span>{d.device_type}</span>
                      <div className="bar-track">
                        <div className="bar-fill" style={{ width: `${(d.clicks / maxDevice) * 100}%` }} />
                      </div>
                      <span>{d.clicks}</span>
                    </div>
                  ))
                )}
              </div>

              <div>
                <h4 style={{ margin: "0 0 8px" }}>Daily Click View (PostgreSQL)</h4>
                {analytics.daily.map((d) => (
                  <div key={d.day} className="bar-row">
                    <span>{String(d.day).slice(0, 10)}</span>
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${(d.clicks / maxDaily) * 100}%` }} />
                    </div>
                    <span>{d.clicks}</span>
                  </div>
                ))}
              </div>

              <div>
                <h4 style={{ margin: "0 0 8px" }}>Top Referrers</h4>
                {analytics.referrers.map((r) => (
                  <div key={r.referrer} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "4px 0" }}>
                    <span>{r.referrer}</span>
                    <strong>{r.clicks}</strong>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p style={{ color: "var(--muted)", fontSize: 14 }}>Select a link to view daily/weekly analytics.</p>
          )}
        </section>
      </div>
    </div>
  );
}
