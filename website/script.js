/* Sync demo: two laptops, a link that can be cut, and a local queue.
   A simulation only; nothing leaves the browser. */
(function () {
  var sim = document.getElementById('sim');
  if (!sim) return;

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var logs = { A: document.getElementById('logA'), B: document.getElementById('logB') };
  var wire = sim.querySelector('.wire');
  var linkState = document.getElementById('linkState');
  var toggle = document.getElementById('toggle');
  var status = document.getElementById('simStatus');
  var online = true;
  var pending = { A: [], B: [] };

  /* Scripted updates in story order. A is Tiam, B is Namit. */
  var script = [
    { by: 'A', kind: 'Goal', text: 'Ship the notes app this week' },
    { by: 'B', kind: 'Decision', text: 'Store notes in SQLite' },
    { by: 'A', kind: 'Task', text: 'Tiam/api claimed the REST endpoints' },
    { by: 'B', kind: 'Progress', text: 'Namit/tests: list endpoint covered' },
    { by: 'B', kind: 'Question', text: 'Should the list paginate?' },
    { by: 'A', kind: 'Reply', text: 'Yes, 20 notes per page' }
  ];
  var lists = {
    A: script.filter(function (s) { return s.by === 'A'; }),
    B: script.filter(function (s) { return s.by === 'B'; })
  };
  /* The first three entries are seeded on load, so each cycle starts after them. */
  var next = { A: 2, B: 1 };

  function nextEntry(by) {
    var list = lists[by];
    return list[next[by]++ % list.length];
  }

  function add(side, entry, queued) {
    var li = document.createElement('li');
    var kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = entry.kind;
    li.className = 'by-' + entry.by.toLowerCase();
    li.appendChild(kind);
    li.appendChild(document.createTextNode(entry.text));
    if (queued) {
      var em = document.createElement('em');
      em.textContent = 'queued locally';
      li.appendChild(em);
      li.classList.add('queued');
    }
    logs[side].appendChild(li);
    while (logs[side].children.length > 6) logs[side].removeChild(logs[side].firstChild);
    return li;
  }

  function say() {
    status.textContent = online
      ? 'Connected. Updates appear on both laptops.'
      : 'Link down. Each laptop keeps its own local context. Queued: ' +
        pending.A.length + " on Tiam's laptop, " + pending.B.length +
        " on Namit's. Cloud models still need connectivity.";
  }

  function send(from) {
    var to = from === 'A' ? 'B' : 'A';
    var entry = nextEntry(from);
    if (online) {
      add(from, entry);
      add(to, entry);
    } else {
      pending[from].push({ entry: entry, li: add(from, entry, true) });
    }
    say();
  }

  function flush() {
    ['A', 'B'].forEach(function (from) {
      var to = from === 'A' ? 'B' : 'A';
      var queue = pending[from];
      pending[from] = [];
      queue.forEach(function (p, i) {
        setTimeout(function () {
          var em = p.li.querySelector('em');
          if (em) em.remove();
          p.li.classList.remove('queued');
          add(to, p.entry);
        }, reduce ? 0 : i * 350);
      });
    });
  }

  toggle.addEventListener('click', function () {
    online = !online;
    toggle.setAttribute('aria-pressed', String(!online));
    toggle.textContent = online ? 'Disconnect link' : 'Reconnect link';
    linkState.textContent = online ? 'Link connected' : 'Link down';
    wire.classList.toggle('off', !online);
    if (online) {
      flush();
      status.textContent = 'Reconnected. Missed updates are replaying in both directions.';
      setTimeout(say, 1800);
    } else {
      say();
    }
  });
  document.getElementById('sendA').addEventListener('click', function () { send('A'); });
  document.getElementById('sendB').addEventListener('click', function () { send('B'); });

  /* Seed the first three scripted updates, one after another. */
  say();
  [script[0], script[1], script[2]].forEach(function (entry, i) {
    function seed() {
      add('A', entry);
      add('B', entry);
    }
    if (reduce) seed();
    else setTimeout(seed, 300 + i * 500);
  });
})();
