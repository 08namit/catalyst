// Catalyst dashboard: plain ES module, no build step, served from the daemon on 127.0.0.1 under
// CSP `default-src 'self'`. Every piece of data is rendered through textContent / text nodes, never innerHTML.

const POLL_MS = 3000;
const TOKEN_KEY = 'catalyst.dashboard.token';
const fixtureMode = new URLSearchParams(location.search).get('fixture') === '1';

const $main = document.getElementById('main');
const $banners = document.getElementById('banners');
const $meta = document.getElementById('meta');
const $title = document.getElementById('project-name');

/** @type {any} last DashboardState received */
let data = null;
let lastOkAt = 0;
/** @type {{kind: 'down'|'auth'|'http', message: string} | null} */
let failure = null;
let timer = 0;
const openKeys = new Set(); // <details data-key> elements the user expanded; survives re-renders

const ORIGIN_LABEL = {
  agent: 'agent-authored',
  hook: 'auto-captured',
  fallback: 'imported from fallback file',
  human: 'human (CLI)',
  system: 'system',
};
const PEER_TONE = { connected: 'ok', connecting: 'warn', unreachable: 'bad', paused: 'warn', never_connected: 'muted' };
const STATUS_TONE = {
  done: 'ok', in_progress: 'info', in_review: 'info', blocked: 'bad', abandoned: 'muted',
  not_started: 'muted', unclaimed: 'muted', claimed: 'info',
};

// ---------------------------------------------------------------------------
// Token: taken from the URL fragment once, kept in sessionStorage, stripped from the address bar.
// ---------------------------------------------------------------------------
function readToken() {
  const m = /(?:^#|&)token=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (m) {
    try { sessionStorage.setItem(TOKEN_KEY, m[1]); } catch { /* storage blocked: keep it in memory only */ }
    history.replaceState(null, '', location.pathname + location.search);
    return m[1];
  }
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
const token = fixtureMode ? null : readToken();

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
/** Create an element. Strings in `kids` become text nodes, so data can never become markup. */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}
const badge = (text, tone = 'muted') => h('span', { class: `badge tone-${tone}` }, text);
const mono = (text) => h('code', null, text);
const empty = (text) => h('p', { class: 'empty' }, text);
const shortId = (id) => (id ? String(id).slice(0, 8) : '');
/** Table cell whose content sits in one wrapper, so the narrow-screen label/value grid stays two columns. */
const td = (label, ...kids) => h('td', { 'data-label': label }, h('div', null, ...kids));

function now() {
  // Fixture timestamps are frozen; measure them against the fixture's own generation time.
  return fixtureMode && data ? Date.parse(data.generatedAt) : Date.now();
}

function relTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const s = Math.round((now() - t) / 1000);
  const a = Math.abs(s);
  let txt;
  if (a < 10) return 'just now';
  if (a < 60) txt = `${a} s`;
  else if (a < 3600) txt = `${Math.round(a / 60)} min`;
  else if (a < 86400) txt = `${Math.round(a / 3600)} h`;
  else txt = `${Math.round(a / 86400)} d`;
  return s >= 0 ? `${txt} ago` : `in ${txt}`;
}
/** <time> with a relative label and the absolute local time on hover. */
function ago(iso, fallback = 'never') {
  if (!iso) return h('span', { class: 'muted' }, fallback);
  const d = new Date(iso);
  return h('time', { datetime: iso, title: Number.isNaN(d.getTime()) ? iso : d.toLocaleString() }, relTime(iso));
}

function nameOf(id) {
  if (!id || id === 'all') return 'everyone';
  const p = data?.state?.participants?.find((x) => x.id === id) ?? data?.sync?.peers?.find((x) => x.participant === id);
  return p ? p.name : shortId(id);
}
const byLine = (ref) => h('span', { class: 'by' }, ref.authorName || nameOf(ref.author), ' · ', ago(ref.ts));

function section(id, title, count, { wide = false, tone = '', note = null } = {}, ...body) {
  return h('section', { class: `card${wide ? ' wide' : ''}${tone ? ` card-${tone}` : ''}`, id, 'aria-labelledby': `${id}-h` },
    h('header', { class: 'card-h' },
      h('h2', { id: `${id}-h` }, title),
      count != null ? h('span', { class: 'count' }, String(count)) : null,
      note ? h('span', { class: 'card-note' }, note) : null),
    ...body);
}

function details(key, summary, ...body) {
  const el = h('details', { 'data-key': key, open: openKeys.has(key) }, h('summary', null, summary), ...body);
  el.addEventListener('toggle', () => (el.open ? openKeys.add(key) : openKeys.delete(key)));
  return el;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------
function renderHeader() {
  const { health, state, generatedAt } = data;
  const project = state.project?.name ?? 'Unnamed project';
  $title.textContent = project;
  document.title = `${project} · Catalyst`;
  const me = state.participants.find((p) => p.isMe);
  const item = (k, ...v) => [h('dt', null, k), h('dd', null, ...v)];
  $meta.replaceChildren(...[
    item('you', me?.name ?? health.name),
    item('daemon', `pid ${health.pid} · v${health.version} · protocol ${health.protocol}`),
    item('ports', `api ${health.apiPort} · peer ${health.peerPort}`),
    item('events', String(state.eventCount)),
    item('generated', ago(generatedAt)),
  ].flat());
}

function secConnection() {
  const { sync, state } = data;
  const peers = sync.peers.map((p) => h('div', { class: 'peer' },
    h('div', { class: 'peer-h' },
      h('strong', null, p.name),
      badge(p.state.replace('_', ' '), PEER_TONE[p.state] ?? 'muted'),
      p.since ? h('span', { class: 'muted' }, 'since ', ago(p.since)) : null),
    h('dl', { class: 'kv' },
      h('dt', null, 'Last sync'), h('dd', null, ago(p.lastSyncAt)),
      h('dt', null, 'Pending outbound'), h('dd', { class: p.pendingOutbound ? 'warn' : '' }, String(p.pendingOutbound)),
      h('dt', null, 'Addresses'), h('dd', null, p.addrs.length ? p.addrs.map((a) => mono(a)) : h('span', { class: 'muted' }, 'none known')),
      p.confirmCode ? [h('dt', null, 'Confirm code'), h('dd', null, mono(p.confirmCode))] : null,
      p.lastError ? [h('dt', null, 'Last error'), h('dd', { class: 'bad' }, p.lastError)] : null)));
  const forks = state.forks.map((f) => h('p', { class: 'alert tone-bad' },
    `Fork alarm: ${nameOf(f.author)} published ${f.eventIds.length} different events with seq ${f.seq} (detected `, ago(f.detectedAt), ').'));
  return section('connection', 'Connection & freshness', null, { wide: true },
    h('p', { class: 'freshness' }, sync.freshness),
    h('ul', { class: 'facts' },
      h('li', null, sync.paused ? badge('networking paused', 'warn') : badge('networking on', 'ok')),
      h('li', null, 'Pending outbound ', h('strong', null, String(sync.pendingOutbound))),
      h('li', null, 'Parked (waiting for missing earlier events) ', h('strong', { class: sync.parkedEvents ? 'warn' : '' }, String(sync.parkedEvents))),
      h('li', null, 'Peer port ', mono(String(sync.peerPort)))),
    forks,
    sync.peers.length ? h('div', { class: 'peers' }, peers)
      : empty('Not paired yet. Run `catalyst pair` here, then `catalyst join <invite>` on the other laptop.'),
    h('p', { class: 'note' }, 'A connection heartbeat is not proof an agent is actively working.'));
}

function secConflicts() {
  const list = data.state.conflicts;
  return section('conflicts', 'Unresolved conflicts', list.length, { tone: list.length ? 'bad' : '' },
    list.length ? h('ul', { class: 'list' }, list.map((c) => h('li', null,
      h('div', { class: 'row' }, badge('CONFLICT', 'bad'), badge(c.scope, 'muted'), mono(c.key)),
      h('ul', { class: 'heads-list' }, c.heads.map((hd) => h('li', null,
        h('strong', null, hd.authorName), ': ', hd.summary, ' ', h('span', { class: 'muted' }, '· ', ago(hd.ts), ' · ', mono(shortId(hd.id)))))),
      h('p', { class: 'hint' }, c.hint))))
      : empty('No unresolved conflicts.'));
}

function secGoal() {
  const { goal, participants } = data.state;
  const goalBlock = (g) => h('div', { class: 'goal' },
    h('h3', null, g.title),
    g.description ? h('p', null, g.description) : null,
    g.successCriteria.length ? h('ul', { class: 'criteria' }, g.successCriteria.map((c) => h('li', null, c))) : null,
    h('p', { class: 'meta-line' }, 'Set by ', byLine(g)));
  return section('goal', 'Shared goal & participants', null, {},
    goal.conflict ? [h('p', null, badge('CONFLICT', 'bad'), ' Competing goals:'), h('div', { class: 'heads' }, goal.heads.map(goalBlock))]
      : goal.current ? goalBlock(goal.current)
        : empty('No shared goal yet. An agent can set one with the set_goal tool.'),
    h('h3', { class: 'sub' }, 'Participants'),
    h('ul', { class: 'people' }, participants.map((p) => h('li', null,
      h('strong', null, p.name), p.isMe ? badge('you', 'info') : null,
      p.role ? h('span', { class: 'muted' }, p.role) : null,
      h('span', { class: 'muted' }, 'joined ', ago(p.joinedAt)),
      mono(p.id)))));
}

function secTasks() {
  const tasks = data.state.tasks;
  return section('tasks', 'Tasks', tasks.length, { wide: true },
    tasks.length ? h('div', { class: 'tasks' }, tasks.map((t) => {
      const latest = t.latestProgress[t.latestProgress.length - 1];
      return h('article', { class: 'task' },
        h('div', { class: 'row' },
          h('strong', null, t.title), mono(t.taskId),
          badge(t.status.replace('_', ' '), STATUS_TONE[t.status] ?? 'info'),
          t.claimConflict ? badge('CLAIM CONFLICT', 'bad') : null),
        h('p', { class: 'meta-line' }, 'Owners: ', t.owners.length ? t.owners.map(nameOf).join(', ') : h('span', { class: 'muted' }, 'unclaimed')),
        t.claimConflict ? h('ul', { class: 'heads-list' }, t.claims.map((c) => h('li', null, h('strong', null, c.ownerName), ' claimed: ', c.scope, ' ', h('span', { class: 'muted' }, '· ', ago(c.ts))))) : null,
        latest ? h('p', { class: 'progress' }, h('span', { class: 'muted' }, 'Latest: '), latest.summary, ' ', h('span', { class: 'muted' }, '— ', byLine(latest))) : null,
        latest?.evidence.length ? h('p', { class: 'meta-line' }, 'Evidence: ', latest.evidence.join('; ')) : null,
        t.openBlockers.length ? h('ul', { class: 'blockers' }, t.openBlockers.map((b) => h('li', null, b))) : null);
    })) : empty('No tasks yet. Agents create them with claim_task.'));
}

function decisionCard(d, isHead) {
  return h('div', { class: `decision${isHead ? '' : ' superseded'}` },
    h('div', { class: 'row' }, h('strong', null, d.title), badge(d.status, d.status === 'proposed' ? 'warn' : 'ok'), isHead ? null : badge('superseded', 'muted')),
    h('p', null, d.decision),
    d.rationale ? h('p', { class: 'muted' }, 'Why: ', d.rationale) : null,
    d.codeRefs.length ? h('p', { class: 'meta-line' }, 'Code: ', d.codeRefs.map((c) => mono(c))) : null,
    h('p', { class: 'meta-line' }, byLine(d), ' · ', mono(shortId(d.id))));
}

function secDecisions() {
  const topics = data.state.decisions;
  return section('decisions', 'Decisions', topics.length, { wide: true },
    topics.length ? h('div', { class: 'topics' }, topics.map((t) => {
      const headIds = new Set(t.heads.map((x) => x.id));
      return h('article', { class: `topic${t.conflict ? ' topic-conflict' : ''}` },
        h('div', { class: 'row' }, mono(t.topic), t.conflict ? badge('CONFLICT', 'bad') : null,
          t.conflict ? h('span', { class: 'muted' }, `${t.heads.length} competing versions`) : null),
        h('div', { class: t.conflict ? 'heads' : '' }, t.heads.map((d) => decisionCard(d, true))),
        t.history.length > 1 ? details(`topic:${t.topic}`, `History (${t.history.length} versions)`,
          h('div', { class: 'history' }, t.history.map((d) => decisionCard(d, headIds.has(d.id))))) : null);
    })) : empty('No decisions recorded yet.'));
}

function message(m) {
  return h('div', { class: 'msg' },
    h('p', { class: 'meta-line' }, h('strong', null, m.authorName), ' → ', nameOf(m.to), ' · ', ago(m.ts),
      m.refs?.topic ? [' · ', mono(m.refs.topic)] : null, m.refs?.task ? [' · ', mono(m.refs.task)] : null,
      m.origin !== 'agent' ? [' ', badge(ORIGIN_LABEL[m.origin] ?? m.origin, 'muted')] : null),
    h('p', null, m.body));
}

function secMessages() {
  const { questions, notifications } = data.state;
  const open = questions.filter((q) => !q.answered).length;
  return section('messages', 'Questions & replies', questions.length, { note: open ? `${open} unanswered` : null },
    questions.length ? h('ul', { class: 'list' }, questions.map((q) => h('li', null,
      h('div', { class: 'row' }, q.answered ? badge('answered', 'ok') : badge('unanswered', 'warn')),
      message(q),
      q.replies.length ? h('div', { class: 'replies' }, q.replies.map(message)) : null)))
      : empty('No questions yet.'),
    h('h3', { class: 'sub' }, `Notifications (${notifications.length})`),
    notifications.length ? h('ul', { class: 'list' }, notifications.map((n) => h('li', null, message(n)))) : empty('None.'));
}

function secIssues() {
  const issues = [...data.state.issues].sort((a, b) => (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1));
  const open = issues.filter((i) => i.status === 'open').length;
  const tone = { bug: 'bad', blocker: 'bad', risk: 'warn' };
  return section('issues', 'Bugs, blockers & risks', issues.length, { note: `${open} open` },
    issues.length ? h('ul', { class: 'list' }, issues.map((i) => h('li', { class: i.status === 'resolved' ? 'resolved' : '' },
      h('div', { class: 'row' }, badge(i.kind, tone[i.kind]), badge(i.status, i.status === 'open' ? 'warn' : 'ok'), h('strong', null, i.title),
        i.taskId ? mono(i.taskId) : null),
      i.detail ? h('p', null, i.detail) : null,
      h('p', { class: 'meta-line' }, 'Reported by ', byLine(i)),
      i.resolution ? h('p', { class: 'meta-line' }, 'Resolved by ', byLine(i.resolution), i.resolution.note ? `: ${i.resolution.note}` : '') : null)))
      : empty('No issues reported.'));
}

function stage(list, emptyText) {
  if (!list.length) return h('span', { class: 'stage-no' }, emptyText);
  return list.map((x) => h('span', { class: 'stage-yes' }, '✓ ', nameOf(x.participant), ' · ', ago(x.at)));
}

function secOutbound() {
  const rows = data.outbound;
  const peersKnown = data.sync.peers.length > 0;
  return section('outbound', 'Outbound delivery', rows.length, { wide: true, note: 'events you authored, newest first' },
    h('p', { class: 'note' }, 'Four separate stages: saved in your local log → delivered to the peer daemon → retrieved by a peer agent (briefing/updates) → explicitly acknowledged.'),
    rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'outbound' },
      h('thead', null, h('tr', null, ['Event', 'Saved locally', 'Delivered', 'Retrieved by peer agent', 'Acknowledged'].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', null, rows.map((r) => {
        const d = r.delivery;
        return h('tr', null,
          td('Event', h('div', { class: 'row' }, badge(r.type, 'muted'), h('span', { class: 'origin' }, ORIGIN_LABEL[r.origin] ?? r.origin)), h('div', null, r.summary)),
          td('Saved locally', h('span', { class: 'stage-yes' }, '✓ ', ago(r.ts))),
          td('Delivered', stage(d.deliveredTo, peersKnown ? 'not yet delivered' : 'no peer paired')),
          td('Retrieved', stage(d.retrievedBy, d.deliveredTo.length ? 'not yet retrieved' : '—')),
          td('Acknowledged', stage(d.acknowledgedBy, d.deliveredTo.length ? 'not yet acknowledged' : '—')));
      }))))
      : empty('You have not published anything yet.'));
}

function secActivity() {
  const items = data.recent;
  return section('activity', 'Activity', items.length, { wide: true, note: 'most recent 100 events, all authors' },
    items.length ? h('ol', { class: 'feed' }, items.map((e) => h('li', null,
      h('span', { class: 'feed-time' }, ago(e.ts)),
      h('span', { class: 'feed-who' }, e.authorName),
      badge(ORIGIN_LABEL[e.origin] ?? e.origin, e.origin === 'hook' ? 'info' : e.origin === 'fallback' ? 'warn' : 'muted'),
      h('span', { class: 'feed-type' }, e.type),
      h('span', { class: 'feed-sum' }, e.summary))))
      : empty('No events yet.'));
}

function sessionTable(list) {
  if (!list.length) return empty('No sessions seen.');
  return h('div', { class: 'table-wrap' }, h('table', { class: 'sessions' },
    h('thead', null, h('tr', null, ['Session', 'Kind', 'Linked to', 'Claude pid', 'Last seen', 'Last context retrieval'].map((c) => h('th', { scope: 'col' }, c)))),
    h('tbody', null, list.map((s) => h('tr', null,
      td('Session', mono(s.id.length > 24 ? `${s.id.slice(0, 24)}…` : s.id)),
      td('Kind', s.kind),
      td('Linked to', s.linkedSession ? mono(shortId(s.linkedSession)) : h('span', { class: 'muted' }, '—')),
      td('Claude pid', s.claudePid ? String(s.claudePid) : h('span', { class: 'muted' }, '—')),
      td('Last seen', ago(s.lastSeenAt)),
      td('Last retrieval', ago(s.lastRetrievalAt)))))));
}

function secSessions() {
  return section('sessions', 'Sessions', null, { wide: true },
    h('h3', { class: 'sub' }, 'This machine'),
    sessionTable(data.sessions),
    data.sync.peers.map((p) => [
      h('h3', { class: 'sub' }, `${p.name}'s machine `, h('span', { class: 'muted' }, '(as last reported by the peer)')),
      sessionTable(p.sessions)]));
}

// ---------------------------------------------------------------------------
// Banners and render loop
// ---------------------------------------------------------------------------
function renderBanners() {
  const out = [];
  if (fixtureMode || data?.fixture) {
    out.push(h('div', { class: 'banner banner-fixture', role: 'status' }, h('strong', null, 'FIXTURE / SIMULATED DATA — not live'),
      fixtureMode ? ' Loaded from fixture-state.json; nothing here came from a daemon.' : ' This project was seeded with CATALYST_FIXTURE=1.'));
  }
  if (failure) {
    const age = lastOkAt ? [' Showing data from ', h('strong', null, relTimeMs(Date.now() - lastOkAt)), ' (greyed out).'] : null;
    if (failure.kind === 'auth') {
      out.push(h('div', { class: 'banner banner-bad', role: 'alert' },
        h('strong', null, 'Token rejected. '), 'The daemon rotates its token on every start. Re-open the dashboard with ', mono('catalyst dashboard'), '.', age));
    } else {
      out.push(h('div', { class: 'banner banner-bad', role: 'alert' },
        h('strong', null, 'Daemon unreachable'), ' — coordination still works through MCP/hooks when the daemon restarts; the dashboard is optional. ',
        h('span', { class: 'muted' }, `(${failure.message})`), age));
    }
  }
  $banners.replaceChildren(...out);
}
function relTimeMs(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

function render() {
  renderBanners();
  if (!data) return;
  renderHeader();
  $main.classList.toggle('stale', Boolean(failure));
  $main.setAttribute('aria-busy', 'false');
  $main.replaceChildren(
    secConnection(), secConflicts(), secGoal(), secTasks(), secDecisions(),
    secMessages(), secIssues(), secOutbound(), secActivity(), secSessions());
}

async function errorMessage(res) {
  try { const body = await res.json(); return body?.error?.message ?? `HTTP ${res.status}`; } catch { return `HTTP ${res.status}`; }
}

async function load() {
  try {
    const res = fixtureMode
      ? await fetch('fixture-state.json', { cache: 'no-store' })
      : await fetch('/api/state', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (res.status === 401 || res.status === 403) {
      failure = { kind: 'auth', message: await errorMessage(res) };
      clearInterval(timer); // a rotated token never becomes valid again
    } else if (!res.ok) {
      failure = { kind: 'http', message: await errorMessage(res) };
    } else {
      data = await res.json();
      lastOkAt = Date.now();
      failure = null;
    }
  } catch (err) {
    failure = { kind: 'down', message: err instanceof Error ? err.message : String(err) };
  }
  if (!data && failure) $main.replaceChildren(h('p', { class: 'panel' }, 'No data received from the daemon yet.'));
  render();
}

function start() {
  if (!fixtureMode && !token) {
    $main.replaceChildren(h('div', { class: 'panel' },
      h('h2', null, 'No access token'),
      h('p', null, 'Open the dashboard with ', mono('catalyst dashboard'), ' (it passes a one-time token in the URL fragment).'),
      h('p', { class: 'muted' }, 'To preview the layout with simulated data, open ', h('a', { href: '?fixture=1' }, '?fixture=1'), '.')));
    return;
  }
  load();
  if (!fixtureMode) timer = setInterval(load, POLL_MS);
}

start();
