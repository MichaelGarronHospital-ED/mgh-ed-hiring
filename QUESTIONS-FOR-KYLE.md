# Open questions for Kyle / Amanda

Running log of things I need confirmed to finish the interviews tool. Answered
items are struck out at the bottom and moved to DESIGN.md.

## Draft email (final)

**Subject:** ED hiring tool — clickable mock to look at + a few questions

Hi Kyle, Amanda,

I've put together a **clickable mock** so you can see the proposed workflow before I
build it for real:

**https://dralvinyang.github.io/ED-motion-voting/tools/interviews/mock.html**

Enter the password **edleadership** when it loads (the interview questions are kept
encrypted so they aren't public). It uses sample data with made-up candidate names.
Use the **"Viewing as"** dropdown at the top to switch between a committee member and
an applicant. It walks through five stages: **Screen → Availability → Panels → Score →
Ranking**.

The plan: each committee member reviews the CV/cover letter (linked straight to the
OneDrive folder), flags anyone they feel is unqualified (a candidate drops off at
**2+ flags**, same as last year), and can optionally give a 1–5 priority rating.
Individual input stays private to the member and leadership. The tool then gathers
everyone's availability and **auto-suggests interview panels** that meet the rules
(3–5 members, you present, ≥1 male + ≥1 female), flagging any slot that's short on
interviewers. I can add/remove candidates if the list changes, and the **screening**
step will be ready well before **Sept 23**.

A few questions when you have them:

1. **Interview dates & format.** I have Oct 1 from 10am (~6 interviews). Please send
   the full slate when ready — which days, how long each interview, how many per day.
   And will interviews run **one at a time (sequential)** or **several panels in
   parallel**? (If you're on every panel, they'd need to be sequential.)

2. **Chairing & panel rules.** Each panel is set to: 3–5 members, **you present**,
   and ≥1 male + ≥1 female. (a) Must **you personally** be on every panel, or can a
   delegate chair some (so more can run in parallel)? (b) Any other rules — e.g.,
   should an interviewer who **flagged** a candidate be kept off that candidate's
   panel? (c) A cap on how many interviews one person does in a day?

3. **Scoring method.** The guide has one overall **1–5** rating per interview. Keep it
   **overall-only**, or also rate **each question 1–5**? And how should the **final
   ranking** be produced — average of interviewers' scores, or scores as input to a
   committee discussion? Any tie-break preference?

4. **Access — who sees what.** Should some views be **admin-only** — e.g., only you
   (not the whole committee) can see the **final scoring summary / ranking**? And who
   should have admin access — you and Amanda?

FYI on scheduling: interviewers and candidates each select **all** the slots that work
for them and mark whether they **can** do each in person, by Zoom, or either; the tool
then builds compliant panels around that.

Thanks — I'll have the screening step ready to circulate shortly.

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

## Still open (in the email above)
1. Full interview date/time slate + interview length + count per day.
2. Interviews **sequential or parallel**? (Drives double-booking + whether Kyle can be on all.)
3. Must **Kyle personally** be on every panel, or can a delegate chair some?
4. Any additional panel rules (e.g. flagged-interviewer conflict); cap on interviews/person/day.
5. Scoring: **per-question 1–5** vs **overall-only**; how the **final ranking** is computed; tie-breaks.
6. **Admin-only** views (who sees final scoring/ranking); who has admin access.
