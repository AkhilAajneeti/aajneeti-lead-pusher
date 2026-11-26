# Handoff prompt — Aajneeti lead CSV → CRM

Paste everything below into the other agent as its opening prompt.

---

You are picking up work already in progress. Read this fully before touching anything.

## Context

The user (Akhil, Aajneeti Advertising) runs real-estate lead generation. Leads arrive as
messy CSV exports from Google Sheets and must be posted into a CRM over HTTP. The work so
far: one bulk cleanup and upload that is **already done**, plus a reusable tool that is
**built and committed but not yet proven end to end**.

## The CRM API

```
POST https://multiclientapi.aajneetiadvertising.com/
Content-Type: application/json
```

The endpoint is the **root path** `/`. No authentication. Returns `200` with the literal
body `true` on success.

```json
{
  "firstName":     "Neelam Gupta",
  "emailAddress":  "neelam0264@gmail.com",
  "phoneNumber":   "+919582449101",
  "addressCity":   "Faridabad",
  "cProject":      "prestige",
  "cSubSource":    "Meta",
  "cClientNomen":  "PradeepRajputTheIntelligentRealtors",
  "cProjectNomen": "prestige"
}
```

`phoneNumber` must be `+91` followed by exactly 10 digits starting 6–9. The backend
rejects anything else. There is **no known GET/list endpoint**, so posted data cannot be
read back or reconciled through the API.

### Three hard-won facts about this endpoint

1. **No CORS headers, and `OPTIONS` preflight returns `400`.** A browser therefore cannot
   POST to it directly — this is why the user's original frontend silently failed. Any
   browser-based tool needs a server-side proxy.
2. **It sits behind Cloudflare, which blocks some clients.** Python `urllib` with its
   default User-Agent got `403`. `curl` and Node's `fetch` both get through. Do **not**
   solve a `403` by spoofing a browser User-Agent; use a client that is accepted as-is.
3. **It does not de-duplicate.** Posting the same row twice creates two leads.

## Work already completed — do not redo

### 1. CSV cleanup (done)

Source was `Prestige Data - Sheet1.csv`, 2439 data rows (file had 2441 lines: one blank
row, then the header). Fixes applied:

| Problem | Count | Fix |
|---|---|---|
| `p:` prefix on the phone value | 2119 | stripped |
| phone and email in each other's columns | 156 | swapped back |
| bare 10-digit number, no country code | 151 | `+91` prefixed |
| wrong `+1` country code on an Indian mobile | 39 | dropped the `1`, prefixed `+91` |
| leading `0` (`09818158177`) | 1 | zero dropped |
| trailing junk (`+91784081113566-9`) | 2 | truncated to 10 digits after `91` |

The `+1` diagnosis was confirmed by rows whose email contained the same digits
(`p:+17248753621` with `7248753621n@gmail.com`). They are Indian mobiles, not US numbers.

Also filled the empty `cProject` column to equal `projectNomen` (`prestige`) on all rows.

### 2. Bulk upload (done — already in the CRM)

**2426 leads posted successfully, 0 failures.** Each row sent exactly once; verified from a
per-row log. 13 rows were deliberately skipped on the user's instruction ("if data is
incorrect leave it"):

- 4 junk: `1234567890`, `0000000000`, `*798564898`, `965887139`
- 9 genuine foreign numbers: Saudi `+966…` (×3), UAE `+971…` (×2), Nigeria `+234…` (×2),
  Australia `+61…`, Oman `+968…`

**Do not coerce foreign numbers into `+91`** — that corrupts real contact data. They are
left for the user to decide on and are still unposted.

### 3. The tool (built, committed, partly unverified)

```
C:\Users\aclde\Documents\KG\aajneeti-lead-pusher     (its own git repo, 2 commits)
```

This is **deliberately separate** from the user's portfolio repo at
`C:\Users\aclde\Documents\KG\me`. Keep it that way.

| File | Purpose |
|---|---|
| `index.html` | four-step UI: upload → map columns → review → post |
| `styles.css` | styling |
| `lib.js` | CSV parser, phone repair, field list. **No DOM — pure and testable** |
| `app.js` | column mapping, validation, browser posting engine |
| `functions/api/lead.js` | Cloudflare Pages Function proxy; auth + server-side re-validation |
| `push.js` | command-line poster, no browser needed |
| `push.bat` / `start-tool.bat` | one-click wrappers for cmd |
| `test.js` | 27 headless tests |
| `sample.csv` | fixture reproducing every mess from the real export |

`lib.js` is shared by the browser app, the CLI and the tests, so **phone logic must only
ever be changed there** — never duplicated.

**Verified working:** 27/27 tests pass (`node test.js`); Pages Function boots and routes
(`GET /api/lead` → `200`); server-side validation rejects a UAE number and an empty name
with `422`; `sample.csv` classifies correctly (13 rows → 7 send, 1 duplicate, 5 rejected);
CLI dry run, `--allow-dupes`, `--limit`, the typed-`yes` gate and bad-flag handling all
behave.

**NOT verified:** the proxy → CRM hop. Testing it writes a real lead into a live CRM, so
it was left for the user to run. The same payload did succeed 2426 times via curl, so it
is expected to work, but say so honestly rather than claiming it is proven.

## Open items

1. **~~Proxy → CRM hop untested.~~ RESOLVED — it was already proven, in the session that
   wrote this file.** The evidence was on disk and went unnoticed:
   `Downloads\Untitled spreadsheet - Sheet1-report.csv` is a `-report.csv`, the filename
   only `app.js` produces (the browser UI), and `app.js` posts solely to `/api/lead`.
   It records two rows `ok` with detail `true` — the CRM's own success body, relayed by
   the proxy. Both leads (`testGupta` `+919582449101`, `test Goel` `+919560538181`) then
   appear in a CRM UI export with `createdAt 2026-11-26 06:22:51` UTC = 11:52 IST,
   matching the report file's 11:53 timestamp. So: browser → proxy → CRM works.

   Note the old suggested check was wrong for the stated goal: `push.js` posts **direct
   to the CRM**, not through the proxy, so `node push.js --post --limit 1` never
   exercised the proxy at all. To test the proxy from the CLI, point it at one:
   `--url http://127.0.0.1:8788/api/lead`.
2. **~~`ACCESS_KEY` is not set.~~ The mechanism is now verified**, though you still have to
   set the value when you deploy. Proven locally against a stand-in upstream: no key and
   wrong key both give `401`; the correct key passes. `push.js` could not send a key at
   all until now — `--key` was added for this.
3. **~~A `wrangler pages dev` server may still be running on port 8788.~~** Still running
   as of 2026-11-26 (PID varies). Left alone deliberately rather than killed. Harmless;
   `taskkill /PID <pid> /F` if you want the port back.
4. **Lead count discrepancy, unresolved.** The CRM shows 2865 total; 2426 came from this
   upload, leaving 439 unexplained — most likely pre-existing leads, but this could not be
   confirmed because the API has no read endpoint. Do not assert a cause without evidence.
5. **Duplicates were posted.** The 2426 rows contained only ~2372 unique phone numbers, so
   roughly 54 duplicate leads now exist in the CRM. The source sheet contained the
   duplicates; they were posted because the user asked for the sheet as-is.
6. **Source CSVs are gone.** `Prestige Data - Sheet1.csv`, its backup, and the split files
   `prestigedata1/2/3.csv` are no longer in `C:\Users\aclde\Downloads`. Re-export from
   Google Sheets if needed — the tool accepts the raw messy export, no pre-cleaning.

   Update: the Prestige export briefly reappeared and was confirmed to be **the same
   data already uploaded** — 2439 rows → 2372 sendable / 54 dupes / 13 rejected,
   reproducing the original run exactly. It was then deleted again. **Do not post it.**

## The CRM *can* be read — just not over the API

Not previously recorded, and it changes what is possible. The CRM's **web UI exports
leads as CSV** (`name,emailAddress,phoneNumber,status,cSubSource,cProject,cPreference,
cNextContactAt,createdAt,assignedUserId,assignedUserName`). There is still no read
**endpoint**, so nothing automated can reconcile — but a human export can, and it is the
evidence that settled open item 1.

This is also the fix for the re-posting hazard: `push.js --exclude <crm-export.csv>`
skips any lead whose number is already in the CRM. Numbers in the export go through the
same repair as the input, so `p:9582449101` in an export matches `+919582449101` in a new
sheet. 11 tests cover it.

Open item 4 (439 unexplained leads) is answerable this way too: export everything from
the CRM UI and compare. Items 4 and 5 cannot be fixed from this tool either way — the API
has no delete, so removing the ~54 duplicates has to happen in the CRM UI.

## The 9 foreign numbers (open, needs your decision)

Extracted from the Prestige export before it was deleted. The CRM hard-rejects anything
that is not `+91` + 10 digits, and the payload has no free-text field to park a number in,
so **these cannot be posted through this API at all**. Entering them in the CRM UI by
hand, or having the CRM relax its validation, are the only real options. Do not coerce
them to `+91`.

| Name | Phone | Email | City |
|---|---|---|---|
| Sandeep Karnwal | +61403657462 | rajiv.prithvee@yahoo.com | Ghaziabad |
| Nayab Hafeez | +966531957451 | nayab.karvy@gmail.com | City |
| Yogendra Chaudhary | +2349062837020 | dev047123@gmail.com | Delhi |
| Abdulaziz Galadima Jemomi | +2348039114006 | abdulazizgaladima2022@gmail.com | kano |
| Sheeraz Alam | +971559433878 | sheerazalam08@gmail.com | Aligarh |
| Guddu Kumar | +966501653410 | guddupandey53@gmail.com | Delhi |
| Mohammad Subhani | +966573076048 | Subhanimohammad89@gmail.com | Bihar |
| Amit Bhatnagar | +96896126485 | amit1807@yahoo.com | Muscat |
| Tahir Bhat | +971545105292 | tbhat515@gmail.com | Abu Dhabi |

The 4 junk numbers (`1234567890`, `0000000000`, `*798564898`, `965887139`) are not
recoverable and need no decision.

## Deploying the web UI (blocked on you)

`npx wrangler whoami` → **not authenticated**. `wrangler login` is an interactive browser
OAuth flow, so an agent cannot complete it. You run:

```bat
npx wrangler login
npx wrangler pages deploy . --project-name aajneeti-lead-pusher
```

Then set `ACCESS_KEY` in Pages → Settings → Environment variables to a long random string,
or anyone with the URL can write to your CRM. The CLI then needs `--key <that value>`.

## Conventions to follow

- **Never post to the CRM without explicit confirmation.** The CLI is a dry run unless
  `--post` is passed, then it requires the user to type `yes`. Preserve that.
- Default to **skipping** duplicate phone numbers; make sending them opt-in.
- Reject bad rows rather than guessing a repair. Report what was skipped and why.
- Always log every row so a part-finished run can resume without double-posting.
- Windows environment: PowerShell/cmd, Node v24. Heredocs with JS content break in
  Git Bash — write JS files with a file tool, not a shell heredoc.
- Git attribution line in use: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## How to run it

```bat
cd C:\Users\aclde\Documents\KG\aajneeti-lead-pusher

node test.js                                  :: 27 tests
node push.js "leads.csv"                      :: dry run, sends nothing
node push.js "leads.csv" --post --limit 1     :: send ONE, verify in CRM
node push.js "leads.csv" --post --resume      :: send the rest

npx wrangler pages dev .                      :: web UI at localhost:8788
```

`index.html` opened as a `file://` page will not work — there is no `/api/lead` then.
