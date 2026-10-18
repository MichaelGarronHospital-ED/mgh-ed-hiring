// ============================================================================
//  Shared helpers for the interviews tool.
// ============================================================================

// ---- storage that cannot take the app down ---------------------------------
// iOS Safari with Settings → Safari → "Block All Cookies", Private Browsing on
// older iOS, and several locked-down in-app browsers make localStorage and
// sessionStorage THROW — and not only on write: the property getter itself can
// throw a SecurityError, so this has to be wrapped rather than feature-detected
// (`"localStorage" in window` throws too).
//
// This is not hypothetical politeness. The gate did `sessionStorage.setItem`
// straight after a successful sign-in, unguarded, so on such a phone the right
// code signed in, the write threw, the gate never closed, and the person saw a
// toast reading "The operation is insecure." — i.e. "it works on my desktop but
// I can't log in on my phone".
//
// A browser that blocks storage simply forgets between visits. That is a real
// but survivable loss (the UI says so); being unable to sign in is not.
const safeGet = (kind, k) => { try { return window[kind].getItem(k); } catch { return null; } };
const safeSet = (kind, k, v) => { try { window[kind].setItem(k, v); return true; } catch { return false; } };
const safeDel = (kind, k) => { try { window[kind].removeItem(k); } catch { /* blocked — nothing to remove */ } };

export const ss = {
  get: (k) => safeGet("sessionStorage", k),
  set: (k, v) => safeSet("sessionStorage", k, v),
  del: (k) => safeDel("sessionStorage", k),
};
export const ls = {
  get: (k) => safeGet("localStorage", k),
  set: (k, v) => safeSet("localStorage", k, v),
  del: (k) => safeDel("localStorage", k),
};

// Does this browser let us remember anything at all? Used to warn people whose
// own answers will not replay on a later visit, rather than letting it look
// like the app lost them.
export function storageWorks(kind = "localStorage") {
  try {
    const k = "__ed_probe__";
    window[kind].setItem(k, "1");
    window[kind].removeItem(k);
    return true;
  } catch { return false; }
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g,
    (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// toast(msg) or toast(msg, "ok"|"err"). Errors linger a little longer.
// toast(msg, kind, { label, run }) adds one button (for example "Undo") and
// stays up for 10 seconds; only then does the toast take taps.
export function toast(msg, kind, action) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  // "toast-ok", not "ok": `.ok` and `.err` are utility classes (green text,
  // the red error line with its margin), and a modifier must never also be a
  // utility, or the toast silently picks up their styles.
  el.className = "toast" + (kind ? " toast-" + kind : "") + (action ? " toast-act" : "");
  if (action) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "toast-btn"; b.textContent = action.label;
    b.onclick = () => { el.classList.add("hide"); clearTimeout(toast._t); action.run(); };
    el.appendChild(b);
  }
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hide"), action ? 10000 : kind === "err" ? 3500 : 2000);
}

// Is a dialog of ours open? (The self-reload after a new release waits for none.)
export const dialogOpen = () => ["confirmWrap", "flowWrap"].some((id) => {
  const el = document.getElementById(id); return el && !el.classList.contains("hidden");
});

// A small multi-step dialog, with the same focus trap and Escape handling as
// confirmDialog. `show(ctl)` paints the first step; ctl has:
//   ctl.step({ title, html, buttons: [{ label, kind: "filled"|"ghost"|"danger"|"tinted", run, disabled, id }] })
//   ctl.body  (the body element, to wire inputs after a step is painted)
//   ctl.close(value)  resolves the promise
// Escape or a click outside closes with null unless opts.sticky.
// Give focus back to what had it before a dialog opened. An item picked from a
// "More" menu is hidden once the menu closes, so its menu's button gets focus
// instead (R11), never the page.
function focusBack(el) {
  if (!el || !el.focus) return;
  const menu = el.closest && el.closest("details.more");
  const target = menu && !menu.open ? menu.querySelector("summary") : el;
  try { if (target) target.focus(); } catch { /* gone */ }
}
export function flowDialog(show, opts = {}) {
  const wrap = document.getElementById("flowWrap");
  if (!wrap) return Promise.resolve(null);
  const title = document.getElementById("flowTitle"), body = document.getElementById("flowBody"),
    btns = document.getElementById("flowBtns");
  const prevFocus = document.activeElement;
  return new Promise((resolve) => {
    let closed = false;
    const ctl = {
      body,
      close: (v = null) => {
        if (closed) return; closed = true;
        wrap.classList.add("hidden"); body.innerHTML = ""; btns.innerHTML = "";
        document.removeEventListener("keydown", onKey, true);
        wrap.onclick = null;
        focusBack(prevFocus);
        if (opts.onClose) try { opts.onClose(v); } catch { /* ignore */ }
        resolve(v);
      },
      step: ({ title: t, html, buttons = [] }) => {
        title.textContent = t || "";
        body.innerHTML = html || "";
        btns.innerHTML = "";
        buttons.forEach((b) => {
          const el = document.createElement("button");
          el.type = "button"; el.className = "btn " + (b.kind || "ghost"); el.textContent = b.label;
          if (b.id) el.id = b.id;
          if (b.disabled) el.disabled = true;
          el.onclick = () => b.run(ctl, el);
          btns.appendChild(el);
        });
        const first = body.querySelector("input:not([type=hidden]):not([disabled]), select, textarea")
          || btns.querySelector("button:not([disabled]):last-child") || btns.querySelector("button");
        if (first) first.focus();
      },
    };
    const onKey = (e) => {
      if (e.key === "Escape" && !opts.sticky) { e.preventDefault(); e.stopPropagation(); ctl.close(null); }
      else if (e.key === "Tab") {
        const f = [...wrap.querySelectorAll("button:not([disabled]), input:not([disabled]), select, textarea, a[href]")]
          .filter((x) => x.offsetParent !== null);
        if (!f.length) return;
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    wrap.classList.remove("hidden");
    document.addEventListener("keydown", onKey, true);
    wrap.onclick = (e) => { if (e.target === wrap && !opts.sticky) ctl.close(null); };
    show(ctl);
  });
}

// Copy text to the clipboard. A browser that blocks the clipboard gets a dialog
// with the text selected and a "Select all" button. Resolves "copied" or "shown".
export async function copyText(text, { title = "Copy this text" } = {}) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return "copied"; }
  } catch { /* blocked: fall through to the dialog */ }
  await flowDialog((ctl) => {
    ctl.step({ title, html: `<p class="muted small">Your browser didn't let us copy it. Select it and copy it yourself.</p>
      <textarea id="copyBox" rows="8" readonly class="copybox">${escapeHtml(text)}</textarea>`,
      buttons: [{ label: "Close", kind: "ghost", run: (c) => c.close("shown") },
        { label: "Select all", kind: "filled", run: () => { const t = document.getElementById("copyBox"); t.focus(); t.select(); } }] });
    const t = document.getElementById("copyBox"); if (t) { t.focus(); t.select(); }
  });
  return "shown";
}

// Styled confirm dialog → Promise<boolean>. Falls back to window.confirm if the
// dialog markup isn't present. `opts` = { title, yes, danger, alt }. With `alt`
// (a label) a third button appears and resolves to the string "alt".
export function confirmDialog(msg, opts = {}) {
  const wrap = document.getElementById("confirmWrap");
  if (!wrap) return Promise.resolve(window.confirm(msg));
  document.getElementById("confirmTitle").textContent = opts.title || "Are you sure?";
  document.getElementById("confirmMsg").textContent = msg;
  const yes = document.getElementById("confirmYes"), no = document.getElementById("confirmNo");
  const alt = document.getElementById("confirmAlt");
  yes.textContent = opts.yes || "Confirm";
  yes.className = "btn " + (opts.danger === false ? "filled" : "danger");
  if (alt) { alt.textContent = opts.alt || ""; alt.hidden = !opts.alt; }
  const prevFocus = document.activeElement;
  wrap.classList.remove("hidden");
  (opts.alt && alt ? alt : yes).focus();
  return new Promise((resolve) => {
    const done = (v) => {
      wrap.classList.add("hidden");
      yes.onclick = no.onclick = wrap.onclick = null;
      if (alt) alt.onclick = null;
      document.removeEventListener("keydown", onKey, true);
      focusBack(prevFocus);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); } // don't also close Setup
      else if (e.key === "Tab") { // trap focus among the visible buttons
        e.preventDefault();
        const btns = [no, alt, yes].filter((b) => b && !b.hidden);
        const i = btns.indexOf(document.activeElement);
        btns[(i + (e.shiftKey ? btns.length - 1 : 1)) % btns.length].focus();
      }
    };
    yes.onclick = () => done(true);
    if (alt) alt.onclick = () => done("alt");
    no.onclick = () => done(false);
    wrap.onclick = (e) => { if (e.target === wrap) done(false); };
    document.addEventListener("keydown", onKey, true);
  });
}

// Trigger a client-side file download (CSV text, or the bytes of an .xlsx).
export function downloadFile(filename, data, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([data], { type: mime });
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

// The normalized last-name key applicants submit availability under, and the id
// of their interviews_availCand document. "Dr Ben Carter" → "carter".
// ONE definition: app.js, store.js, firestore.rules (via the synced allowed
// list) and scripts/ must all agree, or an applicant's answers land under a key
// nobody reads. Changing it strands every answer saved under the old spelling.
export const lastKey = (name) =>
  String(name || "").trim().split(/\s+/).pop().toLowerCase().replace(/[^a-z0-9]/g, "");

// H14: applicants who share a surname. Titles are dropped from the front of a
// name; the given names are what is left before the surname.
const TITLES = new Set(["dr", "mr", "mrs", "ms", "mx", "prof", "miss"]);
const tokKey = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function givenTokens(name) {
  const toks = String(name || "").trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < toks.length - 1 && TITLES.has(tokKey(toks[i]))) i++;
  return toks.slice(i, -1).map(tokKey).filter(Boolean);
}
// "Dr Jane Kim" → "jane"; a name with no given name → "".
export const firstKey = (name) => givenTokens(name)[0] || "";
// every given name, for two applicants whose first names also match ("Jane A Kim" → "janea")
export const givenKey = (name) => givenTokens(name).join("");
// What an applicant TYPES in "First name": titles dropped; all words first (the
// most specific key, "Jane B" -> "janeb"), then the first word ("jane"). The page
// tries them in this order, so "Jane B Kim" is never booked under Jane Kim.
export function typedFirstKeys(first) {
  const toks = String(first || "").trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < toks.length - 1 && TITLES.has(tokKey(toks[i]))) i++;
  const rest = toks.slice(i).map(tokKey).filter(Boolean);
  return [...new Set([rest.join(""), rest[0] || ""])].filter(Boolean);
}
// The id of an applicant's availability document: their own key when they share
// a surname (set by Admin), else today's surname key.
export const candKey = (c) => (c && c.availKey) || lastKey(c && c.name);
export const dupKey = (c) => { const f = firstKey(c.name); return f ? `${lastKey(c.name)}-${f}` : lastKey(c.name); };

// average of numeric values, or null.
export function avg(nums) {
  const v = nums.filter((n) => typeof n === "number" && !isNaN(n));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
