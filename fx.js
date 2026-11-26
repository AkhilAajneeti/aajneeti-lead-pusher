/* Visual feedback only. Nothing here affects what is posted.
 *
 * app.js owns the whole flow and knows nothing about this file. Rather than
 * add hooks to it, this watches the DOM it already changes:
 *
 *   posting starts/ends -> #btn-stop gains or loses .hidden
 *   progress            -> #bar style.width
 *   a lead came back    -> a <tr> is appended to #log tbody, with .t-ok or .t-bad
 *   counters changed    -> #runstats / #stats innerHTML is replaced
 *
 * If this file fails to load the tool still works; it just looks static.
 */
'use strict';

(function () {
  var $ = function (s) { return document.querySelector(s); };
  var reduced = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 1. working state ----------
     While posting, the body carries .is-working and the posting card gets the
     rotating gradient border. */
  var stop = $('#btn-stop');
  var runCard = $('#step-run');
  var working = false;

  function setWorking(on) {
    if (on === working) return;
    working = on;
    document.body.classList.toggle('is-working', on);
    if (runCard) {
      runCard.classList.toggle('working', on);
      runCard.classList.toggle('done', !on && started);
    }
    if (live) live.textContent = on ? 'posting' : (started ? 'finished' : 'idle');
  }

  var started = false;
  if (stop) {
    new MutationObserver(function () {
      var on = !stop.classList.contains('hidden');
      if (on) started = true;
      setWorking(on);
    }).observe(stop, { attributes: true, attributeFilter: ['class'] });
  }

  /* ---------- 2. live badge ----------
     Injected rather than put in index.html, so the markup app.js reads stays
     exactly as it was. */
  var live = null;
  (function () {
    if (!runCard) return;
    var head = runCard.querySelector('.card-h > div');
    if (!head) return;
    var b = document.createElement('span');
    b.className = 'live';
    b.id = 'fx-live';
    b.innerHTML = '<i class="live-dot"></i><span id="fx-live-t">idle</span>';
    head.appendChild(b);
    live = b.querySelector('#fx-live-t');
  }());

  /* ---------- 3. progress ----------
     Mirror the bar's own width into a variable the glow can read, so the
     shimmer sits at the leading edge. */
  var bar = $('#bar');
  if (bar) {
    new MutationObserver(function () {
      var w = parseFloat(bar.style.width) || 0;
      bar.parentElement.style.setProperty('--pct', w);
      /* Only touch the class when it actually has to change. classList.add
         writes the class attribute even when the token is already there, and
         that queues another record; without the guard this callback could
         feed itself. attributeFilter already screens class out, so this is
         belt and braces, but a runaway here would hang the tab. */
      var full = w >= 99.9;
      if (full !== bar.classList.contains('full')) bar.classList.toggle('full', full);
    }).observe(bar, { attributes: true, attributeFilter: ['style'] });
  }

  /* ---------- 4. each lead landing ----------
     app.js appends one row per result. Flash it by state, and throw a spark on
     the badge for a success. Cheap: one class add per row, CSS does the rest. */
  var tbody = document.querySelector('#log tbody');
  if (tbody && !reduced) {
    new MutationObserver(function (recs) {
      for (var i = 0; i < recs.length; i++) {
        var added = recs[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var tr = added[j];
          if (!tr || tr.nodeType !== 1 || tr.tagName !== 'TR') continue;
          var ok = !!tr.querySelector('.t-ok');
          tr.classList.add('fx-in', ok ? 'fx-ok' : 'fx-bad');
          if (ok) ping();
        }
      }
    }).observe(tbody, { childList: true });
  }

  var pingT = 0;
  function ping() {
    var b = document.getElementById('fx-live');
    if (!b) return;
    /* Throttle: at 12 concurrent posts this can fire very fast. */
    var now = Date.now();
    if (now - pingT < 90) return;
    pingT = now;
    b.classList.remove('ping');
    void b.offsetWidth;
    b.classList.add('ping');
  }

  /* ---------- 5. counters ----------
     The stat tiles are rebuilt as HTML strings, so watch the container and
     pop whichever numbers changed. */
  [['#runstats'], ['#stats']].forEach(function (sel) {
    var box = $(sel[0]);
    if (!box || reduced) return;
    var last = {};
    new MutationObserver(function () {
      box.querySelectorAll('.stat').forEach(function (s, i) {
        var v = s.querySelector('b');
        if (!v) return;
        var key = sel[0] + i;
        if (last[key] !== undefined && last[key] !== v.textContent) {
          s.classList.remove('pop');
          void s.offsetWidth;
          s.classList.add('pop');
        }
        last[key] = v.textContent;
      });
    }).observe(box, { childList: true, subtree: true, characterData: true });
  });

  /* ---------- 6. scroll the newest log row into view ----------
     Only while the user has not scrolled up to read something. */
  var wrap = document.querySelector('.tablewrap-log');
  if (wrap && tbody) {
    var pinned = true;
    wrap.addEventListener('scroll', function () {
      pinned = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 40;
    });
    new MutationObserver(function () {
      if (pinned) wrap.scrollTop = wrap.scrollHeight;
    }).observe(tbody, { childList: true });
  }
}());
