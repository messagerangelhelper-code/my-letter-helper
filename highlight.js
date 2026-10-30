// Scroll an answer box into view and make it glow briefly.
export function pointTo(el) {
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.remove("glow"); void el.offsetWidth; el.classList.add("glow");
}
