#!/usr/bin/env node
/* Command-line lead pusher. No browser needed.
 *
 *   node push.js leads.csv              <- DRY RUN: checks and reports, sends nothing
 *   node push.js leads.csv --post       <- actually posts to the CRM
 *
 * Options
 *   --post              really send (without this it is always a dry run)
 *   --allow-dupes       send duplicate phone numbers too (default: skip them)
 *   --limit N           only the first N sendable rows
 *   --concurrency N     how many at once (default 6, max 12)
 *   --url URL           override the CRM endpoint
 *   --log FILE          where to write the run log (default <csv>-log.csv)
 *   --resume            skip rows already marked ok in the log file
 *   --exclude FILE      CSV of leads ALREADY in the CRM (export it from the CRM
 *                       web UI); their phone numbers are skipped. Repeatable.
 *   --key KEY           send x-access-key, for a proxy with ACCESS_KEY set
 *   --set field=value   force a field on every row, e.g. --set cProject=prestige.
 *                       Use when the sheet has no column for it. Repeatable.
 *   --yes               skip the "type yes to continue" prompt
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const L = require('./lib.js');

const DEFAULT_URL = 'https://multiclientapi.aajneetiadvertising.com/';

/* ---------- args ---------- */
const TAKES_VALUE = ['limit', 'concurrency', 'url', 'log', 'key'];
const REPEATABLE = ['exclude', 'set'];
const BOOLEANS = ['post', 'allow-dupes', 'resume', 'yes'];

const opts = {};
const loose = [];
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const needsValue = REPEATABLE.includes(name) || TAKES_VALUE.includes(name);
      if (needsValue && (i + 1 >= argv.length || String(argv[i + 1]).startsWith('--'))) {
        console.error(a + ' needs a value, e.g. ' + a + ' <value>');
        process.exit(1);
      }
      if (REPEATABLE.includes(name)) (opts[name] = opts[name] || []).push(argv[++i]);
      else if (TAKES_VALUE.includes(name)) opts[name] = argv[++i];
      else if (BOOLEANS.includes(name)) opts[name] = true;
      else { console.error('Unknown option: ' + a); process.exit(1); }
    } else {
      loose.push(a);
    }
  }
}
const flag = (n) => opts[n] === true;
const opt = (n, d) => (opts[n] === undefined ? d : opts[n]);
const file = loose[0];

if (!file) {
  console.log('Usage: node push.js <file.csv> [--post] [--allow-dupes] [--limit N]');
  console.log('       [--concurrency N] [--url URL] [--log FILE] [--resume] [--yes]');
  console.log('       [--exclude already-in-crm.csv] [--key ACCESS_KEY]');
  console.log('       [--set field=value]');
  console.log('\nWithout --post it is a dry run: it checks everything and sends nothing.');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error('No such file: ' + file);
  process.exit(1);
}

const DO_POST = flag('post');
const ALLOW_DUPES = flag('allow-dupes');
const RESUME = flag('resume');
const EXCLUDE = opts['exclude'] || [];
const SET = {};
(opts['set'] || []).forEach((pair) => {
  const i = String(pair).indexOf('=');
  const key = i === -1 ? pair : pair.slice(0, i);
  if (i === -1) { console.error('--set needs field=value, got: ' + pair); process.exit(1); }
  if (!L.FIELDS.some((f) => f.key === key)) {
    console.error('--set: no such field "' + key + '". Valid: ' +
      L.FIELDS.map((f) => f.key).join(', '));
    process.exit(1);
  }
  SET[key] = pair.slice(i + 1).trim();
});
const KEY = opt('key', '');
const URL_ = opt('url', DEFAULT_URL);
const CONC = Math.min(12, Math.max(1, Number(opt('concurrency', 6)) || 6));
const LIMIT = Number(opt('limit', 0)) || 0;
const LOGFILE = opt('log', file.replace(/\.csv$/i, '') + '-log.csv');

/* ---------- read + classify ---------- */
const rows = L.parseCSV(fs.readFileSync(file, 'utf8')).filter((r) => r.some((c) => c.trim() !== ''));
if (!rows.length) { console.error('That file has no rows.'); process.exit(1); }

const h = L.findHeaderRow(rows);
const headers = rows[h].map((c) => c.trim());
const data = rows.slice(h + 1);

/* map a CRM field to a column, by exact header then alias */
const pick = (f) => {
  const lower = headers.map((x) => x.toLowerCase());
  let i = lower.indexOf(f.label.toLowerCase());
  if (i !== -1) return i;
  for (const a of f.alias) { i = lower.indexOf(a); if (i !== -1) return i; }
  return -1;
};
const COL = {};
L.FIELDS.forEach((f) => { COL[f.key] = pick(f); });

console.log('file     : ' + path.basename(file));
console.log('header   : line ' + (h + 1) + '  (' + headers.join(', ') + ')');
console.log('mapping  : ' + L.FIELDS.map((f) =>
  f.key + ' <- ' + (COL[f.key] === -1 ? (f.fixed ? '"' + f.fixed + '"' : 'EMPTY') : headers[COL[f.key]])
).join('\n           '));

if (COL.firstName === -1 || COL.phoneNumber === -1) {
  console.error('\nCannot continue: no column matched firstName or phoneNumber.');
  process.exit(1);
}

const cell = (r, key) => {
  const i = COL[key];
  if (i === -1) {
    const f = L.FIELDS.find((x) => x.key === key);
    return f && f.fixed ? f.fixed : '';
  }
  return (r[i] || '').trim();
};

/* ---------- already in the CRM ----------
   The CRM has no read API, so the only trustworthy source for "what is
   already in there" is a CSV exported from the CRM's own web UI. */
const inCRM = new Set();
for (const f of EXCLUDE) {
  if (!fs.existsSync(f)) { console.error('--exclude file not found: ' + f); process.exit(1); }
  const before = inCRM.size;
  L.phoneSetFromCSV(fs.readFileSync(f, 'utf8')).forEach((v) => inCRM.add(v));
  console.log('exclude  : ' + (inCRM.size - before) + ' new numbers from ' + path.basename(f));
}
if (inCRM.size) console.log('exclude  : ' + inCRM.size + ' numbers already in the CRM, will be skipped');

const seen = new Map();
const send = [], rejected = [], dupes = [], skippedInCRM = [];

data.forEach((r, idx) => {
  const line = idx + 1;
  let phone = cell(r, 'phoneNumber');
  let email = cell(r, 'emailAddress');
  const notes = [];

  if (email && L.EMAIL_ISH.test(phone) && !L.EMAIL_ISH.test(email)) {
    const t = phone; phone = email; email = t;
    notes.push('phone/email swapped');
  }

  const fx = L.fixPhone(phone);
  if (fx.why) notes.push(fx.why);

  const lead = {
    firstName: cell(r, 'firstName'),
    emailAddress: email,
    phoneNumber: fx.value,
    addressCity: cell(r, 'addressCity'),
    cProject: cell(r, 'cProject'),
    cSubSource: cell(r, 'cSubSource') || 'Meta',
    cClientNomen: cell(r, 'cClientNomen'),
    cProjectNomen: cell(r, 'cProjectNomen'),
  };

  /* --set wins over the sheet, so a missing column can be filled for every row. */
  Object.keys(SET).forEach((k) => { lead[k] = SET[k]; });

  if (!fx.ok) { rejected.push({ line, phone, why: fx.why, name: lead.firstName }); return; }
  const missing = L.missingRequired(lead);
  if (missing.length) {
    rejected.push({
      line, phone, name: lead.firstName,
      why: 'missing required: ' + missing.join(', '),
    });
    return;
  }
  if (inCRM.has(fx.value)) {
    skippedInCRM.push({ line, phone: fx.value, name: lead.firstName });
    return;
  }
  if (seen.has(fx.value)) {
    dupes.push({ line, phone: fx.value, why: 'same as line ' + seen.get(fx.value), name: lead.firstName });
    if (!ALLOW_DUPES) return;
  } else {
    seen.set(fx.value, line);
  }
  send.push({ line, lead, note: notes.join('; ') });
});

/* ---------- resume ---------- */
let already = new Set();
if (RESUME && fs.existsSync(LOGFILE)) {
  L.parseCSV(fs.readFileSync(LOGFILE, 'utf8')).forEach((r) => {
    if (r[1] === 'ok') already.add(Number(r[0]));
  });
  if (already.size) console.log('resume   : skipping ' + already.size + ' rows already marked ok');
}
let queue = send.filter((p) => !already.has(p.line));
if (LIMIT) queue = queue.slice(0, LIMIT);

/* ---------- report ---------- */
console.log('\n--- check ---------------------------------------------');
console.log('  rows in file   : ' + data.length);
console.log('  will be sent   : ' + queue.length);
console.log('  duplicates     : ' + dupes.length + (ALLOW_DUPES ? ' (sending them too)' : ' (skipped)'));
if (inCRM.size) console.log('  already in CRM : ' + skippedInCRM.length + ' (skipped)');
console.log('  rejected       : ' + rejected.length);

if (rejected.length) {
  console.log('\n  rejected rows (never sent):');
  rejected.slice(0, 40).forEach((r) =>
    console.log('    line ' + String(r.line).padEnd(6) + String(r.phone).padEnd(22) + r.why));
  if (rejected.length > 40) console.log('    ... and ' + (rejected.length - 40) + ' more');
}

if (!DO_POST) {
  console.log('\nDRY RUN - nothing was sent.');
  console.log('To post for real, run the same command again with --post');
  process.exit(0);
}
if (!queue.length) { console.log('\nNothing to send.'); process.exit(0); }

/* ---------- confirm ---------- */
(async () => {
  if (!flag('yes')) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((res) => rl.question(
      '\nPost ' + queue.length + ' leads to ' + URL_ + ' ?\nThis writes to the LIVE CRM and cannot be undone. Type yes to continue: ',
      (a) => { rl.close(); res(a.trim().toLowerCase()); }));
    if (answer !== 'yes') { console.log('Cancelled - nothing sent.'); process.exit(0); }
  }

  /* ---------- post ---------- */
  const log = fs.createWriteStream(LOGFILE, { flags: 'a' });
  const esc = (s) => { s = String(s == null ? '' : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

  let done = 0, ok = 0, fail = 0, next = 0;
  const t0 = Date.now();
  let stopping = false;
  process.on('SIGINT', () => {
    if (!stopping) { stopping = true; console.log('\nStopping after the requests in flight...'); }
  });

  async function one(lead) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(URL_, {
          method: 'POST',
          headers: Object.assign(
            { 'Content-Type': 'application/json', Accept: 'application/json' },
            KEY ? { 'x-access-key': KEY } : {}),
          body: JSON.stringify(lead),
        });
        const text = (await res.text()).trim().slice(0, 120);
        if (res.status === 200) return { status: 'ok', detail: text };
        if (res.status >= 400 && res.status < 500) return { status: 'fail', detail: 'HTTP ' + res.status + ' ' + text };
        if (attempt === 3) return { status: 'fail', detail: 'HTTP ' + res.status + ' ' + text };
      } catch (e) {
        if (attempt === 3) return { status: 'fail', detail: 'network: ' + e.message };
      }
      await new Promise((r) => setTimeout(r, 700 * attempt));
    }
    return { status: 'fail', detail: 'gave up' };
  }

  async function worker() {
    while (next < queue.length && !stopping) {
      const p = queue[next++];
      const r = await one(p.lead);
      if (r.status === 'ok') ok++; else fail++;
      done++;
      log.write([p.line, r.status, esc(p.lead.phoneNumber), esc(p.lead.firstName), esc(r.detail)].join(',') + '\n');
      if (r.status !== 'ok') console.log('  FAIL line ' + p.line + ' ' + p.lead.phoneNumber + ' - ' + r.detail);
      if (done % 25 === 0 || done === queue.length) {
        const rate = done / ((Date.now() - t0) / 1000);
        const left = Math.round((queue.length - done) / (rate || 1));
        process.stdout.write('  ' + done + '/' + queue.length + '  ok=' + ok + ' fail=' + fail +
          '  ~' + left + 's left\n');
      }
    }
  }

  console.log('\nposting with ' + CONC + ' at a time, log -> ' + LOGFILE + '\n');
  await Promise.all(Array.from({ length: Math.min(CONC, queue.length) }, worker));
  log.end();

  const secs = Math.round((Date.now() - t0) / 1000);
  console.log('\n--- done ----------------------------------------------');
  console.log('  posted   : ' + ok);
  console.log('  failed   : ' + fail);
  if (stopping) console.log('  stopped early, ' + (queue.length - done) + ' not attempted');
  console.log('  time     : ' + secs + 's');
  console.log('  log      : ' + LOGFILE);
  if (fail || stopping) console.log('\n  To retry only what did not go through:\n    node push.js "' + file + '" --post --resume');
  process.exit(fail ? 1 : 0);
})();
