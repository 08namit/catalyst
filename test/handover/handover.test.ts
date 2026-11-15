import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectPaths } from '../../src/core/paths.js';
import { HANDOVER_BEGIN, HANDOVER_END, renderHandoverBlock, updateHandoverFile } from '../../src/handover/important.js';
import { renderSnapshot, writeSnapshot } from '../../src/handover/snapshot.js';
import { decision, makePair, sync, syncSummary, tempDir } from '../store/helpers.js';

function populated() {
  const { a, b } = makePair();
  a.append({ type: 'goal.set', payload: { title: 'Ship v1', successCriteria: ['e2e passes'] }, origin: 'agent' });
  a.append({ type: 'task.claimed', payload: { taskId: 'api', scope: 'server' }, origin: 'agent' });
  a.append({
    type: 'progress.reported',
    payload: { taskId: 'api', status: 'in_progress', summary: 'routes | done', evidence: ['npm test: 12 passed'], nextSteps: ['add auth'], branch: 'feat/api', commit: 'abc1234' },
    origin: 'agent',
  });
  b.append(decision('db/engine', 'Engine', 'sqlite'));
  a.append(decision('db/engine', 'Engine', 'postgres'));
  b.append(decision('api/format', 'Format', 'JSON <!-- catalyst:handover:end --> injected'));
  b.append({ type: 'issue.reported', payload: { kind: 'bug', title: 'Crash on empty body', taskId: 'api' }, origin: 'agent' });
  b.append({ type: 'message.posted', payload: { kind: 'question', body: 'Which port?' }, origin: 'agent' });
  b.append({ type: 'activity.captured', payload: { kind: 'commit', summary: 'c', commits: [{ hash: 'def5678', message: 'fix crash' }] }, origin: 'hook' });
  sync(a, b);
  sync(b, a);
  return { a, b };
}

describe('IMPORTANT.md handover', () => {
  it('renders identically on two replicas with the same events', () => {
    const { a, b } = populated();
    const ta = renderHandoverBlock(a.getState());
    expect(ta).toBe(renderHandoverBlock(b.getState()));
    expect(ta.startsWith(HANDOVER_BEGIN)).toBe(true);
    expect(ta.endsWith(HANDOVER_END)).toBe(true);
    // the injected end marker in peer text is neutralised
    expect(ta.split(HANDOVER_END)).toHaveLength(2);
    expect(ta).toMatch(/Last material update: .* by (Tiam|Namit) \(event `[0-9a-f]{8}`\)/);
    expect(ta).toMatch(/Ship v1/);
    expect(ta).toMatch(/routes \\\| done/);
    expect(ta).toMatch(/⚠ Open conflicts/);
    expect(ta).toMatch(/sqlite/);
    expect(ta).toMatch(/postgres/);
    expect(ta).toMatch(/Crash on empty body/);
    expect(ta).toMatch(/Which port\?/);
    expect(ta).toMatch(/npm test: 12 passed/);
    expect(ta).toMatch(/branch `feat\/api` commit `abc1234`/);
    expect(ta).toMatch(/commit `def5678` fix crash/);
    expect(ta).toMatch(/add auth/);
    expect(ta).toMatch(/get_briefing/);
  });

  it('shows agents and queue fields, identically on both replicas', () => {
    const { a, b } = populated();
    const api = 'a7a6a241124692d30';
    a.append({ type: 'agent.registered', payload: { agent: api, name: 'api', agentType: 'general-purpose' }, origin: 'system', agent: api });
    a.append({ type: 'agent.registered', payload: { agent: 'b1c2d3e4f5a6b7c8d', name: 'gone', active: false }, origin: 'system', agent: 'b1c2d3e4f5a6b7c8d' });
    a.append({ type: 'task.created', payload: { taskId: 'core', title: 'Core', order: 0 }, origin: 'agent' });
    a.append({ type: 'task.created', payload: { taskId: 'ui', title: 'UI', dependsOn: ['core'], assignee: b.me, order: 1 }, origin: 'agent' });
    a.append({ type: 'task.claimed', payload: { taskId: 'core', scope: 'core lib' }, origin: 'agent', agent: api });
    sync(a, b);
    sync(b, a);
    const ta = renderHandoverBlock(a.getState());
    expect(ta).toBe(renderHandoverBlock(b.getState()));
    const agentLines: Record<string, string[]> = {
      Tiam: ['- Tiam (lead) — working on `api`', '- Tiam / api (general-purpose) — working on `core`'],
      Namit: ['- Namit (lead)'],
    };
    const expected = ['### Agents', ...a.getState().participants.flatMap((p) => agentLines[p.name]!), '- 1 finished agent(s) not shown.'].join('\n');
    expect(ta).toContain(expected);
    expect(ta).toMatch(/\| Task \| Owner\(s\) \| Status \| Depends on \| Latest \| By \|/);
    expect(ta).toMatch(/\| `core` Core \| Tiam \/ api \| claimed \| — \|/);
    expect(ta).toMatch(/\| `ui` UI \(for Namit\) \| — \| unclaimed · blocked \| `core` \|/);
    expect(renderSnapshot(a.getState(), syncSummary('connected'), '2026-11-14T12:00:00.000Z')).toMatch(/- Claim `core` \(Tiam \/ api\): core lib/);
  });

  it('creates the file, preserves manual text, and rewrites only on change', () => {
    const { a } = populated();
    const path = join(tempDir(), 'IMPORTANT.md');
    const first = updateHandoverFile(path, a.getState());
    expect(first.changed).toBe(true);
    expect(first.content).toMatch(/^# IMPORTANT/);
    expect(first.content).toMatch(/## Manual notes/);

    const manualTop = '# My project\r\n\nHand-written intro.\n\n';
    const manualBottom = '\n\n## Notes\nKeep me   exactly.\n';
    const block = first.content.slice(first.content.indexOf(HANDOVER_BEGIN), first.content.indexOf(HANDOVER_END) + HANDOVER_END.length);
    writeFileSync(path, manualTop + block + manualBottom);
    const mtime = statSync(path).mtimeMs;
    const same = updateHandoverFile(path, a.getState());
    expect(same.changed).toBe(false);
    expect(statSync(path).mtimeMs).toBe(mtime);

    a.append({ type: 'goal.set', payload: { title: 'Ship v2' }, origin: 'agent' });
    const changed = updateHandoverFile(path, a.getState());
    expect(changed.changed).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text.startsWith(manualTop)).toBe(true);
    expect(text.endsWith(manualBottom)).toBe(true);
    expect(text).toMatch(/Ship v2/);
    expect(readdirSync(join(path, '..')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('regenerates a block containing git conflict markers', () => {
    const { a } = populated();
    const path = join(tempDir(), 'IMPORTANT.md');
    const block = renderHandoverBlock(a.getState());
    const conflicted =
      '# Title\n\nintro\n\n' +
      HANDOVER_BEGIN +
      '\n<<<<<<< HEAD\nLast material update: mine\n=======\nLast material update: theirs\n>>>>>>> other\n' +
      HANDOVER_END +
      '\n\n## Manual notes\nkeep\n';
    writeFileSync(path, conflicted);
    const r = updateHandoverFile(path, a.getState());
    expect(r.changed).toBe(true);
    expect(r.content).toBe('# Title\n\nintro\n\n' + block + '\n\n## Manual notes\nkeep\n');
    expect(r.content).not.toMatch(/<<<<<<<|>>>>>>>/);
  });

  it('inserts a block into an existing file without markers', () => {
    const { a } = populated();
    const path = join(tempDir(), 'IMPORTANT.md');
    writeFileSync(path, '# Handover\nexisting notes\n');
    const r = updateHandoverFile(path, a.getState());
    expect(r.content.startsWith('# Handover\n\n' + HANDOVER_BEGIN)).toBe(true);
    expect(r.content.endsWith('existing notes\n')).toBe(true);
  });
});

describe('snapshot', () => {
  it('writes snapshot.md and snapshot.json atomically with generatedAt and fallback instructions', () => {
    const { a } = populated();
    const paths = projectPaths(tempDir());
    const generatedAt = '2026-11-14T12:00:00.000Z';
    const sync = syncSummary('unreachable');
    writeSnapshot(paths, a.getState(), sync, generatedAt);
    const md = readFileSync(paths.snapshotMd, 'utf8');
    expect(md).toMatch(`Generated at ${generatedAt} — this is a read-only fallback snapshot`);
    expect(md).toMatch(/unreachable since/);
    expect(md).toMatch(/2 local update\(s\) pending delivery/);
    expect(md).toMatch(/\.catalyst\/inbox\/<uuid>\.json/);
    expect(md).toMatch(/"catalystDraft": 1/);
    expect(md).not.toMatch(/catalyst:handover:begin/);
    const json = JSON.parse(readFileSync(paths.snapshotJson, 'utf8'));
    expect(json.generatedAt).toBe(generatedAt);
    expect(json.state.eventCount).toBe(a.getState().eventCount);
    expect(json.sync.peers[0].state).toBe('unreachable');
    expect(readdirSync(paths.dataDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(existsSync(paths.snapshotMd)).toBe(true);
    expect(renderSnapshot(a.getState(), sync, generatedAt)).toBe(md);
  });
});
