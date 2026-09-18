# Changes — overnight polish pass

Running log of what changed and why, newest first. Companion to DESIGN.md
(decisions) and README.md (how to run). Written during the autonomous polish
pass so the morning review has a paper trail.

Verification note: there is no browser/Node in the build environment, so live
Firestore and rules could not be exercised here. UI/UX was verified by driving
the app headlessly in **forced local mode** (Chromium/Firefox/WebKit via
Playwright, at mobile + desktop widths) with fictitious seed data — never real
applicant PII, never the live Firestore. Runtime Firestore/rules testing is left
to the morning review; anything not runtime-tested is called out below.

---

## S1 — Committee code rotated + questions re-encrypted
- The old code `edleadership` (public — it is also Motion Voting's passcode) no
  longer decrypts the interview questions. Re-encrypted `{q,s,g}` under a new
  strong private code (same PBKDF2-SHA256 keystream + XOR scheme, same salt/iters).
- Updated `ENC_CIPHER` in [`js/data.js`](js/data.js) and [`mock.html`](mock.html).
- The new code appears **nowhere** in the repo. It is delivered in the morning
  summary (chat only).
- Verified end-to-end in a headless browser: old code → "Incorrect code"; new
  code → accepted; new code + `!` → admin accepted.
