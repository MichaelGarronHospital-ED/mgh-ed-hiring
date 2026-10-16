// ============================================================================
//  Close the round (H1, design section 6.4).
//
//  First half (nothing in the round changes except a pause, so it can always
//  be stopped): pause, take a fresh snapshot, save it as a new archive attempt
//  in parts of at most 900,000 UTF-8 bytes, read it back and check it, then ask
//  for the backup download and the typed round name.
//  Second half: clear CLEAR_COLLECTIONS only, deleting a document only if it is
//  still identical to its saved copy, then ONE finish batch resets the meta
//  fields, marks the attempt closed and opens the next round. A stop after
//  clearing began puts every cleared document back from the copy.
//
//  THE OWNERSHIP RULE (review 3 M1): every write this flow makes, without
//  exception, goes through store.closeTx (the tx() helper below), which
//  re-reads state and the attempt inside a transaction and goes on only if
//  this page (its id AND this load's nonce) holds the close and the attempt
//  has the status that step expects. Before any timer acts, and whenever the
//  tab wakes, the page re-reads state and stands down if it no longer holds
//  the close. Never add a plain write to this flow.
// ============================================================================

import { buildBackup, chunkBytes, unchunk, parseBackup, CLEAR_COLLECTIONS, canonical, encodeValue, utf8Length,
         FORMAT, VERSION, docHash } from "./backup.js?v=R7";
import { entry as hEntry } from "./history.js?v=R7";
import { escapeHtml, flowDialog, toast, ss } from "./util.js?v=R7";
import { bookingFor } from "./stages.js?v=R7";

export const TIMING = { renewMs: 30000, staleMs: 5 * 60000, idleMs: 30 * 60000, lateMs: 2 * 60000, progressMs: 30000,
  keptMax: 200, chunk: 450, partBytes: 900000, keptHistoryBytes: 400000 };

const rand = () => Math.random().toString(36).slice(2, 8);
const ymd = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

// The page id lives in sessionStorage, so a page that reloads mid-close is
// still the holder; where storage is blocked it lives in memory only. Every
// page load also makes a fresh nonce. A duplicated tab copies sessionStorage,
// so twins start with the same id: on the first state the page sees, it keeps
// the id only if that id holds a close (a reload mid-close carries on) and
// otherwise takes a new one, so the twins part ways (review M4).
let TAB = null;
export function pageId() {
  if (TAB) return TAB;
  TAB = ss.get("ed_iv_tab") || `p-${rand()}${rand()}`;
  ss.set("ed_iv_tab", TAB);
  return TAB;
}
export function newPageId() {
  TAB = `p-${rand()}${rand()}`;
  ss.set("ed_iv_tab", TAB);
  return TAB;
}
export const LOAD = `l-${rand()}${rand()}`;
export const holds = (st) => !!st && st.closingTab === pageId() && !!st.lease && typeof st.lease === "object" && st.lease.load === LOAD;

// deps: { store(), state() (page state S), byWho(), release, roundName(), retentionMonths(),
//         downloadText(name, text, mime), excelFromData(data), rerender(), onActive(bool) }
export function createRounds(deps) {
  const C = { active: false, attemptId: null, half: 1, backup: null, text: null, ctl: null, kept: [], keptHistory: [], name: "",
    lastAction: 0, lastProgress: 0, lastTick: 0, timer: null, resuming: false, resumed: false, stoodDown: false,
    seenFirst: false, preResumeLoad: null, partsTried: 0, leaseSeen: { key: "", since: 0 } };
  const hooks = {};               // test hooks (the emulator build reaches them); empty in normal use
  const store = () => deps.store();
  const ctx = () => ({ tab: pageId(), load: LOAD, attemptId: C.attemptId });
  const acted = () => { C.lastAction = Date.now(); };

  // ---- the only way this flow writes -----------------------------------
  // One at a time: every close transaction waits for the one before it (the
  // heartbeat and a "Try again" must never race each other).
  let chain = Promise.resolve();
  function tx(expect, fn) {
    const run = chain.then(() => tx1(expect, fn));
    chain = run.catch(() => {});
    return run;
  }
  async function tx1(expect, fn) {
    try { return await store().closeTx(ctx(), expect, fn); }
    catch (e) {
      if (e && e.code === "took-over") { tookOver(); throw e; }
      if (e && e.code === "permission-denied") {            // refused by the rules: do we still hold it?
        let st = {}; try { st = await store().getStateFresh(); } catch { /* offline */ }
        if (!holds(st)) { tookOver(); const t = new Error("took over"); t.code = "took-over"; throw t; }
      }
      throw e;
    }
  }

  // ---- lease, heartbeat, waking up ----------------------------------------
  function setActive(on) {
    C.active = on;
    if (deps.onActive) deps.onActive(on);
    clearInterval(C.timer); C.timer = null;
    if (on) { C.lastTick = Date.now(); C.timer = setInterval(tick, TIMING.renewMs); }
  }
  async function wakeCheck() {
    if (!C.active) return false;
    let st;
    try { st = await store().getStateFresh(); } catch { return true; }   // offline: try again next tick
    if (!holds(st)) {
      if (st.closingTab === pageId()) C.stoodDown = true;
      tookOver(st.closingTab === pageId() ? "This close is continuing in another copy of this page." : undefined); return false;
    }
    return true;
  }
  async function renew() { try { await tx(null, () => {}); } catch { /* handled in tx */ } }
  async function tick() {
    C.lastTick = Date.now();
    if (!(await wakeCheck())) return;
    const now = Date.now();
    if (C.half === 1) {
      if (now - C.lastAction > TIMING.idleMs) { await stop("Closing was stopped because nothing happened for 30 minutes. The round is open again."); return; }
      if (C.ctl) await renew();
    } else if (now - C.lastProgress < TIMING.progressMs || now - C.lastAction < TIMING.idleMs) await renew();
  }
  const onWake = async () => { if (C.active && document.visibilityState === "visible" && (await wakeCheck())) await renew(); };
  try { document.addEventListener("visibilitychange", onWake); window.addEventListener("focus", onWake); } catch { /* tests */ }

  function tookOver(msg = "Another Leadership page took over closing. Nothing more was changed from this page.") {
    if (!C.active && !C.ctl) return;
    setActive(false);
    show({ title: "Closing the round", html: `<p>${escapeHtml(msg)}</p>`, buttons: [{ label: "Close", kind: "filled", run: (k) => k.close() }] });
  }

  // ---- the dialog ------------------------------------------------------------
  function show(step) {
    if (C.ctl) { C.ctl.step(step); return; }
    flowDialog((ctl) => { C.ctl = ctl; ctl.step(step); }, { sticky: true, onClose: () => { C.ctl = null; } });
  }
  const progress = (title, text) => show({ title, html: `<p class="muted">${escapeHtml(text)}</p>`, buttons: [] });
  const stopButton = (label = "Stop closing") => ({ label, kind: "ghost", run: () => { acted(); stop(); } });

  // ---- first half -------------------------------------------------------------
  async function begin() {
    const st = deps.state().meta || {};
    if ((st.keptFromClose || []).length) {
      toast(`First decide what to do with the ${st.keptFromClose.length} item${st.keptFromClose.length === 1 ? "" : "s"} kept from the last close (Setup, This round).`, "err");
      return;
    }
    acted();
    show({ title: "Close the round?",
      html: `<p>Everything in it (applicants, screening, availability, panels, scores, ranking, offers and change history) moves to
        Past rounds, which only Leadership can see. The committee and applicants will see an empty tool, ready for the next round.</p>
        <p class="muted">Kept for next round: the committee list, the interview questions and your settings.</p>`,
      buttons: [{ label: "Cancel", kind: "ghost", run: (k) => k.close() }, { label: "Continue", kind: "filled", run: () => { acted(); pause(); } }] });
  }

  async function pause() {
    C.attemptId = `a-${ymd()}-${rand()}`;
    C.name = deps.roundName();
    C.half = 1; C.kept = []; C.backup = null;
    try { await store().startClose(ctx(), C.attemptId); }
    catch (e) {
      show({ title: "Close the round", html: `<p>${escapeHtml(e && e.code === "took-over" ? "Another Leadership page is already closing the round." : (e && e.message) || "Couldn't start. Check your connection.")}</p>`,
        buttons: [{ label: "Close", kind: "filled", run: (k) => k.close() }] });
      return;
    }
    setActive(true);
    await saveCopy(true);
  }

  // steps 3 and 4: a fresh snapshot, saved as parts, read back and checked
  async function saveCopy(create) {
    progress("Saving a copy of the round", "Reading everything fresh from the database. Keep this page open.");
    try {
      const raw = await store().snapshotRaw();
      const st = (raw.interviews_meta || {}).state || {};
      const b = await buildBackup(raw, { exportedBy: deps.byWho(), build: deps.release });
      b.round.name = C.name || st.roundName || `Hiring round ${new Date().getFullYear()}`;
      const text = JSON.stringify(b);
      const parts = chunkBytes(text, TIMING.partBytes);
      const roundId = st.roundId || `r-before-rounds-${ymd()}`;
      if (create) await tx(["missing"], (w) => w.attemptCreate(C.attemptId, { roundId, name: b.round.name, status: "saving",
        startedAt: w.claim.at, closedBy: deps.byWho(), format: FORMAT, version: VERSION, parts: parts.length, bytes: utf8Length(text),
        checksum: b.checksum, counts: b.counts, restoredAt: null }));
      C.partsTried = Math.max(C.partsTried, parts.length);
      for (let i = 0; i < parts.length; i++) {
        if (hooks.beforePart) await hooks.beforePart(i);
        // the first write also says how many parts there are, so a later "Try
        // again" can delete every one of them inside its own transaction
        await tx(["saving"], (w) => { if (i === 0 && !create) w.attempt({ parts: parts.length }); w.part(i, parts[i]); });
        C.lastProgress = Date.now();
      }
      const back = unchunk(await store().readParts(C.attemptId));
      if (back !== text) throw new Error("The saved copy didn't read back the same.");
      await parseBackup(back);                                  // the checksum again, from what was saved
      await tx(["saving"], (w) => w.attempt({ status: "saved", roundId, name: b.round.name, parts: parts.length,
        bytes: utf8Length(text), checksum: b.checksum, counts: b.counts }));
      C.backup = b; C.text = text;
      step5();
    } catch (e) {
      if (e && e.code === "took-over") return;
      console.warn("close: saving the copy failed", e);
      show({ title: "Saving the copy didn't work", html: "<p>Nothing in the round was changed.</p>",
        buttons: [stopButton(), { label: "Try again", kind: "filled", run: () => { acted(); retry(); } }] });
    }
  }
  // "Try again": a new attempt id in state and the new attempt in one
  // transaction; the failed attempt is only a copy, and it and its parts are
  // deleted in that same transaction (no write outside closeTx).
  async function retry() {
    const old = C.attemptId, next = `a-${ymd()}-${rand()}`;
    try {
      await tx(["missing", "saving", "saved"], (w) => {
        w.state({ closingAttemptId: next });
        w.attemptCreate(next, { roundId: "pending", name: C.name, status: "saving", startedAt: w.claim.at, closedBy: deps.byWho(),
          format: FORMAT, version: VERSION, restoredAt: null });
        if (w.att) {
          const n = Math.max(Number(w.att.parts) || 0, C.partsTried || 0);
          for (let i = 0; i < n; i++) w.partDelete(old, i);
          w.attemptDelete(old);
        }
      });
    } catch (e) { if (e && e.code === "took-over") return; show({ title: "Couldn't try again", html: `<p>${escapeHtml((e && e.message) || "Check your connection.")}</p>`, buttons: [stopButton(), { label: "Try again", kind: "filled", run: retry }] }); return; }
    C.attemptId = next; C.partsTried = 0;
    await saveCopy(false);
    // the real roundId and counts, now that the copy is saved
  }

  function step5() {
    const phone = /iPhone|iPad|Android/i.test(navigator.userAgent || "") || (navigator.maxTouchPoints || 0) > 1;
    const paint = (ticked) => show({ title: "Now save the backup",
      html: `<p>Download the backup file and save it with the CVs on OneDrive. It has applicant names and the committee's comments; don't email it.</p>
        ${phone ? `<p class="small">Keep this page open until you have saved the backup. If you switch to another app for more than a few minutes, another Leadership page could take over the close.</p>` : ""}
        <div class="row backup-actions"><button type="button" class="btn tinted small" id="clBackup">Download backup file</button>
          <button type="button" class="btn ghost small" id="clExcel">Download Excel</button></div>
        <label class="small knows"><input type="checkbox" id="clSaved" ${ticked ? "checked" : ""}/> I saved the backup.</label>`,
      buttons: [stopButton(), { label: "Next", kind: "filled", id: "clNext", disabled: !ticked, run: () => { acted(); step6(); } }] });
    paint(false);
    const wire = () => {
      const b = document.getElementById("clBackup"), x = document.getElementById("clExcel"), t = document.getElementById("clSaved");
      if (b) b.onclick = () => { acted(); deps.downloadText(deps.backupName(C.backup.round.name), JSON.stringify(C.backup, null, 1), "application/json"); };
      if (x) x.onclick = () => { acted(); deps.excelFromData(C.backup.data); };
      if (t) t.onchange = () => { acted(); const n = document.getElementById("clNext"); if (n) n.disabled = !t.checked; };
    };
    wire();
  }

  function step6() {
    show({ title: "Close the round",
      html: `<p>Type the round name to confirm: <b>${escapeHtml(C.backup.round.name)}</b></p>
        <input id="clName" type="text" autocomplete="off" aria-label="Round name"/>`,
      buttons: [stopButton(), { label: "Close the round", kind: "danger", id: "clGo", disabled: true, run: () => { acted(); clear(); } }] });
    const i = document.getElementById("clName");
    if (i) i.oninput = () => { acted(); const g = document.getElementById("clGo"); if (g) g.disabled = i.value.trim().toLowerCase() !== C.backup.round.name.trim().toLowerCase(); };
  }

  // ---- second half ------------------------------------------------------------
  async function clear(resumed) {
    C.half = 2; C.lastProgress = Date.now();
    progress("Closing the round", "Clearing the working round. Keep this page open.");
    // collected afresh on every run (a "Try again" starts from nothing)
    C.kept = []; C.keptHistory = [];
    try {
      if (!resumed) await tx(["saved"], (w) => w.attempt({ status: "clearing" }));
      const copy = C.backup.data;
      for (const coll of CLEAR_COLLECTIONS) {
        const live = (await store().readCollections([coll]))[coll];
        const same = [], keptHere = new Map();
        // kept: changed (or new) after the copy. Each carries the hash of the
        // document as kept; history written after the copy goes with the old
        // round (on the attempt) and is removed from the new one at finish.
        const keep = (id, d) => keptHere.set(id, coll === "interviews_history" ? { id, data: encodeValue(d) } : { coll, id, hash: docHash(d) });
        Object.entries(live).forEach(([id, d]) => {
          const c = (copy[coll] || {})[id];
          if (c !== undefined && canonical(encodeValue(d)) === canonical(c)) same.push(id);
          else keep(id, d);
        });
        for (let i = 0; i < same.length; i += TIMING.chunk) {
          const ids = same.slice(i, i + TIMING.chunk);
          if (hooks.beforeChunk) await hooks.beforeChunk(coll, ids);
          // decided inside the transaction, kept outside it: a transaction that
          // runs its function twice must not count an item twice
          const chunkKept = await tx(["clearing"], async (w) => {
            const mine = [];
            const cur = await Promise.all(ids.map((id) => w.get(coll, id)));
            ids.forEach((id, j) => {
              if (cur[j] && canonical(encodeValue(cur[j])) === canonical(copy[coll][id])) w.del(coll, id);
              else if (cur[j]) mine.push([id, cur[j]]);
            });
            return mine;
          });
          (chunkKept || []).forEach(([id, d]) => keep(id, d));
          C.lastProgress = Date.now();
        }
        keptHere.forEach((k) => (coll === "interviews_history" ? C.keptHistory : C.kept).push(k));
      }
      // history kept from after the copy rides on the attempt document, which
      // must stay under Firestore's 1 MiB: count bytes as well as entries
      if (C.kept.length > TIMING.keptMax || C.keptHistory.length > TIMING.keptMax
          || utf8Length(JSON.stringify(C.keptHistory)) > TIMING.keptHistoryBytes) {
        show({ title: "The round was not closed",
          html: `<p>More than ${TIMING.keptMax} items changed after the copy was saved, so the round was not closed. Something is still
            writing to it (often an older Physician Hiring page left open). Reload or close every other Physician Hiring page, then stop
            closing, which puts everything back exactly as it was, and close the round again.</p>`,
          buttons: [{ label: "Stop closing and put everything back", kind: "filled", run: () => { acted(); putBack(); } }] });
        return;
      }
      await finish();
    } catch (e) {
      if (e && e.code === "took-over") return;
      console.warn("close: clearing failed", e);
      show({ title: "Closing stopped part way", html: "<p>Nothing is lost: everything is in the saved copy.</p>",
        buttons: [{ label: "Stop closing and put everything back", kind: "ghost", run: () => { acted(); putBack(); } },
          { label: "Try again", kind: "filled", run: () => { acted(); clear(true); } }] });
    }
  }

  // step 9: ONE batch, all or nothing (under 10 documents)
  async function finish() {
    const months = deps.retentionMonths();
    const name = C.backup.round.name;
    const applicants = Object.keys(C.backup.data.interviews_candidates || {}).length;
    const nextRound = `r-${ymd()}-${rand()}`;
    const kept = C.kept.slice(0, TIMING.keptMax), keptHistory = C.keptHistory.slice(0, TIMING.keptMax);
    await tx(["clearing"], (w) => {
      keptHistory.forEach((h) => w.del("interviews_history", h.id));
      w.set("interviews_meta", "config", { times: [], slots: [], panelOverrides: {}, days: {}, deadlines: {} },
        { mergeFields: ["times", "slots", "panelOverrides", "days", "deadlines"] });
      w.set("interviews_meta", "allowed", { keys: [] }, { mergeFields: ["keys"] });
      w.set("interviews_meta", "schedule", { locked: false, panels: {} });
      w.set("interviews_public", "slots", { times: [], slots: [], booking: "open" }, { mergeFields: ["times", "slots", "booking"] });
      w.attempt({ status: "closed", closedAt: store().now(), deleteAfter: months ? store().tsFromMillis(Date.now() + months * 30.44 * 864e5) : null,
        ...(keptHistory.length ? { keptHistory } : {}) });
      w.stateReplace({ interviewsComplete: false, stages: {}, roundStatus: "open", roundId: nextRound, roundName: "", roundOpenedAt: store().now(),
        closingAttemptId: null, closingStartedAt: null, closingTab: null, keptFromClose: kept, keptFromRound: kept.length ? name : null,
        keptFromAttempt: kept.length ? C.attemptId : null, broughtBackFrom: null });
      w.history(hEntry("round.close", `Closed the round '${name}' (${applicants} applicant${applicants === 1 ? "" : "s"}`
        + `${kept.length ? `, ${kept.length} item${kept.length === 1 ? "" : "s"} kept because ${kept.length === 1 ? "it" : "they"} changed after the copy` : ""})`, { by: deps.byWho() }));
    });
    setActive(false);
    const until = months ? new Date(Date.now() + months * 30.44 * 864e5).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : null;
    show({ title: "Round closed",
      html: `<p>${until ? `Round closed. It is kept until ${escapeHtml(until)} (your setting: ${months % 12 ? months + " months" : months / 12 + " year" + (months === 12 ? "" : "s")}).`
        : "Round closed. It is kept until someone deletes it. Set how long to keep closed rounds in Setup."}</p>`,
      buttons: [{ label: "Done", kind: "filled", run: (k) => k.close() }] });
    deps.rerender();
  }

  // ---- stopping ----------------------------------------------------------------
  // Before clearing: nothing to undo; the attempt becomes "abandoned" (a copy).
  async function stop(message) {
    try {
      await tx(["missing", "saving", "saved"], (w) => {
        w.state({ roundStatus: "open", closingAttemptId: null, closingStartedAt: null, closingTab: null });
        w.set("interviews_public", "slots", { booking: bookingFor({ ...w.st, roundStatus: "open" }) }, { mergeFields: ["booking"] });
        if (w.att) w.attempt({ status: "abandoned" });
        w.history(hEntry("round.close", "Started closing the round and stopped. Nothing was lost.", { by: deps.byWho() }));
      });
    } catch (e) {
      if (e && e.code === "took-over") return;
      // the attempt was clearing after all (another step got there): put back instead
      if (C.half === 2) return putBack();
      show({ title: "Couldn't stop", html: `<p>${escapeHtml((e && e.message) || "Check your connection.")}</p>`, buttons: [stopButton("Try again")] });
      return;
    }
    setActive(false);
    show({ title: "Closing stopped", html: `<p>${escapeHtml(message || "Closing was stopped. The round is open again. Nothing was lost.")}</p>`,
      buttons: [{ label: "Close", kind: "filled", run: (k) => k.close() }] });
    deps.rerender();
  }

  // After clearing began: write back every document that is missing, confirm,
  // then open the round again; the attempt becomes "abandoned" (only a copy now).
  async function putBack() {
    progress("Putting everything back", "Writing back every cleared item from the saved copy. Keep this page open.");
    try {
      const copy = C.backup.data;
      for (const coll of CLEAR_COLLECTIONS) {
        const live = (await store().readCollections([coll]))[coll];
        const missing = Object.keys(copy[coll] || {}).filter((id) => live[id] === undefined);
        for (let i = 0; i < missing.length; i += TIMING.chunk) {
          const ids = missing.slice(i, i + TIMING.chunk);
          await tx(["clearing"], (w) => ids.forEach((id) => {
            const d = store().decode(copy[coll][id]);
            w.set(coll, id, coll === "interviews_history" ? { ...d, restored: true } : d);
          }));
          C.lastProgress = Date.now();
        }
      }
      const again = await store().readCollections([...CLEAR_COLLECTIONS]);
      const gone = CLEAR_COLLECTIONS.flatMap((c) => Object.keys(copy[c] || {}).filter((id) => again[c][id] === undefined));
      if (gone.length) throw new Error(`${gone.length} items did not come back.`);
      await tx(["clearing"], (w) => {
        w.state({ roundStatus: "open", closingAttemptId: null, closingStartedAt: null, closingTab: null });
        w.set("interviews_public", "slots", { booking: bookingFor({ ...w.st, roundStatus: "open" }) }, { mergeFields: ["booking"] });
        w.attempt({ status: "abandoned" });
        w.history(hEntry("round.close", "Started closing the round and stopped. Nothing was lost.", { by: deps.byWho() }));
      });
    } catch (e) {
      if (e && e.code === "took-over") return;
      show({ title: "Putting back stopped part way", html: `<p>${escapeHtml((e && e.message) || "Check your connection.")} Nothing is lost: everything is in the saved copy.</p>`,
        buttons: [{ label: "Try again", kind: "filled", run: () => { acted(); putBack(); } }] });
      return;
    }
    setActive(false);
    show({ title: "Closing stopped", html: "<p>Everything is back. The round is open again. Nothing was lost.</p>",
      buttons: [{ label: "Close", kind: "filled", run: (k) => k.close() }] });
    deps.rerender();
  }

  // ---- loading the saved copy (after a reload or a takeover) -------------------
  async function loadCopy() {
    const text = unchunk(await store().readParts(C.attemptId));
    C.backup = await parseBackup(text);
    C.text = text;
  }

  // ---- this page reloaded mid-close (same id, new load): carry on --------------
  async function resume(st) {
    if (C.resuming) return;
    C.resuming = true;
    try {
      // until the reclaim's own snapshot arrives, a snapshot may still carry the
      // previous load's claim: that is this page before the reload, not a twin
      C.preResumeLoad = st.lease && st.lease.load;
      await store().reclaim(ctx());                    // a holder write with this load's nonce
      C.attemptId = st.closingAttemptId;
      C.name = st.roundName || "";
      setActive(true); acted();
      const att = await store().readAttempt(C.attemptId);
      const status = att ? att.status : "missing";
      if (status === "missing" || status === "saving") { C.half = 1; await retry(); }
      else if (status === "saved") { C.half = 1; await loadCopy(); step5(); }
      else if (status === "clearing") { C.half = 2; await loadCopy(); await clear(true); }
    } catch (e) { if (!(e && e.code === "took-over")) console.warn("close: resume failed", e); }
    finally { C.resuming = false; }
  }

  // ---- other pages ----------------------------------------------------------------
  // Called with every new state document. Returns how this page should look:
  //   "none"     no close in progress
  //   "holder"   this page holds it (the dialog shows the step)
  //   "fresh"    another page holds it and is renewing: read-only, no buttons
  //   "stale"    the lease hasn't changed for 5 minutes on THIS page's clock:
  //              offer Finish closing / Stop closing (a takeover first)
  // Call it only once the state document has loaded (the first call decides
  // whether this page is a reload of the holder).
  function onState(st) {
    st = st || {};
    const first = !C.seenFirst;
    C.seenFirst = true;
    if (st.roundStatus !== "closing") {
      C.leaseSeen = { key: "", since: 0 }; C.stoodDown = false; C.resumed = false; C.preResumeLoad = null;
      if (first) newPageId();
      return "none";
    }
    // a close with no holder (left that way by an older page) is offered at once
    if (!st.closingTab) { C.leaseSeen = { key: "", since: 0 }; if (first) newPageId(); return "stale"; }
    const load = st.lease && st.lease.load;
    if (st.closingTab === pageId() && !C.stoodDown) {
      if (load === LOAD) return "holder";
      if (C.active && load && load === C.preResumeLoad) return "holder";   // our own claim from before the reload
      // another copy of this page (a duplicated tab) wrote a newer claim: it wins
      if (C.active) { C.stoodDown = true; tookOver("This close is continuing in another copy of this page."); return "fresh"; }
      // this page reloaded mid-close: carry on. Only on the first state after
      // loading: later, the same id with another load is a twin's close, and
      // this page stays read-only (review M4)
      if (first && !C.resuming && !C.resumed) { C.resumed = true; resume(st); return "holder"; }
      if (C.resuming || C.resumed) return "holder";
    } else if (first && st.closingTab !== pageId()) newPageId();
    const key = JSON.stringify(st.lease || null);
    if (C.leaseSeen.key !== key) C.leaseSeen = { key, since: Date.now() };
    return Date.now() - C.leaseSeen.since >= TIMING.staleMs ? "stale" : "fresh";
  }

  // "Finish closing" / "Stop closing" from a page that sees a stale close.
  async function takeoverAnd(action, st) {
    const attemptId = st.closingAttemptId || null;
    C.attemptId = attemptId; C.name = st.roundName || "";
    try { await store().takeover(ctx(), attemptId); }
    catch (e) {
      toast(e && e.code === "permission-denied" ? "The close is still running on another page. Try again in a few minutes."
        : (e && e.message) || "Couldn't take over. Check your connection.", "err");
      return;
    }
    setActive(true); acted();
    const att = attemptId ? await store().readAttempt(attemptId) : null;
    const status = att ? att.status : "missing";
    if (action === "stop") {
      if (status === "clearing") { C.half = 2; await loadCopy(); await putBack(); }
      else { C.half = 1; await stop(); }
      return;
    }
    if (status === "missing" || status === "saving") { C.half = 1; await retry(); }
    else if (status === "saved") { C.half = 1; await loadCopy(); step5(); }
    else if (status === "clearing") { C.half = 2; await loadCopy(); await clear(true); }
  }

  return { begin, onState, takeoverAnd, hooks, tick, wakeCheck, get active() { return C.active; }, _tx: tx, _ctx: ctx, _C: C,
    // the steps themselves, for tests that drive the flow without a screen
    _steps: { pause, saveCopy, clear, finish, stop, putBack, setActive } };
}
