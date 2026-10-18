# Changes — overnight polish pass

Running log of what changed and why, newest first. Companion to DESIGN.md
(decisions) and README.md (how to run). Written during the autonomous polish
pass so the morning review has a paper trail.

Verification note (updated Sept 21 2026): the Firestore **rules** have since been
exercised for real — the emulator suite in [`tests/`](tests/) runs green here,
**44/44**, and was confirmed load-bearing by breaking `isAdmin()` and watching 20
of the 39 fail (see the Sept 21 entries below). What remains untested is only the
**roles auth path**: creating the three Firebase Auth accounts and flipping
`AUTH.mode`, which needs the live project. Everything else
was verified by driving the app headlessly with Playwright in **forced local mode**
(config's firebaseConfig blanked via request interception) with fictitious seed
data — **never** real applicant PII, **never** the live Firestore. Verified across
**Chromium, Firefox, and WebKit** at mobile (400/430px) and desktop (1000px):
all three roles (committee/admin/applicant), every tab, the gate (old code
rejected / new accepted / applicant code), question decryption, candidate slot
selection, the panel editor + validation, and tab keyboard navigation — no console
errors. The paneling algorithm was re-ported to Python and checked against 300
randomized trials (optimal matching + every panel invariant). What still needs
the operator's live testing: Firestore reads/writes under the hardened rules and
the three role-account sign-ins (see the console steps in README).

---

## R11: tabs in the order of the work, a quieter page (built Oct 18 2026)

Alvin asked for "as minimal and simple as possible, anyone can pick it up" (spec:
`../designs/ux-pass-2026-10-18.md`). Only how things look and where they sit changed. Every
gate, confirm, stage lock, history entry, privacy rule and saved value is as it was.

- **Admin tabs are Screen, Availability, Panels, Questions, Ranking**, the order a round is
  run in. Members keep Screen, Availability, Score; screeners keep Screen.
- **Interview times moved from Setup to the top of the Availability tab** (same editor, same
  safe save). Once times exist it folds to one line, "2 times on Tue, Nov 17", with Edit.
- **The interview questions moved from Setup to a new Questions tab** (Admin only). They still
  lock once scoring starts; only the wording can change then.
- **Screen tab:** "+ Add applicants" is the first thing on the tab, opening the form in place.
- **Panels tab:** one main button (Lock the schedule, then Send times to applicants); Export
  CSV, Print, Reset hand-made panels, the calendar file for all interviews and Copy all
  applicant emails are in one More menu. Each panel has two small groups, Email (applicant,
  panel) and Calendar (panel, applicant), instead of four long links.
- **Setup is shorter and grouped:** People, This round, Records, Passwords.
- **Fewer words on the page:** long explanations moved behind the (i) next to what they
  explain (the interviewer load, the backup card, the times editor, Offers, the legends under
  the grids). "Everyone has answered" style lines that only say all is well are gone.
- Small tap targets (Auto/On/Off, 1 room/2 rooms, question order) grew to 40px on phones; the
  More menus close when you pick something, tap elsewhere or press Escape.
- Sims follow the moves (`scenarios`, `editors`, `foundations`, `notices`, `applicants`,
  `emulator`), `adminHasNoName` now pins the tab order and where the editors are, and
  `foundations` `editorsSurviveUpdates` pins that a live update never redraws a times form
  being typed in or loses a question being typed (each guard was removed once to see it fail).
- No module or export was removed. `firestore.rules` is unchanged.

## R10: "Leadership" is now "Admin" in every visible word (built Oct 18 2026; ships after R9)

Alvin's decision (Oct 18 2026): the shared password and access level called "Leadership" is
called "Admin" everywhere people see it. Nothing else changes: same password, same accounts,
nobody is signed out.

- **The page:** the sign-in help ("the Admin password"), the role line ("Admin access.", "Those
  need the Admin password"), "Only Admin sees everyone's together", the "(Admin only)" concern and
  note boxes, "Taken off by Admin" / "Kept on by Admin" and the exports' "(Admin decision)",
  "Admin is closing this round", "Another Admin page took over closing", Past rounds "which only
  Admin can see", Setup's Passwords card ("Admin, ED and Guest") and Change history ("Admin",
  "Admin (name)").
- **Kept as "leadership"** where it means the department's leaders as people: "Not on the list?
  Ask leadership to add you.", "Check with leadership before changing." (how long closed rounds
  are kept) and the two lines that send a disabled account or a wrong-looking password to
  leadership for the Firebase console (the Admin password gives no console access).
- **Unchanged on purpose:** account emails (`admin@`, voting's `leadership@`), uids, every stored
  value (`by: "leadership"`, `shortlistBy: "leadership"`, a backup's `exportedBy`), role keys in
  code, browser storage keys, addresses and `firestore.rules` (not even its comments, so the file
  still matches the published rules). Old history entries show as "Admin" because the page names
  them; nothing is rewritten.
- `scripts/diagnose-login.mjs` and `scripts/report-data.mjs` print "Admin"; tests and sims that
  read the words follow (`tests/history.test.mjs`, `sim/stages.mjs`, `sim/rounds.mjs`,
  `sim/passwords-moved.mjs`, `sim/emulator.mjs`). Code comments, README, CLAUDE.md, DESIGN.md
  and the sim, tests and scripts READMEs use "Admin" too; older entries here stay as written.
- **Cleanup planned for the release after R9, done here** (Alvin asked to finish all remaining
  work; R11 has nothing left). Each was unused since R9 or kept "one more release" by R8b, so
  the rule "never remove a module in the release that stops using it" is met:
  - deleted `js/passwords.js` (the old page's rules of a change) and `tests/passwords.test.mjs`;
  - removed `store.updatePasswords` (both stores), the Firebase `appFns` the old page's helper
    apps used (`loadFirestore` in `js/app.js`), and the unused `.pw*` and `#pwNote` styles;
  - removed R8b's leftovers for older cached pages: `emailOrder` and `rememberKind` in
    `js/signin.js`, `AUTH.newEmails` and `PARTNERS.voting.newEmails` in `js/config.js`, and the
    `{ emails: { old, new } }` account shape (`signInPinned` takes `{ email, uid }` only; an
    account with no email is refused, `tests/signin.test.mjs`). The page stopped using them
    in R8b (R8 was the last that imported them). An R8 page still open or cached that fetches
    `js/signin.js` afresh now fails to start; a reload fixes it (R8b went live on Oct 18);
  - removed the sim's `playwright-core` dev dependency (used only by the old WebKit check);
  - `scripts/diagnose-login.mjs`: its header now says the ED tools passwords page keeps voting
    on the same values (it said Setup).
  `interviews_meta/passwords` stays in backups and restore, and the Setup card still reads its
  `pending` field. No rules change.
- Version `R10`.

---

## R9: the passwords page moved to the ED dashboard (built Oct 17 2026; ships after R8)

Phase B of the passwords design (section B.7.1). The Leadership, ED and Guest passwords are now
seen and changed on the ED tools passwords page in the dashboard repo,
`https://michaelgarronhospital-ed.github.io/passwords.html` (the gear on the ED tools front page),
which keeps them encrypted in the separate Firebase project `mgh-ed-admin`. Nothing in this tool
changes a password any more.

- **Contains R8b** (`main` merged in, Oct 18, after R8 and R8b went live): new emails only.
  Nothing R9 adds uses `emailOrder`, `rememberKind` or `newEmails`; R8b kept them for older
  pages, and they stay here too (a cached older passwords page may still load them) until R10.
- **`passwords.html` is a plain redirect** to that page: a meta refresh, a tiny plain script
  (`js/pwmoved.js`, loaded last so the message shows while the new page loads; no module, no
  inline script) and a visible "The passwords page has moved. Open it." with a 44 px button, in
  the ED look (light and dark). Old links and bookmarks keep working.
- **`js/pwpage.js` is now a stub**, `location.replace(PASSWORDS_PAGE)`, for older copies of the
  page still in a browser's cache (they load it as a module).
- **`js/config.js`:** `PASSWORDS_PAGE`, the one address; `tests/versions.test.mjs` checks the
  page, the plain script and the stub all use it.
- **Setup, "Passwords for all ED tools":** "The Leadership, ED and Guest passwords are seen and
  changed on the ED tools passwords page (the gear on the ED tools front page)." and a link. If a
  change started on the old page never finished (`interviews_meta/passwords.pending`), the card
  adds "An older password change started here didn't finish. Open the passwords page; it finds
  which tools still have the old password." and its summary says so while closed. The card has
  nothing else: no field, no button.
- **Kept one more release** (never remove a module in the release that stops using it):
  `js/passwords.js`, `store.updatePasswords` and `tests/passwords.test.mjs`, unused from R9 and
  deleted in R10 (with the `.pw*` styles and the sim's `playwright-core`, used only by the old
  page and its WebKit check; R10 also brings the comment in `scripts/diagnose-login.mjs` up to
  date, left alone here because R8b edits that file). `interviews_meta/passwords` stays in backups and restore. No rules
  change.
- **Sims:** `sim/passwords.mjs` and `sim/passwords-webkit.mjs` (the old page against the
  emulators) are replaced by `sim/passwords-moved.mjs`, in `npm test` on LocalStore: the redirect
  with scripts on and off (no module, nothing fetched but the copy and a stand-in for the new
  page), the moved line and button at 390 and 1280 px in light and dark, a cached older page sent
  on by the stub, and the Setup card with no record, a finished change and an unfinished one.
  `make-site.sh --emulator` no longer patches `js/pwpage.js`. `sim/foundations.mjs` checks the
  card's new line and link.
- README (the passwords section points to the new page; the one deliberate exception to "nothing
  derived from a password" is the encrypted copy in `mgh-ed-admin`, outside any repo), CLAUDE.md.
- Version `R9`.

**Before deploying:**
- The dashboard passwords page (PR A, the page; PR B, the gear links to it) is live and checked
  on Alvin's phone, and R8 is live. R9 ships the day after R8 at the earliest.
- On the day, read `interviews_meta/passwords` again (design B.5.7, department login,
  read-only); if it has a pending change, finish it on the old page before merging R9.

**Merging with R8b.** R9 branches from `hiring-r8`; whichever of R8b and R9 lands second merges
`main` first. Expected conflicts:
- The `?v=` pins, `version.json` and `RELEASE`: give the merged result a release name after the
  one that is live (R9 lands second: `R9`; R8b lands second: `R9b`), every pin the same.
- `js/app.js`, the `config.js` import: it must carry `PASSWORDS_PAGE`. Taking R8b's side drops
  it and the Leadership Setup tab throws a ReferenceError (the sims catch it).
- `js/passwords.js` and `js/signin.js`: keep R8b's code and only set the new pin (R8b still
  exports `emailOrder` and `rememberKind`).
- `passwords.html`, `js/pwpage.js` and the two deleted sims: keep R9's.
- `CHANGES.md` itself: keep both sections.

**Rollback.** Before the merge, revert the R9 commit. After the merge, a revert of R9 also needs
its `?v=` pins, `version.json` and `RELEASE` fixed by hand (every pin the same).

Tests: see the release commit message.

---

## R8b: the R7d cleanup, new emails only (ships after the email switch, NOT in its window)

R7d, built on R8 (it was `hiring-r7d` on R7c; that branch is superseded by `hiring-r8b`).
Cleanup only: R7c already signs in through the switch (and through an `--undo`) by trying both
emails of each account; nothing in the window needs this release. If something else is live by
then, rebase this on it.

- `js/config.js`: `AUTH` and `PARTNERS.voting` sign-in emails are the `.invalid` ones only
  (`admin@`, `committee@`, `applicant@mgh-ed-hiring.invalid`; `leadership@`, `ed@mgh-ed-voting.invalid`).
  `newEmails` stays one release, with the same `.invalid` values, for an older page still open or
  cached (it reads it); removed in the release after this.
- `js/signin.js`: one sign-in with the account's one email, accepted only for the pinned uid; the
  "which email worked" note (`ed_iv_emailkind`, `ed_iv_emailkind_voting`) is deleted on load.
  `emailOrder` and `rememberKind` stay exported one more release (review): an older page imports
  them; they now give `["new"]` and do nothing, and `signInPinned` still takes an older page's
  `{ emails: { old, new } }` and uses the new one. The gate, `#apply`, the passwords page and the
  flow's helpers use it; both scripts sign in once with the one email and check the uid. A wrong
  password is three refused sign-ins on the gate again, still ONE try toward the wait.
- Ship it only when the switch is settled: once `--undo` would no longer be wanted (this page
  refuses the right password if the accounts are back on the old emails; pinned by the emulator).
- Version `R8b`.

Tests: NEW `tests/emails.test.mjs` (every sign-in email ends in `.invalid`; no
`@ed-hiring.app` or `@ed-motion-voting.app` address in `js/` or a page); `tests/signin.test.mjs`
(one call with the `.invalid` email, a wrong password one refused call, another uid refused, the
old notes deleted, an older page's imports and call shape reach the new email only);
`tests/passwords.test.mjs` (the helpers sign in once each, `.invalid` only); every rules test signs
in with the new emails and the sims make the accounts with them; `sim/auth.mjs` back to three
refusals per wrong password, one wait per three; emulator `signInWithInvalidEmailsOnly` (each
role, another uid refused, and after an `--undo` this page refuses: why it ships late); the
email-change cases (`emailChangeKeepsSessions`, `sim/auth.mjs`, `sim/passwords.mjs`) change the
email BACK (what `--undo` would do): an old page signed in under the other email still knows the
role. R7c's switch cases (`signInAcrossTheSwitch`, `afterApplyPageAndFlowWork`) are gone with
the fallback.

---

## R8: remove what R7 stopped using (built Oct 16, carries R7c; ships on or after Oct 24 2026)

- **Contains R7c** (`main` merged in, Oct 17): roles by uid, rules v3, and R7c's two-email
  sign-in (`js/signin.js`), unchanged, so R8 works before, during and after the email switch.

- **Deleted `js/data.js`**, the old encrypted copy of the interview questions. Since R7 the page
  reads the questions only from `interviews_meta/questions` and finds the role by signing in, so
  nothing used it; it stayed one release so cached older pages kept working. After this release
  no file in the repo is derived from a password.
- Removed the compatibility leftovers kept for one release: `CANDIDATE_CODE_LOCAL` and `AUTH.mode` (config),
  the inert `maybeMigrateQuestions` and `store.createQuestions` (the R1 to R6 questions copy),
  and the old `IV.clearOverrides` name (now only `IV.resetPanels`). `fromLegacy` stays: it
  defines the legacy question ids and the tests build fixtures with it.
- README "Re-keying" removed. NEW check in `tests/versions.test.mjs`: `js/data.js` does not exist
  and no module, test, sim or script imports it.
- **Before deploying:** R7 live for a week, and Alvin has signed in with each of the three
  passwords and run "Change a password" to the Check step. **Never roll the page back past R7
  after a password has been changed in the app** (pre-R7 pages decide the role by decrypting).
- **Review fixes (deployability pass, small things that were already there):** every screen
  has a landmark (the sign-in box, the name picker and the applicant page are main regions; the
  notice lines are one region), both availability grids are a labelled region you can reach
  with the keyboard and scroll sideways, the Ranking tab's headings go in order, and on a phone
  each committee row is one line (name, what they do) with "Details" for the rest.
- **Final review:** the applicant page has one main region (its own), the empty-state titles are
  level 2 headings so no tab skips a level, and the tab row sits inside a navigation landmark.

Tests: as R7, plus the new versions check. Checked: see the release commit message.

---

## R7c: roles known by uid, ahead of the account emails moving to .invalid (Oct 17 2026)

Phase A of the passwords design. The account emails (`admin@ed-hiring.app` and so on) are on a
domain nobody owns, so a stranger could register it and reset a password; they move to
`@mgh-ed-hiring.invalid` addresses that can never be registered. For that to break nothing, a
role must be known by its account's uid, which never changes, and not by its email.

- **Rules v3** (`firestore.rules`): `isAdmin`, `isCommittee` and `isApplicant` check the account's
  pinned uid and a password sign-in (`signedIn(uid)`), never `token.email`. Everything else is
  unchanged. Header: the accounts by uid and email, "never delete a role account". Published
  separately, before this page (deploy step A3), with a tag `rules-v3-<date>`.
- **Pages by uid** (`js/config.js` `AUTH.uids`, `PARTNERS.voting.uids`): the hiring page's resume
  (`roleOfUser`), the passwords page's resume and sign-in, and the passwords flow's own account
  all compare uids; a sign-in that lands on another uid than the role account's counts as a
  refusal. The flow re-authenticates the page's account with the email it has NOW.
- **Sign-in across the switch (review):** every sign-in (the gate, `#apply`, the passwords page,
  and the passwords flow's helper sign-ins for the hiring AND Motion Voting accounts) tries the
  email kind that last worked on this browser (only "old" or "new" is kept, `ed_iv_emailkind` and
  `ed_iv_emailkind_voting`; never a password), else the old email; on a wrong-password or
  no-such-account answer it tries the other email once; only the pinned uid is accepted
  (`js/signin.js`, `config.js` `newEmails`). So the right password works before `--apply`, after
  it (on this page, an open one or a cached one) and after `--undo`, with no page change in the
  window. A wrong password still counts as ONE try toward the 30-second wait (it costs up to six
  refused sign-ins on the gate: three roles, two emails).
- The signed-out message is now "You were signed out. Please sign in again." (both pages).
- Scripts: `diagnose-login.mjs` and `report-data.mjs` check the returned uid. README (a uid table,
  "never delete", the lost-password steps no longer delete and re-add an account), DESIGN, CLAUDE.
- Version `R7c`.

**Precondition for every later hiring branch:** every hiring branch must contain R7c (merge
`main` into it first). R7d (new emails only, dropping the old emails and the fallback) ships
after the email switch, rebased on whatever is live then. A branch made before R7c (`hiring-r8`
at 689b3f8 was one) signs in with the old emails only and decides roles by email: merged after
the email switch, it would lock everyone out.

Tests: NEW `tests/signin.test.mjs` (before `--apply`, after it, after `--undo`, a wrong password,
another uid behind an email, a network error stops at once); `tests/passwords.test.mjs` (the
flow's helpers fall back for hiring and voting accounts); `sim/auth.mjs` (after `--apply` an R7c
page signs in and the next sign-in needs no refusal; after `--undo` too; three wrong passwords
still mean one wait); emulator `signInAcrossTheSwitch` (each role after `--apply` with an R7c
page, the same browser after `--undo`, a squatter on a freed old email refused);
`sim/passwords.mjs` `afterApplyPageAndFlowWork` (the passwords page and a whole ED change after
`--apply`). NEW `tests/rules-uids.test.mjs` (for each role: right uid with the old email allowed, with
the new `.invalid` email allowed, right email with another uid refused, anonymous and custom-token
sign-ins refused; no role's uid acts as another); NEW `tests/uids.test.mjs` (config uids equal
the rules', no email role check in `js/`); every rules test now uses the pinned uids with a
password sign-in (`tests/helpers/identities.mjs`). Sims: emulator accounts are made with the
pinned uids (`sim/emu.mjs`); NEW emulator case `emailChangeKeepsSessions`: (1) signed in as
each role, the email changed by the admin API, reload: in as the same role or at the sign-in box,
never another role; (2) an old cached page (old emails in its config) with the account signed in
under its new email: reload, still in, same role (a page deciding by email fails this); (3) a
fresh sign-in across the switch is `signInAcrossTheSwitch`. `sim/auth.mjs` (a stub that keeps the
session: signed in, email changed, reload, still in) and `sim/passwords.mjs` (the passwords page,
as (2)).

**Finding for the window:** the Auth emulator, like Firebase, ends sessions on an email change:
an ID token issued a second or more before the change is refused (`TOKEN_EXPIRED`) and the SDK
clears the user on the next load, though the refresh token itself still works. So expect every
signed-in device to be asked for its password once after `migrate-emails.py --apply`, as the
design already plans (A.3 point 4, A.5.1).

---

## R7b: the passwords get their own page (Oct 17 2026)

Alvin's R7 phone check: every sign-in works, but he wants password changing on the ED
dashboard, not inside Physician Hiring, and on his phone tapping Check "doesn't show anything"
(Check wanted the new values too, and its message landed below the fold of a long dialog).

- **NEW `passwords.html`, "ED tools passwords"** (`js/pwpage.js`): Leadership only, nothing
  else on it. Same sign-in rules as Physician Hiring: the Leadership account is found by
  signing in to it, the sign-in lasts this tab only, nothing typed is kept, 3 wrong tries on a
  device mean a 30-second wait, and a sign-in that ends says why. Coming from Physician Hiring
  in the same tab as Leadership needs no new sign-in. Same look (`css/ed-ui.css` unchanged) and
  version pinning. The ED dashboard gets a tile for it; Physician Hiring's Setup card is now one
  line linking to it (the dialog code left `app.js`).
- **The order is now: tick, the CURRENT values and Check, then the new values.** Check needs
  only the three current values (`validateCurrent` in `js/passwords.js`), proves every account
  (and Physician Hiring's account of each unticked password), and lists them; only after it
  passed are the new values asked for, with Change now. Every safety rule stays: all three
  different, including from every value in use now; the unfinished-change record and "Finish the
  change"; nothing over another page's unfinished change; the leave-page warning; the fixed
  order with a fresh sign-in before each change.
- **Messages where they can be seen:** every message sits at the top of its step, right under
  the title (on an iPhone the keyboard covers the bottom half), is scrolled into view and is
  announced (`role=alert`). On a touch screen the field to fix is marked (red outline,
  `aria-invalid`) rather than focused, so the keyboard doesn't open over the message; a desktop
  still focuses it. "Checking..." shows on the button and in the message line at once.
- **Finishing an unfinished change runs Check too** (on the accounts not changed yet, and
  Physician Hiring's account of each unticked password), says "Use the same new password as
  the first time", and if an account that already changed refuses the new value typed, says
  plainly that it differs from the first try and goes back to the new values (no loop of Try
  again). The step with the current passwords says why all three are needed, and a new value
  already in use gives one line instead of two.
- Version `R7b` (a release between R7 and R8): `tests/versions.test.mjs` accepts a trailing
  letter and also checks `passwords.html`.

Tests: `tests/passwords.test.mjs` (`validateCurrent`, the skip list when finishing, a different
value when finishing, one line for a value in use); `sim/passwords.mjs` rewritten for the page
(5 cases, finishing with Check and with a different value); NEW `sim/passwords-webkit.mjs`
(WebKit at iPhone 13 size: the Check message is in the top half of the screen and the field is
marked, not focused; `playwright-core` 1.60.0, sim only); `sim/foundations.mjs` checks
the Setup card's link.

---

## Tests run on GitHub for every push (Oct 17 2026)

- `.github/workflows/tests.yml` runs the rules and unit tests and the full round simulations on
  every push and pull request. No page, rule or test changed.

---

## R7: sign in without data.js, and change the passwords in Setup (Oct 16 2026)

- **The gate finds the role by signing in (design 5.2).** `app.js` no longer imports
  `js/data.js` (the file is unchanged and unused for one release, so a cached older page still
  works for its last minutes; R8 deletes it). The password is tried on the role accounts in
  `roleOrder()`: Guest first on an `#apply` link, else the role that last worked on this browser
  (`ed_iv_lastrole`, not secret), else ED, Guest, Leadership. A refusal moves on; any other error
  stops with its own message; all refused is "Incorrect password." A disabled account is tried
  last so it can't hide the others. The password is never stored: `ed_iv_code` is deleted on load,
  and a reload resumes from Firebase's own tab-only sign-in (`authStateReady`). If the sign-in
  ends while the page is open, the gate comes back with "You were signed out, probably because a
  password changed. Enter the current password." `signInError` lost its "the code decrypted"
  branch (one source of truth now). Local mode uses `LOCAL_CODES` in `config.js` (blank here).
- **Setup, "Passwords for all ED tools" (H3, design 5.4 and 5.5).** NEW `js/passwords.js`. Shows
  when each password last changed (or "Not changed in this app yet"). "Change a password": tick
  Leadership, ED or Guest; type the three current and the new ones (with Show, and the
  warnings); validation (match, 10 characters, no outer spaces, not "password", differs from
  now, the three all different); **Check** signs in to every account with its current value in
  memory-only helper apps (`initializeAuth` + `inMemoryPersistence`; the page's own account by
  `reauthenticateWithCredential`) and changes nothing; **Change now** goes voting `ed@`, voting
  `leadership@`, hiring `committee@`, `applicant@`, `admin@` last, each signed in seconds
  before its own change, retrying once on `requires-recent-login`; then every new value is
  checked, the dates written with one history line ("Changed the ED password"), and "Done" with a
  copy-ready message that has no password in it. Progress is kept in
  `interviews_meta/passwords.pending` (account keys only), so a half-done change says exactly
  which tool has the new value, "Try again" finishes it, and a closed tab's change is finished
  from Setup ("A password change didn't finish (started ...). Open it to finish."). The card
  waits until the questions are in the database. "The tools already have different passwords"
  takes one account's own current value.
- `store.updatePasswords` (both stores; transaction with its history entry). `config.js`:
  `PARTNERS.voting` (Motion Voting's public web config and account emails), `LOCAL_CODES`;
  `CANDIDATE_CODE_LOCAL` stays one release, unused. `loadFirestore` also returns the app
  functions. `maybeMigrateQuestions` is inert (removed in R8).
- `scripts/diagnose-login.mjs` now only tries sign-ins (the three hiring accounts, `--voting` for
  Motion Voting's two), each in a memory-only app; env var `ED_PASSWORD`.
- README "Passwords" rewritten (how to change, half-done changes, honest limit, and the console
  steps for when nobody knows a password), "Re-keying" reduced to a note; CLAUDE.md "A sign-in
  failure is not a wrong code" replaced by "The role is found by signing in, and nothing in any
  repo may be derived from a password".
- **Deploy gate:** the latest JSON backup must contain `interviews_meta/questions` with every
  question, and nobody changes a password in the first 15 minutes after R7 goes live (cached
  older pages still decide the role by decrypting).
- **Not done exactly as written:** the old `"anon"` auth mode is no longer supported (it found the
  role by decrypting `data.js`; the live tool has used `"roles"` since Sept). In local mode the role
  (not the password) is kept for the tab (`ed_iv_localrole`), standing in for Firebase's tab-only
  sign-in. In the emulator the two Motion Voting accounts live in the same Auth emulator project as
  hiring's (the Auth emulator maps every API key to its default project); they are still reached
  through separate memory-only helper apps.

- **Review fixes:**
  - A new password may not be any password in use now (any role's, or a value one tool
    already has): if a change stopped part way, that account would let people in as the wrong
    role. Check also signs in to the Physician Hiring account of each unticked password, so
    "all different" rests on values an account accepted.
  - While a change is unfinished, "Change a password" is gone and every way in finishes it
    (a new change used to overwrite the record of where the old one stopped).
  - A check after the change that couldn't connect, or was paused, is reported as that, not as
    a mismatch, and Try again checks those accounts with the new value first (kept in the
    record too). A switched-off account is named in Check and Change.
  - The browser asks before leaving the page while "Changing" runs; the dialog itself checks
    that the questions are saved and that this is the live site.
  - At the sign-in page, every account refusing is "Incorrect password." (a switched-off
    account is named only when it is Leadership's).
  - `scripts/diagnose-login.mjs` signs in with Firebase's REST call and the live site's
    Referer (the keys refuse anything else); a key that still refuses is "can't test from
    here", never "wrong password".
  - Final review: finishing an unfinished change has no Back to the tick boxes, and starting a
    change refuses (in the same transaction) when another page has an unfinished change of other
    passwords, so its record is never overwritten (`sim/passwords.mjs`).
  - After 3 wrong passwords on a device, the sign-in page waits 30 seconds (a countdown on the
    button) before the next try: each wrong password is refused by three accounts, and Firebase
    pauses devices that keep failing. The Passwords card stays hidden unless Firebase is loaded.
  - With no questions document but notes already filed under question ids, the questions
    editor is not locked (nothing could be added before) and offers "Start from the noted
    questions", which rebuilds the ids the notes use ("0" to "n-1") for the wording to be typed
    again, so the notes stay attached.
  - `AUTH.mode` is no longer read (removed in R8, since cached older pages still read it); the
    sim's anonymous sign-in stub and old comments about it are gone.

Tests: NEW `tests/passwords.test.mjs` (11 with the review fixes: validation table; Check stops at the first refusal and
changes nothing; a 6-minute pause between Check and Change now still changes all five against a
fake auth that enforces the 5-minute rule; fixed order with each account signed in right before
its change; converge from every half state with the in-progress account changed or not; one retry
on `requires-recent-login`; memory-only helpers and re-authentication of the page's own account;
no value reaches the console, storage or what is recorded). `sim/auth.mjs` rewritten (13 checks,
sign-in by order, reload resume, revoked sign-in). NEW `sim/passwords.mjs` (`npm run passwords`,
emulators: change ED at 1280 px, change all three at 390 px with the connection cut after two
accounts and finished from a new browser, drift caught by Check). Emulator cases updated for no
questions copy. Checked: see the release commit message.

---

## R6: close the round, past rounds, keep-until, restore from a file (Oct 16 2026)

- **Close the round (H1c).** `js/rounds.js`. Setup, This round: name the round, "Close this
  round". First half: pause (`roundStatus: "closing"`, a lease claim, `booking: "paused"`), a fresh
  snapshot saved as a new `interviews_archive` attempt in parts of at most 900,000 UTF-8 bytes,
  read back and checksum-checked, then "Now save the backup" (tick "I saved the backup") and the
  typed round name. Second half: `clearing`, then for each of the eight `CLEAR_COLLECTIONS`, a
  fresh read and deletes in chunks of up to 450, each document re-read in the transaction and
  deleted only if identical to its copy; then ONE finish batch (config times, slots, panels, days,
  deadlines emptied; allowed and schedule reset; public times emptied and booking open; the
  attempt `closed` with `closedAt` by the server and `deleteAfter` from the keep setting; a new
  open round; one history entry). Committee, chair, settings, questions and passwords untouched.
- **Ownership.** Every write goes through `closeTx` (state and attempt re-read; this page's id and
  load nonce must hold the lease; the attempt must have the expected status). Heartbeat every 30
  seconds only while the close is alive; idle auto-stop after 30 minutes in the first half only;
  a wake check before any timer acts and on focus; a duplicated tab's older copy stands down
  ("This close is continuing in another copy of this page."); a reloaded page carries on.
- **Other pages.** Leadership pages are read-only while the lease is fresh ("Leadership (another
  page) is closing the round now."); once it hasn't changed for 5 minutes on their own clock they
  offer "Finish closing" and "Stop closing" (or "Stop closing and put everything back"), each a
  takeover the server refuses while the lease is under 5 minutes old. Put-back writes back every
  missing document from the copy (history marked restored), checks, then reopens.
- **Kept items** (changed after the copy) are never deleted, listed in `keptFromClose` (at most
  200; more stops the close with Finish or Stop offered), quarantined from every view, backup and
  the allowed list, and resolved by "Download and delete them" (type the round name) or "Keep
  them in this round". A new close can't start until then.
- **Past rounds (H1c):** download backup or Excel, print, Bring back (replace restore, attempt
  marked `restoredAt`), Delete permanently after `deleteAfter` (typed name; parts, then the
  attempt), "Unfinished copies (safe to delete)". **Keep closed rounds for:** 1, 2, 3, 5, 7 years
  or by hand, with "Also apply to the past rounds already closed?".
- **Restore (H1b):** `planRestore` (pure, always against a fresh read): checks (format, version,
  checksum, ids, 1 MB per document, 10,000 documents), shape pre-checks for what the rules check,
  a preview table, "missing items only" (this round's file only; members referenced but gone
  come back as Left the committee; question ids with notes come back archived; Setup never
  overwritten) and "replace" (empty round only; config merged; state open with a new round id
  and `broughtBackFrom`; booking from the restored stages; history restored with original times).
- **Not done exactly as written:** history entries written after the copy are left in place in
  the new round's history rather than listed as kept (the rules only let history be deleted
  while a round is closing, and they are a log); the test-only timing override and controller
  access exist in the sim and emulator copies only (`make-site.sh` patches them in).

- **Review fixes:**
  - A tab duplicated before a close shares the tab id; it now takes its own id on the first
    state it sees unless that id holds a close, carries a close on only on that first state
    (a real reload), and is otherwise read-only, so it can never take over its twin's close.
    A reloaded page accepts its own claim from before the reload, and a page that stood down
    is reset once no close is running. A close with no holder is offered at once.
  - Every close transaction waits for the one before it (heartbeat and Try again never race).
  - Clearing collects kept items afresh each run, decided inside each transaction, so a retry
    never counts one twice. More than 200 kept items offers only "Stop closing and put
    everything back", with why.
  - Kept items carry the hash of the document as kept, and count as kept only while the
    document is unchanged: availability under the same member or surname in the next round is
    the new round's as soon as it is written. "Download and delete them" deletes only what is
    still exactly the kept document. History written after the copy goes with the closed round
    (on its saved copy, removed from the new round in the finish batch) and is in the kept
    download.
  - Replace and Bring back are refused until Leadership decides about kept items; "missing
    items only" accepts a file from before rounds for a round brought back from such a file.
  - "Try again" deletes the failed copy's parts inside its own transaction (no plain delete).
  - Other pages are made read-only with `inert`, not only greyed out.
  - Final review: history kept from after the copy is limited by size too (400,000 bytes on the
    attempt document, well under Firestore's 1 MiB); more offers only "Stop closing and put
    everything back".

Tests: `tests/close-scope.test.mjs` (with `tests/helpers/memfirestore.mjs`), R6 cases in
`tests/backup.test.mjs`; `sim/rounds.mjs` (6 scenarios); emulator: quiet close then bring back
(ED rating saves at once) and close again, killed mid-parts and finished elsewhere, killed
mid-clear and put back (round and meta exactly as before), frozen chunk refused after takeover,
sleeping laptop (wake check, `closeTx` and the rules each on their own), reload and duplicated
tab, 6-minute clock skew, kept item during clearing, restore missing items. Checked: see the
release commit message.

---

## R5: two rooms, day chairs, my panels, messages, applicants' confirmed times (Oct 16 2026)

- **Two rooms and day chairs (H13).** `panels.js`: `chair` may be `null` or a function of
  (time, room); `opts.rooms` makes a time two seats; both rooms are built together (room 1
  first, then room 2 from the people left, then the other order), never sharing a person; the
  room-2 applicant waits with reason "two-rooms" if neither order works. `shareOut` uses each
  panel's own chair and never seats someone in both rooms. With a string chair and no rooms
  the output is identical to before (pinned against `tests/fixtures/panels-v1.mjs`). Setup:
  "1 room / 2 rooms" per time, "Chair this day" (usual chair, another interviewer, or "No chair
  this day"; hand-made panels that day swap chairs as Change chair does), "Room 2 led by".
  Panels: "Room 2" on the row, the load line names who chaired which days, Needs attention
  says when two balanced panels can't run at once or someone is in both rooms. `slots.js`
  keeps `rooms: 2`.
- **My panels (H9).** The Score tab never pre-selects; once the schedule is locked it lists
  your own interviews ("Show all applicants" / "Show only my interviews"), "You have no
  interviews on the schedule" when empty; the score label names the applicant.
- **Messages and calendar files (H8).** `js/notify.js` (applicant and panel emails, reminders,
  `mailto` with Bcc and a copy fallback past 1,800 characters; never a dash) and `js/ics.js`
  (Toronto time with a VTIMEZONE, 75-octet folding, CRLF). Setup, Interview details. Panels:
  per-row copy and calendar buttons, bulk calendar and emails (with "Lock the schedule first"
  while not locked). Availability: "Email who we're waiting on".
- **Applicants' confirmed time (H11).** Panels, "Send times to applicants" (locked only) writes
  `interviews_applicant/{key}` (no names) for changed applicants and deletes stale ones, with
  `schedule.publishedAt` and a history entry, in one batch. The applicant page reads `booking`
  first ("Booking is paused. Please try again later." with no name step; "Booking is closed..."
  with the name step so a time can still be fetched), re-reads it once after a refusal, then
  fetches its own notice once: "Your interview", "I'll be there" / "I can't come" (confirm
  dialog, Undo), the reply date, and "Need a different time? Reply to our email." Leadership:
  no badge for confirmed, "Withdrew <date>" always, "No reply yet" after the reply date; Needs
  attention lists both. `book.html` forwards with `#apply`.
- **Fixes found on the way.** The allowed-list sync now looks again once its own write settles
  (a change arriving during that write was skipped); the local store also listens for the
  browser's storage event (a cross-tab message could arrive before the change was visible).

- **Review fix:** when an applicant's time pick is refused, the page reads the public booking
  flag once (as the reply buttons already did) and shows "Booking is closed" or "paused" if that
  is why, rather than "We can no longer find your name".
- **Review fixes (deployability pass):** the day-chair and room-2 pickers are 16px on phones (no
  iOS zoom); the Score tab's empty choice reads "Choose an applicant" (the longer text was cut off
  on a phone).
- **Final review:** the email to an applicant who shares first and last name with another
  (Jane B Kim beside Jane Kim) says "For your first name, type exactly: Jane B".

Tests: `tests/panels.rooms.test.mjs` (identity over 400 rounds, two rooms disjoint and legal,
no-chair days, brute-force maximum), `tests/ics.test.mjs`, `tests/notify.test.mjs`;
`sim/notices.mjs` (8 scenarios); `sim/score.mjs` (no pre-selection case) and `score-stress.mjs`
updated; `sim/check.mjs` restates rooms and day chairs and fuzz uses them in every even round;
emulator `applicantNotice`, `bookingPausedNoProbe`. Checked: see the release commit message.

---

## R4: applicants who share a surname; rename, merge and delete in the app (Oct 16 2026)

- **Shared surnames (H14).** `util.js`: `firstKey`, `givenKey`, `typedFirstKeys`, `candKey`
  (`availKey` when set, else `lastKey`), `dupKey`. The applicant page asks for first and last
  name and tries the last name alone first, then last name plus first name (then every given
  name, for two applicants whose first names also match). Adding a second applicant with an
  existing surname gives every active member of the group their own `availKey` and says so;
  two with the same first and last name are refused ("Add a middle initial to one of them").
  A document saved under the plain surname is never guessed: Panels, Needs attention asks
  "Whose are they?" (or "Not sure: ask both again"), and the move copies the whole document
  only if the chosen applicant hasn't answered again. A pair found in live data without keys
  gets "Give them separate answers". The allowed list holds `candKey`s.
- **Write-loop guard checked (review M4, m4).** Normal roster edits always write at once; an
  older tab rewriting the list is capped at 3 writes in 10 minutes with a reload message
  (sim: two tabs with different key rules).
- **Rename, merge, delete permanently (H5).** Screen tab, More. `js/candidates.js` plans
  (`renamePlan`, `mergePlan` ported from `scripts/migrate-candidate.mjs` but copying the whole
  availability document, `deletePlan`), applied by `store.applyPlan` (one batch under 450
  operations, otherwise copies-before-deletes chunks). Merge has a dry-run preview and
  "Download backup and merge"; delete needs the typed surname. History entries hold no names.
  The yellow "saved entries nobody can see" box now has "Move these to ..." and "Delete
  permanently" buttons instead of a terminal command.
- **Scripts.** `allowed-list.mjs` uses `availKey` (same rule as the app, so a script run can't
  fight an open page); `sync-allowed.mjs` and `report-data.mjs --issues` stop flagging pairs
  that have keys; `scripts/README.md` says the app does all three now.

- **Review fixes:** the applicant page tries the most specific first-name key first (all given
  names, then the first one), so "Jane B Kim" is found as herself and never booked under Jane
  Kim (`tests/keys.test.mjs`). The maintenance scripts use the applicant's own key when they
  share a surname (`availKey`), like the app: `report-data`, `purge-candidate` and
  `migrate-candidate` read and move the right document, and `rename-candidate` recomputes
  `availKey` the way the app's Rename does (and refuses, pointing to the app, when a rename
  would create a new shared surname).
  The local (sim) store also listens to the storage event, as from R5 (a channel message can
  arrive before the other tab's write is visible), and the two-tab sim answers from the
  storage event too, with the newer tab in front.
  Final review: when two applicants share both surname and first name (Jane Kim, Jane B Kim),
  Leadership's same-surname note says the second must type "Jane B" exactly (`typeExactly`,
  `tests/keys.test.mjs`); the four-edits sim waits up to 5 seconds for the list.

Tests: `tests/keys.test.mjs`, `tests/candidates.test.mjs` (the remove-and-re-add fixture from
`scripts/seed-migration.mjs`), `applicant-availability` two-Kims case; `sim/applicants.mjs`
(7 scenarios); emulator `sameSurnameBooking`. Checked: see the release commit message.

---

## R3: stages, deadlines, the schedule lock, leadership decides the list (Oct 16 2026)

- **Round stages (H4).** `js/stages.js`; Setup, Round stages: Close screening, availability,
  scoring (confirms as in the design), "closed Oct 3" with Reopen. Each close is one
  transaction on `interviews_meta/state` with its history entry; closing availability also
  writes `interviews_public/slots.booking = "closed"` in the same commit (reopen: "open");
  closing screening freezes every applicant without a leadership decision as on or off
  (`shortlistBy: "auto"`), reopening clears only those. ED pages: one grey line ("Screening is
  closed. Your answers are saved.") and every input `disabled` + `aria-disabled`; a save the
  rules refuse because a stage closed says so instead of "check your connection".
- **Deadlines (H4).** Setup, Deadlines (screening, availability, applicants confirm by). The
  countdown banner reads Setup first, `SCREENING_DEADLINE` in `config.js` only as a fallback,
  and stops once screening is closed.
- **Lock the schedule (H4).** Panels: "Lock the schedule" saves every panel to
  `interviews_meta/schedule`; while locked panels come from there (re-validated), nothing is
  computed, Edit edits the locked panel, and Needs attention names anyone no longer free then
  or no longer on the committee. Unlock goes back to following availability; hand-made panels
  from before the lock are kept.
- **Ranking reveal** offers "Reveal and close scoring" (one transaction) or "Reveal only".
- **Leadership decides the list (H7).** Reviewers: "Concern" (counts) and "Note" (never counts,
  "I know this applicant personally", at most 2,000 characters). Collation: "N concerns",
  notes under "Notes (don't count)" with a "knows them" tag, "Make this a note" on each concern
  (one checked write; undoable), and "Interview list: Auto / On / Off" with pills only when
  not the expected state (undoable). Setup, Screening rule: the threshold (0 = never
  automatically). Shortlist CSV and the Excel screening sheet gain notes and "knows them".
- `store`: `updateState`, `updateSchedule`, `setCandidates`, `txDoc` (a checked one-document
  change, used by undo), `now()`, `DEL`.
- `sim/check.mjs` restates the new list rule (leadership decision, then the Setup threshold).

- **Review fix:** the applicant page reads `booking` from the public times document (it was
  only read from R5 on), so once availability is closed an applicant sees "Booking is closed.
  If you need to change your times, reply to our email." instead of every name being "not
  found". Checked in the emulator (`bookingFlag`).
- **Review fixes (deployability pass):** the applicant's name form is redrawn only when
  booking changes, so a name being typed or filled in by the browser is never wiped by an
  unrelated update (`sim/stages.mjs`). The screening-rule number box is 16px on phones (no
  iOS zoom).

Tests: `tests/stages.test.mjs` (the `isOnList` truth table, freeze and reopen plans);
`sim/stages.mjs` (7 scenarios); emulator `stageRefusals` (a note pending when scoring closes
is refused with the right message and nothing is written; an older page's screening write is
refused) and `bookingFlag`. Checked: see the release commit message.

---

## R2: committee editor and questions editor (Oct 16 2026)

- **Setup, Committee and screeners (H6)** replaces the textarea: one row per person (name,
  Interviews and screens or Screens only, F or M for interviewers, Active or Left the
  committee, optional work email). Saving merges by id onto the latest saved list in a
  transaction (someone added from another device meanwhile is kept) and writes a
  `committee.save` history line with counts only. A row can be removed outright only when the
  person saved nothing. Warnings: two active people with the same name, an interviewer without
  F or M; refused: the chair leaving or becoming screens-only ("Pick another chair first.").
  "Add people": "Name, F" or "Name, M" adds an interviewer with a new opaque id, a bare name a
  screener.
- **Left the committee**: input stays and counts (shown "(left)"), off the name list, panels,
  the availability grid and waiting-on lines. **Screens only**: the Screen tab alone. The name
  list says "Not on the list? Ask leadership to add you."
- **Setup, Interview questions (H2)**: rows with Move up, Move down, Remove, "Add a question",
  the rating scale and guidance, one "Save questions" transaction with a history line. Locked
  once scoring starts: only the wording can change, with a confirm. Archived questions (from a
  restore) are kept on save.
- Drafts live in `ui.commDraft` / `ui.qDraft`, so a live re-render never wipes typing, and the
  self-reload waits while either is open.

- **Review fix:** an open Score tab redraws when the question wording, the scale or the
  guidance changes (they are part of its signature now), flushing anything still pausing
  first, instead of keeping the old text up (`sim/editors.mjs` checks it from a second tab).

Tests: `sim/editors.mjs` (5 scenarios, in `npm test`): rename keeps input, a left member's
concern still counts, screens-only never on a panel, chair and duplicate checks, questions
edit, reorder and lock. Checked: see the release commit message.

---

## R1: foundations (members by id, questions in the database, history, backup file) (Oct 16 2026)

Needs rules v2 (R0) published first: every leadership save now writes a history entry,
which the v1 rules refuse.

- **Members keyed by id (H6, data layer).** `js/members.js`. Every key that names a person is
  a member id; legacy members' id is their name, which is exactly what every saved document
  already uses, so nothing moved. The name list, panels, grids, ranking and exports draw names
  from ids. Saving the committee textarea keeps each person's id. Nothing looks different yet.
- **Interview questions in Firestore (H2, data layer).** `js/questions.js`,
  `interviews_meta/questions`. The first Leadership sign-in copies them out of the encrypted
  `js/data.js` (ids `"0"`..`"n-1"`, the keys every note already has) in a create-only
  transaction with a history entry. The Score tab reads the document and keys notes by
  question id; `data.js` stays the fallback (and the role check) until R7.
- **Change history (H12).** `js/history.js`; every leadership change in the app writes its
  entry in the same batch or transaction (roster, committee, chair, times, panels, offers,
  ranking reveal, settings, the question copy). No applicant name is stored. Setup, Change
  history shows them 50 at a time (one-shot reads). "Undo my edits" on Panels is now "Reset
  hand-made panels": it names the panels it removes and can be undone from a 10-second
  toast or from Change history (refused if the panel changed since).
- **Backup file (H1a).** Ranking and Setup: "Download backup file (for restoring)", one JSON
  file built from a fresh one-shot read of every round collection (`store.snapshotRaw`),
  never page state; format in `js/backup.js` (timestamps as `{ __ts }`, SHA-256 checksum of
  canonical JSON, a closing state is never exported). The Excel workbook is now built from
  the same fresh read and gains a Questions sheet, score columns headed by question text, and
  rows for people who left or were taken off the list.
- **Log out (H12)** saves anything pausing, waits up to 5 seconds for unconfirmed saves (asks
  before discarding), then clears this browser's copies of scores, screening and picks.
- **Deploy safety (section 2.3).** Every import carries `?v=R1` (same as `version.json` and
  `RELEASE`); the page checks `version.json` every 10 minutes and shows "This page was
  updated..." (Leadership pages reload themselves only when nothing could be lost, once per
  version). The allowed-list sync stops after 3 "fights" with another tab in 10 minutes and
  says to reload the other tab; writes caused by this tab's own roster edits are never held.
- **util.js:** `toast` takes an action button, `flowDialog` (multi-step dialog), `copyText`.
- **Not done as written:** the design's "module split of app.js" was taken as "new logic goes
  in new modules"; existing render code stayed in `app.js` (smaller change, same behaviour).

- **Review fixes:** the allowed-surname sync counts a "fight" only when the saved list changed
  since this tab last looked (to something it did not write) while its own roster stayed the
  same; ordinary snapshots and the retry timer never count, so a tab held back writes again
  (it used to stop for good). Calls are gathered for 250 ms, and the page looks again once a
  write settles, so a roster edit made during a write is not missed (`tests/allowed-sync.test.mjs`).
  README lists the known gaps while a page from before Oct 2026 is still open.
  A page from before R1 still open with these modules (a mixed cache) gets the SDK functions it
  does not pass from the SDK it already loaded, so Leadership saves don't fail. Both stylesheets
  carry `?v=` like the scripts (`tests/versions.test.mjs`). After Log out, the sign-in page says
  once that scores are saved but this device won't show them again.
  Final review: the allowed-list write is never put off more than 2 seconds by a stream of
  snapshots, and an edit to this tab's own roster is written even while it is held back after a
  fight. The applicant's name form is never redrawn under them (it wiped typed or filled-in
  names).

Tests: node `members`, `questions`, `history`, `backup`, `store.snapshot`, `store.questions`,
`versions` (39). Sim: `sim/foundations.mjs` (7 scenarios, in `npm test`). New emulator
harness: `sim/emulator.mjs`, `sim/emu.mjs`, `sim/firebase.json`, `make-site.sh --emulator`
(3 cases: the question copy and roster add under the real rules, an ED rating and score note,
the backup as a fresh read). Checked: rules and node 229/229; sim 15/15 scenarios, 7/7
foundations, e2e, score, auth, fuzz 40; stress (plain, latency, flaky); emulator 3/3.

Undo: revert the merge. The questions document, history entries and `addedAt` stay; older
pages ignore them.

---

## R0: rules v2, server side for the Oct 2026 hiring items (Oct 16 2026)

One rules release ahead of every page change, fully backward compatible: nothing in it
does anything until a later page sets a stage, starts a close or writes a new document.

- **Stage gates (H4).** `interviews_meta/state.stages.<screening|availability|scoring>.closed`
  stops the ED password writing that stage (screening, scores, interviewer and applicant
  times). Leadership still can. Missing state, or the old `{ interviewsComplete }` shape,
  means open.
- **Round gate (H1).** While `state.roundStatus` is `"closing"`, every ED and Guest write
  is refused (even the name probe).
- **Applicant reply (H11).** Availability documents may also hold `reply` ("", confirmed,
  withdrawn) and `replyAt` (a timestamp). After availability closes an applicant can
  still confirm or withdraw, and change nothing else. The `{}` name probe still passes.
- **New collections.** `interviews_applicant` (one confirmed time per applicant: Guest
  may fetch one by id, never list), `interviews_history` (leadership only, append-only,
  server-stamped, deletable only while a round is closing), `interviews_archive` (the
  close-round copies: a five-status machine, `saving`, `saved`, `clearing`, `closed`,
  `abandoned`, with server-stamped `closedAt` and a 30-day floor on `deleteAfter`).
- **Close lease.** During a close every write to `state` must carry a fresh
  `lease = { tab, load, at: serverTimestamp() }`; a takeover is refused while the lease is
  under 5 minutes old by the server's clock; starting a close needs a fresh claim; a
  stored claim that is missing, malformed or not a map counts as expired. Every attempt
  write needs a fresh `owner` claim from the page in `closingTab` for the attempt in
  `closingAttemptId`. Outside a close it always passes.
- **Leadership first.** `isAdmin()` comes first in every rule, so the extra `get()` of
  `state` is paid on ED and Guest writes only (one read each).
- **Review fix:** every write to `state` must leave `roundStatus: "closing"` exactly when
  `closingTab` is set (`leaseOk`), so a close can never be left without a holder, or a holder
  without a close; a close found with no holder can be finished or stopped by any page at once.
  The header's set-up steps now name the passwords, not the old codes.
- **Review fix:** the sim's generated site copies are never tracked (`.gitignore` has
  `site-emulator/`; NEW `tests/repo-hygiene.test.mjs` fails if anything generated is tracked).

Tests: `tests/rules-v2.test.mjs` (83 with the review fix, its own project id) covers every probe in the
design, including the review round 4 and 5 ones run before publishing: a close started
without a claim, with a client-time claim, and over an old claim; expired, missing and
malformed stored claims (null, a string, a number, a map without `at`), with and without
a close running; takeover refused at 4 minutes and accepted at 6 by the server clock;
the sleeping-laptop writes (a stale page's renew, stop and attempt status change refused
while another page holds the lease); and a load-bearing copy with `stageOpen()` forced
true. The guards were mutation-checked by hand. Checked: rules 190/190 (the 109 from
before, unchanged); sim 15/15 scenarios, e2e, score, auth, fuzz 40 (no page change).

Deploy: tag `rules-v1-2026-10-16` (done locally on the old main), publish with
`npx firebase-tools deploy --only firestore:rules`, then tag `rules-v2-<date>`.
Undo: `git show rules-v1-2026-10-16:firestore.rules > firestore.rules` and deploy (only
while no R1+ page is live).

---

## Security pass: ED password can't delete, Log out signs out, docs cleaned (Oct 16 2026)

The ED password now goes to every ED physician, not just the 13 on the committee, so
what that account can do was narrowed to what the app actually uses.

- **Rules (`firestore.rules`): the committee account can save but never delete.**
  Screening, scores and both kinds of availability are now create/update for the
  committee and delete for admin only. The roster (`interviews_candidates`) is
  admin-only to write: adding and removing candidates were already leadership-only
  in the app. Every committee write the app makes still works: flag, un-flag,
  reason, rating and clearing a rating (saves 0), score and clearing a score (saves
  0), notes, and ticking or unticking a time (unticking is `deleteField()` under
  merge, an update). Leadership keeps every power it had.
- **Applicant availability has a fixed shape.** Only `slots`, each value in person /
  Zoom / either, at most 200 times. Applies to every writer. The `{}` name-check
  probe still passes. The test that pinned "the modality value is not validated" as
  a known limitation was flipped on purpose.
- **Log out signs out of Firebase.** Both Log out buttons used to clear the tab's
  saved password and reload, leaving the Firebase sign-in stored in the browser.
  They now call `signOut` first (capped at 3s). The sign-in is also kept for this tab
  only (`browserSessionPersistence`, memory only if the browser blocks storage), to
  match the password, which already lived per tab. This also stops a sign-in on a
  second tab switching the first tab's account. A reload in the same tab still signs
  straight back in.
- **Docs.** README no longer describes yearly code rotation or gives example codes
  that hint at the password pattern; the anonymous sign-in steps were replaced with
  the roles model the tool actually runs (README, `js/config.js`). CLAUDE.md now says
  applicants use the Guest password plus their surname, not tokenized links. The sim's
  stand-in guest code is now `guestpw`, like `adminpw` / `staffpw`.

New checks: `sim/auth.mjs` (in `npm test`) drives the gate against a stub Firebase and
fails on the old code. Checked: rules 109/109; sim 15/15 scenarios, e2e, score, auth
7/7, fuzz 40 rounds clean.

**To take effect** the rules must be published (README → "Publishing the rules"). The
live page works with both the old and new rules, so either can go first.

---

## Three shared passwords: ED, Leadership, Guest (Oct 14 2026)

The ED tools now share three passwords (MGH-ED-Tools/README.md). For hiring they replace
the three codes one for one: **ED** = the old staff code (committee), **Leadership** = the
old admin code, **Guest** = the old applicant code. The interview questions were re-locked
under the new ED and Leadership passwords (`js/data.js`, the two `ENC_WRAP_*` values; the
encrypted questions themselves are unchanged), and the three Firebase accounts' passwords
were set to match, by `set-passwords.py` in MGH-ED-Tools, which verified each sign-in.

- The applicant code is no longer written in this public repo: `CANDIDATE_CODE_LOCAL` is
  blank (it only ever mattered in local mode; live, the Guest password is checked by
  Firebase), and a blank value can never match.
- Every screen says "password" and names which one: the gate, the error messages, the
  "three passwords" hint after two failed tries, and the committee/leadership note.

Checked: rules 94/94; sim e2e, score and fuzz pass, scenarios 13/15 (the two known); the
re-lock was proven against this tool's own `decryptContent` on fixture data (new ED and
Leadership unlock, old codes and Guest refused).

---

## Offers on the Ranking tab; one-click backup of the whole cycle (Oct 14 2026)

Both were on the deferred list (DESIGN.md #5 and #6, Oct 7 2026).

### Added: Offers (admin only)

Under the ranking table, one row per candidate in ranking order (then anyone not
yet scored, then anyone with a recorded outcome who has since left the list, so
nothing recorded disappears):

- A segmented status: Not offered / Offered / Accepted / Declined. Choosing one
  stamps today's date (offered, then answered); both dates stay editable.
- A note per candidate (start date, conditions, why someone declined). The Save
  button appears only once something is typed. A live update arriving mid-note
  keeps the draft, the focus and the caret (`keepFocus`, `ui.offerNotes`).
- A summary line: offers made, accepted, declined, awaiting reply.
- Stored in a new collection, `interviews_offers` (one document per candidate),
  readable and writable by the admin account ONLY. Reviewers cannot see who was
  offered or who declined. The rules also check the shape (status is one of the
  four, known fields only, note up to 4,000 characters). 4 new emulator tests.

### Added: Back up this hiring cycle

A card at the bottom of the Ranking tab (also shown before the ranking is
revealed): **Download Excel** writes one workbook with a sheet each for Summary,
Candidates, Screening, Availability (committee and applicants), Panels, Scores
(with per-question notes), Ranking, Offers, Committee and Interview times.
**Print or save as PDF** prints a clean summary (summary, ranking, offers,
candidates, panels); the browser's print dialog saves it as a PDF.

- `js/xlsx.js` writes the .xlsx with no library and no network (the tool still
  loads nothing but Firebase). Checked by opening the files with openpyxl.
- Not exported: the interview questions (encrypted) and committee members'
  gender (used only to balance panels).
- The separate CSVs (shortlist, schedule, scores) are unchanged.

Checked: rules 94/94; sim e2e, score and fuzz (40 rounds) pass, scenarios 13/15
(the two known driver failures); offers and backup driven end to end at 390 and
1280 px, axe-core clean; the "Export scores" link darkened to AA contrast.

---

## Taking out everything that wasn't the work (Sept 26 2026)

"All the pages look so cluttered with different cards and instructions." They
did. Every tab opened with a blue **What to do here** panel of three or four
sentences, then a boxed progress note, then sometimes a third grey box, and only
then the thing you came to do. Seventeen applicants were seventeen bordered
cards. Every panel wore two green ticks confirming nothing was wrong. A deadline
that had passed said so on every screen, every day, for the rest of the round.

Nothing was removed from the tool — the work it does is unchanged, and every
warning that exists because something once went wrong is still there. What went
is the packaging around it.

**One line, not a panel.** The instruction panels are gone; each tab now carries
a single grey sentence under the tab bar ("Flag anyone you feel isn't qualified.
Priority is optional."). The longer explanations moved onto the ⓘ next to the
thing they explain, where they are asked for rather than announced — including
the one that matters most, why scores are write-only and replay from this
browser. The `localStorage` machinery that remembered whether you had collapsed
each panel went with them.

**Lists, not stacks of cards.** The applicant list, the panels and the scoring
questions are each one card ruled between rows. Same information, a fraction of
the borders, and the eye follows a column of names instead of hopping between
boxes.

**Status only when it isn't fine.** Panels show a badge only when something is
actually wrong with them. The collation prints "0 flags · ★ — 0 of 13 rated"
nowhere: a figure appears when there is one. The green "interview" pill on every
row is gone — the pills that remain are "removed" and "excluded · flags", which
are the rows you were looking for. Seventeen red **remove** links are grey until
you reach for one.

**Repeats collapse.** "Needs attention" grouped fourteen copies of the same
sentence into one line with the names in it. The Availability tab lost a whole
section: the dashboard's only content was who hadn't answered, so that is now a
line inside each grid, and the section headers carry the counts ("7 of 16
applicants") so a closed section still answers the question.

**The deadline bar counts down and then stops.** It appears a fortnight out and
goes at the end of the day it names, rather than reporting a passed date
indefinitely. The `past` style stays defined and still pinned by
`tests/css-collisions.test.mjs` — one `if` from returning, and the next person to
want it shouldn't have to rediscover why a banner modifier can't be a utility.

Measured on the same data, full-page height at 1240px: reviewer Screen 2027 →
1475, leadership Screen 2150 → 1593, Availability 2713 → 1686, Panels 1620 →
1114. The applicant's own page — the only one anyone outside the department
sees — is now a title, one sentence and the times.

Two regressions the rendering caught, both invisible in the diff: the scoring
list's sticky picker painted over the first question once it was inside an
`overflow:hidden` card, and on a phone the applicant rows squeezed "Dr
Nandakumar" into two clipped lines behind the rating buttons. Both are fixed;
[`sim/`](sim/) checks every tab at 390px. 14/14 scenarios, the fuzz and 31/31
pure tests all pass unchanged — the scraper needed updating for the new markup,
which is the point of having it.

## The admin could see THAT applicants had answered, not WHAT they answered (Sept 26 2026)

Asked mid-round why 3 of 17 applicants' availability wasn't visible anywhere:
because it wasn't. The tool said "3 of 17 submitted" and listed the other 14 as
chips, and the only way to see which hours somebody had actually offered was to
open the panel editor for that one person and read the Time dropdown. The
question a coordinator actually has — *where should I add an interview time?* —
could not be answered from the screen at all.

`candGrid()` is the applicant half of the availability grid, admin-only, on the
Availability tab under the interviewer one. Rows are times and columns are
applicants, so a row reads as demand for that hour; the letters (P/Z/E) carry
the meaning rather than the colour, as in the other grid.

Three things make it answer the question rather than just show the data:

- **The schedule is drawn on top of it.** The applicant who gets each hour has
  a ringed cell — a shape, not a fifth colour, since the four are already spent
  and a fifth would be unreadable for anyone who can't separate hues. Five
  letters in a row with one ring *is* the reason the other four are under
  "needs attention".
- **Red is reserved for what you can act on.** The Usable column is green when
  applicants want that hour and a panel can run, red when they want it and no
  panel can (the actionable case — that hour needs interviewers), and neutral
  when nobody has asked for it yet. Painting the quiet hours red would have
  made the whole grid cry wolf during collection, which is exactly the phase
  this is for.
- **The shortfall names its cause.** "17 applicants, 10 times" invites the
  wrong fix. The note now splits the people who can't be scheduled the same
  three ways the Panels tab does — hasn't answered / no panel can run at their
  times / their times are taken — and only the third says more interview times
  would help. With 14 of 17 still to answer it reads "chase those first".

A footer row gives each applicant's number of offered times, with a red dash
for nothing at all, which is the column to scan when chasing people. On a phone
the grid scrolls inside its own wrapper like the interviewer one, but the time
labels stay pinned left and the Usable column and the date heading are now
pinned too — with 17 columns the summary you are reading the row *for* was
otherwise several screens away. `sim/scenarios.mjs` checks every cell against
what was actually submitted, that the rings match the schedule, and that none
of it runs off a 390px screen.

## What a simulated round found: right schedule, wrong explanations (Sept 26 2026)

A whole round was played through the real UI, end to end — leadership adds ten
applicants, thirteen interviewers tap their availability, every applicant goes
through the applicant link and picks their times, leadership opens Panels. Then
several hundred randomised rounds on top (committee, times, availability and
flags all random, replayable by seed). The harness is [`sim/`](sim/); it re-states the
panel rules from scratch rather than importing `panels.js`, so the scheduler
cannot mark its own homework.

**The scheduling itself came out clean** — across every round, no panel was ever
missing the chair, unbalanced, the wrong size, or built from people who hadn't
said they were free; no applicant was ever double-booked or scheduled at a time
they hadn't offered; and the number interviewed always matched a separately
written maximum matching (cross-checked by brute force on the small rounds).

What was wrong was everything the tab *said* about the schedule, plus one
interviewer quietly doing nothing.

**Yang was on none of the eight panels, and the tab blamed him for it.** The
seat-sharing hands each free seat to whoever has fewest panels so far — fair at
every step, and it can still finish with somebody on zero. When several people
are tied on nothing the seat goes to the first alphabetically; by the time the
loser comes round again the seats they could have taken belong to people who are
now the only ones who fit. Yang was free for four of the eight interviews and
finished with none, while the Interviewer load section said the cause was
"almost always because they haven't sent their availability" — which he had, days
earlier. A perfect share existed: every man on exactly one panel, every woman on
two.

`shareOut()` in `panels.js` now finishes the job with the standard
augmenting-path move: seat the unused person, hand the seat's occupant another
one, and on down the chain — accepting a chain only if every panel it touches is
still legal (chair present, size unchanged, still balanced, everyone still
available in that modality). Each chain adds exactly one person and takes nobody
off, so it can only improve the share, and it is a no-op when the greedy already
used everyone — which is what the existing fairness tests pin. In the round
above the load went from "one not used, one person on three" to **1–2 each,
nobody idle**. Where somebody is *still* idle it is now arithmetic: the harness
proves it by enumerating every legal membership of the panels that were booked
and taking the best possible arrangement.

**"No available time yields a balanced panel" was told to three different
people.** It is the answer to only one of them:

| What actually happened | What the tab said | What it says now |
|---|---|---|
| The applicant never picked any time | no balanced panel is possible | hasn't picked any interview times yet — chase them |
| Their times can't carry a panel | (correct) | no time they can do yields a balanced panel |
| Their times are already taken | no balanced panel is possible | the only time they can do (Thu 10:00) is already taken by Dr Carter — add another time, or move someone |

Half the random rounds hit one of the two wrong cases. The three need three
different actions — chase the applicant, look at the committee's availability,
add an interview time — and with interviews a week away, sending a coordinator
after the wrong one costs a day. `autoPanels` now returns `why` per unscheduled
candidate (`no-answer` / `no-panel` / `contested`, with the contested times), and
the Panels tab names the applicants holding those times. "Not on any panel" is
split the same way for interviewers.

**Changing the chair could leave a hand-built panel with two people.** The swap
dropped the old chair and added the new one — but if the new chair was *already*
on that panel, the drop was not paid for: a 3-person panel came back as 2, which
is not a panel, and the only sign was a small red "✗ 2 members" badge. The old
chair is still an ordinary committee member, so they now keep the seat.

Nothing else moved: 12 targeted scenarios (returning applicants, unknown and
removed surnames, editing a time people have answered for both ways, manual
panels, double-booking, removals, flag exclusions, the CSV export) all pass, and
the emulator suite is green at **90/90** including the new
[`tests/panels.share.test.mjs`](tests/panels.share.test.mjs).

## The phone bugs: a banner that became a badge, and a gate that blocked itself (Sept 26 2026)

Three reports — "can't log in on my phone but fine on desktop", "check mobile
layout", "the deadline pop-up is off centre" — and the first two turned out to be
the same kind of fault: something that worked everywhere the developer looked.

All of it was found by driving the real page in Chromium at phone widths (the
harness serves `tools/interviews/` with `config.js` and `data.js` swapped for
test doubles, so the gate opens without the real code and nothing touches
Firebase). Reasoning about the CSS had produced the wrong answer twice before
the page was actually rendered.

**The deadline bar collapsed into a badge.** `renderBanner` sets the bar's whole
className, and for a deadline in the past it used `"banner info"`. `.info` is the
16px round "i" badge — `display:inline-flex; width:16px; height:16px;
border-radius:50%`. Nothing overrode it, so the bar became a 26px circle with its
text hanging off the **left edge of the screen**, over the header. Measured:
`.inner` at left −50 on a phone, −44 on desktop.

It needed no code change to appear. The modifier is only added once the deadline
is in the past, so it broke by itself on the morning of Sept 24 — which is why it
looked like a mystery. Exactly the `.tip`/`.tooltip` trap again, and the third
time this family of bug has cost real confusion here.

The modifier is now `past`, and `.banner` pins its own `display`, `width`,
`height` and `border-radius` as a last line of defence, since that rule sits
after every utility. [`tests/css-collisions.test.mjs`](tests/css-collisions.test.mjs)
reads the modifiers straight out of `app.js` and fails if any of them is also a
standalone class in the stylesheet — restoring `" info"` fails it. The bar now
measures 268/268 on desktop and 13/13 on a phone, flush with the header and cards.

**The gate locked out the phone it was typed on.** iOS Safari with Settings →
Safari → **Block All Cookies**, Private Browsing on older iOS, and several
in-app browsers make `localStorage` and `sessionStorage` throw — and not only on
write: the *property getter itself* throws, so `"localStorage" in window` throws
too and feature-detection doesn't help.

Straight after a successful sign-in the gate did an unguarded
`sessionStorage.setItem("ed_iv_code", …)`. On such a phone: the right code, a
real sign-in, then the write throws, the gate never closes, and a toast appears
reading **"The operation is insecure."** Reproduced exactly in the harness — the
correct code, stuck at the gate. That is "works on my desktop, not on my phone".

Every storage access in `app.js` and `store.js` now goes through `ss`/`ls`
helpers in `util.js` that cannot throw; there are no raw calls left. A browser
that blocks storage simply forgets between visits, which the gate now says
plainly, instead of being unable to sign in. All three roles were re-tested under
both shapes of blocking: 6/6 get in, against 1/3 before.

Two more things that made a broken phone indistinguishable from a wrong code:

- `index.html` now carries a small **ES5** watchdog ahead of the module. If
  `app.js` never loads or never parses — a browser too old for its syntax, a
  blocked script, a proxy serving something else — no handler is ever attached,
  so the page looks fine and the Enter button simply does nothing. It now says
  so. Deliberately ES5, because it has to run on the browsers that can't parse
  the app; `app.js` sets `window.__edReady` and the watchdog speaks up at 8s.
- A `pointer: coarse` / `max-width:640px` block lifts text-link buttons from
  19–23px to ~39px and the info badge from 16px to 22px. The negative margins
  cancel the padding exactly, so the layout is pixel-identical. Keyed on pointer
  as well as width because a tablet is a touch device at 768px and was getting
  mouse-sized targets (verified: 40px with touch, unchanged with a mouse).

**iOS zoomed the page whenever anyone typed.** The responsive block sets
`body { font-size:15.5px }` and every control takes `font:inherit`, so all of
them sat under the 16px threshold at which iOS Safari zooms the whole page on
focus — including the access-code box, which shoved the Enter button off-screen
as you typed. A final `@media (max-width:640px)` block lifts controls back to
16px while density stays. It **must remain last** in the stylesheet: the rules it
overrides (`.overlay-box input`, `.tform input`) have identical specificity and
appear later, so order is what decides it. The collision test asserts that too.

After all of it, every width from 320px to 1440px is clean: no horizontal scroll,
no element escaping the viewport, no sub-16px fields, no undersized tap targets,
and header, banner and content share one left edge.

---

## Panels share the work out, and a sign-in failure says what's wrong (Sept 25 2026)

**Fair panels.** `buildPanel` filled seats in roster order. Stable, and maximally
unfair: with a fully available 13-person committee *every* panel came out as
chair + the first woman + the first man on the list, so three people sat all day
and ten never interviewed anyone.

It now takes `{ loads, lastUsed, size }` and prefers fewest-panels-so-far, then
least-recently-used (so equal loads rotate instead of the tie always going to the
same name), then alphabetical — panels are rebuilt on every render, so the result
has to be deterministic or the UI jitters and the exported schedule stops matching
the screen. `autoPanels` builds scarcest-slot-first, so a slot with four people
free picks before the well-staffed slots take the people it needed.

The reason this is safe to do greedily: a panel can form **iff** the eligible
pool holds the chair, at least one person of each gender, and three people. All
three are properties of the pool, not of the order we consider people in — so
ordering cannot turn a feasible panel infeasible, and cannot change which
candidates get scheduled. [`tests/panels.fairness.test.mjs`](tests/panels.fairness.test.mjs)
asserts that rather than trusting it: it keeps a verbatim copy of the old
algorithm and checks feasibility agrees for every (candidate, slot) pair across
400 randomised rosters, plus every panel invariant across another 400.

On the real roster, 10 interviews now use **all 13** members — and the split is
provably optimal, not merely better: 3,3,2,2 for the four women and 2,2,1,1,1,1,1,1
for the eight non-chair men. It cannot be flatter than that, and the reason is
arithmetic rather than a defect: every panel needs at least one woman, so 4 women
carry 10 of the 20 non-chair seats at 2.5 each while 8 men share the other 10 at
1.25. The tests assert balance *within* each group at the arithmetic minimum, so
nobody later "flattens" it by breaking the balance rule.

`fairSize()` handles the other way of leaving people out: 4 interviews × 2
non-chair seats cannot seat 12 people however evenly you share them. Panels grow
past the minimum of 3, up to the permitted 5, only far enough to give everyone one
interview — so a 4-interview round uses panels of 4 and still seats all 13. The
common case stays at 3, the lightest load on everyone. Availability still caps it.

The Panels tab now shows **Interviewer load**, counted from the panels on screen
(auto *and* manual, since a hand edit re-skews the share) and flagging anyone on
no panel at all.

**Sign-in diagnosis.** Kyle couldn't get in as admin and the app could not say
why, because every failure — wrong code, missing Firebase account, wrong account
password, provider disabled, throttled device, blocked CDN — came out as
`"Incorrect code."`

That one message was the bug. A code that **decrypts** is cryptographically proven
to be a genuine staff or admin code, since nothing else unwraps the content key.
So if Firebase then rejects it, the code is right and the *account* is wrong. The
two halves are independent by design and nothing keeps them in step: `data.js`
decides staff-vs-admin, the Firebase console decides whether that string is the
account password. Telling the holder of a correct code to retype it is the one
action that cannot help, and it hides the console from the person who needs it.

Now: `signInError(e, { codeVerified })` names the actual fault and what to do
about it — including `operation-not-allowed` (Email/Password switched off),
`user-disabled`, a tagged `app/sdk-unreachable` for when the Firebase SDK never
loaded (a hospital network or content blocker, which used to read as a bad code),
and `too-many-requests`, where it says **not** to retry, because Firebase
throttles the device and every attempt extends the block. The detail is safe to
print: it only appears after a valid code has decrypted, so the reader already has
access.

Three smaller fixes on the same path:

- A stored code that fails is now **cleared** from `sessionStorage`. It used to be
  replayed on every page load, so a stale code quietly burned the device's
  rate-limit budget and could lock someone out by itself — while looking like the
  code was at fault.
- The member-pick screen now says which access you got: **Leadership** or
  **Committee**, with a line pointing at the separate admin code. The staff code
  signs in perfectly well, just without Panels, Ranking and Setup — someone who
  reaches for the wrong one gets in, finds the leadership view missing, and
  reports "I can't log in as admin". Nothing on screen had told them.
- After two failures the gate explains that three different codes exist.

[`scripts/diagnose-login.mjs`](scripts/diagnose-login.mjs) tests both halves for a
given code and names the fault, so this needs no more guessing:
`ED_IV_CODE='…' node diagnose-login.mjs` (code via env var, so it stays out of
shell history; `--offline` for the decrypt half alone; it never prints the code).
The decrypt path is browser code, so the script lends `js/data.js` a `window`;
Node's WebCrypto was checked to run the full PBKDF2 → HKDF(20192-bit) → XOR
pipeline, so a "does not decrypt" from the tool is a real answer and not a Node
limitation.

---

## The name check was erasing the answers it was meant to protect (Sept 25 2026)

An audit of the applicant pipeline — submit → save → return visit → admin view →
auto-scheduling — found one bug that silently deleted real data, and it was in
the one write nobody thought of as a write.

`store.checkName()` asks the rules "is this surname on the roster?" the only way
an applicant can: by attempting a write and seeing whether it is refused. It sent
`setDoc(ref, { slots: {} }, { merge: true })`, described in its own comment as
"a no-op for a name that IS on the roster".

It is not a no-op. `merge` builds its field mask from the **leaf** paths of the
data, and an empty map has none of its own — so `slots` is itself the leaf, and
the write **replaces the whole map**. Every time the applicant had picked was
deleted.

Three things made it invisible:

- It fires on the way **in**, not on save, so it never looked like a data write.
- The applicant's surname lives in `sessionStorage`, so it re-fired on **every
  visit after the browser tab was closed** — the return visit the page invites
  with "you can come back and update them".
- The applicant's own screen replays from the per-device `localStorage` echo
  (they cannot read their document back — write-without-read). So they still saw
  their times ticked, on a page that had just emptied them on the server, while
  the committee saw them in "waiting on". Indistinguishable from an applicant who
  ignored the email, right up until nobody schedules them.

The probe now sends `{}` — no field paths at all, so the rules still evaluate it
(an unknown surname is still refused, which is the whole point) and an existing
document is left untouched. Pinned by
[`tests/applicant-availability.test.mjs`](tests/applicant-availability.test.mjs),
which drives the **real** `FirestoreStore` against the emulator under the real
rules; reverting the one-line fix fails 2 of its 15 tests.

Every other `merge` write in `js/` and `scripts/` was checked for the same shape.
`setAvail` always writes exactly one key; `rename-candidate.mjs` and
`migrate-candidate.mjs` both guard their availability moves on
`picks(from) > 0`, so neither can send an empty map. This was the only instance.

`report-data.mjs --issues` now flags an availability document that exists but
holds no times. That document is only ever created by the name check, so it means
"they opened the link and nothing is recorded" — which is not the same fact as no
reply, and is the fingerprint this bug left. The stored data cannot say whether
such an applicant picked times and lost them or picked none, so **ask them
directly rather than assuming**.

Two smaller scheduling bugs found in the same pass, both on the manual-override
path (the auto-matcher cannot produce either):

- `validatePanel` warned when a panellist had answered with the **wrong
  modality**, but said nothing when `avail[slot]` was `undefined` — a panellist
  who never said they could make that time at all. The more serious case was the
  silent one. Both now warn.
- Nothing checked whether two applicants were booked into the **same time**.
  `validatePanel` only ever sees one panel, so a manual override could quietly
  double-book an hour. `computePanels` now returns `doubleBooked` and the Panels
  tab lists it under "Needs attention" with a link to edit either side.

---

## A failed write must not look like a saved one (Sept 21 2026)

Chasing the missing rating to its end: it was never stranded and never on the
server. The coordinator dashboard showed the reviewer in "waiting on" — no
screening document from them at all — and the hidden-input check was empty. A
test write then saved and read back correctly, so writes work now.

What made it *look* saved at the time was an asymmetry in the store.
`setAvail` has always rolled back a failed write — its comment says "don't
leave an unsaved pick on screen" — but `setScreening` and `setScore` wrote the
optimistic echo and never undid it. So a refused or dropped write left the
rating on screen **and in localStorage permanently**, while the server had
nothing: a phantom that looks saved on that device and is simply absent from
every other one, and from the collation. Both now roll back to the previous
value (not merely clear) and rethrow, so the caller's "Couldn't save" toast is
the only outcome a reviewer ever sees. It matters more for scores, which are
never read back from the server, so the mirror is the only thing that ever
shows a reviewer their own answer.

Also: a read-back listener refused by the rules is now dropped from the watch
map instead of sitting in it. Firestore tears a listener down on error and
never retries, so a reviewer who had the tab open while the rules were
published stayed stuck on the refused state — and `_syncOwnScreening` skipped
the key as already-watched. It now re-subscribes on the next roster snapshot,
with no reload.

Four tests cover it, confirmed load-bearing: removing the screening rollback
alone fails two of them. Suite is 44/44.

The original rating is most likely explained by `mock.html`, which carried the
real applicant names and saved nothing anywhere. It has since been deleted.

---

## Finding input stranded on a removed applicant (Sept 21 2026)

A reviewer reported a rating they had given that no longer appeared. It was not
the read-back path at all: the applicant had been removed and re-added under a
corrected surname, so the rating sits on the soft-deleted entry. The
orphan check added earlier the same day could not see it — `migrate-candidate.mjs`
says why in its own header: *"the old entry is only soft-deleted
(removed:true), so it isn't even detectable as an orphan."* That is the one
shape this failure has actually taken here, so it is the one the check has to
find.

- **`hiddenInput()` replaces the orphan-only check** and catches both shapes:
  a roster entry that is gone, and one that is only `removed:true`. The
  coordinator dashboard now names the entry, breaks down what is stranded
  (flags / ratings / interview scores), lists the members affected, guesses the
  live entry it belongs to by matching first name or surname key, and prints a
  runnable `migrate-candidate.mjs --from … --to … --apply`. It also says
  plainly that nothing is lost.
- **Ratings are attributed in the collation**, like flags always were, behind a
  tap-to-open "*n* ratings". Without it there was no way to answer a reviewer
  asking "is mine recorded?". A `<details>`, not a tooltip, on purpose: a phone
  has no hover, so anything parked in `title`/`data-tip` is unreachable on the
  device most of this committee uses.
- **A real applicant's name was in the public repo** — the worked example in
  `scripts/` used the actual applicant whose name was mangled, together with
  the story of it. Replaced throughout with an invented one. Note this only
  scrubs the working tree; **git history still contains it**, and removing that
  needs a history rewrite and a force push.

Reviewer isolation was re-checked against the same data: with input stranded on
a removed duplicate and other people's flags and ratings present, an ordinary
reviewer's DOM contains no collation row, no rating chip, no hidden-input row,
no flag reason, and no mention of the removed entry — while the live applicant
stays reviewable. An applicant's isolation is asserted in the rules suite by
both verbs (`get` and `list`) on screening and scores, so the Sept 21 loosening
for reviewers did not reach them; and the guest code was run through
`decryptContent` in a real browser, with near-miss guesses, to confirm it
unwraps no interview questions.

---

## Legible grid, honest averages, readable collation, screening read-back (Sept 21 2026)

Prompted by four questions from Alvin after using the tool: the grid's vertical
names were hard to read, it wasn't clear how averages handle people who didn't
vote, his own ratings looked missing after a re-login, and nobody knew what the
collation card does when several people flag one applicant. Answering them
turned up a shipped CSS bug that had been hiding every instruction in the app.

- **`.tip` collided with `.note.tip` — every "What to do here" box was
  invisible.** The instant-tooltip class added in *Instant info tooltips* (Sept
  18) was called `.tip`, and `.note.tip` — the blue guidance box on every tab —
  had been using that name since the first build. `.note.tip` only overrode
  `background`/`border-color`/`color`, so it inherited `position:absolute`,
  `opacity:0` and `pointer-events:none` from the tooltip and rendered nothing.
  The worst case was the **applicant** view, whose only on-screen explanation of
  in-person/Zoom/either is one of these boxes: applicants have been picking
  times with no instructions at all. The tooltip is now `.tooltip`; don't rename
  it back. Delegated tooltip binding was also widened from `.info` to
  `[data-tip]`, so the availability grid's per-square names work as its legend
  has been promising.
- **Interviewer names in the availability grid are slanted 45°**, not vertical.
  Each label is absolutely positioned and rotated about its bottom-left corner,
  so it starts at its own column and rises to the right; a `pad` spacer column
  keeps the last name from being clipped, since rotated text is out of flow and
  can't widen the table. Grid cells gained `min-width` — without it the table
  shrank to fit a phone and squashed the squares into slivers instead of
  scrolling.
- **The averages now show their denominator, and the ranking corrects for who
  did the scoring.** Nothing was ever normalized: both averages are plain means
  over whoever answered, and a missing answer is (correctly) left out rather
  than imputed — but the figure alone can't distinguish 4.5-from-two from
  4.5-from-twelve. Screening now prints "*n* of 13 rated" next to every average.
  Ranking adds an **Adj** column: each candidate faces a different 3–5 person
  panel, so a plain mean also measures panel generosity. Adj subtracts each
  rater's own offset (their mean minus the overall mean) before averaging;
  raters with a single score have no measurable offset and are left alone, so
  with disjoint panels Adj degrades gracefully to the raw mean. Rows whose rank
  changes under the adjustment say so with a ▲/▼. Both columns are shown
  because the adjustment is a model and the raw mean is the fact.
- **The collation card is a list, not a six-column table.** Several people
  flagging one applicant is the normal case, and `"; "`-joining their sentences
  into one table cell produced an unreadable run-on that also hid who said what.
  Each reason is now its own attributed line (leadership-only, as before), with
  bare flags shown as "flagged without a reason" and sorted last. Applicants
  still in the running sort first. The CSV gained *Flagged by*, *Rated by* and
  *Committee size* columns for the same reason.
- **A reviewer's own screening now follows them to any device.** This was the
  "I rated people, logged out, and my ratings were gone" report, and it had
  three causes, all real: under the roles model a reviewer could write screening
  but not read it back, so the app replayed their answers from a per-device
  localStorage echo — which is not written when you are signed in as *admin*
  (rate as admin, return as a reviewer, blank), was not written at all before
  `AUTH.mode` flipped to `roles` on Sept 18, and never crosses to a second
  device. Plus a remove-and-re-add strands everything on the old `c-<uuid>`.

  **Fix (Alvin's call, Sept 21):** `interviews_screening` now allows `get` to
  the committee and `list` to admin only. The app subscribes to precisely
  `<member>~<candidateId>` for the signed-in member — `store.setMember()` →
  `_syncOwnScreening()`, re-run whenever the roster changes — and never requests
  a colleague's document. The collation still needs `list`, so it stays
  leadership-only.

  **Scores were deliberately NOT loosened.** A reviewer who could `get` a score
  could reconstruct the ranking mid-process, which is the one thing this model
  exists to prevent; the Score tab still replays from the device mirror and now
  says so in as many words. The asymmetry is asserted in the test suite so
  nobody later "tidies" it into symmetry.

  **Honest limit, written down rather than glossed:** all reviewers share one
  Firebase account, so the `get` is not scoped to the person doing it — a
  reviewer at a browser console could fetch a colleague's screening document.
  That is the same trust boundary the *write* side has always had (anyone with
  the staff code can already submit screening as someone else), so it widens an
  existing limit rather than introducing a new kind. Closing it properly means
  per-member accounts; README → "Real access control" spells out the cost. The
  Screen tab's copy changed accordingly, from the promise "nobody else sees your
  flags or ratings" to the true statement that the app never shows one reviewer
  another's.

  Alongside: the coordinator dashboard **counts entries attached to applicants
  no longer on the list** and points at `scripts/migrate-candidate.mjs`; and the
  member picker waits for the saved roster (`store.ready`) instead of letting
  someone commit to a config-default spelling, with a live guard that returns
  them to the picker if the roster stops containing their name mid-session.

  **Ratings are shown in admin view only** — confirmed as an explicit
  requirement after the above landed. The front end may be *able* to fetch; what
  matters is that nothing renders a rating outside admin view. Every path that
  carries someone else's figure (the collation card, both CSV exports, the
  Ranking table) is behind `ui.isAdmin`, and Panels/Ranking aren't in a
  reviewer's tab row. Belt and braces: a committee-scoped store subscribes to no
  collection holding ratings, so a reviewer's state has nothing to leak even if
  a gate were missed. Checked end to end by signing in as an ordinary reviewer
  against seed data where *other* people had flagged, rated and scored, then
  forcing every `<details>` open and scanning the full DOM — not just the
  visible text — for their reasons, ratings, the collation, the exports and the
  Adj column. None present; the reviewer's own controls still work and show
  unset.

  **The local mirror is now written for admins too.** It used to be
  committee-only, so rating something while signed in as *admin* and returning
  with the staff code showed a blank review **on the same machine** — the
  likeliest cause of the original report, and unaffected by any rules change.
  Scores still never come back from the server, so for those this mirror
  remains the only replay a reviewer gets.

  **⚠ Deploy step:** none of the read-back works until the updated
  `firestore.rules` is pasted into **Firebase console → Firestore → Rules →
  Publish**. Until then the app behaves exactly as before — the per-document
  reads are simply denied and logged, and the app **says so rather than
  promising otherwise**: `store.screeningReadBack` starts `null`, flips to
  `true` on the first per-document snapshot and `false` on a refusal, and the
  Screen tab's wording follows it. The front end can ship ahead of the rules
  without telling reviewers something untrue.

- **The collation can be sorted by name, average priority or flags.** Whichever
  is chosen, the still-in / excluded split holds first, so someone already off
  the list never drifts back up into the list you are working. Unrated
  applicants sort **last** under average priority rather than as a low score —
  "nobody rated them" is not "everybody rated them badly", and the two must not
  look alike. The choice is remembered per device (it is a UI preference, not
  data). Checked by driving the real order for each key, including the unrated
  and excluded cases, and across a reload.
- **Declutter.** "What to do here" is now a `<details>` that remembers being
  collapsed across sessions (localStorage, per tab) — full guidance on a first
  visit, one line thereafter. Screening review cards are one row each (name ·
  priority · flag) instead of three, which took ~600px off that page. The Score
  tab gained a sticky candidate picker with ‹ › and a "*n* of *m* scored by you"
  count, ticks beside candidates already scored, and 1-based question numbers
  (they read "Question 0" before; the stored key is still the array index).
  Applicant lists are alphabetical everywhere.

Verified by driving the real app headlessly (Chromium, forced local mode, the
`data.js` content module stubbed, fictitious names only) at 400px and 1000px
across all five tabs plus the applicant view — no console errors. The rules
suite is **44/44** against the emulator, up from 33: the new screening
`get`/`list` split is covered both ways, and `tests/store.own-screening.test.mjs`
drives `FirestoreStore` against a stub Firestore to assert the client only ever
subscribes to the signed-in member's own documents.

---

## Availability grid, applicant surname gate, rename tooling (Sept 21 2026)

Three changes prompted by a real incident: an applicant's name was misspelled,
someone fixed it by removing and re-adding her, and two physicians' screening
ratings silently disappeared from the Screen tab.

- **"Who's available when" grid** on the Availability tab, visible to reviewers
  and admin. One row per interview time, one column per interviewer. Each cell
  carries a letter (`P` in person, `Z` Zoom, `E` either, blank not available) as
  well as a colour, so it reads correctly without colour vision; hover any square
  for the name. The right-hand **Panel** column answers the question the grid
  exists for — whether a balanced panel could actually run at that time — and it
  calls `buildPanel`, the same function the Panels tab uses, so the two can never
  disagree about the rules. A non-viable row says *why* on hover (no chair, too
  few, no mix). Scrolls horizontally inside its own wrapper on a phone with the
  time column pinned; the page itself never overflows.
- **Applicants can no longer submit under a surname that isn't on the roster.**
  This was a silent-loss bug: `interviews_availCand` is keyed by normalized
  surname and applicants have write-without-read, so a typo or a name we hold
  differently saved happily to a document nobody reads. The applicant saw
  "Saved" and would simply never have been scheduled. `firestore.rules` now
  `get()`s `/interviews_meta/allowed` on every applicant write — server-side, so
  the roster stays unreadable to applicants — and the app checks the name at the
  gate and says so plainly instead of accepting it. The list is kept in step with
  the roster by the admin session (`syncAllowedNames`) and by
  `scripts/sync-allowed.mjs`. **Fail-closed: run `sync-allowed.mjs --apply`
  BEFORE publishing the rules**, or applicants are locked out.
- **`scripts/` — maintenance tooling**, chiefly `rename-candidate.mjs`, which
  fixes a name **in place**. The app has no rename, so the obvious move is to
  remove and re-add — which mints a new `c-<uuid>` and strands every rating,
  score and note on the old id, with the old entry still listed as removed. That
  is precisely how the ratings went missing. Renaming keeps the document id, so
  nothing needs migrating. Also `report-data.mjs` (read-only inventory, with an
  `--issues` mode that flags stale entries, duplicate surnames and availability
  matching no candidate), `migrate-candidate.mjs` (clean up after a
  remove-and-re-add) and `purge-candidate.mjs` (hard-delete an entry, refusing
  while anything still references it). Every writing script is dry-run by default.

`lastKey` moved from `app.js` into `util.js`: the rules' allowed list, the store
and the app must agree on exactly one definition of an availability document id,
and there were about to be two.

Rules suite extended to **33 tests, all passing**, including the refusal of an
unrostered surname and the fail-closed behaviour when the list is missing. The
"one applicant can overwrite another's availability" limitation test was updated
rather than deleted — it is narrowed (the target must now be a real applicant),
not closed. App changes verified headlessly in Chromium at 1100px and 390px in
local mode with fictitious data: grid geometry, the viability column against
four hand-built scenarios, the applicant gate accepting and refusing, and no
console errors in any role.

One bug caught during that verification worth recording: the grid's column
headers used `class="who"`, colliding with the existing global `.who`
(`display:flex`), which stopped the `<th>` laying out as table cells — the
columns stacked into a single unreadable strip. Every element-counting assertion
still passed. The suite now asserts the headers' **geometry**, not just that they
exist.

---

## Screen tab: alphabetical names, one applications link (Sept 21 2026)
- **"Who are you?" is now alphabetical.** It followed the roster's stored order,
  which puts the chair first — fine for panel building, useless for finding
  yourself in a list of 13. Sorted on a *copy*: `EFF().committee` is the live
  settings array (or the `COMMITTEE` constant), and panel building reads that
  order, so sorting in place would have quietly reordered the roster everywhere.
  The `— Select your name —` placeholder still comes first, so the existing
  safeguard against clicking straight through onto someone else's name holds.
- **The CV & cover-letter link appears once, above the first candidate.** Every
  applicant's files live in the same OneDrive folder, so the identical link was
  repeating on all ~20 candidate cards. Now a single bar above the list.
- If **no** folder has been saved, the bar now says so instead of showing the
  old per-card dead link that looked clickable and explained nothing. Note the
  precedence: `EFF()` is `s.oneDrive || ONEDRIVE`, so the link saved in
  Setup → Applications folder wins and `ONEDRIVE = "#"` in `js/config.js` is only
  the fallback for a fresh deployment. A configured tool is unaffected — the
  consolidated link uses the saved folder exactly as the per-card links did.
- Verified headlessly (Chromium, local mode, fictitious candidates) as both
  reviewer and admin, at 1000px and 400px: list sorted, exactly one link, zero
  per-card links, link sits above the first card, candidate names unaffected,
  no console errors, no horizontal overflow.

---

## Firestore rules actually verified (Sept 21 2026)
- **Why:** the rules suite was written on Sept 18 but had never been *run* — this
  environment had neither Node nor Java, so every claim about the rules rested on
  reading them. Two days out from the screening cut, that was the biggest
  unverified thing in the tool.
- Installed the toolchain (`nodejs npm default-jre-headless`) and ran it:
  **30 tests, 30 pass**, emulator and all. The guarantees in
  [`tests/README.md`](tests/README.md) now hold as tested facts: the ranking and
  screening stay admin-only, an applicant reaches no committee data, an applicant
  can write availability but not read it back, only the admin can change setup,
  reviewers can still do their job, and unknown/anonymous accounts get nothing.
- Confirmed the suite is load-bearing, not vacuously green: replacing
  `isAdmin()` with `return true` fails **16 of the 30** — including every
  anti-bias guarantee. Rules file restored byte-for-byte afterwards.
- **Still needs the operator:** the three Auth accounts + `AUTH.mode` flip
  against the live project. The rules they will run under are now tested; the
  accounts themselves cannot be exercised without Firebase.

---

## Interview-times editor + stable time ids (Sept 18 2026)
- **Why:** availability and manual panels were keyed by a time's *position* in the
  list, so removing or inserting a time silently moved people's answers onto a
  different time. Times now have permanent ids (`js/slots.js`); legacy lists and the
  config defaults keep their index as id, so nothing already saved moves.
- **Setup → Interview times:** grouped by day, per-time answer counts and "panel
  booked" markers; add a single time or a split block (preview before adding); edit
  (with **Keep answers** / **Ask again** when people have answered) and remove a
  time or a whole day (confirmation lists answers and panels affected).
- **Edge cases:** duplicates blocked; overlap and past-date warnings; end-before-start
  and too-short ranges caught in the preview; removing the last time now really
  leaves none (it used to snap back to the config defaults); stale answers for
  removed times don't count as "submitted"; manual panels at a removed time are
  dropped and flagged; an admin editing a time that someone else removes is told so.
- **Concurrency:** writes go through `store.updateTimes`, a Firestore transaction
  that re-reads the latest list (and writes the applicant mirror in the same commit).
- **Bug fix:** settings writes used `setDoc(…, {merge:true})`, which deep-merges maps,
  so deleting a manual panel ("Reset to auto") never removed it in Firestore. Now
  `mergeFields`, which replaces each written field.
- **Bug fix (applicants):** saving availability rewrote the whole record from what
  the page knew. Applicants can't read their saved record (write-only), so tapping one
  time on a return visit erased everything they had picked before. Now each tap
  changes only that time, and the applicant's own picks are remembered on their device
  so they can see them when they come back.
- Setup no longer loses what you're typing when someone else saves in the meantime.
  Other people's live changes are held while you're typing and applied when you leave the field.
- Manual panel saves, chair and committee changes also read the latest saved copy
  first, so an admin working from an out-of-date screen can't bring back a deleted panel.
- Verified headlessly (local mode, fictitious data) in Chromium, Firefox and WebKit at
  1000px and 400px. The Firestore transaction path needs a live check by the operator.

---

## Unified 3-code login (admin / physicians / guest)
Replaced the single committee code + "!" convention with **three independent codes**
shared across the ED tools:
- **Admin** (leadership), **ED physicians** (staff/committee/voters), **guest**
  (applicants) — chosen by the user; kept out of the repo (only the low-value guest
  local-fallback appears, in `config.js`).
- **Crypto:** the questions are now encrypted with a random content key `K` that is
  wrapped separately under the staff and admin codes (`data.js`/`mock.html`), so the
  two codes are **fully independent** yet both decrypt — which also **closes the
  self-elevation gap** the audit flagged (a reviewer can no longer become admin).
  `decryptContent` returns `{q,s,g,isAdmin}`; `unlock` no longer strips a trailing "!".
- **Motion Voting:** `ADMIN_PASSCODE` updated to the shared admin code (if the locked
  Firebase backend is used, update the `LEADER_EMAIL` Auth user's password to match).
- Updated README (three-code scheme + re-keying recipe), `firestore.rules` header,
  and the roles table. Verified in Chromium/Firefox/WebKit: staff→committee,
  admin→admin (+admin tabs), guest→applicant, wrong/old codes rejected.

## Audit round 1 — fixes from a 6-dimension adversarial review
Ran a multi-agent audit (security, persistence, logic, edge cases, paneling,
a11y/CSS) with per-finding verification. Fixes applied, worst first:

- **CRITICAL (functional):** candidate availability was *read* by display name but
  *written* by normalized last-name key, so tapped times never highlighted and a
  second tap silently cleared them. Now reads by the same `ui.candLast` key. Verified.
- **CRITICAL (cross-browser):** Firefox rejects large PBKDF2 `deriveBits`, so the
  questions wouldn't decrypt in Firefox → switched to PBKDF2→HKDF keystream
  (previous commit). Verified in Chromium/Firefox/WebKit.
- **Panel overrides no longer trusted blindly:** `computePanels` re-validates every
  override (force chair, drop members no longer on the committee, check size +
  balance + per-slot modality availability); the editor now has an explicit
  modality control; unbalanced saves ask for confirmation; the "balanced panel"
  badge is now conditional (✓/✗) with warnings; and changing the chair/committee
  migrates or prunes saved overrides.
- **Paneling:** replaced the greedy most-constrained-first assignment with maximum
  bipartite matching (Kuhn's) — never falsely marks a candidate unschedulable when
  a full assignment exists. Re-validated in Python (300 random trials optimal).
- **A11y:** tabs now have `aria-controls`/`aria-labelledby`, roving tabindex, and
  arrow/Home/End keyboard nav; confirm/gate dialogs are `role="dialog"` with focus
  restore + Tab trap; decorative emoji wrapped in `aria-hidden`; WCAG-AA contrast
  fixes (faint text, amber, tinted-button label); backdrop-filter opaque fallback.
- **Robustness:** anon sign-in errors now surface at the gate (no silent blank app)
  + a console warning when running `anon` with a real project; Score "Guidance"
  section keeps its open/closed state; Screen status pill distinguishes
  "removed" (admin) from "excluded · flags"; panel-editor member handler passes a
  committee index so names with apostrophes can't break it; dropped a dead
  settings-mirror guard. Documented the admin-vs-reviewer shared-code limit honestly.

## v2 — Apple redesign, unified candidate login, real security model
Large cohesive pass. Everything verified headlessly in local mode (committee,
admin, applicant flows; mobile + desktop; no console errors).

**DESIGN** — rewrote [`css/styles.css`](css/styles.css) as one Apple-style sheet:
hairline cards with soft depth, SF-style type + spacing, iOS segmented controls &
toggles, translucent sticky segmented tabs, spinner, refined toast, deadline
banner, empty states, smooth transitions, `prefers-reduced-motion` + `@media print`
support, and a proper mobile layout (larger touch targets, single-column slots).

**UX** — [`js/app.js`](js/app.js) rewrite:
- Collapsible `<details>` sections (remember open/closed) for the dense admin
  areas (Screen collation/dashboard/add, Setup, guidance) to cut overwhelm.
- Short plain-English "What to do here" instructions on **every** section.
- Real empty states everywhere (no candidates, no slots, no scores, nothing to score).

**QOL** — loading spinner + disabled state on the gate and on every awaited action
(login, save, add, exports, reveal); optimistic UI (writes reflect immediately);
`saving → saved` toasts and error toasts; styled confirm dialog.

**FEAT**
- CSV exports: shortlist, schedule, scores.
- Coordinator dashboards: who has/hasn't submitted screening & availability.
- **Manual panel override**: inline editor per panel (change slot, add/remove
  members with the chair locked in, 3–5 validation) + "schedule manually" for
  unschedulable candidates + "reset to auto"/"reset all".
- Deadline banner (screening due Sept 23, turns urgent ≤3 days).
- Confirmation dialogs for destructive actions (remove candidate/time, reveal ranking).
- Print-friendly schedule (`window.print()` + print stylesheet).
- Accessibility: ARIA roles/labels, `aria-pressed`/`aria-selected`, focus-visible
  rings, keyboard-submit forms, contrast.

**C1 — unified applicant login (same link).** The gate now accepts either the
committee code (→ committee/admin) or a **different applicant code** (→ candidate
view: enter last name → pick your own times only; never sees roster/questions/
scores). `book.html` forwards to `index.html`; `js/book.js` removed. Applicants
submit availability keyed by their typed **last name** (so they never read the roster).

**SEC — real access control.** Added a role-based auth model:
- [`firestore.rules`](firestore.rules) rewritten to branch on
  `request.auth.token.email` for three role accounts (admin / committee /
  applicant). Applicants can read only public slots + write their own availability;
  reviewers cannot read scores/screening (ranking is admin-only *for real*).
- [`js/config.js`](js/config.js) `AUTH` block (mode + role emails). Default
  `mode:"anon"` so the **live app keeps working unchanged** until you activate
  roles — exact console steps in README → "Real access control".
- [`js/store.js`](js/store.js) is now role-aware: subscribes only to collections a
  role may read, and keeps a per-device "echo" of a reviewer's own screening/scores
  so they still see their own input without a server read. Slots are mirrored to a
  PII-free `interviews_public/slots` doc for applicants.
- **Not runtime-tested** here (no live Firebase in this env): the roles path,
  rules, and the account setup need you to apply the console steps + flip
  `AUTH.mode`. Called out honestly in README and the rules header.

Schema: additive only (`settings.panelOverrides`, `interviews_public/slots`);
existing collections/keys unchanged. `availCand` now read by candidate-id (legacy)
**or** last-name key, so existing data keeps working.

## S1 — Committee code rotated + questions re-encrypted
- The old code `edleadership` (public — it is also Motion Voting's passcode) no
  longer decrypts the interview questions. Re-encrypted `{q,s,g}` under a new
  strong private code (same PBKDF2-SHA256 keystream + XOR scheme, same salt/iters).
- Updated `ENC_CIPHER` in [`js/data.js`](js/data.js) and `mock.html` (since deleted).
- The new code appears **nowhere** in the repo. It is delivered in the morning
  summary (chat only).
- Verified end-to-end in a headless browser: old code → "Incorrect code"; new
  code → accepted; new code + `!` → admin accepted.
