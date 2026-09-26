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
cd tools/interviews/sim
npm install
npx puppeteer browsers install chrome     # once, if you have no Chrome
npm test                                  # scenarios + one full round + 40 random rounds
```

`$CHROME` overrides the browser; otherwise any Chrome in the puppeteer cache or
the usual system paths is used.

| Command | What it does |
|---|---|
| `npm run e2e` | One scripted round, clicked through end to end. Prints the schedule, the interviewer load and anything that breaks a rule. |
| `npm run scenarios` | The awkward paths: returning applicants, unknown/removed surnames, editing a time people have answered for, manual panels, double-booking, removals, chair changes, the CSV export. |
| `npm run fuzz -- 100 1` | 100 random rounds (committee, times, availability, flags) from seed 1. A seed replays exactly. |

`make-site.sh` builds `site/` — a copy of the tool with `config.js`'s
`firebaseConfig` blanked (so it runs on `LocalStore`) and `data.js` replaced by a
stub (`adminpw` = leadership, `staffpw` = reviewer). Nothing here can reach
Firebase or real data. Re-run it after changing the tool; every `npm` script
above does.

## What it checks

`check.mjs` deliberately **does not import `panels.js`**. It re-states the rules
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

`scenarios.mjs` covers the paths a random round rarely reaches, including the
Panels tab at **390px** — the "needs attention" lines are prose, and prose is
what runs off the edge of a phone.

## Scope

This is the client half. It says nothing about the Firestore rules — those are
[`../tests/`](../tests/), which run against the emulator. It also runs in local
mode, so it cannot see anything that only happens under the roles auth model.

Applicant names here are invented (`Ashcombe`, `Trelawney`, …) and must stay
that way: no real applicant's name belongs in this repo.
