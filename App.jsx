import { useEffect, useMemo, useRef, useState } from "react";
import { pointTo } from "./highlight.js";
import { BRAND } from "./brand.js";
import { LETTERS, CATEGORIES, PROFILE_FIELDS, LAST_REVIEWED, byId } from "./letters.js";
import { compose, plain, pieces, formatDate } from "./compose.js";
import { loadData, saveData } from "./storage.js";
import Premium from "./Premium.jsx";
import Account from "./Account.jsx";
import { supabase } from "./account.js";
import { isPremium, checkPremiumOnce, syncAccount } from "./premium.js";

const STOP = new Set(["a", "an", "the", "to", "for", "my", "i", "me", "of", "and", "or", "on", "in", "how", "do", "can", "letter", "write", "want", "need", "about", "with", "get", "is", "it"]);

function searchLetters(query, list) {
  const words = (query.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOP.has(w));
  if (!words.length) return list;
  const stem = (w) => w.replace(/(ing|ed|es|s)$/, "");
  const scored = list.map((l) => {
    const cat = CATEGORIES.find((c) => c.id === l.cat)?.name || "";
    const toStems = (t) => (t.toLowerCase().match(/[a-z0-9]+/g) || []).map(stem);
    // Words in the title count most, then keywords, then the description.
    const layers = [[toStems(l.title), 3], [toStems(l.keywords), 2], [toStems(`${l.when} ${cat}`), 1]];
    let score = 0;
    for (const w of words) {
      const s = stem(w);
      let hit = 0;
      for (const [stems, weight] of layers) {
        if (stems.includes(s) || (s.length >= 4 && stems.some((h) => h.startsWith(s)))) { hit = weight; break; }
      }
      score += hit;
    }
    return { l, score };
  });
  const best = Math.max(0, ...scored.map((x) => x.score));
  return scored.filter((x) => x.score > 0 && x.score >= best * 0.6).sort((a, b) => b.score - a.score).map((x) => x.l);
}

// Dates as YYYY-MM-DD in the person's own time zone (not UTC).
const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayIso = () => isoLocal(new Date());
function addDays(iso, days) {
  const d = new Date(`${iso || todayIso()}T12:00:00`);
  d.setDate(d.getDate() + days);
  return isoLocal(d);
}

function Field({ f, value, onChange }) {
  const id = `f-${f.id}`;
  if (f.type === "check") {
    return (
      <label className="toggle" htmlFor={id}>
        <input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        <span>{f.label}</span>
      </label>
    );
  }
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{f.label}{f.required && <span className="req" aria-hidden="true"> *</span>}</label>
      {f.hint && <p className="muted small hint">{f.hint}</p>}
      {f.type === "textarea" ? (
        <textarea id={id} rows={f.rows || 3} value={value || ""} placeholder={f.placeholder || ""} autoComplete={f.autoComplete} onChange={(e) => onChange(e.target.value)} />
      ) : f.type === "select" ? (
        <select id={id} value={value || ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input
          id={id}
          type={f.type === "date" ? "date" : "text"}
          inputMode={f.type === "money" ? "decimal" : f.inputMode}
          autoComplete={f.autoComplete || "off"}
          placeholder={f.type === "money" ? "0.00" : f.placeholder || ""}
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

function LetterCard({ l, onOpen }) {
  return (
    <li>
      <button type="button" className="card letter-card" onClick={() => onOpen(l.id)}>
        <span className="lc-icon" aria-hidden="true">{l.icon}</span>
        <span className="lc-body">
          <strong>{l.title}</strong>
          <span className="lc-meta">
            <span className="muted small">{CATEGORIES.find((c) => c.id === l.cat)?.name}</span>
            {l.deadline && <span className="badge badge-deadline">Has a deadline</span>}
          </span>
        </span>
      </button>
    </li>
  );
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = document.createElement("textarea");
    t.value = text;
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand("copy");
    t.remove();
    return ok;
  }
}

function LetterView({ letter, data, update, premium, goPremium, editingKey, setEditingKey, onBack, say }) {
  const letterRef = useRef(null);
  const values = data.drafts[letter.id] || {};
  const setValue = (id, val) => update({ drafts: { ...data.drafts, [letter.id]: { ...values, [id]: val } } });
  const setProfile = (id, val) => update({ profile: { ...data.profile, [id]: val } });
  const built = useMemo(() => compose(letter, values, data.profile), [letter, values, data.profile]);
  const text = plain(built.text);
  const recipient = letter.fields.filter((f) => ["to", "toAddress", "toEmail"].includes(f.id));
  const details = letter.fields.filter((f) => !["to", "toAddress", "toEmail"].includes(f.id));
  const blanks = built.left.length;
  const canShare = typeof navigator !== "undefined" && !!navigator.share;

  async function onCopy() {
    say((await copyText(text)) ? "Letter copied. Paste it into an email, message or document." : "Couldn't copy. Select the letter text and copy it by hand.");
  }
  function onEmail() {
    const to = (values.toEmail || "").trim();
    window.location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(built.subject)}&body=${encodeURIComponent(text)}`;
  }
  async function onShare() {
    try { await navigator.share({ title: built.subject, text }); } catch { /* cancelled */ }
  }
  function onSave() {
    if (!premium) return goPremium();
    const entry = { letterId: letter.id, title: letter.title, to: values.to || "", values, updatedAt: Date.now() };
    if (editingKey && data.saved.some((s) => s.key === editingKey)) {
      update({ saved: data.saved.map((s) => (s.key === editingKey ? { ...s, ...entry } : s)) });
    } else {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      update({ saved: [{ key, status: "draft", sentOn: "", followUp: "", createdAt: Date.now(), ...entry }, ...data.saved] });
      setEditingKey(key);
    }
    say("Saved to My Letters.");
  }
  function onClear() {
    const next = { ...data.drafts };
    delete next[letter.id];
    update({ drafts: next });
    setEditingKey(null);
  }

  return (
    <>
      <button type="button" className="link back" onClick={onBack}>← All letters</button>
      <section className="card">
        <h1><span aria-hidden="true">{letter.icon}</span> {letter.title}</h1>
        <p>{letter.when}</p>
        {letter.deadline && <div className="callout callout-deadline"><strong>Deadline:</strong> {letter.deadline}</div>}
        {letter.caution && <div className="callout callout-caution"><strong>Good to know:</strong> {letter.caution}</div>}
      </section>

      <section className="card form">
        <h2>1. Your details</h2>
        <p className="muted small">Saved on this phone and added to every letter.</p>
        {PROFILE_FIELDS.map((f) => <Field key={f.id} f={f} value={data.profile[f.id]} onChange={(v) => setProfile(f.id, v)} />)}
        <h2>2. Who it's going to</h2>
        {recipient.map((f) => <Field key={f.id} f={f} value={values[f.id]} onChange={(v) => setValue(f.id, v)} />)}
        <h2>3. The details</h2>
        {details.map((f) => <Field key={f.id} f={f} value={values[f.id]} onChange={(v) => setValue(f.id, v)} />)}
        <button type="button" className="btn-primary wide" onClick={() => pointTo(letterRef.current)}>👇 See my letter</button>
        <button type="button" className="link" onClick={onClear}>Clear this letter</button>
      </section>

      <section ref={letterRef} className="card answer" aria-live="polite">
        <p className="answer-tag">👉 Here it is</p>
        <div className="row-between">
          <h2>Your letter</h2>
          <span className={blanks ? "badge badge-blanks" : "badge badge-ready"}>{blanks ? `${blanks} blank${blanks > 1 ? "s" : ""} to fill` : "Ready to send ✓"}</span>
        </div>
        {blanks > 0 && <p className="muted small">Highlighted parts still need filling in above.</p>}
        <div className="paper" aria-label="Letter preview">
          {pieces(built.text).map((p, i) => (p.blank ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
        </div>
        <div className="actions">
          <button type="button" className="btn-primary" onClick={onCopy}>Copy</button>
          <button type="button" className="btn-secondary" onClick={() => window.print()}>Print or PDF</button>
          <button type="button" className="btn-secondary" onClick={onEmail}>Email</button>
          {canShare && <button type="button" className="btn-secondary" onClick={onShare}>Share</button>}
          <button type="button" className="btn-secondary" onClick={onSave}>
            {editingKey ? "Update saved" : "Save"}{!premium && <span className="pill-premium">Premium</span>}
          </button>
        </div>
        <p className="muted small">"Print or PDF" opens your phone's print screen. Choose "Save as PDF" there to keep a copy.</p>
      </section>

      <section className="card">
        <h2>📮 How to send it</h2>
        <ul className="plain">{letter.send.map((s) => <li key={s}>{s}</li>)}</ul>
        {letter.tips.length > 0 && (
          <>
            <h3>Good to know</h3>
            <ul className="plain">{letter.tips.map((s) => <li key={s}>{s}</li>)}</ul>
          </>
        )}
        {letter.sources.length > 0 && (
          <>
            <h3>Sources</h3>
            <ul className="plain sources">
              {letter.sources.map((s) => <li key={s.url}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.name}</a></li>)}
            </ul>
          </>
        )}
        <p className="muted small disclaimer-inline">
          This is general information, not legal advice. For court papers, an eviction or a lawsuit, get free help from{" "}
          <a href="https://www.lawhelp.org/" target="_blank" rel="noopener noreferrer">legal aid</a>.
        </p>
      </section>
    </>
  );
}

function SavedView({ data, update, onOpen, onBack }) {
  const today = todayIso();
  const set = (key, patch) => update({ saved: data.saved.map((s) => (s.key === key ? { ...s, ...patch } : s)) });
  const remove = (key) => update({ saved: data.saved.filter((s) => s.key !== key) });
  return (
    <>
      <button type="button" className="link back" onClick={onBack}>← All letters</button>
      <section className="card">
        <h1>My Letters</h1>
        <p className="muted small">Saved on this phone. Mark a letter as sent and we'll remind you here when it's time to follow up.</p>
      </section>
      {data.saved.length === 0 && <p className="empty">No saved letters yet. Open a letter and tap Save.</p>}
      <ul className="saved-list">
        {data.saved.map((s) => {
          const due = s.status === "sent" && s.followUp && s.followUp <= today;
          return (
            <li key={s.key} className={due ? "card saved due" : "card saved"}>
              <div className="row-between">
                <strong>{s.title}</strong>
                {due && <span className="badge badge-blanks">Follow up</span>}
              </div>
              <p className="muted small">{s.to ? `To ${s.to} · ` : ""}Saved {new Date(s.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</p>
              <div className="chips" role="group" aria-label="Status">
                {[["draft", "Draft"], ["sent", "Sent"], ["resolved", "Resolved"]].map(([id, name]) => (
                  <button key={id} type="button" className={s.status === id ? "chip on" : "chip"} aria-pressed={s.status === id}
                    onClick={() => set(s.key, id === "sent" && !s.sentOn ? { status: id, sentOn: today, followUp: s.followUp || addDays(today, 30) } : { status: id })}>
                    {name}
                  </button>
                ))}
              </div>
              {s.status !== "draft" && (
                <div className="dates">
                  <label className="label small" htmlFor={`sent-${s.key}`}>Sent on</label>
                  <input id={`sent-${s.key}`} type="date" value={s.sentOn || ""} onChange={(e) => set(s.key, { sentOn: e.target.value })} />
                  {s.status === "sent" && (
                    <>
                      <label className="label small" htmlFor={`fu-${s.key}`}>Follow up on</label>
                      <input id={`fu-${s.key}`} type="date" value={s.followUp || ""} onChange={(e) => set(s.key, { followUp: e.target.value })} />
                    </>
                  )}
                </div>
              )}
              <div className="button-row">
                <button type="button" className="btn-secondary" onClick={() => onOpen(s)}>Open</button>
                <button type="button" className="link danger" onClick={() => remove(s.key)}>Delete</button>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export default function App() {
  const [data, setData] = useState(loadData);
  const [view, setView] = useState("home");
  const [openId, setOpenId] = useState(null);
  const [editingKey, setEditingKey] = useState(null);
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState("");
  const [premium, setPremium] = useState(isPremium);
  const [notice, setNotice] = useState("");
  const [toast, setToast] = useState("");

  const update = (patch) => setData((d) => { const n = { ...d, ...patch }; saveData(n); return n; });

  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--main", BRAND.colors.main);
    root.setProperty("--main-2", BRAND.colors.mainHover);
    root.setProperty("--soft", BRAND.colors.soft);
    document.title = BRAND.name;
    checkPremiumOnce().then((status) => {
      setPremium(isPremium());
      if (status === "activated") setNotice("Premium is active. Thank you! My Letters and follow-up reminders are unlocked.");
      else if (status === "expired") setNotice("Your Premium plan has ended. Every letter is still free to fill in, print, copy and email.");
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT") return;
      syncAccount().then((status) => {
        setPremium(isPremium());
        if (status === "activated") setNotice("Welcome back! Premium from your CashCow account is on.");
      });
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => { document.documentElement.classList.toggle("big-text", !!data.bigText); }, [data.bigText]);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [view, openId]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const list = useMemo(() => searchLetters(query, LETTERS.filter((l) => !cat || l.cat === cat)), [query, cat]);
  const today = todayIso();
  const due = premium ? data.saved.filter((s) => s.status === "sent" && s.followUp && s.followUp <= today) : [];
  const goPremium = () => setView("premium");
  const open = (id) => { setEditingKey(null); setOpenId(id); setView("letter"); };
  const openSaved = (s) => {
    update({ drafts: { ...data.drafts, [s.letterId]: s.values } });
    setEditingKey(s.key);
    setOpenId(s.letterId);
    setView("letter");
  };
  const letter = openId ? byId[openId] : null;

  return (
    <div className="app">
      <header className="top no-print">
        <button type="button" className="brand" onClick={() => setView("home")} aria-label={`${BRAND.name} home`}>
          <span className="logo" aria-hidden="true">✉</span>
          <span>{BRAND.name}</span>
        </button>
        <button type="button" className="link light" onClick={() => setView("settings")}>Settings</button>
      </header>

      <main>
        {notice && (
          <div className="notice no-print" role="status">
            <span>{notice}</span>
            <button type="button" className="link" onClick={() => setNotice("")} aria-label="Dismiss">✕</button>
          </div>
        )}

        {view === "premium" && <Premium premium={premium} onBack={() => setView(letter ? "letter" : "home")} />}

        {view === "settings" && (
          <>
            <section className="card form">
              <h2>Your details</h2>
              <p className="muted small">Added to every letter. Saved on this phone only.</p>
              {PROFILE_FIELDS.map((f) => <Field key={f.id} f={f} value={data.profile[f.id]} onChange={(v) => update({ profile: { ...data.profile, [f.id]: v } })} />)}
              <h2>Easier reading</h2>
              <label className="toggle">
                <input type="checkbox" checked={!!data.bigText} onChange={(e) => update({ bigText: e.target.checked })} />
                <span>Bigger text and buttons</span>
              </label>
              <button type="button" className="btn-primary" onClick={() => setView(letter ? "letter" : "home")}>Done</button>
            </section>
            <Account premium={premium} />
          </>
        )}

        {view === "letter" && letter && (
          <LetterView letter={letter} data={data} update={update} premium={premium} goPremium={goPremium}
            editingKey={editingKey} setEditingKey={setEditingKey} onBack={() => setView("home")} say={setToast} />
        )}

        {view === "saved" && (premium
          ? <SavedView data={data} update={update} onOpen={openSaved} onBack={() => setView("home")} />
          : <Premium premium={false} onBack={() => setView("home")} />)}

        {view === "home" && (
          <>
            <section className="card hero">
              <h1>What do you need to write?</h1>
              <p className="muted">{BRAND.tagline}</p>
              <label htmlFor="search" className="sr-only">Search letters</label>
              <input id="search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. refund, late fee, debt collector" />
              <div className="chips cats" role="group" aria-label="Topics">
                {CATEGORIES.map((c) => (
                  <button key={c.id} type="button" className={cat === c.id ? "chip on" : "chip"} aria-pressed={cat === c.id} onClick={() => setCat(cat === c.id ? "" : c.id)}>
                    <span aria-hidden="true">{c.icon}</span> {c.name}
                  </button>
                ))}
              </div>
            </section>

            {due.length > 0 && (
              <section className="card due-card">
                <h2>Time to follow up</h2>
                <ul className="plain">
                  {due.map((s) => <li key={s.key}><strong>{s.title}</strong>{s.to ? ` to ${s.to}` : ""}, sent {formatDate(s.sentOn)}</li>)}
                </ul>
                <button type="button" className="btn-secondary" onClick={() => setView("saved")}>Open My Letters</button>
              </section>
            )}

            <div className="quick-nav">
              <button type="button" className="qn" onClick={() => setView("saved")}>📁 My Letters{!premium && <span className="pill-premium">Premium</span>}</button>
              <button type="button" className="qn" onClick={() => setView("settings")}>👤 Your details</button>
            </div>

            {list.length === 0 ? (
              <p className="empty">No letter matches that yet. Try a simpler word, like "refund" or "bill", or pick a topic above.</p>
            ) : (
              <ul className="letter-list">{list.map((l) => <LetterCard key={l.id} l={l} onOpen={open} />)}</ul>
            )}

            {!premium && (
              <section className="card premium-teaser">
                <h2>Go Premium</h2>
                <p className="muted">Save your letters, track when you sent them, and get reminded when it's time to follow up. From $1.99 a month.</p>
                <button type="button" className="btn-primary" onClick={goPremium}>See plans</button>
              </section>
            )}

            <section className="card">
              <h2>🛡️ Got a suspicious letter or message?</h2>
              <p className="muted">Before you reply or pay, check it with ScamShield, another CashCow app.</p>
              <a className="btn-secondary link-btn" href="https://cashcowai.online/scamshield.html" target="_blank" rel="noopener noreferrer">Check it with ScamShield</a>
            </section>

            <section className="card">
              <h2>💬 CashCow Community</h2>
              <p className="muted">Swap tips with other members in the <strong>Bills &amp; Money</strong> channel. Uses your free CashCow account.</p>
              <a className="btn-secondary link-btn" href="https://cashcowai.online/community.html#money" target="_blank" rel="noopener noreferrer">Open the community</a>
            </section>

            <Account premium={premium} />

            <p className="disclaimer">
              General information, not legal advice. Letters are based on guidance from the CFPB, FTC and other official sources, last reviewed {LAST_REVIEWED}.
              Your details stay on this phone.
            </p>
          </>
        )}
      </main>

      {toast && <div className="toast no-print" role="status">{toast}</div>}
    </div>
  );
}
