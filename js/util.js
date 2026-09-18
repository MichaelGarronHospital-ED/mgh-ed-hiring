// ============================================================================
//  Shared helpers for the interviews tool.
// ============================================================================

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g,
    (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// toast(msg) or toast(msg, "ok"|"err"). Errors linger a little longer.
export function toast(msg, kind) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.className = "toast" + (kind ? " " + kind : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hide"), kind === "err" ? 3500 : 2000);
}

// Styled confirm dialog → Promise<boolean>. Falls back to window.confirm if the
// dialog markup isn't present. `opts` = { title, yes, danger }.
export function confirmDialog(msg, opts = {}) {
  const wrap = document.getElementById("confirmWrap");
  if (!wrap) return Promise.resolve(window.confirm(msg));
  const $ = (s) => wrap.querySelector(s) || document.querySelector(s);
  document.getElementById("confirmTitle").textContent = opts.title || "Are you sure?";
  document.getElementById("confirmMsg").textContent = msg;
  const yes = document.getElementById("confirmYes"), no = document.getElementById("confirmNo");
  yes.textContent = opts.yes || "Confirm";
  yes.className = "btn " + (opts.danger === false ? "filled" : "danger");
  wrap.classList.remove("hidden");
  yes.focus();
  return new Promise((resolve) => {
    const done = (v) => {
      wrap.classList.add("hidden");
      yes.onclick = no.onclick = wrap.onclick = null;
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    wrap.onclick = (e) => { if (e.target === wrap) done(false); };
    document.addEventListener("keydown", onKey);
  });
}

// Trigger a client-side file download (used for CSV exports).
export function downloadFile(filename, text, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

// Whole-button loading state around an async action; restores label + toasts.
export async function withBusy(btn, fn, okMsg) {
  if (!btn) return fn();
  const label = btn.innerHTML;
  btn.disabled = true; btn.classList.add("loading");
  btn.innerHTML = `<span class="spinner"></span>`;
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, "ok");
    return r;
  } catch (e) {
    toast((e && e.message) || "Something went wrong", "err");
    throw e;
  } finally {
    btn.disabled = false; btn.classList.remove("loading"); btn.innerHTML = label;
  }
}

// Days until an ISO date (today at local midnight). Negative = past.
export function daysUntil(iso) {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return null;
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((d - now) / 86400000);
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
