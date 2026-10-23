(function () {
  var menu = document.getElementById('menu'), side = document.getElementById('side');
  if (menu) menu.addEventListener('click', function () { var o = side.classList.toggle('open'); menu.setAttribute('aria-expanded', String(o)); });
  var q = document.getElementById('q'), box = document.getElementById('results'), idx = null;
  if (!q) return;
  function load() { return idx ? Promise.resolve(idx) : fetch('search-index.json').then(function (r) { return r.json(); }).then(function (j) { idx = j; return j; }); }
  function run() {
    var words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) { box.hidden = true; return; }
    load().then(function (list) {
      var hits = list.map(function (p) {
        var t = (p.title + ' ' + p.text).toLowerCase(), score = 0;
        for (var i = 0; i < words.length; i++) { var w = words[i]; if (t.indexOf(w) < 0) return null; score += p.title.toLowerCase().indexOf(w) >= 0 ? 10 : 1; }
        var at = t.indexOf(words[0]); return { p: p, score: score, snip: p.text.slice(Math.max(0, at - p.title.length - 50), at - p.title.length + 90) };
      }).filter(Boolean).sort(function (a, b) { return b.score - a.score; }).slice(0, 8);
      box.innerHTML = '';
      if (!hits.length) { var li = document.createElement('li'); li.textContent = 'Nothing found. Try a simpler word.'; li.style.padding = '.5rem .8rem'; box.appendChild(li); }
      hits.forEach(function (h) {
        var li = document.createElement('li'), a = document.createElement('a'), s = document.createElement('small');
        a.href = h.p.slug + '.html'; a.textContent = h.p.title; s.textContent = h.p.group + (h.snip ? ' · …' + h.snip + '…' : ''); a.appendChild(s); li.appendChild(a); box.appendChild(li);
      });
      box.hidden = false;
    });
  }
  q.addEventListener('input', run);
  q.addEventListener('keydown', function (e) { if (e.key === 'Escape') { box.hidden = true; q.blur(); } });
  document.addEventListener('click', function (e) { if (!document.getElementById('search').contains(e.target)) box.hidden = true; });
})();
