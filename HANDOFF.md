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

1. **Proxy → CRM hop untested.** The intended check is
   `node push.js "leads.csv" --post --limit 1`, then look in the CRM.
2. **`ACCESS_KEY` is not set.** If the Pages app is ever deployed publicly, anyone with
   the URL can write to the CRM. Running locally (`127.0.0.1`) does not need it.
3. **A `wrangler pages dev` server may still be running on port 8788** from testing.
4. **Lead count discrepancy, unresolved.** The CRM shows 2865 total; 2426 came from this
   upload, leaving 439 unexplained — most likely pre-existing leads, but this could not be
   confirmed because the API has no read endpoint. Do not assert a cause without evidence.
5. **Duplicates were posted.** The 2426 rows contained only ~2372 unique phone numbers, so
   roughly 54 duplicate leads now exist in the CRM. The source sheet contained the
   duplicates; they were posted because the user asked for the sheet as-is.
6. **Source CSVs are gone.** `Prestige Data - Sheet1.csv`, its backup, and the split files
   `prestigedata1/2/3.csv` are no longer in `C:\Users\aclde\Downloads`. Re-export from
   Google Sheets if needed — the tool accepts the raw messy export, no pre-cleaning.

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
