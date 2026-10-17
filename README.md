# ED Physician Hiring — Interviews Tool

A five-stage hiring tool: **Screen → Availability → Panels → Score → Ranking**.
Static frontend (no build step). Runs in **local mode** out of the box; add a
Firebase project to go multi-device and real-time.

- **Committee:** [`index.html`](index.html) — enter the committee code, pick your name.
- **Applicants:** [`book.html`](book.html) — one link, type your name, pick your times.

The clickable prototype Kyle reviewed (`mock.html`) was **deleted on Sept 21 2026**,
once the real tool had superseded it. It was still being served publicly, it looked
enough like the real thing to confuse anyone handed the wrong link, and it carried a
second copy of the encrypted questions — so re-keying had to be done in two places or
the stale copy would still open under the old code.

Design + decisions live in [`DESIGN.md`](DESIGN.md); the paneling algorithm is in
[`js/panels.js`](js/panels.js) (validated in a Python prototype before porting).

## Where it lives

| | |
|---|---|
| Committee | https://michaelgarronhospital-ed.github.io/mgh-ed-hiring/ |
| Applicants | https://michaelgarronhospital-ed.github.io/mgh-ed-hiring/book.html |
| Repo | https://github.com/MichaelGarronHospital-ED/mgh-ed-hiring |
| Owner | Alvin Yang |
| Firebase project | `mgh-ed-hiring` (config in [`js/config.js`](js/config.js), public by design) |

- **Deploys:** GitHub Pages, from `main`, root folder, no build step. A push to
  `main` is live about a minute later.
- **Secrets:** none in the repo and none in GitHub Actions. The staff, admin and
  guest codes are shared by word of mouth; the role-account passwords live only
  in the Firebase console (see "Real access control" below).
- **Old address:** this tool used to live at
  `https://dralvinyang.github.io/ED-motion-voting/tools/interviews/`. That old
  repo now only redirects here, keeping the path, query string and #hash, so
  links already sent to applicants and the committee still work. The voting tool
  that shared that repo is now `mgh-ed-motion-voting`.

## Passwords: the ED tools' three shared passwords

Since Oct 14 2026 every ED tool uses the same three passwords (shared out of band,
never written in this repo):

- **ED password** (ED physicians / the committee): unlocks the interview questions and
  opens Screen · Availability · Score.
- **Leadership password**: also unlocks the questions, and adds Panels · Ranking ·
  Offers · Setup. It is independent of the ED password, so knowing the ED password
  does not make anyone leadership.
- **Guest password** (applicants): goes straight to the applicant's own scheduling; it
  unlocks nothing and sees no committee data.

The ED and Leadership passwords each independently "unwrap" the question key (a random
content key wrapped under each; see "Re-keying" below), so both unlock the questions
without either revealing the other. In the live (roles) model each password is also the
password of one Firebase account: `committee@` (ED), `admin@` (Leadership), `applicant@`
(Guest).

**To change them:** edit `~/mgh-ed-passwords.txt` and run `python3 set-passwords.py --apply`
from the `MGH-ED-Tools` folder (see the README there). It re-locks the questions, sets all
the Firebase account passwords for hiring and voting, and verifies each one; then commit
and push `js/data.js`.

## Run it now (local mode)
Open `index.html` over **https** (or `http://localhost`, not a `file://` path — the
question decryption needs a secure context). With `firebaseConfig` left empty in
[`js/config.js`](js/config.js), it uses `localStorage` + `BroadcastChannel`: fully
working on **one machine / browser** (great for demo and click-through), seeded with
sample candidates. Data does **not** sync across devices in this mode.

## Go live (multi-device, real-time)
1. **Create a Firebase project** — a *separate* one from Motion Voting (this holds
   applicant data). Build → Firestore Database → Create (production mode).
2. Authentication → **Get started** → enable **Email/Password** and add the three role
   accounts (see "Real access control" below). The app signs in with the password the
   person types; there is no anonymous sign-in.
3. Firestore → **Rules** → paste [`firestore.rules`](firestore.rules) → Publish.
4. Project settings → Your apps → Web → copy the config → paste into
   `firebaseConfig` in [`js/config.js`](js/config.js).
5. Deploy, then open `index.html` as **admin** (the admin code) → the **Setup** tab, and
   set the real **committee** (names + each member's self-identified gender, used only
   to build balanced panels), **chair**, **interview times**, and the **OneDrive**
   applications-folder link. These save to your Firestore — they never go in the repo.
   (`ORG_NAME` branding is the only thing still set in [`js/config.js`](js/config.js);
   the roster placeholders there are just fallbacks until you run Setup.)
6. Committee → `index.html`; applicants → `book.html`.

## Interview times
Setup (gear icon) → **Interview times**. Add one time, or a block that's split into
back-to-back interviews (e.g. Oct 7, 9:00–12:00, 1-hour → three times). Each time can be
edited or removed, or a whole day at once; changes show on everyone's screen live.
- Every time has a permanent id (`js/slots.js`); availability and manual panels are
  keyed by it, so adding/editing/removing one time never shifts answers onto another.
- Editing a time people already answered asks: **Keep answers** (typo fix — answers
  and any booked panel move with it) or **Ask again** (real change — old answers are
  discarded and those people show as "waiting on" again). Removing a time discards its
  answers and any manual panel there; affected candidates are re-planned.
- Duplicates are blocked; overlaps and past dates ask for confirmation. Edits run in a
  Firestore transaction, so two admins editing at once don't overwrite each other.
- The `SLOTS` in `js/config.js` are only the starting defaults, used until the first
  edit in Setup. After that the saved list is authoritative, even if it's empty.

## Re-keying (change the staff / admin codes or the questions)
The questions are encrypted once with a random content key `K`; `K` is then wrapped
(`K XOR PBKDF2(code)`) separately under the **staff** and **admin** codes. Changing a
code = re-wrapping `K`; changing the questions = re-encrypting + re-wrapping. Run this
(Python 3), then paste the printed `ENC_CIPHER`, `ENC_WRAP_STAFF`, `ENC_WRAP_ADMIN` into
[`js/data.js`](js/data.js) — the only copy, now that `mock.html` is gone:

```python
import hashlib, hmac, json, base64, os
STAFF = "your-staff-code"; ADMIN = "your-admin-code"   # independent; never commit these
QUESTIONS = [ ... ]               # the 10 questions
SCALE = [ ... ]; GUIDE = [ ... ]  # the 5 scale levels + guidance bullets
salt = base64.b64decode("ZWQtbW9jay1zYWx0LTAxIQ=="); iters = 100000  # = ENC_SALT/ENC_ITER
def hkdf(ikm, salt, length, info=b""):     # RFC 5869, matches WebCrypto HKDF
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    okm, t, i = b"", b"", 1
    while len(okm) < length:
        t = hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest(); okm += t; i += 1
    return okm[:length]
kdf = lambda c: hashlib.pbkdf2_hmac("sha256", c.encode(), salt, iters, dklen=32)
K = os.urandom(32)
pt = json.dumps({"q":QUESTIONS,"s":SCALE,"g":GUIDE}, ensure_ascii=False).encode()
enc  = bytes(a ^ b for a, b in zip(pt, hkdf(K, salt, len(pt))))
wS   = bytes(a ^ b for a, b in zip(K, kdf(STAFF)))
wA   = bytes(a ^ b for a, b in zip(K, kdf(ADMIN)))
b64 = lambda b: base64.b64encode(b).decode()
print("ENC_CIPHER    =", b64(enc)); print("ENC_WRAP_STAFF =", b64(wS)); print("ENC_WRAP_ADMIN =", b64(wA))
```

**Changing a password.** Passwords never change by themselves: the question key is
baked into `js/data.js` and the Firebase account passwords stay as set. The normal way
is `set-passwords.py` (see "Passwords" above), which does the re-lock and the Firebase
accounts in one go. The recipe above is the manual equivalent: re-run it with the new
ED and Leadership passwords, paste the new values, push, then set the matching Firebase
account passwords in the console. Pick passwords that are not easy to guess, and never
write one, or a hint about its pattern, in this public repo.

## One link, three audiences
The same `index.html` serves everyone; what you can do depends on the code you type:
- **ED physician / committee** — the staff code → Screen · Availability · Score.
- **Admin** — the (independent) admin code → signed in as "Admin" with no name to
  pick: the collation, both availability grids, Panels · Ranking · Setup. An admin who
  also reviews taps **review as a member** in the header to pick their name, which
  adds their own screening, availability and the Score tab.
- **Applicant** — a **different applicant code** → taken straight to their own
  scheduling (enter last name, pick times). They never see the roster, questions,
  scores, or other applicants. (`book.html` now just forwards here.)

## Real access control (the "roles" security model)
`AUTH.mode` in [`js/config.js`](js/config.js) is `"roles"`, and that is how the live
tool runs: each of the three passwords is the password of one Firebase account, and
the Firestore rules decide what each account may do, on the server. (The old
`"anon"` mode, where every visitor signed in anonymously and the data was only
protected by the page itself, is still in the code but must not be used with real
data; the published rules refuse anonymous sign-ins.) Setting the roles model up
from scratch takes these console steps (they can't be done from the repo):

1. **Firebase console → Authentication → Sign-in method →** enable **Email/Password**.
2. **Authentication → Users → Add user** three times (emails must match
   `AUTH` in `js/config.js`; the **passwords are the shared secrets** you hand out):

   | Email | Password | Who |
   |---|---|---|
   | `committee@ed-hiring.app` | the **staff code** | ED physicians / reviewers |
   | `admin@ed-hiring.app` | the **admin code** (independent of the staff code) | leadership |
   | `applicant@ed-hiring.app` | the **guest code** | candidates |

   > The admin code is independent of the staff code, so a reviewer who knows the
   > staff code **cannot** sign in as admin — the reviewer/admin (ranking) wall holds.
   > Remaining tradeoff: the staff code both decrypts the questions and is the
   > committee Firebase password, so keep it off any public channel and prefer a
   > code that isn't trivially guessable.

   > **What one reviewer can see of another.** All reviewers share the single
   > `committee@…` account, so the rules cannot tell them apart. Scores are
   > therefore unreadable to the whole committee — that is what keeps the ranking
   > private. **Screening is deliberately looser**: a reviewer may fetch a
   > screening document *by exact id*, which is what lets their own flags and
   > ratings follow them to a new device, so a reviewer who opened the browser
   > console could also fetch a colleague's. Bulk listing stays admin-only, and
   > the app itself never requests anyone else's. The same shared account already
   > means a reviewer could *submit* screening as someone else. Closing both
   > properly means per-member accounts: thirteen users instead of three, rules
   > keyed on `request.auth.token.email`, and the name-pick screen replaced by a
   > real sign-in.

3. **Firestore → Rules →** paste [`firestore.rules`](firestore.rules) → **Publish**.
4. Check that [`js/config.js`](js/config.js) has `AUTH.mode = "roles"` (it does).
5. Sign in as **admin** once — the app publishes the PII-free list of interview times
   to `/interviews_public/slots` (and again on every edit in Setup → Interview times),
   so applicants can read *only* that.

What this enforces (server-side, not just UI):
- Applicants can read **only** the interview slots and write **only** their own
  availability. They **cannot** read the roster, questions, screening, or scores.
- Reviewers can submit screening/scores/availability and read the roster +
  availability, but **cannot read anyone's scores** or list the screening, so the
  **ranking is admin-only for real**, not just hidden in the UI.
- The ED password (every ED physician has it) can **save but never delete**: no
  document in any collection, and it **cannot change the applicant list**. Adding,
  removing and deleting are leadership's.
- Applicant availability can only hold `slots` (time id → in person / Zoom / either),
  at most 200 times.
- A sign-in lasts for that browser tab only. **Log out** signs out of Firebase too.
- **Rules v2 (Oct 2026).** When leadership closes a stage (screening, availability or
  scoring), the ED password can no longer change that stage's answers, on the server,
  not just on screen; applicants can still confirm or withdraw after availability
  closes. While a round is being closed, ED and Guest writes are paused. The change
  history, the applicants' confirmed times and the saved copies of closed rounds are
  three new collections; only leadership can read them (an applicant can fetch only
  their own confirmed time). Leadership is always checked first in every rule, so
  these gates cost nothing on leadership saves and one extra read on ED and Guest
  saves. Everything reads "not set" as open, so data from before v2 behaves as before.

Honest limits (see the header of `firestore.rules`): reviewers share one committee
account, so per-**member** write-isolation isn't rule-enforceable (needs per-member
accounts or custom claims). So a reviewer cannot delete anything, but could still
overwrite a colleague's screening or score. And an applicant could overwrite another's
availability by typing their last name. The same shared Guest account means an applicant
who types another applicant's surname could see that person's confirmed interview time,
or confirm or withdraw for them; every reply shows to leadership with its date, and a
withdrawal never removes anyone by itself. All of these are low-impact and documented.

### Publishing the rules from the command line

`firebase.json` and `.firebaserc` point the Firebase CLI at this project
(`mgh-ed-hiring`) and at `firestore.rules`, so the console paste above can be replaced by:

```bash
npx firebase-tools login                    # once, as the department Google account
node scripts/sync-allowed.mjs --apply       # first, as above
npx firebase-tools deploy --only firestore:rules
```

`--only firestore:rules` publishes the rules and nothing else (no hosting, no data).
The tests in `tests/` keep their own emulator-only `firebase.json` and are unaffected.

**Every published rules version gets a git tag**, so a rollback is one command:
`rules-v1-2026-10-16` (before stages and rounds) and `rules-v2-<date>` (tag it on the
commit you published, the day you publish). To go back: `git show <tag>:firestore.rules
> firestore.rules`, then deploy as above. **Roll back the page first, then the rules, and
never the rules alone while a page from Oct 2026 release R1 or later is live**: those
pages write a change-history entry with every leadership save, and the v1 rules refuse
it, so every leadership save would fail.

## Backups and the change history (Oct 2026)

- **Download a backup before every release of the tool and before any big change.**
  Ranking tab, "Back up this hiring cycle", or Setup, Backup: **Download backup file (for
  restoring)** saves the whole working round as one JSON file, read fresh from the database
  (never from what the page happens to hold). It includes the interview questions, the input
  of people who have left or were taken off the list, the applicants' replies and the change
  history. A later release can load it back in. **Download Excel** is the same read, for
  people to look at. Both have applicant names and the committee's comments: save them with
  the CVs on OneDrive and don't email them.
- **Setup, Change history** lists every change made with the Leadership password, newest
  first, 50 at a time. It never stores an applicant's name (names are filled in when it is
  shown). Hand-made panel changes can be undone there (and for 10 seconds from the message
  after "Reset hand-made panels"); undo is refused if the panel changed since.
- **Setup, Committee and screeners** has one row per person: name, "Interviews and screens"
  or "Screens only", F or M (interviewers only; self-identified, used only to balance panels),
  "Active" or "Left the committee", and an optional work email. Renaming someone keeps all
  their input. Someone who left keeps their input, and it still counts, but they leave every
  list of people. A row can be removed outright only if that person saved nothing. "Add
  people" takes one per line: "Name, F" or "Name, M" for interviewers, just the name for
  screeners.
- **Setup, Interview questions** edits the questions, the rating scale and the guidance.
  Once anyone has scored, questions can't be added, removed or reordered (only the wording
  fixed), because notes are filed under each question.
- **Interview questions now live in the database.** The first Leadership sign-in on the Oct
  2026 release copies them out of the old locked `js/data.js` automatically; Change history
  then shows "Copied the interview questions". Notes stay attached to their question.
- **Log out** first saves anything still pausing and waits up to 5 seconds for unsaved
  changes (it asks before throwing any away), then clears this browser's copy of your scores.
- **When a new version goes live**, an open page notices within 10 minutes and shows "This
  page was updated. Reload to get the latest version." A Leadership page reloads itself
  instead, but only when nothing typed could be lost.
- **Known gaps while a page from before Oct 2026 is still open** (it never shows that line,
  so reload every open tab on release day). Low risk, but known:
  - An old page saving the committee from its text box drops each person's id, role, status
    and email. Anyone added with the new editor (an id like `m-...`) would then lose the link
    to what they entered until it is put back from the JSON backup; people from before keep
    theirs (their id is their name).
  - An old page editing interview times drops "2 rooms".
  - An old page counts concerns with a fixed threshold of 2 and ignores Leadership's On or
    Off decisions.
  - An old page saving during a closed stage gets "Couldn't save. Check your connection"
    (the server refuses it).

## After the interviews: offers and the backup

On the **Ranking** tab (admin):

- **Offers**: for each candidate choose Not offered / Offered / Accepted / Declined;
  the dates fill in themselves and can be changed; add a note. Only the admin
  account can see or change offers (`interviews_offers` in `firestore.rules`).
- **Back up this hiring cycle**: *Download Excel* saves everything in the round
  (candidates, screening, availability, panels, scores, ranking, offers) as one
  workbook; *Print or save as PDF* prints a summary. Save the Excel file with the
  CVs on OneDrive after each cycle: the site is the working copy, not the record.

## Security notes
- The **questions/scale/guidance** are encrypted and only decrypt with the correct
  committee code — not readable in the page source.
- Applicant **names/CVs** never live in the repo — names in Firestore/local, CVs in
  access-controlled OneDrive (the app only links out).
