/* Pure logic, shared by the browser app and by test.js under Node.
   No DOM in here on purpose, so it can be tested headlessly. */
(function (root) {
  'use strict';

  /* ---------- the 8 fields the CRM accepts ---------- */
  const FIELDS = [
    { key: 'firstName',     label: 'firstName',     req: true,  alias: ['name', 'firstname', 'first name', 'full name', 'lead name', 'customer name', 'client name'] },
    { key: 'phoneNumber',   label: 'phoneNumber',   req: true,  alias: ['phonenumber', 'phone', 'phone number', 'mobile', 'mobile number', 'contact', 'contact number', 'number'] },
    { key: 'emailAddress',  label: 'emailAddress',  req: false, alias: ['emailaddress', 'email', 'email address', 'mail', 'e-mail'] },
    { key: 'addressCity',   label: 'addressCity',   req: false, alias: ['city', 'addresscity', 'town', 'location', 'address city'] },
    { key: 'cProject',      label: 'cProject',      req: true,  alias: ['cproject', 'project'] },
    { key: 'cProjectNomen', label: 'cProjectNomen', req: true,  alias: ['projectnomen', 'cprojectnomen', 'project nomen'] },
    { key: 'cClientNomen',  label: 'cClientNomen',  req: true,  alias: ['cclientnomen', 'clientnomen', 'client', 'client nomen'] },
    { key: 'cSubSource',    label: 'cSubSource',    req: false, alias: ['csubsource', 'subsource', 'source'], fixed: 'Meta' },
  ];

  const EMAIL_ISH = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  /* Country codes we must NOT rewrite into +91 - these are real foreign numbers. */
  const FOREIGN_CC = {
    '966': 'Saudi Arabia', '971': 'UAE', '968': 'Oman', '974': 'Qatar',
    '973': 'Bahrain', '965': 'Kuwait', '234': 'Nigeria', '61': 'Australia',
    '44': 'UK', '65': 'Singapore', '60': 'Malaysia', '977': 'Nepal',
    '880': 'Bangladesh', '92': 'Pakistan', '94': 'Sri Lanka', '27': 'South Africa',
  };

  /* =========================================================
     CSV parsing - quotes, embedded commas/newlines, BOM, CRLF
     ========================================================= */
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    const rows = [];
    let row = [], cell = '', inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; }
          else inQuotes = false;
        } else {
          cell += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(cell); cell = '';
      } else if (c === '\n') {
        row.push(cell); rows.push(row); row = []; cell = '';
      } else if (c !== '\r') {
        cell += c;
      }
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  /* The first row that looks like headers rather than data.
     (The Prestige sheet starts with an empty row - this skips it.) */
  function findHeaderRow(rows) {
    const known = new Set(FIELDS.reduce(
      (acc, f) => acc.concat(f.label.toLowerCase(), f.alias), []));
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const cells = rows[i].map((c) => c.trim().toLowerCase()).filter(Boolean);
      if (cells.length < 2) continue;
      if (cells.some((c) => known.has(c))) return i;
    }
    return Math.max(0, rows.findIndex((r) => r.some((c) => c.trim() !== '')));
  }

  /* =========================================================
     Phone repair - the whole point of this tool
     ========================================================= */
  function fixPhone(raw) {
    const original = String(raw == null ? '' : raw).trim();
    if (!original) return { ok: false, value: '', why: 'no phone number' };

    /* "p:+919582449101", "ph: 98...", "Mobile - 98..." */
    const stripped = original.replace(/^\s*(p|ph|phone|mob|mobile|tel|no)\s*[:\-.]?\s*/i, '');
    let d = stripped.replace(/\D/g, '');
    if (!d) return { ok: false, value: original, why: 'no digits in the value' };

    let note = '';

    if (d.indexOf('91') === 0 && d.length >= 12) {
      if (d.length > 12) note = 'trimmed extra digits after +91';
      d = d.slice(2, 12);
    } else if (d.length === 10) {
      note = 'added +91';
    } else if (d.length === 11 && d[0] === '0') {
      d = d.slice(1);
      note = 'dropped the leading 0';
    } else if (d.length === 11 && d[0] === '1') {
      /* Common in this data: +1 pasted instead of +91 on an Indian mobile. */
      d = d.slice(1);
      note = 'wrong +1 country code, read as Indian';
    } else {
      for (const cc in FOREIGN_CC) {
        if (d.indexOf(cc) === 0 && d.length >= cc.length + 8) {
          return {
            ok: false,
            value: '+' + d,
            why: 'foreign number (' + FOREIGN_CC[cc] + ') - the CRM only takes +91',
          };
        }
      }
    }

    if (!/^[6-9]\d{9}$/.test(d)) {
      const why = d.length < 10 ? 'only ' + d.length + ' digits - incomplete'
        : d.length > 10 ? d.length + ' digits - too long'
        : 'does not start with 6, 7, 8 or 9';
      return { ok: false, value: original, why: why };
    }
    return { ok: true, value: '+91' + d, why: note };
  }

  /* =========================================================
     Which required fields is this lead missing?

     cProject, cProjectNomen and cClientNomen say which client and which
     project a lead belongs to. A lead that reaches the CRM without them
     cannot be routed to anyone, so they are required, not decorative.
     phoneNumber is listed required too, but fixPhone judges it first and
     reports a better reason, so callers check that before calling this.

     Returns an array of field labels, empty when the lead is complete.
     ========================================================= */
  function missingRequired(lead) {
    return FIELDS
      .filter(function (f) { return f.req; })
      .filter(function (f) {
        const v = lead == null ? '' : lead[f.key];
        return String(v == null ? '' : v).trim() === '';
      })
      .map(function (f) { return f.label; });
  }

  /* =========================================================
     Build a set of phone numbers that are ALREADY in the CRM.

     The CRM has no GET endpoint, but its web UI exports leads as CSV
     (name,emailAddress,phoneNumber,status,...). Feeding that export back in
     is the only way to avoid re-posting leads that are already there.

     Returns a Set of '+91XXXXXXXXXX' strings. Anything unparseable is
     ignored rather than guessed at.
     ========================================================= */
  function phoneSetFromCSV(text) {
    const out = new Set();
    const rows = parseCSV(text);
    if (!rows.length) return out;

    const h = findHeaderRow(rows);
    const phoneField = FIELDS.find((f) => f.key === 'phoneNumber');
    const names = [phoneField.label.toLowerCase()].concat(phoneField.alias);

    let col = -1;
    const header = (rows[h] || []).map((c) => c.trim().toLowerCase());
    for (let i = 0; i < header.length; i++) {
      if (names.indexOf(header[i]) !== -1) { col = i; break; }
    }

    for (let i = h + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row.some((c) => c.trim() !== '')) continue;
      /* Known column when we found one; otherwise scan every cell, so an
         export with an unfamiliar header still contributes. */
      const cells = col === -1 ? row : [row[col]];
      for (let j = 0; j < cells.length; j++) {
        const fx = fixPhone(cells[j]);
        if (fx.ok) { out.add(fx.value); if (col !== -1) break; }
      }
    }
    return out;
  }

  const api = {
    FIELDS: FIELDS,
    missingRequired: missingRequired,
    phoneSetFromCSV: phoneSetFromCSV,
    FOREIGN_CC: FOREIGN_CC,
    EMAIL_ISH: EMAIL_ISH,
    parseCSV: parseCSV,
    findHeaderRow: findHeaderRow,
    fixPhone: fixPhone,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LeadLib = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
