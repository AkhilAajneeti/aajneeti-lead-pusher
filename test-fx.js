/* Headless check of fx.js - run: node test-fx.js
 *
 * fx.js is the only file here that needs a DOM, so it cannot be tested the way
 * lib.js is. Rather than pull in a browser, this provides the small part of the
 * DOM it touches: elements, classList, the few selectors it asks for, and a
 * MutationObserver that is asynchronous and batched like the real one.
 *
 * It is a stand-in, not a browser. It proves the state machine - when the
 * working classes go on and off, how each result row is classified, that a
 * burst of rows is handled - and it does NOT prove anything about how the page
 * looks. Two faithfulness details matter and are modelled on purpose:
 *
 *   - observer callbacks run on a microtask, not synchronously, so a callback
 *     that mutates the DOM cannot recurse without bound;
 *   - attributeFilter is honoured, and classList.add writes the class
 *     attribute even when the token is already present.
 *
 * That second pair is what caught the #bar callback feeding itself and hanging
 * the tab. If you change fx.js and this file goes quiet or loops, suspect the
 * stub before you suspect the browser.
 */
'use strict';
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function eq(label, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  console.log('  FAIL ' + label + '\n       got  ' + JSON.stringify(got) +
              '\n       want ' + JSON.stringify(want));
}

/* ---------- tiny DOM ---------- */
const observers = [];

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); this.el._attr(); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); this.el._attr(); }
  contains(c) { return this.set.has(c); }
  toggle(c, on) {
    const want = on === undefined ? !this.set.has(c) : !!on;
    if (want) this.set.add(c); else this.set.delete(c);
    this.el._attr();
    return want;
  }
  toString() { return [...this.set].join(' '); }
}

class El {
  constructor(tag, opts = {}) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentElement = null;
    this.id = opts.id || '';
    this.classList = new ClassList(this);
    if (opts.cls) opts.cls.split(' ').forEach((c) => this.classList.set.add(c));
    this.style = { setProperty: (k, v) => { this.style[k] = v; } };
    this._setW = (w) => { this.style.width = w; this._attr('style'); };
    this._text = '';
    this.offsetWidth = 1;
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this._char(); }
  set innerHTML(v) {
    this._html = v;
    this.children = [];
    /* Only the one shape fx.js builds. */
    if (/live-dot/.test(v)) {
      const i = new El('i', { cls: 'live-dot' });
      const s = new El('span', { id: 'fx-live-t' });
      s._text = (v.match(/>([^<]*)<\/span>/) || [, ''])[1];
      this.appendChild(i); this.appendChild(s);
    }
  }
  appendChild(c) { c.parentElement = this; this.children.push(c); this._childList(c); return c; }
  querySelector(sel) { return this._find(sel)[0] || null; }
  querySelectorAll(sel) { return this._find(sel); }
  _find(sel) {
    const out = [];
    const want = (el) => {
      /* compound selectors first: they also start with '.' or '#' */
      if (sel === '.card-h > div') return el.tagName === 'DIV' && el.parentElement &&
        el.parentElement.classList.contains('card-h');
      if (sel === '#stepper .sp') return el.classList.contains('sp');
      if (sel.startsWith('#')) return el.id === sel.slice(1);
      if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
      return el.tagName === sel.toUpperCase();
    };
    const walk = (el) => el.children.forEach((c) => { if (want(c)) out.push(c); walk(c); });
    walk(this);
    return out;
  }
  _notify(type, arg) {
    const hit = [];
    observers.forEach((o) => {
      if (o.target === this) {
        if (type === 'attributes' && !o.opts.attributes) return;
        if (type === 'attributes' && o.opts.attributeFilter &&
            o.opts.attributeFilter.indexOf(arg && arg.attr) === -1) return;
        if (type === 'childList' && !o.opts.childList) return;
        if (type === 'characterData' && !o.opts.characterData) return;
        hit.push(o);
        return;
      }
      /* subtree watchers on an ancestor. A real MutationObserver still only
         reports the types it asked for, so filter here too — without this the
         stat-pulse callback would retrigger itself forever. */
      if (!o.opts.subtree) return;
      if (type === 'attributes' && !o.opts.attributes) return;
      if (type === 'childList' && !o.opts.childList) return;
      if (type === 'characterData' && !o.opts.characterData) return;
      let p = this.parentElement;
      while (p) { if (p === o.target) { hit.push(o); return; } p = p.parentElement; }
    });
    hit.forEach((o) => queue(o, type === 'childList' ? { addedNodes: [arg] } : {}));
  }
  _attr(attr) { this._notify('attributes', { attr: attr || 'class' }); }
  _childList(c) { this._notify('childList', c); }
  _char() { this._notify('characterData'); }
  addEventListener() {}
}

/* One pending batch per observer, delivered on a microtask. */
const pending = new Map();
let scheduled = false;
function queue(o, rec) {
  if (!pending.has(o)) pending.set(o, []);
  pending.get(o).push(rec);
  if (scheduled) return;
  scheduled = true;
  Promise.resolve().then(() => {
    scheduled = false;
    const batch = [...pending.entries()];
    pending.clear();
    global.__fires = (global.__fires || 0) + batch.length;
    if (global.__fires > 3000) {
      const tally = {};
      batch.forEach(([o]) => { tally[o.tag] = (tally[o.tag] || 0) + 1; });
      console.log('RUNAWAY. this batch:', JSON.stringify(tally, null, 1));
      process.exit(2);
    }
    batch.forEach(([obs, recs]) => obs.cb(recs));
  });
}
const tick = () => new Promise((r) => setTimeout(r, 0));

class MutationObserverStub {
  constructor(cb) { this.cb = cb; }
  observe(target, opts) {
    const id = observers.length;
    observers.push({ target, opts: opts || {}, cb: this.cb, id,
      tag: (target.id || target.tagName) + ':' + JSON.stringify(opts || {}) });
  }
  disconnect() {}
}

/* ---------- build the bits of index.html fx.js touches ---------- */
const doc = new El('html');
const body = new El('body');
doc.appendChild(body);

const stop = new El('button', { id: 'btn-stop', cls: 'hidden' });
const stepRun = new El('section', { id: 'step-run', cls: 'card' });
const cardH = new El('div', { cls: 'card-h' });
const headInner = new El('div');
cardH.appendChild(headInner);
stepRun.appendChild(cardH);

const progress = new El('div', { cls: 'progress' });
const bar = new El('div', { id: 'bar' });
progress.appendChild(bar);
stepRun.appendChild(progress);

const runstats = new El('div', { id: 'runstats' });
const stats = new El('div', { id: 'stats' });
const wrap = new El('div', { cls: 'tablewrap tablewrap-log' });
const table = new El('table', { id: 'log' });
const tbody = new El('tbody');
table.appendChild(tbody);
wrap.appendChild(table);

/* the other three steps, hidden at load exactly as index.html has them */
const stepUpload = new El('section', { id: 'step-upload', cls: 'card' });
const stepMap = new El('section', { id: 'step-map', cls: 'card hidden' });
const stepReview = new El('section', { id: 'step-review', cls: 'card hidden' });
stepRun.classList.add('hidden');

const stepper = new El('ol', { id: 'stepper' });
const pips = [0, 1, 2, 3].map(() => stepper.appendChild(new El('li', { cls: 'sp' })));
pips[0].classList.add('is-on');

body.appendChild(stepper);
body.appendChild(stepUpload);
body.appendChild(stepMap);
body.appendChild(stepReview);
body.appendChild(stop);
body.appendChild(stepRun);
stepRun.appendChild(runstats);
body.appendChild(stats);
stepRun.appendChild(wrap);

global.document = {
  body,
  querySelector: (s) => (s === '#log tbody' ? tbody : doc.querySelector(s)),
  querySelectorAll: (s) => doc.querySelectorAll(s),
  getElementById: (id) => doc.querySelector('#' + id),
  createElement: (t) => new El(t),
};
global.MutationObserver = MutationObserverStub;
global.window = { matchMedia: () => ({ matches: false }) };

/* ---------- run fx.js ---------- */
const src = fs.readFileSync(path.join(process.argv[2] || __dirname, 'fx.js'), 'utf8');
new Function(src)();


(async function () {
  console.log('fx.js behaviour');
  await tick();

  /* ---- which step is live ---- */
  eq('step 1 active at load', stepUpload.classList.contains('active'), true);
  eq('hidden steps not active', stepMap.classList.contains('active'), false);
  eq('run card not active at load', stepRun.classList.contains('active'), false);
  eq('pip 1 on at load', pips[0].classList.contains('is-on'), true);

  /* app.js reveals step 2 */
  stepMap.classList.remove('hidden');
  await tick();
  eq('active moved to step 2', stepMap.classList.contains('active'), true);
  eq('step 1 no longer active', stepUpload.classList.contains('active'), false);
  eq('pip 1 now done', pips[0].classList.contains('is-done'), true);
  eq('pip 2 now on', pips[1].classList.contains('is-on'), true);

  /* and step 3, then step 4 */
  stepReview.classList.remove('hidden');
  await tick();
  eq('active moved to step 3', stepReview.classList.contains('active'), true);
  stepRun.classList.remove('hidden');
  await tick();
  eq('active moved to step 4', stepRun.classList.contains('active'), true);
  eq('pip 4 on', pips[3].classList.contains('is-on'), true);
  eq('pips 1-3 done', pips.slice(0, 3).every((p) => p.classList.contains('is-done')), true);

  /* writing .active onto an observed element must settle, not feed itself */
  const before = global.__fires || 0;
  await tick(); await tick(); await tick();
  eq('step sync settles', (global.__fires || 0) - before < 12, true);

  /* badge injected into the posting heading */
  const badge = doc.querySelector('#fx-live');
  const txt = () => doc.querySelector('#fx-live-t').textContent;
  eq('live badge injected', !!badge, true);
  eq('badge starts idle', txt(), 'idle');

  /* idle: no working classes */
  eq('body not working at load', body.classList.contains('is-working'), false);
  eq('card not working at load', stepRun.classList.contains('working'), false);
  eq('card not done at load', stepRun.classList.contains('done'), false);

  /* posting starts: app.js removes .hidden from #btn-stop */
  stop.classList.remove('hidden');
  await tick();
  eq('body marked working', body.classList.contains('is-working'), true);
  eq('card marked working', stepRun.classList.contains('working'), true);
  eq('badge says posting', txt(), 'posting');

  /* progress mirrored onto the container for the glow */
  bar._setW('42.5%');
  await tick();
  eq('percent mirrored', progress.style['--pct'], 42.5);
  eq('not full yet', bar.classList.contains('full'), false);

  /* results landing */
  function row(ok) {
    const tr = new El('tr');
    tr.appendChild(new El('td', { cls: ok ? 't-ok' : 't-bad' }));
    tbody.appendChild(tr);
    return tr;
  }
  const r1 = row(true);
  const r2 = row(false);
  await tick();
  eq('ok row animated in', r1.classList.contains('fx-in'), true);
  eq('ok row flagged ok', r1.classList.contains('fx-ok'), true);
  eq('ok row not flagged bad', r1.classList.contains('fx-bad'), false);
  eq('failed row flagged bad', r2.classList.contains('fx-bad'), true);
  eq('failed row not flagged ok', r2.classList.contains('fx-ok'), false);

  /* a burst of rows must not throw and must all be classified */
  const burst = [];
  for (let i = 0; i < 200; i++) burst.push(row(i % 7 !== 0));
  await tick();
  eq('burst all classified', burst.every((t) => t.classList.contains('fx-in')), true);
  eq('burst ok/bad split', burst.filter((t) => t.classList.contains('fx-bad')).length, 29);

  /* bar reaching the end */
  bar._setW('100.0%');
  await tick();
  eq('full at 100%', bar.classList.contains('full'), true);

  /* posting ends: app.js adds .hidden back */
  stop.classList.add('hidden');
  await tick();
  eq('working cleared', body.classList.contains('is-working'), false);
  eq('card no longer working', stepRun.classList.contains('working'), false);
  eq('card marked done', stepRun.classList.contains('done'), true);
  eq('badge says finished', txt(), 'finished');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}());
