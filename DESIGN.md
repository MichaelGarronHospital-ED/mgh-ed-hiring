# ED Physician Hiring — Interviews Tool (Design)

One app, three phases, for the MGH ED 26-27 physician hiring round. Same stack as
Motion Voting (Firebase/Firestore, static site on GitHub Pages). Recommend a
**separate Firebase project** from voting — this holds candidate names +
evaluations, so keep the data isolated.

## Identity model

- **Committee members** (internal, 12 + Kyle as chair): a **shared committee access
  code** opens the app, then pick your name. Same people **screen and interview**.
  Admin page separately passcode-gated.
- **Candidates** (external): **one shared link**; candidate **types their name**,
  matched to the roster server-side with **no visible candidate list** (applicants
  never see who else applied). No per-person links to generate. Applicant PII (CV,
  cover letter) is **never hosted** — links point to the access-controlled OneDrive
  folder (committee has access via TEHN login).
- **Input privacy:** each member sees only their **own** flags/ratings/scores; only
  admin (Kyle/Amanda) sees everyone's input + the aggregate. Mirrors last year's
  "send your list to Amanda" and avoids one opinion anchoring others. All input is
  editable until the admin **closes** that phase.

## Phase 1 — Screen → shortlist (DEADLINE: Sept 23 2026)

Committee member view, one row per candidate:
- Link out to OneDrive CV/cover letter.
- **Flag: "concern about qualifications"** + reason (free text).
- **Optional overall rating 1–5** — informs interview *order* only; does NOT drive the cut.

Admin view:
- Collate flags → **candidate removed at ≥2 flags** (confirmed, last year's rule).
  Threshold kept configurable in code.
- Ratings shown as averages to inform interview order.
- **Add / remove candidates** in case the list changes.
- Export shortlist.

> No bias-test attestation in the tool (per Alvin, 2026-09-16). Handled offline
> unless we're told to add it later.

## Phase 2 — Availability → panels

Sequence:
1. Amanda defines **interview days + slots** (Oct 1 from 10am, ~6 that day; more
   dates added as they arrive).
2. **Interviewers** select **all slots that work for them**.
3. **Candidates** submit **all slots that work for them** via their private link.
4. Each person marks a **modality per selected slot**: in-person / Zoom / either
   (default *either*). Listed slots are modality-agnostic.
5. Tool matches each candidate to one of their available slots and assembles a
   **panel**. Enforced, but **not surfaced to users as a gender rule** — framing it
   as an "M/F rule" could be misconstrued (Kyle, 2026-09-17). Rules:
   - **3–5 members**
   - the **chair (Kyle)** — required, but **not displayed as a rule in itself**
   - **at least one member who identifies as female and at least one who identifies
     as male** (by self-identification) — shown to users only as a "balanced panel",
     never as M/F badges.
   - no interviewer double-booked across concurrent slots
   - Panel modality = the candidate's modality for the slot; only interviewers who can
     do that modality are eligible. **In-person encouraged where possible.**
   - **No other panel rules** (Kyle: flagged-interviewer conflict not needed).
6. **Admin proposes → overrides.** The tool auto-proposes panels; Amanda can swap
   any member by hand. When a slot **can't** satisfy the hard rules, the tool
   **warns** rather than failing silently (esp. "Kyle on every panel" at ~17 interviews).
7. **Coordinator dashboard:** who has / hasn't submitted screening or availability,
   so Amanda can chase.

## Phase 3 — Score → rank

Per interviewer, per candidate, using the 2026 Interview Guide (**revised** overall
scale, 2026-09-17):
- Free-text **notes per question**.
- **One holistic overall 1–5 rating** using the revised evaluation guide + panelist
  guidance. Per-question 1–5 ratings were considered (Kyle floated a "suggested overall
  from per-question" idea) but **not added** — the guide is deliberately holistic and
  several questions aren't 1–5-ratable; keeping one overall rating lowers reviewer
  burden. (My recommendation to Kyle; easy to add per-question later if he wants.)
- Aggregate → ranked list for **4–6 offers**, shown on an **admin-only Ranking view,
  hidden until all interviews are complete** (anti-bias; Kyle confirmed). Default:
  ranked by **average score as decision support** for the committee's final discussion
  (not a purely mechanical cut).

### Interview questions & evaluation scale — CONFIDENTIAL, not stored here
The 10 questions (pronouns icebreaker + Q1–Q10) and the 1–5 evaluation scale come from
the **2026 Interview Guide** and are **deliberately not reproduced in this repo** —
candidates shouldn't be able to see them in advance. In the mock they're stored
**encrypted** and decrypted only after the login password; in the real tool they live
behind the committee gate (Firestore). Source of truth: `Interview Guide_ER PHYSICIAN_2025 Updated.pdf`.

## Reference data

**Committee / interviewers (12, confirmed) — gender for the panel rule (8 M / 4 F):**
Rosenstein (M), Yang (M), Jha (M), Marrocco (F), Balachandran (M), Mohindra (F),
Klaiman (F), Porfiris (M), Hayre (M), Reynolds (F), Bahar (M), Losier (M).

**Candidates:** 17 confirmed (editable in the tool). Applicant names are **not stored
in this repo** — they live in the OneDrive folder / the tool's Firestore data, to keep
applicant PII out of a repo that feeds a public Pages site.

## Decisions locked (Alvin, 2026-09-16)
- One combined tool, phased; build Phase 1 first.
- Screening = flag-if-unqualified, **remove at ≥2** (same as last year) + optional
  1–5 rating for order only. No bias attestation in-tool.
- Candidate list confirmed but **add/remove** supported.
- Committee confirmed; same people screen + interview.
- Build availability + auto-paneling in-app (not Doodle). Panel rules are **hard**.
- Candidates + interviewers select **all** working slots; **modality per slot**
  (in-person / Zoom / either), listed slots agnostic.
- Candidate docs = link to OneDrive only.
- Candidate sign-in = **one shared link + type your name** (no per-person links).
- Committee sign-in = **shared committee code + name-pick**.
- Input is **private** to submitter + admin; editable until the phase is closed.
- Admin can **override** any auto-proposed panel; tool warns on infeasible slots.
- No email-sending in-tool: it's the source of truth and **exports** the schedule/CSV;
  Amanda notifies candidates.
- **Panel composition** (Kyle 2026-09-17): enforce ≥1 female-identifying + ≥1
  male-identifying member + the chair, but **present it as "balanced panel", never as an
  M/F rule**, and don't show "chair present" as a rule. No other panel rules.
- **Ranking is admin-only, hidden until all interviews are complete** (Kyle confirmed) —
  ranked by average score as decision support for the committee discussion.
- **Booking view**: in-person interviews **encouraged where possible** (Kyle).
- **Revised overall rating scale + panelist guidance** incorporated (2026-09-17).
- **Separate Firebase project**, locked Firestore rules, **delete data after the round**.

## Mock
`mock.html` — self-contained, "MOCK" banner, **10 fictitious candidate names**,
**password-gated (`edleadership`)**. The confidential interview questions + evaluation
scale are stored **encrypted** (PBKDF2-SHA256 keystream, XOR) and decrypted only after
login, so they are not readable in the public page source. Five tabs: **Screen ·
Availability · Panels · Score · Ranking** (no committee-vs-admin toggle). "Viewing as" defaults to **Vojdani (Kyle)** and switches between any committee
member and an applicant; in the applicant view the tabs are hidden and only the
slot-selection screen shows. Slot availability is a single always-visible **In person /
Zoom / Either** control per slot. **Panels** tab shows auto-suggested panels with size +
"balanced panel" status (no M/F labels) plus a "needs attention" list (understaffed
slots, unschedulable candidates) — the matching logic itself is still to be built
(Phase 2). **Ranking** tab is labelled admin-only. All tabs carry seeded sample data.
Amanda is not referenced in the tool UI (she remains in the email/coordination plan).

## Kyle's replies (2026-09-17) — resolved
- Panel rule reframed to "balanced panel" (see above); **no other rules**.
- Ranking = **admin-only, hidden until interviews complete** — confirmed.
- Rating = keep **overall-only** with the revised guide (per-question not added).
- Booking view: **in-person encouraged**.
- **Revised overall rating scale** supplied and incorporated.
- Dates: **Amanda will send** the interview times.

## Still open / working defaults
- **Final-ranking method** not explicitly answered → default: average score as
  **decision support** for the committee discussion (admin-only). Confirm with Kyle.
- **Dates**: awaiting Amanda's time slots.
- **Sequential vs parallel** + **chair-every-panel** not raised → assume sequential
  with Kyle chairing (safe default).

## Open logic decisions / edge cases (my working assumptions)
- **Screening rating** is an optional 1–5 *priority* hint, separate from the interview
  Evaluation Scale; does not affect the ≥2-flag cut.
- **Modality resolution:** panel modality = the candidate's modality for that slot;
  only interviewers who can do that modality (or "either") that slot are eligible.
- **Unschedulable candidate** (no slot yields a compliant panel) → flagged for manual
  handling, never silently dropped.
- **Missing scores:** final average uses whoever scored; dashboard shows coverage.
- **Name match** (candidate login): case-insensitive, trims; no match → "contact Amanda".
  All 17 last names are unique.
- **Editing** allowed until admin **closes** a phase.
