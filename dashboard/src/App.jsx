import React, { useState, useEffect, useMemo, useCallback } from "react";

/* ------------------------------------------------------------------ *
 * Remote Job Radar — dashboard
 * A signal console for a solo founder watching 121 staffing agencies.
 * Signature: the header sweep + the amber "new signal" beacon on fresh roles.
 * Everything else stays quiet grayscale so the new-role ping is the one loud thing.
 * ------------------------------------------------------------------ */

const T = {
  bg: "#101318", panel: "#171B22", panelHi: "#1E232C", border: "#262C37",
  text: "#E7E9EE", muted: "#8B93A2", faint: "#5B6270",
  amber: "#F5B544", amberDim: "rgba(245,181,68,.14)",
  teal: "#3ED6B0", red: "#F0736A", ink: "#101318",
};
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

const CATS = ["Customer Service", "Chat Support", "Data Entry", "Call Center", "Medical Records", "Member Services"];


/* ---- localStorage helpers (with in-memory fallback) ---- */
const mem = {};
async function sget(k, d) {
  try { const r = localStorage.getItem(k); return r != null ? JSON.parse(r) : (k in mem ? mem[k] : d); }
  catch { return k in mem ? mem[k] : d; }
}
async function sset(k, v) {
  mem[k] = v;
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* fallback: memory only */ }
}

/* ---- live feed source ---- */
// Local dev serves public/feed.json at /feed.json. In production, set
// VITE_FEED_URL to your repo's raw feed URL (e.g. the GitHub raw data/feed.json).
const FEED_URL = import.meta.env.VITE_FEED_URL || "/feed.json";

const timeAgo = (iso) => {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

export default function App() {
  const [jobs, setJobs] = useState([]);
  const [feedError, setFeedError] = useState(null);
  const [seen, setSeen] = useState([]);
  const [saved, setSaved] = useState([]);
  const [dismissed, setDismissed] = useState([]);
  const [tab, setTab] = useState("new");
  const [q, setQ] = useState("");
  const [activeCats, setActiveCats] = useState([]);
  const [equipFilter, setEquipFilter] = useState("all"); // all | only | hide
  const [showAlerts, setShowAlerts] = useState(false);
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState({ channel: "telegram", chatId: "", email: "" });

  useEffect(() => {
    (async () => {
      setSeen(await sget("radar:seen", []));
      setSaved(await sget("radar:saved", []));
      setDismissed(await sget("radar:dismissed", []));
      setSettings(await sget("radar:settings", { channel: "telegram", chatId: "", email: "" }));
      setReady(true);
    })();
  }, []);

  // Pull the live feed the monitor writes every sweep.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(FEED_URL, { cache: "no-store" });
        if (!r.ok) throw new Error(`feed ${r.status}`);
        const data = await r.json();
        setJobs(Array.isArray(data) ? data : []);
      } catch (e) {
        setFeedError(e.message || "could not load feed");
      }
    })();
  }, []);

  const persist = useCallback((k, v, setter) => { setter(v); sset(k, v); }, []);
  const toggleSave = (id) => persist("radar:saved", saved.includes(id) ? saved.filter(x => x !== id) : [...saved, id], setSaved);
  const dismiss = (id) => persist("radar:dismissed", [...new Set([...dismissed, id])], setDismissed);
  const markAllSeen = () => persist("radar:seen", [...new Set([...seen, ...jobs.map(j => j.id)])], setSeen);
  const toggleCat = (c) => setActiveCats(activeCats.includes(c) ? activeCats.filter(x => x !== c) : [...activeCats, c]);

  const newIds = useMemo(() => jobs.filter(j => !seen.includes(j.id)).map(j => j.id), [jobs, seen]);

  const visible = useMemo(() => {
    let list = jobs;
    if (tab === "new") list = list.filter(j => newIds.includes(j.id) && !dismissed.includes(j.id));
    else if (tab === "saved") list = list.filter(j => saved.includes(j.id));
    else list = list.filter(j => !dismissed.includes(j.id));
    if (activeCats.length) list = list.filter(j => activeCats.includes(j.category));
    if (equipFilter === "only") list = list.filter(j => j.byod);
    else if (equipFilter === "hide") list = list.filter(j => !j.byod);
    if (q.trim()) {
      const s = q.toLowerCase();
      list = list.filter(j => (j.title + j.agency + j.category).toLowerCase().includes(s));
    }
    return [...list].sort((a, b) => new Date(b.firstSeen) - new Date(a.firstSeen));
  }, [jobs, tab, newIds, dismissed, saved, activeCats, equipFilter, q]);

  const counts = {
    new: jobs.filter(j => newIds.includes(j.id) && !dismissed.includes(j.id)).length,
    all: jobs.filter(j => !dismissed.includes(j.id)).length,
    saved: saved.length,
  };

  const agencyCount = useMemo(() => new Set(jobs.map(j => j.agency)).size, [jobs]);
  const lastSweep = useMemo(() => jobs.reduce((a, j) => (j.firstSeen > a ? j.firstSeen : a), ""), [jobs]);

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: SANS }}>
      <style>{`
        @keyframes sweep { 0%{transform:translateX(-100%)} 100%{transform:translateX(400%)} }
        @keyframes ping { 0%{box-shadow:0 0 0 0 rgba(245,181,68,.5)} 70%{box-shadow:0 0 0 7px rgba(245,181,68,0)} 100%{box-shadow:0 0 0 0 rgba(245,181,68,0)} }
        .rowcard{ transition:border-color .15s, background .15s, transform .06s; }
        .rowcard:hover{ background:${T.panelHi}; border-color:${T.border}; }
        .rowcard:active{ transform:translateY(1px); }
        .ib{ background:transparent;border:1px solid ${T.border};color:${T.muted};cursor:pointer;
             border-radius:8px;font-family:${MONO};transition:all .12s; }
        .ib:hover{ color:${T.text};border-color:${T.faint}; }
        .ib:focus-visible,.chip:focus-visible,.tab:focus-visible,input:focus-visible,select:focus-visible{
             outline:2px solid ${T.amber};outline-offset:2px; }
        .lnk{ color:inherit;text-decoration:none; }
        .lnk:hover{ color:${T.amber}; }
        .chip{ cursor:pointer;border-radius:999px;font-family:${MONO};font-size:11px;
               letter-spacing:.03em;transition:all .12s; }
        input::placeholder{ color:${T.faint}; }
        @media (prefers-reduced-motion: reduce){ .sweepbar,.beacon{ animation:none !important; } }
      `}</style>

      {/* ---- header / signature sweep ---- */}
      <header style={{ position: "sticky", top: 0, zIndex: 20, background: "rgba(16,19,24,.9)",
        backdropFilter: "blur(8px)", borderBottom: `1px solid ${T.border}` }}>
        <div style={{ maxWidth: 920, margin: "0 auto", padding: "14px 18px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span className="beacon" style={{ width: 9, height: 9, borderRadius: 999, background: T.teal,
                boxShadow: `0 0 10px ${T.teal}`, animation: "ping 2.4s infinite" }} />
              <span style={{ fontFamily: MONO, fontWeight: 700, letterSpacing: ".22em", fontSize: 14 }}>RADAR</span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: T.faint, letterSpacing: ".04em" }}>remote-job monitor</span>
            </div>
            <button className="ib" onClick={() => setShowAlerts(true)}
              style={{ marginLeft: "auto", padding: "7px 12px", fontSize: 12 }}>◔ Alerts</button>
          </div>

          {/* telemetry + scanning bar */}
          <div style={{ marginTop: 12 }}>
            <div style={{ position: "relative", height: 3, borderRadius: 3, background: T.panelHi, overflow: "hidden" }}>
              <div className="sweepbar" style={{ position: "absolute", inset: 0, width: "25%",
                background: `linear-gradient(90deg,transparent,${T.teal},transparent)`,
                animation: "sweep 3.4s linear infinite" }} />
            </div>
            <div style={{ marginTop: 8, fontFamily: MONO, fontSize: 11.5, color: T.muted,
              display: "flex", gap: 14, flexWrap: "wrap" }}>
              <span>{jobs.length} roles</span>
              <span style={{ color: T.faint }}>·</span>
              <span>{agencyCount} agencies</span>
              <span style={{ color: T.faint }}>·</span>
              <span style={{ color: counts.new ? T.amber : T.muted }}>{counts.new} new</span>
              <span style={{ color: T.faint }}>·</span>
              <span>last sweep {lastSweep ? timeAgo(lastSweep) : "—"}</span>
            </div>
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 920, margin: "0 auto", padding: "18px 18px 80px" }}>
        {/* ---- tabs ---- */}
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          {[["new", "New"], ["all", "All"], ["saved", "Saved"]].map(([k, label]) => (
            <button key={k} className="tab" onClick={() => setTab(k)}
              style={{ padding: "8px 14px", borderRadius: 9, cursor: "pointer", fontFamily: MONO, fontSize: 12.5,
                letterSpacing: ".03em", border: `1px solid ${tab === k ? T.amber : T.border}`,
                background: tab === k ? T.amberDim : "transparent", color: tab === k ? T.amber : T.muted }}>
              {label} <span style={{ opacity: .8 }}>{counts[k]}</span>
            </button>
          ))}
          {tab === "new" && counts.new > 0 && (
            <button className="ib" onClick={markAllSeen}
              style={{ marginLeft: "auto", padding: "8px 12px", fontSize: 12 }}>Mark all seen</button>
          )}
        </div>

        {/* ---- search + category filters ---- */}
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search title or agency…"
            style={{ flex: "1 1 220px", padding: "9px 12px", borderRadius: 9, background: T.panel,
              border: `1px solid ${T.border}`, color: T.text, fontFamily: SANS, fontSize: 13.5 }} />
        </div>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 18 }}>
          {CATS.map(c => {
            const on = activeCats.includes(c);
            return (
              <button key={c} className="chip" onClick={() => toggleCat(c)}
                style={{ padding: "5px 11px", border: `1px solid ${on ? T.teal : T.border}`,
                  background: on ? "rgba(62,214,176,.12)" : "transparent", color: on ? T.teal : T.muted }}>
                {c}
              </button>
            );
          })}
          {activeCats.length > 0 && (
            <button className="chip" onClick={() => setActiveCats([])}
              style={{ padding: "5px 11px", border: `1px solid ${T.border}`, background: "transparent", color: T.faint }}>
              clear ✕
            </button>
          )}
        </div>

        {/* ---- equipment / BYOD filter ---- */}
        <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap", marginBottom: 18 }}>
          <span style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: ".08em", color: T.faint, textTransform: "uppercase" }}>Equipment</span>
          {[["all", "All roles"], ["only", "Equipment required"], ["hide", "No equipment"]].map(([k, label]) => {
            const on = equipFilter === k;
            return (
              <button key={k} className="chip" onClick={() => setEquipFilter(k)}
                style={{ padding: "5px 11px", border: `1px solid ${on ? T.amber : T.border}`,
                  background: on ? T.amberDim : "transparent", color: on ? T.amber : T.muted }}>
                {label}
              </button>
            );
          })}
        </div>

        {/* ---- feed ---- */}
        {!ready ? (
          <Empty title="Warming up the radar…" body="Loading your saved and seen roles." />
        ) : visible.length === 0 ? (
          <Empty
            title={tab === "new" ? "No new remote roles since your last sweep." :
              tab === "saved" ? "Nothing saved yet." : "No roles match those filters."}
            body={tab === "new" ? "The radar's still watching all 121 agencies. New posts land here the moment they appear." :
              tab === "saved" ? "Star a role to keep it here while you apply." : "Try clearing a filter or the search box."} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {visible.map(j => {
              const isNew = newIds.includes(j.id);
              const isSaved = saved.includes(j.id);
              return (
                <div key={j.id} className="rowcard"
                  style={{ position: "relative", background: T.panel, border: `1px solid ${T.border}`,
                    borderLeft: `3px solid ${isNew ? T.amber : "transparent"}`, borderRadius: 11,
                    padding: "13px 14px 13px 15px" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                    {/* beacon */}
                    <span aria-hidden className="beacon" style={{ marginTop: 6, flex: "0 0 auto", width: 8, height: 8,
                      borderRadius: 999, background: isNew ? T.amber : T.faint,
                      animation: isNew ? "ping 2s infinite" : "none" }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontFamily: MONO, fontSize: 11.5, color: T.muted, letterSpacing: ".02em" }}>
                          {j.agency}
                        </span>
                        <span style={{ fontFamily: MONO, fontSize: 11, color: T.faint }}>· {timeAgo(j.firstSeen)}</span>
                      </div>
                      <a className="lnk" href={j.url} target="_blank" rel="noreferrer"
                        style={{ display: "block", marginTop: 3, fontSize: 15.5, fontWeight: 600, lineHeight: 1.3 }}>
                        {j.title}
                      </a>
                      <div style={{ marginTop: 7, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <Tag color={T.teal}>{j.category}</Tag>
                        <span style={{ fontFamily: MONO, fontSize: 11, color: T.muted }}>{j.location}</span>
                        <span style={{ fontFamily: MONO, fontSize: 11, color: T.faint }}>via {j.source}</span>
                        {j.maybeHybrid && <Tag color={T.red}>maybe hybrid</Tag>}
                        {j.byod && (
                          <Tag color={T.amber}>
                            ⚙ equipment{j.equipment?.length ? `: ${j.equipment.join(", ")}` : " required"}
                          </Tag>
                        )}
                      </div>
                    </div>
                    {/* actions */}
                    <div style={{ display: "flex", gap: 6, flex: "0 0 auto" }}>
                      <button className="ib" title={isSaved ? "Unsave" : "Save"} onClick={() => toggleSave(j.id)}
                        style={{ width: 32, height: 32, color: isSaved ? T.amber : T.muted,
                          borderColor: isSaved ? T.amber : T.border }}>★</button>
                      <button className="ib" title="Dismiss" onClick={() => dismiss(j.id)}
                        style={{ width: 32, height: 32 }}>✕</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p style={{ marginTop: 26, fontFamily: MONO, fontSize: 11, color: feedError ? T.red : T.faint, lineHeight: 1.7 }}>
          {feedError
            ? `Couldn't load the feed (${feedError}). Check VITE_FEED_URL or that data/feed.json is reachable.`
            : <>Live feed — driven by <code>data/feed.json</code>, refreshed every sweep. Links open the real posting.</>}
        </p>
      </main>

      {showAlerts && (
        <AlertsDrawer settings={settings}
          onClose={() => setShowAlerts(false)}
          onSave={(s) => { persist("radar:settings", s, setSettings); setShowAlerts(false); }} />
      )}
    </div>
  );
}

function Tag({ children, color }) {
  return (
    <span style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: ".03em", color,
      border: `1px solid ${color}`, borderRadius: 999, padding: "2px 8px", opacity: .95,
      background: "transparent" }}>{children}</span>
  );
}

function Empty({ title, body }) {
  return (
    <div style={{ border: `1px dashed ${T.border}`, borderRadius: 14, padding: "40px 24px",
      textAlign: "center", background: T.panel }}>
      <div style={{ fontFamily: MONO, letterSpacing: ".14em", color: T.faint, fontSize: 12 }}>◌ ◌ ◌</div>
      <div style={{ marginTop: 12, fontSize: 15.5, fontWeight: 600 }}>{title}</div>
      <div style={{ marginTop: 6, color: T.muted, fontSize: 13.5, maxWidth: 420, margin: "6px auto 0" }}>{body}</div>
    </div>
  );
}

function AlertsDrawer({ settings, onClose, onSave }) {
  const [s, setS] = useState(settings);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(8,10,14,.6)",
      display: "flex", justifyContent: "flex-end", zIndex: 50 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: "min(420px,100%)", height: "100%",
        background: T.panel, borderLeft: `1px solid ${T.border}`, padding: 22, overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
          <span style={{ fontFamily: MONO, fontWeight: 700, letterSpacing: ".16em", fontSize: 13 }}>ALERTS</span>
          <button className="ib" onClick={onClose} style={{ marginLeft: "auto", width: 30, height: 30 }}>✕</button>
        </div>
        <p style={{ color: T.muted, fontSize: 13, lineHeight: 1.6, marginBottom: 20 }}>
          Where the radar pings you when a new remote role appears. These values live in your
          monitor's config — the sweep runs server-side, so alerts arrive even with this tab closed.
        </p>

        <label style={lbl}>Deliver to</label>
        <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
          {["telegram", "email"].map(ch => (
            <button key={ch} onClick={() => setS({ ...s, channel: ch })}
              style={{ flex: 1, padding: "9px 0", borderRadius: 9, cursor: "pointer", fontFamily: MONO, fontSize: 12.5,
                textTransform: "capitalize", border: `1px solid ${s.channel === ch ? T.amber : T.border}`,
                background: s.channel === ch ? T.amberDim : "transparent", color: s.channel === ch ? T.amber : T.muted }}>
              {ch}
            </button>
          ))}
        </div>

        {s.channel === "telegram" ? (
          <>
            <label style={lbl}>Telegram chat ID</label>
            <input value={s.chatId} onChange={e => setS({ ...s, chatId: e.target.value })}
              placeholder="e.g. 738104922" style={inp} />
            <p style={{ ...hint }}>Message @userinfobot to get yours. The bot token stays in your GitHub secrets.</p>
          </>
        ) : (
          <>
            <label style={lbl}>Email address</label>
            <input value={s.email} onChange={e => setS({ ...s, email: e.target.value })}
              placeholder="you@example.com" style={inp} />
            <p style={{ ...hint }}>Delivered via a free Resend account wired into the sweep.</p>
          </>
        )}

        <button onClick={() => onSave(s)}
          style={{ width: "100%", marginTop: 22, padding: "11px 0", borderRadius: 10, cursor: "pointer",
            border: "none", background: T.amber, color: T.ink, fontFamily: MONO, fontWeight: 700,
            letterSpacing: ".04em", fontSize: 13 }}>
          Save alert settings
        </button>
      </div>
    </div>
  );
}

const lbl = { display: "block", fontFamily: MONO, fontSize: 11, letterSpacing: ".06em", color: T.faint, marginBottom: 7, textTransform: "uppercase" };
const inp = { width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 9, background: T.bg, border: `1px solid ${T.border}`, color: T.text, fontFamily: MONO, fontSize: 13 };
const hint = { marginTop: 8, color: T.faint, fontSize: 12, lineHeight: 1.6 };
