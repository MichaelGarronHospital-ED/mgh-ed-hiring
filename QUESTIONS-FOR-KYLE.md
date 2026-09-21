# Open questions for Kyle / Amanda

Running log of things I need confirmed to finish the interviews tool. Answered
items are struck out at the bottom and moved to DESIGN.md.

## Draft email (final)

**Subject:** ED hiring tool — mock to look at (+ a few questions)

Hi Kyle, Amanda,

I've built a **clickable mock** of a tool to run our hiring process end-to-end. Have a look:

**https://dralvinyang.github.io/ED-motion-voting/tools/interviews/mock.html**
Password: **(the committee code — sent separately)**

**Please note:** this is only a *mock* with made-up candidate names to show the idea —
nothing is saved and it isn't the finished tool. Once you confirm the details below, the
real working version takes me about **a day** to build.

**How it would work, start to finish:**

1. **Screen the applications.** Each committee member opens the tool and, for every
   applicant, reads their CV and cover letter (linked from the OneDrive folder) and
   flags anyone they don't think is qualified. If **2 or more** people flag the same
   person, they come off the interview list (same rule as last year). You can also give
   a quick **1–5 priority** score. Your input is private — only leadership sees the totals.

2. **Collect availability.** Interviewers tick which interview times they can do, and
   whether they can be **in person, on Zoom, or either**. Applicants get **one link**,
   type their name, and pick the times that work for them.

3. **Auto-build panels.** The tool suggests an interview panel for each time slot that
   follows the rules — **3–5 people, you present, at least one man and one woman** — and
   **flags any time slot that's short on interviewers** so it can be fixed.

4. **Score the interviews.** Each panel member scores the candidate out of 5 using our
   standard interview guide, with notes per question.

5. **Rank.** The tool averages the scores into a **ranked list** to help decide the
   4–6 offers.

**A few things I need from you to build the real one:**

1. **Interview dates & format.** I have Oct 1 from 10am (~6 interviews). Please send the
   full set of dates when ready — which days, how long each interview, how many per day.
   And will interviews run **one at a time**, or **several panels at once**? (If you're
   on every panel, they'd need to be one at a time.)

2. **Chairing & panel rules.** Each panel is set to 3–5 people, **you present**, and at
   least one man + one woman. (a) Must **you personally** be on every panel, or can a
   delegate chair some? (b) Any other rules — e.g., should someone who **flagged** a
   candidate be kept off that candidate's panel? (c) A cap on how many interviews one
   person does in a day?

3. **Scoring.** The guide has one overall **1–5** rating. Keep it that way, or also rate
   **each question 1–5**? And how should the **final ranking** be decided — a straight
   average of scores, or scores as a starting point for a group discussion?

4. **Access.** Should some views be **leadership-only** (e.g., only you see the final
   ranking)? And who should have admin access?

Thanks — happy to tweak the mock based on what you think.

Alvin

## Answered (moved to DESIGN.md)
- ~~Screening cut rule~~ → confirmed: flag, remove at ≥2 (rating does not drive cut).
- ~~Candidate list~~ → confirmed; add/remove supported in tool.
- ~~Hiring committee~~ → confirmed; same people screen + interview.
- ~~Bias attestation~~ → not building it (unless told later).
- ~~Interview questions + rubric~~ → 2026 Interview Guide received.
- ~~Committee OneDrive access~~ → yes, via TEHN login.
- ~~Committee member genders~~ → received (8 M / 4 F).
- ~~Candidate self-scheduling~~ → candidates select all working slots via private link.
- ~~In-person vs Zoom~~ → per-person, per-slot toggle (default either); listed slots agnostic.

## Reply to Kyle (draft, 2026-09-17)

**Subject:** RE: ED hiring tool

Thanks Kyle — all really helpful. I've updated the mock (same link + password):

- **Panels:** reworked so it's not framed as a male/female rule. Behind the scenes it
  still makes sure each panel has at least one person who identifies as female and one
  who identifies as male, plus you as chair — but the tool just shows it as a "balanced
  panel," and your presence isn't shown as a rule. No other panel rules added.
- **Ranking:** now an admin-only view, hidden until all interviews are done, so it can't
  bias anyone.
- **Booking view:** added that in-person interviews are encouraged where possible.
- **Rating scale:** dropped in your revised guide (it reads really well) plus the
  panelist guidance.
- On **rating each question vs one overall score:** my suggestion is to keep a single
  overall 1–5 (using your revised guide) with written notes per question, rather than
  scoring all ten questions. A few of them (pronouns, "any questions for us") aren't
  really 1–5 items, and one overall rating keeps it quick so people actually finish it.
  Easy to add per-question scoring later if you'd like — happy to try it either way.
- **Dates:** great, I'll wait for Amanda's times.

For the final list, the tool will simply rank candidates by their average score as a
starting point for our discussion.

Alvin

---

## Status — SENT to Kyle 2026-09-16; reply received 2026-09-17 (see above)

Still open (asked):
1. Any additional panel rules (e.g. flagged-interviewer conflict); cap on interviews/person/day.
2. Scoring: **per-question 1–5** vs **overall-only**; **final ranking** = average vs discussion; specific logic.
3. Confirm **Ranking hidden until all interviews complete** (Alvin's proposed default).

Deferred / not asked:
- ~~**Dates:**~~ → Amanda sent them: Oct 1 (7 × 1 h, 9am–4:30pm with a 1:00–1:30 break
  before the afternoon) + Oct 7 9am–12pm (3 × 1 h) = 10 interviews; Oct 8 as overflow.
- **Sequential vs parallel** + **Kyle-chairs-every-panel** — not asked; assume sequential
  with Kyle chairing until told otherwise.
