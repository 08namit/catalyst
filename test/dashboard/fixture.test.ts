import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DashboardState } from '../../src/core/api.js';

const staticDir = fileURLToPath(new URL('../../src/dashboard/static/', import.meta.url));
const read = (name: string) => readFileSync(staticDir + name, 'utf8');

describe('dashboard fixture', () => {
  const fixture = JSON.parse(read('fixture-state.json')) as DashboardState;

  it('is explicitly marked as simulated data', () => {
    expect(fixture.fixture).toBe(true);
  });

  it('has every DashboardState top-level key', () => {
    const keys: Array<keyof DashboardState> = ['generatedAt', 'health', 'state', 'sync', 'sessions', 'outbound', 'recent', 'fixture'];
    expect(Object.keys(fixture).sort()).toEqual([...keys].sort());
  });

  it('covers the scenarios the dashboard must render', () => {
    expect(fixture.state.participants).toHaveLength(2);
    expect(fixture.state.decisions.some((t) => t.conflict && t.heads.length > 1)).toBe(true);
    expect(fixture.state.questions.some((q) => q.answered && q.replies.length > 0)).toBe(true);
    expect(fixture.sync.peers.some((p) => p.state === 'unreachable')).toBe(true);
    const stages = fixture.outbound.map(({ delivery: d }) =>
      d.acknowledgedBy.length ? 'acknowledged' : d.retrievedBy.length ? 'retrieved' : d.deliveredTo.length ? 'delivered' : 'saved');
    expect(new Set(stages)).toEqual(new Set(['saved', 'delivered', 'retrieved', 'acknowledged']));
  });

  it('has every ProjectState key (v0.2: agents, agentAcknowledgements)', () => {
    const keys: Array<keyof DashboardState['state']> = [
      'project', 'me', 'participants', 'agents', 'goal', 'tasks', 'decisions', 'conflicts', 'questions', 'notifications', 'issues',
      'generalProgress', 'activity', 'acknowledgements', 'agentAcknowledgements', 'forks', 'lastMaterial', 'eventCount', 'opaqueCount',
    ];
    expect(Object.keys(fixture.state).sort()).toEqual([...keys].sort());
  });

  it('covers named agents: subagents of both people, one finished, live claims', () => {
    const { agents, participants } = fixture.state;
    for (const p of participants) expect(agents.some((a) => a.participant === p.id && a.agent === 'lead')).toBe(true);
    expect(agents.some((a) => a.agent !== 'lead' && a.active && a.claims.length > 0)).toBe(true);
    expect(agents.some((a) => !a.active)).toBe(true);
    for (const a of agents) {
      expect(a.address).toBe(`${a.participant}/${a.agent}`);
      expect(a.displayName).toBe(a.agent === 'lead' ? a.participantName : `${a.participantName} / ${a.name}`);
    }
  });

  it('covers the task queue: order, dependencies, assignee, ready, per-agent owners', () => {
    const { tasks, agents } = fixture.state;
    for (const t of tasks) {
      expect(typeof t.order).toBe('number');
      expect(Array.isArray(t.dependsOn)).toBe(true);
      expect(typeof t.ready).toBe('boolean');
      expect(t.assignee === 'any' || /^p_[0-9a-f]{24}$/.test(t.assignee)).toBe(true);
      expect(t.ownerKeys).toEqual([...new Set(t.claims.map((c) => c.ownerKey))]);
      for (const c of t.claims) {
        expect(c.ownerKey).toBe(`${c.owner}/${c.ownerAgent}`);
        expect(agents.some((a) => a.address === c.ownerKey)).toBe(true);
      }
    }
    expect(tasks.some((t) => !t.ready && t.dependsOn.length > 0)).toBe(true);
    expect(tasks.some((t) => t.claimConflict && t.ownerKeys.length > 1)).toBe(true);
  });

  it('every source reference carries agent and agentName', () => {
    const refs: Array<{ agent?: string; agentName?: string; authorName: string }> = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (typeof o.id === 'string' && typeof o.author === 'string' && 'authorName' in o && 'seq' in o) refs.push(o as never);
        Object.values(o).forEach(walk);
      }
    };
    walk(fixture);
    expect(refs.length).toBeGreaterThan(20);
    for (const r of refs) {
      expect(typeof r.agent).toBe('string');
      if (r.agent === 'lead') expect(r.agentName).toBe(r.authorName);
      else expect(r.agentName?.startsWith(`${r.authorName} / `)).toBe(true);
    }
  });
});

describe('dashboard app.js', () => {
  const app = read('app.js');

  it('renders Agents and Queue panels and names agents, not just people', () => {
    expect(app).toMatch(/function secAgents\(/);
    expect(app).toMatch(/function secQueue\(/);
    expect(app).toMatch(/secAgents\(\), secQueue\(\)/);
    expect(app).toMatch(/agentName/);
  });

  it('never uses innerHTML', () => {
    expect(app).not.toMatch(/\.(innerHTML|outerHTML|insertAdjacentHTML)\b/);
  });
});

describe('dashboard index.html is CSP-compatible (default-src self)', () => {
  const html = read('index.html');

  it('has no inline script code', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\bsrc=/);
      expect(body?.trim()).toBe('');
    }
  });

  it('has no inline event handlers or style attributes', () => {
    expect(html).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/<[^>]+\sstyle\s*=/i);
    expect(html).not.toMatch(/<style\b/i);
  });
});
