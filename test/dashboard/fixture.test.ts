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
