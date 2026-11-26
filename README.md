# Aajneeti Lead Pusher

Upload a CSV of leads → it repairs and filters the phone numbers → press **Post** and
they go into the CRM. Runs as a static page plus one Cloudflare Pages Function.

Independent of the portfolio repo — this is its own project.

---

## Why the proxy exists (don't remove it)

The CRM endpoint `https://multiclientapi.aajneetiadvertising.com/`:

- sends **no CORS headers**, and
- answers an `OPTIONS` preflight with **HTTP 400**.

A browser therefore **cannot** POST JSON to it directly — the request is blocked before
it leaves the page. That is why posting from a plain frontend never worked.

`functions/api/lead.js` runs on Cloudflare's edge, so the browser only talks to your own
origin (`/api/lead`, same-origin, no CORS) and the edge talks to the CRM server-to-server.
It also sidesteps Cloudflare's bot challenge, which rejected non-browser clients.

```
browser ──POST /api/lead──> Pages Function ──POST──> multiclientapi…
         (same origin)        (server-side)
```

---

## Deploy to Cloudflare Pages

### Option A — Git (recommended)

1. Push this folder to a GitHub repo.
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
3. Pick the repo and set:
   - **Framework preset:** `None`
   - **Build command:** *(leave empty)*
   - **Build output directory:** `/`
4. **Save and Deploy.**

### Option B — straight from your machine

```bash
npx wrangler pages deploy .
```

### Then set the access key (do this)

**Settings → Environment variables → Add variable**

| Name | Value |
|---|---|
| `ACCESS_KEY` | any long random string |

Without it, **anyone who finds your URL can write leads into your CRM.** With it set, the
page asks for the key and the header badge turns green. Optionally add `UPSTREAM_URL` to
point at a different CRM endpoint.

> Note: changing environment variables requires a redeploy to take effect.

---

## Run it locally

Double-click **`start-tool.bat`**, or:

```bash
npx wrangler pages dev .      # http://localhost:8788
```

Opening `index.html` as a `file://` page will **not** work — there is no `/api/lead` then.
The badge in the top right will say "proxy not reachable".

---

## Command line, no browser (`push.js`)

For bulk runs this is the quickest route. It needs no proxy and no Cloudflare — Node
reaches the CRM directly (CORS only restricts browsers).

**Easiest:** drag a CSV onto **`push.bat`**. It shows a report, then asks before posting.

**Or from cmd:**

```bat
node push.js "C:\path\to\leads.csv"           :: DRY RUN - checks, sends nothing
node push.js "C:\path\to\leads.csv" --post    :: posts, after you type yes
```

| Option | What it does |
|---|---|
| `--post` | actually send; without it you always get a dry run |
| `--allow-dupes` | send duplicate phone numbers too (default: skip) |
| `--limit N` | only the first N sendable rows — good for a 1-row test |
| `--concurrency N` | how many at once, 1–12 (default 6) |
| `--resume` | skip rows already logged as `ok`, to retry a part-finished run |
| `--yes` | skip the confirmation prompt (for scheduled runs) |
| `--url URL` | post somewhere else |
| `--log FILE` | log location (default `<csv>-log.csv`) |

Safety built in: it is a dry run unless you pass `--post`, it then asks you to type `yes`,
`Ctrl+C` stops it cleanly, and every row is logged so `--resume` never double-posts.

**A sensible first run:**

```bat
node push.js "leads.csv"                      :: see the report
node push.js "leads.csv" --post --limit 1     :: send ONE, check the CRM
node push.js "leads.csv" --post --resume      :: send the rest
```

---

## How to use it

1. **Choose your CSV.** Headers are auto-detected; a leading blank row is skipped.
2. **Match your columns.** Auto-mapped from the header names. Any field can be set to
   *fixed value* to send the same text on every row (handy for `cClientNomen`).
3. **Check the numbers.** Four tabs: Ready, Repaired, Duplicates, Rejected. Download the
   rejected rows as CSV before posting if you want to fix them by hand.
4. **Post.** Live progress, time remaining, and a per-row log. **Stop** halts it;
   **Resume** continues with only what hasn't been sent, so nothing is posted twice.
   Afterwards download a full report or just the failed rows.

---

## The phone rules

A row is sent only if the number ends up as `+91` followed by 10 digits starting 6–9.

**Repaired automatically**

| In the file | Sent as | |
|---|---|---|
| `p:+919582449101` | `+919582449101` | `p:` / `ph:` / `Mobile -` prefixes stripped |
| `9582449101` | `+919582449101` | `+91` added |
| `09818158177` | `+919818158177` | leading `0` dropped |
| `p:+17248753621` | `+917248753621` | wrong `+1` instead of `+91` |
| `+91784081113566-9` | `+917840811135` | trailing junk trimmed |
| `98765 43210` | `+919876543210` | spaces and dashes removed |
| email in the phone column | — | phone and email swapped back |

**Rejected, never sent**

| Example | Why |
|---|---|
| `1234567890`, `0000000000` | placeholder junk |
| `965887139` | fewer than 10 digits |
| `+971559433878`, `+966531957451`, `+61403657462` | genuine foreign numbers — the CRM only takes `+91`, and coercing them would corrupt real data |

Duplicate phone numbers are flagged and skipped by default (first occurrence is kept);
untick the option if you want every copy posted.

---

## Tests

```bash
node test.js                 # 27 unit tests on the phone + CSV logic
node test.js sample.csv      # also classify a file and print the breakdown
```

`sample.csv` reproduces every mess found in the real Prestige export.
All the shared logic is in `lib.js`, which has no DOM in it so it can be tested headlessly.

---

## Files

| File | Purpose |
|---|---|
| `index.html` | the four-step UI |
| `styles.css` | styling |
| `lib.js` | CSV parser, phone repair, field list — pure, testable |
| `app.js` | mapping, validation, the posting engine |
| `functions/api/lead.js` | Cloudflare Pages Function: auth, validation, forwards to CRM |
| `test.js` | headless tests |
| `sample.csv` | messy fixture |
| `push.js` | command-line poster, no browser needed |
| `push.bat` | drag a CSV onto this to check then post |
| `start-tool.bat` | double-click to start the web tool |

---

## Good to know

- The CRM **does not de-duplicate**. Posting the same file twice creates duplicate leads.
  The Resume button protects you inside one run, not across reloads.
- The browser also validates, but `functions/api/lead.js` re-validates server-side, so a
  bad number can't reach the CRM even if the page is bypassed.
- Default concurrency is 6 at a time; ~2,400 leads takes about 6 minutes. The slider goes
  to 12 — raise it only if the CRM keeps up.
- The CRM replies with the literal body `true` on success.
