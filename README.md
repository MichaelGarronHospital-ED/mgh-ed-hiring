# ED Physician Hiring — Interviews Tool

A five-stage hiring tool: **Screen → Availability → Panels → Score → Ranking**.
Static frontend (no build step). Runs in **local mode** out of the box; add a
Firebase project to go multi-device and real-time.

- **Committee:** [`index.html`](index.html) — enter the committee code, pick your name.
- **Applicants:** [`book.html`](book.html) — one link, type your name, pick your times.
- **Mock (design demo):** [`mock.html`](mock.html) — the clickable prototype Kyle reviewed.

Design + decisions live in [`DESIGN.md`](DESIGN.md); the paneling algorithm is in
[`js/panels.js`](js/panels.js) (validated in a Python prototype before porting).

## Access codes
There is **no code in the source**. The committee code (shared with the team
out-of-band, not written down in this repo) is what people type to enter; it also
decrypts the interview questions. Admins type the same code **+ `!`** and additionally
see the Ranking tab. Regular members never see the Ranking — it's admin-only and hidden
until all interviews are marked complete.

> **Security:** the code decrypts the confidential questions, so treat it like the
> questions themselves. Before real use, set your real questions + a **strong private
> code** and re-encrypt (below) — never a code that appears anywhere public.

## Run it now (local mode)
Open `index.html` over **https** (or `http://localhost`, not a `file://` path — the
question decryption needs a secure context). With `firebaseConfig` left empty in
[`js/config.js`](js/config.js), it uses `localStorage` + `BroadcastChannel`: fully
working on **one machine / browser** (great for demo and click-through), seeded with
sample candidates. Data does **not** sync across devices in this mode.

## Go live (multi-device, real-time)
1. **Create a Firebase project** — a *separate* one from Motion Voting (this holds
   applicant data). Build → Firestore Database → Create (production mode).
2. Firestore → **Rules** → paste [`firestore.rules`](firestore.rules) → Publish.
3. Authentication → **Get started** → enable **Anonymous**.
4. Project settings → Your apps → Web → copy the config → paste into
   `firebaseConfig` in [`js/config.js`](js/config.js).
5. Deploy, then open `index.html` as **admin** (code + `!`) → the **Setup** tab, and
   set the real **committee** (names + each member's self-identified gender, used only
   to build balanced panels), **chair**, **interview times**, and the **OneDrive**
   applications-folder link. These save to your Firestore — they never go in the repo.
   (`ORG_NAME` branding is the only thing still set in [`js/config.js`](js/config.js);
   the roster placeholders there are just fallbacks until you run Setup.)
6. Committee → `index.html`; applicants → `book.html`.

## Changing the committee code
The questions are encrypted with the code, so changing it means re-encrypting them.
Run this (Python 3), then paste the new `ENC_CIPHER` into [`js/data.js`](js/data.js):

```python
import hashlib, json, base64
CODE = "your-new-code"            # committee code (no trailing "!")
QUESTIONS = [ ... ]               # the 10 questions
SCALE = [ ... ]; GUIDE = [ ... ]  # the 5 scale levels + guidance bullets
salt=b"ed-mock-salt-01!"; iters=100000
pt=json.dumps({"q":QUESTIONS,"s":SCALE,"g":GUIDE},ensure_ascii=False).encode()
ks=hashlib.pbkdf2_hmac("sha256",CODE.encode(),salt,iters,dklen=len(pt))
print(base64.b64encode(bytes(a^b for a,b in zip(pt,ks))).decode())
```

## Security (read before using real applicant data)
- The **questions/scale/guidance** are encrypted and only decrypt with the correct
  code — they are not readable in the page source.
- The **baseline Firestore rules** require sign-in but don't, by themselves,
  separate committee from applicant access (both sign in anonymously). The
  committee code gates the app client-side. For a hard boundary before storing real
  CVs/decisions, add Firebase Auth accounts (or custom claims) and tighten
  `firestore.rules` per collection. **Never** put CVs in the repo — link to
  access-controlled OneDrive.
- Applicant **names** live only in Firestore/local, never in the repo.
