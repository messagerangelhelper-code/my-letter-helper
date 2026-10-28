// Saved on this phone only: your name and address, letters in progress, and
// (Premium) the letters you've saved with their sent and follow-up dates.
const KEY = "mlh-data";

const DEFAULTS = { profile: {}, drafts: {}, saved: [], bigText: false };

export function loadData() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    return { ...DEFAULTS, ...(v && typeof v === "object" ? v : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveData(d) {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    /* storage not available (private window); the app still works */
  }
}
