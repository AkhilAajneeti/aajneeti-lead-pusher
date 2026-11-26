/* Lead Pusher - CSV -> phone filter -> CRM (via the /api/lead proxy) */
'use strict';

const API = '/api/lead';

/* Pure logic (CSV parsing, phone repair, field list) lives in lib.js so it can
   be unit-tested under Node. See test.js. */
const { FIELDS, EMAIL_ISH, parseCSV, findHeaderRow, fixPhone } = LeadLib;

/* ---------- state ---------- */
const S = {
  rows: [], headers: [], map: {}, fixed: {}, prepared: [],
  filter: 'ready', running: false, stop: false, results: [], fileName: '',
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

/* =========================================================
   Step 1 - file in
   ========================================================= */
function onFile(file) {
  if (!file) return;
  S.fileName = file.name;

  const fr = new FileReader();
  fr.onload = () => {
    const all = parseCSV(fr.result).filter((r) => r.some((c) => c.trim() !== ''));
    if (!all.length) { alert('That file has no rows in it.'); return; }

    const h = findHeaderRow(all);
    S.headers = all[h].map((c) => c.trim());
    S.rows = all.slice(h + 1).map((r) => {
      const o = {};
      S.headers.forEach((k, i) => { o[k] = (r[i] || '').trim(); });
      return o;
    });

    $('#file-info').textContent = file.name + ' - ' + S.rows.length.toLocaleString()
      + ' data rows, ' + S.headers.length + ' columns (header found on line ' + (h + 1) + ')';

    buildMapping();
    $('#step-map').classList.remove('hidden');
    $('#step-map').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  fr.onerror = () => alert('Could not read that file.');
  fr.readAsText(file);
}

/* =========================================================
   Step 2 - column mapping (exact header match first, then aliases)
   ========================================================= */
function autoPick(f) {
  const lower = S.headers.map((h) => h.toLowerCase());
  let i = lower.indexOf(f.label.toLowerCase());
  if (i !== -1) return S.headers[i];
  for (const a of f.alias) {
    i = lower.indexOf(a);
    if (i !== -1) return S.headers[i];
  }
  return f.fixed ? '__fixed__' : '';
}

function buildMapping() {
  const box = $('#mapping');
  box.innerHTML = '';

  FIELDS.forEach((f) => {
    const picked = autoPick(f);
    S.map[f.key] = picked;
    S.fixed[f.key] = f.fixed || '';

    const opts = S.headers.map((h) => '<option value="' + esc(h) + '"'
      + (h === picked ? ' selected' : '') + '>' + esc(h) + '</option>').join('');

    const d = document.createElement('div');
    d.className = 'fld';
    d.innerHTML = '<label for="m-' + f.key + '"><code>' + f.label + '</code>'
      + (f.req ? ' <span class="req">*</span>' : '') + '</label>'
      + '<select id="m-' + f.key + '">'
      + '<option value="">- leave empty -</option>'
      + '<option value="__fixed__">- fixed value -</option>'
      + opts
      + '</select>'
      + '<input type="text" id="v-' + f.key + '" placeholder="value used for every row" value="'
      + esc(f.fixed || '') + '"' + (picked === '__fixed__' ? '' : ' hidden') + '>';
    box.appendChild(d);

    const sel = d.querySelector('select');
    const inp = d.querySelector('input');
    if (picked === '__fixed__') sel.value = '__fixed__';

    sel.addEventListener('change', () => {
      S.map[f.key] = sel.value;
      inp.hidden = sel.value !== '__fixed__';
    });
    inp.addEventListener('input', () => { S.fixed[f.key] = inp.value; });
  });
}

function valueOf(row, key) {
  const m = S.map[key];
  if (!m) return '';
  if (m === '__fixed__') return (S.fixed[key] || '').trim();
  return (row[m] || '').trim();
}

/* =========================================================
   Step 3 - validate and classify every row
   ========================================================= */
function prepare() {
  if (!S.map.firstName || !S.map.phoneNumber) {
    alert('Please map both firstName and phoneNumber before continuing.');
    return;
  }

  const swapOn = $('#opt-swap').checked;
  const dupeOn = $('#opt-dupes').checked;
  const seen = new Map();
  S.prepared = [];

  S.rows.forEach((row, i) => {
    let phoneRaw = valueOf(row, 'phoneNumber');
    let email = valueOf(row, 'emailAddress');

    /* The Prestige sheet had 156 rows with these two the wrong way round. */
    let swapped = false;
    if (swapOn && email && EMAIL_ISH.test(phoneRaw) && !EMAIL_ISH.test(email)) {
      const t = phoneRaw; phoneRaw = email; email = t;
      swapped = true;
    }

    const fix = fixPhone(phoneRaw);
    const lead = {
      firstName: valueOf(row, 'firstName'),
      emailAddress: email,
      phoneNumber: fix.value,
      addressCity: valueOf(row, 'addressCity'),
      cProject: valueOf(row, 'cProject'),
      cSubSource: valueOf(row, 'cSubSource') || 'Meta',
      cClientNomen: valueOf(row, 'cClientNomen'),
      cProjectNomen: valueOf(row, 'cProjectNomen'),
    };

    const notes = [];
    if (swapped) notes.push('phone and email were swapped');
    if (fix.why) notes.push(fix.why);

    let state;
    if (!fix.ok) {
      state = 'bad';
    } else if (!lead.firstName) {
      state = 'bad';
      notes.push('the name is empty');
    } else if (dupeOn && seen.has(fix.value)) {
      state = 'dupe';
      notes.push('same number as row ' + seen.get(fix.value));
    } else {
      state = notes.length ? 'fixed' : 'ready';
      seen.set(fix.value, i + 1);
    }

    S.prepared.push({
      line: i + 1, lead: lead, state: state,
      note: notes.join('; '), raw: phoneRaw, result: null,
    });
  });

  renderReview();
  $('#step-review').classList.remove('hidden');
  $('#step-review').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

const sendable = () => S.prepared.filter((p) => p.state === 'ready' || p.state === 'fixed');

const stat = (cls, v, label) => '<div class="stat ' + cls + '"><b>'
  + (typeof v === 'number' ? v.toLocaleString() : v) + '</b><span>' + label + '</span></div>';

function renderReview() {
  const n = (s) => S.prepared.filter((p) => p.state === s).length;
  const go = sendable().length;

  $('#stats').innerHTML = stat('acc', S.prepared.length, 'rows in file')
    + stat('ok', go, 'will be sent')
    + stat('warn', n('fixed'), 'repaired')
    + stat('warn', n('dupe'), 'duplicates')
    + stat('bad', n('bad'), 'rejected');

  $('#post-count').textContent = go.toLocaleString();
  $('#btn-post').disabled = go === 0;
  renderPreview();
}

function renderPreview() {
  const list = S.prepared.filter((p) => p.state === S.filter);
  const show = list.slice(0, 300);

  $('#preview tbody').innerHTML = show.map((p) => '<tr>'
    + '<td class="t-dim">' + p.line + '</td>'
    + '<td>' + esc(p.lead.firstName || '-') + '</td>'
    + '<td class="mono' + (p.state === 'bad' ? ' t-bad' : '') + '">'
    + esc(p.state === 'bad' ? p.raw : p.lead.phoneNumber) + '</td>'
    + '<td>' + esc(p.lead.emailAddress || '-') + '</td>'
    + '<td>' + esc(p.lead.addressCity || '-') + '</td>'
    + '<td class="note">' + esc(p.note || '-') + '</td>'
    + '</tr>').join('') || '<tr><td colspan="6" class="t-dim">Nothing in this group.</td></tr>';

  $('#preview-note').textContent = list.length > show.length
    ? 'Showing the first 300 of ' + list.length.toLocaleString() + '.' : '';
}

/* =========================================================
   Step 4 - post, with concurrency, retries and a stop button
   ========================================================= */
async function postOne(lead, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['x-access-key'] = key;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(API, {
        method: 'POST', headers: headers, body: JSON.stringify(lead),
      });
      let data = {};
      try { data = await res.json(); } catch (e) { /* non-JSON reply */ }

      if (res.ok && data.ok) return { status: 'ok', detail: String(data.response || 'true') };
      if (res.status === 401) {
        return { status: 'fail', detail: 'access key rejected - check ACCESS_KEY', halt: true };
      }
      if (res.status === 422) {
        return { status: 'fail', detail: data.error || 'rejected by validation' };
      }
      if (res.status >= 400 && res.status < 500) {
        return { status: 'fail', detail: 'HTTP ' + res.status + ' ' + (data.error || '') };
      }
      if (attempt === 3) {
        return { status: 'fail', detail: 'HTTP ' + res.status + ' ' + (data.error || data.response || '') };
      }
    } catch (e) {
      if (attempt === 3) return { status: 'fail', detail: 'network error: ' + e.message };
    }
    await new Promise((r) => setTimeout(r, 600 * attempt));
  }
  return { status: 'fail', detail: 'gave up after 3 tries' };
}

async function run(queue) {
  S.running = true;
  S.stop = false;

  $('#step-run').classList.remove('hidden');
  $('#btn-stop').classList.remove('hidden');
  $('#btn-stop').disabled = false;
  $('#btn-resume').classList.add('hidden');
  $('#btn-post').disabled = true;
  $('#step-run').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const key = $('#opt-key').value.trim();
  const conc = Number($('#opt-conc').value) || 6;
  const total = queue.length;
  const t0 = Date.now();
  let done = 0, ok = 0, fail = 0, halted = false;

  const tick = () => {
    $('#bar').style.width = (done / total * 100).toFixed(1) + '%';
    const left = done ? Math.round((Date.now() - t0) / done * (total - done) / 1000) : 0;
    $('#runstats').innerHTML = stat('acc', done + ' / ' + total, 'processed')
      + stat('ok', ok, 'posted')
      + stat('bad', fail, 'failed')
      + stat('warn', done && !S.stop ? left + 's' : '-', 'time left');
  };
  tick();

  const logBody = $('#log tbody');
  const logRow = (p, r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td class="t-dim">' + p.line + '</td>'
      + '<td class="' + (r.status === 'ok' ? 't-ok' : 't-bad') + '">' + r.status + '</td>'
      + '<td class="mono">' + esc(p.lead.phoneNumber) + '</td>'
      + '<td class="note">' + esc(r.detail) + '</td>';
    logBody.prepend(tr);
    while (logBody.children.length > 400) logBody.lastChild.remove();
  };

  let next = 0;
  async function worker() {
    while (next < total && !S.stop && !halted) {
      const p = queue[next++];
      const r = await postOne(p.lead, key);
      if (r.halt) { halted = true; S.stop = true; }

      p.result = r.status;
      S.results.push({
        line: p.line, status: r.status, phone: p.lead.phoneNumber,
        name: p.lead.firstName, detail: r.detail,
      });
      if (r.status === 'ok') ok++; else fail++;
      done++;
      logRow(p, r);
      if (done % 5 === 0 || done === total) tick();
    }
  }

  await Promise.all(Array.from({ length: Math.min(conc, total) }, worker));
  tick();

  S.running = false;
  $('#btn-stop').classList.add('hidden');
  $('#btn-dl-report').classList.remove('hidden');
  if (fail) $('#btn-dl-failed').classList.remove('hidden');

  const remaining = sendable().filter((p) => !p.result).length;
  if (remaining) $('#btn-resume').classList.remove('hidden');
  $('#btn-post').disabled = remaining === 0;

  if (halted) {
    alert('Stopped: the proxy rejected the access key. Fix it, then press Resume.');
  } else if (S.stop) {
    alert('Stopped. ' + ok + ' posted, ' + remaining + ' still waiting - press Resume to carry on.');
  } else {
    alert('Finished. ' + ok + ' posted, ' + fail + ' failed.');
  }
}

/* ---------- CSV download ---------- */
function download(name, rows) {
  const csv = rows.map((r) => r.map((c) => {
    const s = String(c == null ? '' : c);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');

  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

const base = () => (S.fileName || 'leads').replace(/\.csv$/i, '');

/* =========================================================
   wiring
   ========================================================= */
$('#file').addEventListener('change', (e) => onFile(e.target.files[0]));

const drop = $('#drop');
drop.addEventListener('click', () => $('#file').click());
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault();
  drop.classList.add('hot');
}));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault();
  drop.classList.remove('hot');
}));
drop.addEventListener('drop', (e) => onFile(e.dataTransfer.files[0]));

$('#opt-conc').addEventListener('input', (e) => { $('#conc-val').value = e.target.value; });
$('#btn-check').addEventListener('click', prepare);

$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.remove('is-on'));
  t.classList.add('is-on');
  S.filter = t.dataset.f;
  renderPreview();
}));

$('#btn-post').addEventListener('click', () => {
  const queue = sendable().filter((p) => !p.result);
  if (!queue.length) return;
  const msg = 'Post ' + queue.length.toLocaleString() + ' leads into the live CRM?'
    + '\n\nThis cannot be undone from this tool.';
  if (confirm(msg)) run(queue);
});

$('#btn-resume').addEventListener('click', () => {
  const queue = sendable().filter((p) => !p.result);
  if (queue.length) run(queue);
});

$('#btn-stop').addEventListener('click', () => {
  S.stop = true;
  $('#btn-stop').disabled = true;
});

$('#btn-dl-rejected').addEventListener('click', () => {
  const bad = S.prepared.filter((p) => p.state === 'bad' || p.state === 'dupe');
  if (!bad.length) { alert('Nothing was rejected - every row is good.'); return; }
  download(base() + '-rejected.csv',
    [['line', 'name', 'phone as in file', 'email', 'city', 'why']].concat(
      bad.map((p) => [p.line, p.lead.firstName, p.raw, p.lead.emailAddress, p.lead.addressCity, p.note])));
});

$('#btn-dl-report').addEventListener('click', () => {
  download(base() + '-report.csv',
    [['line', 'status', 'name', 'phone', 'detail']].concat(
      S.results.map((r) => [r.line, r.status, r.name, r.phone, r.detail])));
});

$('#btn-dl-failed').addEventListener('click', () => {
  const failed = S.results.filter((r) => r.status !== 'ok');
  download(base() + '-failed.csv',
    [['line', 'name', 'phone', 'detail']].concat(
      failed.map((r) => [r.line, r.name, r.phone, r.detail])));
});

window.addEventListener('beforeunload', (e) => {
  if (S.running) { e.preventDefault(); e.returnValue = ''; }
});

/* ---------- proxy health check ---------- */
fetch(API).then((r) => r.json()).then((d) => {
  const el = $('#health');
  el.textContent = d.keyRequired ? 'proxy ready - key required' : 'proxy ready - no key set';
  el.className = 'pill ' + (d.keyRequired ? 'pill-ok' : 'pill-bad');
  el.title = d.keyRequired
    ? 'Protected by ACCESS_KEY.'
    : 'WARNING: no ACCESS_KEY is set, so anyone with this URL can write to your CRM.';
}).catch(() => {
  const el = $('#health');
  el.textContent = 'proxy not reachable';
  el.className = 'pill pill-bad';
  el.title = 'Open this through Cloudflare Pages or "npx wrangler pages dev .", not as a plain file.';
});
