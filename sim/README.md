# Round simulation

Drives a **whole hiring round through the real UI**: leadership adds applicants,
thirteen interviewers send their availability, every applicant goes through the
applicant link and picks their times, and leadership opens the Panels tab. What
the tab shows is then checked against the scheduling rules — restated here from
scratch, so a mistake in `panels.js` cannot excuse itself.

It exists because the two problems it found were both invisible from the code:
the schedule was *correct* and the **explanations next to it were wrong**, and
one interviewer was quietly left off every panel. See CHANGES.md → "What a
simulated round found".

Dev-only, like [`../tests/`](../tests/). Never shipped; the tool itself still has
no build step and no dependencies.

## Run it

```bash
cd sim
npm install
npx puppeteer browsers install chrome     # once, if you have no Chrome
npm test                                  # scenarios + one full round + score + auth + 40 random rounds
```

`$CHROME` overrides the browser; otherwise any Chrome in the puppeteer cache or
the usual system paths is used.

| Command | What it does |
|---|---|
| `npm run e2e` | One scripted round, clicked through end to end. Prints the schedule, the interviewer load and anything that breaks a rule. |
| `npm run scenarios` | The awkward paths: returning applicants, unknown/removed surnames, editing a time people have answered for, manual panels, double-booking, removals, chair changes, the CSV export. |
| `npm run fuzz -- 100 1` | 100 random rounds (committee, times, availability, flags) from seed 1. A seed replays exactly. |
| `npm run score` | The Score tab's typed score: 16 scripted cases (wrong-candidate filing, eaten taps, lost-on-lock, clearing). |
| `npm run auth` | Sign-in and Log out against a stub Firebase (the other sims never reach Firebase): the sign-in is kept for one tab only, a reload signs back in, Log out signs out of Firebase, and a browser that blocks storage can still sign in. |
| `npm run foundations` | The Oct 2026 foundations (in `npm test`): members keyed by id, the questions document and the one-time copy from the old locked file, change history with undo, the backup file and Excel from a fresh read, log out clearing this browser's copies, and the reload notice. |
| `npm run editors` | Setup's committee editor and questions editor (in `npm test`): rename keeps input, someone who left still counts but leaves every list, screens-only people are never on a panel, the chair can't leave, and the questions lock once scoring starts. |
| `npm run stages` | Round stages, deadlines, the schedule lock and the interview-list decisions (in `npm test`): closing screening freezes the list and disables a reviewer's buttons, reopening clears only the frozen answers, a locked schedule doesn't move when someone's availability changes (and Needs attention names them), the countdown reads Setup, notes never count, Make this a note keeps the words (and undoes), On overrides concerns, threshold 0, revealing the ranking can close scoring. |
| `npm run applicants` | Shared surnames and rename, merge, delete in the app (in `npm test`): a second Kim is prompted and the old answers move only to the chosen Kim, each Kim books under their own key (plain Kim refused, a unique surname still books with the last name only), rename moves availability, the merge preview matches what moves, delete needs the typed surname and leaves nothing, four quick roster edits all go out, and an older tab rewriting the allowed list is capped at 3 writes with a reload message. |
| `npm run notices` | Two rooms and day chairs, my panels on the Score tab, copy-ready emails and calendar files, and the applicant's confirmed time (in `npm test`): only my panels listed once the schedule is locked (switching keeps an unsaved note), the applicant confirms or withdraws and Undo, booking closed still takes a reply, booking paused shows no name step, a late reply shows to leadership only, and Setup's 2 rooms and no-chair day give disjoint, legal panels. |
| `npm run emulator` | The REAL page (Firestore and Firebase Auth code, real `firestore.rules`) against the local emulators, project `mgh-ed-hiring-test-emu`. Needs `../tests` installed (it uses that `firebase-tools`) and Java. `make-site.sh --emulator` builds `site-emulator/` by patching the copy only. Not part of `npm test` (it starts emulators). |
| `npm run stress` | Random panellist behaviour on the Score tab, checked against a model after every pause: plain, with write latency, and with 15% failed writes. `node score-stress.mjs 1 <seed>` replays one; `FULL=1` prints its whole trail. |

`make-site.sh` builds `site/` — a copy of the tool with `config.js`'s
`firebaseConfig` blanked (so it runs on `LocalStore`) and `data.js` replaced by a
stub (`adminpw` = leadership, `staffpw` = reviewer). Nothing here can reach
Firebase or real data. Re-run it after changing the tool; every `npm` script
above does.

## What it checks

`check.mjs` deliberately **does not import `panels.js`**. Since Oct 2026 it also restates two-room times and day chairs (at most that many applicants at a time, panels at one time share nobody, each panel has its own day's chair or none), and every even fuzz round uses them. It re-states the rules
from DESIGN.md and checks the schedule on screen against them:

- every panel has the chair, 3–5 members, one of each gender, and everyone on it
  said they were free at that time in a compatible modality;
- the applicant said they were free then too;
- one applicant per time, nobody scheduled twice;
- **as many applicants as possible are interviewed** — a separately written
  maximum matching, cross-checked by brute force on small rounds;
- the "understaffed time" list is exactly the times somebody is free for where no
  balanced panel can form;
- every unscheduled applicant is given the **right reason** of the three (hasn't
  answered / no balanced panel possible / their times are taken);
- **nobody is left off every panel when a seat existed for them** — proved by
  enumerating every legal membership for the panels that were booked and taking
  the arrangement that uses the most people;
- every interviewer on no panel is given the right one of *their* three reasons
  (no availability sent / free only at times or in a format nothing is booked in
  / squeezed out of a full panel). "Free at that time" is not enough to earn the
  third: someone who can do 10am only by Zoom cannot sit on the in-person panel
  booked then, and both this check and the tab got that wrong first time round.

`scenarios.mjs` covers the paths a random round rarely reaches: it also reads
the **applicant availability grid** back cell by cell and checks it against what
each applicant actually submitted, that the ringed cells match the schedule, and
that the summary column survives being scrolled on a phone. It renders both the
Panels and Availability tabs at **390px** — the "needs attention" lines are prose, and prose is
what runs off the edge of a phone.

## Scope

This is the client half. It says nothing about the Firestore rules — those are
[`../tests/`](../tests/), which run against the emulator. It also runs in local
mode, so it cannot see anything that only happens under the roles auth model.

Applicant names here are invented (`Ashcombe`, `Trelawney`, …) and must stay
that way: no real applicant's name belongs in this repo.
