// Turns a letter template + what the person typed into the finished letter.
// Blanks they haven't filled are marked so the preview can highlight them.
import { PROFILE_FIELDS } from "./letters.js";

const OPEN = "\u0001";
const CLOSE = "\u0002";

export function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function formatMoney(v) {
  const t = String(v).trim();
  if (/^\$/.test(t)) return t;
  const n = Number(t.replace(/,/g, ""));
  if (!Number.isFinite(n) || t === "") return t;
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function display(field, raw) {
  if (field.type === "date") return formatDate(raw);
  if (field.type === "money") return formatMoney(raw);
  return String(raw).trim();
}

// Short name for a blank, e.g. "Last 4 digits of the card" -> "last 4 digits of the card".
function blankName(field) {
  return field.label.replace(/\s*\(.*?\)\s*/g, " ").trim().toLowerCase();
}

export function compose(letter, values, profile, today = new Date()) {
  const all = [...PROFILE_FIELDS, ...letter.fields];
  const merged = { ...profile, ...values };
  const fieldOf = Object.fromEntries(all.map((f) => [f.id, f]));
  const missing = new Set();

  const x = (id) => {
    const f = fieldOf[id];
    const raw = merged[id];
    if (raw !== undefined && raw !== null && String(raw).trim() !== "" && raw !== false) return display(f || {}, raw);
    missing.add(id);
    return OPEN + (f ? blankName(f) : id) + CLOSE;
  };

  const v = Object.fromEntries(Object.entries(merged).map(([k, val]) => [k, typeof val === "string" ? val.trim() : val]));
  const subject = letter.subject(x, v);
  const paragraphs = letter.body(x, v).filter(Boolean);
  const dateText = today.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const from = [x("name"), x("address"), v.phone ? x("phone") : null, v.email ? x("email") : null].filter(Boolean).join("\n");
  const to = [x("to"), x("toAddress")].join("\n");
  const text = [from, dateText, to, `Re: ${subject}`, "To whom it may concern:", ...paragraphs, `Sincerely,\n\n\n${x("name")}`].join("\n\n");

  // Required blanks still empty (optional ones only show when used).
  const required = all.filter((f) => f.required && !f.skip).map((f) => f.id);
  const left = required.filter((id) => {
    const raw = merged[id];
    return raw === undefined || raw === null || String(raw).trim() === "";
  });

  return { subject: plain(subject), text, missing: [...missing], left };
}

// The letter as plain text, with any blanks shown as [like this].
export function plain(text) {
  return text.replaceAll(OPEN, "[").replaceAll(CLOSE, "]");
}

// Splits text into pieces for the preview: { text, blank }.
export function pieces(text) {
  const out = [];
  const re = new RegExp(`${OPEN}([^${CLOSE}]*)${CLOSE}`, "g");
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), blank: false });
    out.push({ text: m[1], blank: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), blank: false });
  return out;
}
