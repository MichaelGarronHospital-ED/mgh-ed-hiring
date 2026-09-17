// ============================================================================
//  Shared helpers for the interviews tool.
// ============================================================================

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g,
    (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

export function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hide");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hide"), 2000);
}

// case-insensitive, whitespace-tolerant name match against a list of names.
export function matchName(input, names) {
  const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, " ");
  const t = norm(input);
  if (!t) return null;
  let hit = names.find((n) => norm(n) === t);
  if (hit) return hit;
  // allow "last name" or "first last" partial where unambiguous
  const cands = names.filter((n) => norm(n).includes(t) || t.includes(norm(n)));
  return cands.length === 1 ? cands[0] : null;
}

export function debounce(fn, ms = 400) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function csvCell(s) { return `"${String(s ?? "").replace(/"/g, '""')}"`; }

// average of numeric values, or null.
export function avg(nums) {
  const v = nums.filter((n) => typeof n === "number" && !isNaN(n));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
