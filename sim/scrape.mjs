// Read the schedule back off the Panels tab exactly as a coordinator sees it.
// Everything downstream is checked against what the UI SHOWS, not against what
// the scheduler returns internally.

// slot label -> id, computed in the page with the app's own slots.js, so the
// scraper and the app can never disagree about how a time is written.
export async function slotLabelMap(page) {
  return page.evaluate(async () => {
    const { effectiveSlots, slotLabel } = await import("./js/slots.js");
    const { SLOTS } = await import("./js/config.js");
    const st = JSON.parse(localStorage.getItem("ed_interviews_v1") || "{}");
    const out = {};
    effectiveSlots(st.settings || {}, SLOTS).forEach((t) => { out[slotLabel(t)] = t.id; });
    return out;
  });
}

export async function readPanels(page) {
  const labels = await slotLabelMap(page);
  const raw = await page.evaluate(() => {
    const txtOf = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
    const panels = [];
    document.querySelectorAll("#panels .panelbox").forEach((box) => {
      const head = box.querySelector(":scope > .row > .grow");
      if (!head) return;
      const editBtn = [...box.querySelectorAll("button")]
        .find((b) => /IV\.editPanel\('/.test(b.getAttribute("onclick") || ""));
      const cand = editBtn ? editBtn.getAttribute("onclick").match(/IV\.editPanel\('([^']+)'\)/)[1] : null;
      if (!cand) return;
      const name = txtOf(head.querySelector("b"));
      // the bare text node after the name holds " · <time label> "
      const slotLabel = [...head.childNodes].filter((n) => n.nodeType === 3)
        .map((n) => n.textContent).join(" ").replace(/\s+/g, " ").replace(/^\s*·\s*/, "").trim();
      const pills = [...head.querySelectorAll(".pill")].map((p) => p.textContent.trim());
      const membersEl = box.querySelector(":scope > .small");
      panels.push({
        cand, name, slotLabel,
        modality: pills.includes("In-person") ? "ip" : pills.includes("Zoom") ? "zoom" : null,
        manual: pills.includes("manual"),
        members: txtOf(membersEl).split("·").map((s) => s.trim()).filter(Boolean),
        badges: [...box.querySelectorAll(".badge")].map((b) => b.textContent.trim()),
      });
    });
    const attention = { unschedulable: [], understaffed: [], doubleBooked: [], lostTime: [], reasons: {} };
    const card = [...document.querySelectorAll("#panels .card")]
      .find((c) => /Needs attention/.test(c.textContent));
    if (card) card.querySelectorAll("li").forEach((li) => {
      const t = li.textContent.replace(/\s+/g, " ").trim();
      const ids = [...li.querySelectorAll("button")]
        .map((b) => (b.getAttribute("onclick") || "").match(/IV\.(?:editPanel|clearOverride)\('([^']+)'\)/))
        .filter(Boolean).map((m) => m[1]);
      if (/booked at the same time/.test(t)) attention.doubleBooked.push({ text: t, ids });
      else if (/time that has since been removed/.test(t)) attention.lostTime.push(ids[0]);
      else if (/not enough available interviewers/.test(t)) attention.understaffed.push(t.split(" — ")[0].trim());
      else if (ids.length) { attention.unschedulable.push(ids[0]); attention.reasons[ids[0]] = t; }
    });
    return { panels, attention, empty: /No panels yet/.test(document.querySelector("#panels").textContent) };
  });

  const toId = (label) => (label in labels ? labels[label] : `??${label}`);
  return {
    schedule: raw.panels.map((p) => ({ ...p, slot: toId(p.slotLabel) })),
    unschedulable: raw.attention.unschedulable,
    reasons: raw.attention.reasons,
    understaffed: raw.attention.understaffed.map(toId),
    doubleBooked: raw.attention.doubleBooked,
    lostTime: raw.attention.lostTime,
    empty: raw.empty,
  };
}

// The applicant availability grid (admin, Availability tab), read back as data:
// { columns, cells: { Surname: { slotLabel-free id: "ip"|"zoom"|"either" } },
//   booked: { Surname: slotId }, offered: { Surname: "3" }, usable, capacity }
export async function readCandGrid(page) {
  const raw = await page.evaluate(() => {
    const sec = document.querySelector('details[data-sec="candgrid"]');
    if (!sec) return null;
    const table = sec.querySelector("table.avgrid");
    const columns = [...table.querySelectorAll("thead th.ivcol")].map((th) => th.textContent.trim());
    const cells = {}, booked = {}, offered = {}, usable = {};
    columns.forEach((c) => { cells[c] = {}; });
    let day = "";
    table.querySelectorAll("tbody tr").forEach((tr) => {
      if (tr.classList.contains("dayrow")) { day = tr.textContent.trim(); return; }
      if (tr.classList.contains("footrow")) {
        [...tr.querySelectorAll("td.tot")].forEach((td, i) => { offered[columns[i]] = td.textContent.trim(); });
        return;
      }
      const time = tr.querySelector("th.tlab").textContent.trim();
      const label = `${day} · ${time}`;
      [...tr.querySelectorAll("td.av")].forEach((td, i) => {
        const mod = ["ip", "zoom", "either"].find((m) => td.classList.contains(m));
        if (mod) cells[columns[i]][label] = mod;
        if (td.classList.contains("booked")) booked[columns[i]] = label;
      });
      const sum = tr.querySelector("td.sum");
      usable[label] = sum ? sum.textContent.trim() : "";
    });
    const warn = sec.querySelector(".note.warnbox");
    return { columns, cells, booked, offered, usable, capacity: warn ? warn.textContent.replace(/\s+/g, " ").trim() : "" };
  });
  if (!raw) return null;
  // This grid heads each day with the LONG date and labels rows with the time
  // only, so build the map with the same two helpers the grid itself uses
  // rather than guessing at slotLabel's short form.
  const byLabel = await page.evaluate(async () => {
    const { effectiveSlots, groupByDate, slotTimeLabel } = await import("./js/slots.js");
    const { SLOTS } = await import("./js/config.js");
    const st = JSON.parse(localStorage.getItem("ed_interviews_v1") || "{}");
    const out = {};
    groupByDate(effectiveSlots(st.settings || {}, SLOTS)).forEach((g) =>
      g.items.forEach((t) => { out[`${g.title} · ${slotTimeLabel(t)}`] = t.id; }));
    return out;
  });
  const toId = (label) => (label in byLabel ? byLabel[label] : `??${label}`);
  const remap = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [toId(k), v]));
  return {
    columns: raw.columns,
    cells: Object.fromEntries(Object.entries(raw.cells).map(([c, m]) => [c, remap(m)])),
    booked: Object.fromEntries(Object.entries(raw.booked).map(([c, l]) => [c, toId(l)])),
    offered: raw.offered, usable: remap(raw.usable), capacity: raw.capacity,
  };
}

// The interviewer-load section, as shown to the admin.
export async function readLoad(page) {
  return page.evaluate(() => {
    const sec = document.querySelector('details[data-sec="panelload"]');
    if (!sec) return null;
    const chips = [...sec.querySelectorAll(".sec-body > div > .chip")].map((c) => {
      const m = c.textContent.trim().match(/^(.*?)\s*(?:×(\d+)|—)$/);
      return m ? { name: m[1].trim(), n: m[2] ? +m[2] : 0 } : null;
    }).filter(Boolean);
    // the three "not on any panel" lines, by the reason each one gives
    const idle = { silent: [], wrongTimes: [], squeezed: [] };
    sec.querySelectorAll(".sec-body p.small").forEach((p) => {
      const t = p.textContent.replace(/\s+/g, " ");
      const who = [...p.querySelectorAll(".chip")].map((c) => c.textContent.trim());
      if (!who.length) return;
      if (/no availability sent yet/.test(t)) idle.silent.push(...who);
      else if (/free only at times/.test(t)) idle.wrongTimes.push(...who);
      else if (/every panel they could have joined/.test(t)) idle.squeezed.push(...who);
    });
    return { summary: sec.querySelector(".sec-sub") ? sec.querySelector(".sec-sub").textContent : "", chips, idle,
             unusedWarning: /Not on any panel/.test(sec.textContent) };
  });
}
