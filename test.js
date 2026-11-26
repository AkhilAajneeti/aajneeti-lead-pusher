/* Headless check of lib.js — run: node test.js [path-to-csv]
   Verifies the phone repair rules against hand-picked cases, then (if a CSV is
   given) classifies the whole file so the counts can be compared with a known run. */
'use strict';

const L = require('./lib.js');
const fs = require('fs');

let pass = 0, fail = 0;

function eq(label, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  console.log('  FAIL ' + label + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want));
}

console.log('phone repair');
[
  ['p:+919582449101',    '+919582449101', 'p: prefix stripped'],
  ['919582449101',       '+919582449101', 'bare 91 + 10'],
  ['+919582449101',      '+919582449101', 'already correct'],
  ['9582449101',         '+919582449101', '10 digits, no code'],
  ['p:8368628976',       '+918368628976', 'p: + 10 digits'],
  ['p:09818158177',      '+919818158177', 'leading zero'],
  ['p:+17248753621',     '+917248753621', 'wrong +1 country code'],
  ['17042419064',        '+917042419064', 'wrong 1 prefix, no plus'],
  ['p:+91784081113566-9','+917840811135', 'junk digits after the number'],
  ['p:+91876507308719',  '+918765073087', 'too long, trimmed'],
  ['98765 43210',        '+919876543210', 'space inside the number'],
  ['Mobile - 9876543210','+919876543210', 'label prefix'],
].forEach(([raw, want, label]) => {
  const r = L.fixPhone(raw);
  eq(label + ' [' + raw + ']', r.ok ? r.value : 'REJECTED:' + r.why, want);
});

console.log('correctly rejected');
[
  ['p:1234567890',    'placeholder 1234567890'],
  ['p:0000000000',    'all zeros'],
  ['p:*798564898',    '9 digits'],
  ['965887139',       '9 digits'],
  ['p:+61403657462',  'Australia'],
  ['p:+966531957451', 'Saudi'],
  ['p:+971559433878', 'UAE'],
  ['p:+2349062837020','Nigeria'],
  ['p:+96896126485',  'Oman'],
  ['',                'empty'],
  ['n/a',             'no digits'],
].forEach(([raw, label]) => {
  const r = L.fixPhone(raw);
  eq('rejects ' + label + ' [' + raw + ']', r.ok, false);
});

console.log('csv parser');
{
  const rows = L.parseCSV('a,b,c\r\n1,"two, with comma",3\r\n4,"say ""hi""",6\r\n');
  eq('row count', rows.length, 3);
  eq('quoted comma kept', rows[1][1], 'two, with comma');
  eq('escaped quotes', rows[2][1], 'say "hi"');
  const blank = L.parseCSV(',,,,,,\nname,phoneNumber,emailAddress,City,a,b,c\nx,1,2,3,4,5,6\n');
  eq('header row after a blank row', L.findHeaderRow(blank), 1);
}

/* ---- optional: classify a whole file ---- */
const file = process.argv[2];
if (file && fs.existsSync(file)) {
  console.log('\nfile: ' + file);
  const rows = L.parseCSV(fs.readFileSync(file, 'utf8')).filter((r) => r.some((c) => c.trim() !== ''));
  const h = L.findHeaderRow(rows);
  const headers = rows[h].map((c) => c.trim());
  const data = rows.slice(h + 1);
  const col = (n) => headers.indexOf(n);
  const iPhone = col('phoneNumber'), iMail = col('emailAddress'), iName = col('name');

  const seen = new Set();
  const c = { ready: 0, repaired: 0, dupe: 0, bad: 0 };
  const rejects = [];

  data.forEach((r, i) => {
    let phone = (r[iPhone] || '').trim();
    let mail = (r[iMail] || '').trim();
    let swapped = false;
    if (mail && L.EMAIL_ISH.test(phone) && !L.EMAIL_ISH.test(mail)) {
      const t = phone; phone = mail; mail = t; swapped = true;
    }
    const fx = L.fixPhone(phone);
    if (!fx.ok || !(r[iName] || '').trim()) {
      c.bad++;
      rejects.push((i + 1) + '  ' + phone + '  ' + (fx.why || 'no name'));
    } else if (seen.has(fx.value)) {
      c.dupe++;
    } else {
      seen.add(fx.value);
      if (swapped || fx.why) c.repaired++; else c.ready++;
    }
  });

  console.log('  header line        : ' + (h + 1));
  console.log('  data rows          : ' + data.length);
  console.log('  clean              : ' + c.ready);
  console.log('  repaired           : ' + c.repaired);
  console.log('  duplicates         : ' + c.dupe);
  console.log('  rejected           : ' + c.bad);
  console.log('  WOULD SEND         : ' + (c.ready + c.repaired) + '  (+ ' + c.dupe + ' if duplicates allowed)');
  console.log('  rejected rows:');
  rejects.forEach((x) => console.log('    ' + x));
}

/* ---------- phoneSetFromCSV: the "already in the CRM" guard ---------- */
console.log('already-in-CRM set');
{
  /* A real CRM UI export, header and quoting as the CRM emits it. */
  const crmExport =
    'name,emailAddress,phoneNumber,status,cSubSource,cProject,cPreference,cNextContactAt,createdAt,assignedUserId,assignedUserName\n' +
    '"test Goel",test@hotmail.com,+919560538181,New,Meta,testignLead,,,"2026-11-26 06:22:51",6a450,"Akhil Test2"\n' +
    'testGupta,test@gmail.com,+919582449101,New,Meta,testignLead,,,"2026-11-26 06:22:51",6a450,"Akhil Test2"\n';
  const set = L.phoneSetFromCSV(crmExport);
  eq('picks up both numbers', set.size, 2);
  eq('has first', set.has('+919560538181'), true);
  eq('has second', set.has('+919582449101'), true);
  eq('no false positive', set.has('+919999999999'), false);

  /* Messy values in the export must normalise to the same key the pusher
     builds, or the guard silently lets a duplicate through. */
  const messy = 'name,phoneNumber\nA,p:9582449101\nB,919560538181\nC,p:+17248753621\n';
  const m = L.phoneSetFromCSV(messy);
  eq('normalises p: prefix', m.has('+919582449101'), true);
  eq('normalises bare 91', m.has('+919560538181'), true);
  eq('normalises wrong +1', m.has('+917248753621'), true);

  /* Foreign and junk numbers are not valid keys; they must not enter the set. */
  const bad = 'name,phoneNumber\nA,+971559433878\nB,1234567890\nC,\nD,965887139\n';
  eq('foreign/junk excluded', L.phoneSetFromCSV(bad).size, 0);

  /* An export with an unrecognised phone header still contributes, by scan. */
  const odd = 'lead,mobile no\nA,+919560538181\n';
  eq('unknown header still scanned', L.phoneSetFromCSV(odd).has('+919560538181'), true);

  eq('empty input is safe', L.phoneSetFromCSV('').size, 0);
  eq('header only is safe', L.phoneSetFromCSV('name,phoneNumber\n').size, 0);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
