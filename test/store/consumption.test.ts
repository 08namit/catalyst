// Regressions from the adversarial review: consumption accounting must only reflect what a session was shown.
import { describe, expect, it } from 'vitest';
import { acknowledge, getUpdates } from '../../src/store/index.js';
import { makePair, sync, syncSummary } from './helpers.js';

describe('consumption accounting', () => {
  it('pages get_updates by the text budget and never skips records that were not rendered', () => {
    const { a, b } = makePair();
    const progressIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      progressIds.push(b.append({ type: 'progress.reported', payload: { status: 'in_progress', summary: `update ${i} ` + 'x'.repeat(3500), evidence: ['y'.repeat(500)] }, origin: 'agent' }).event.id);
    }
    sync(b, a);
    const seen = new Set<string>();
    let calls = 0;
    for (;;) {
      const r = getUpdates(a, { limit: 50 }, { session: 's1', sync: syncSummary('connected'), agent: 'lead' });
      calls++;
      for (const u of r.updates) {
        expect(r.text).toContain(u.id.slice(0, 8)); // every returned record is in the text
        seen.add(u.id);
      }
      if (!r.hasMore) break;
      expect(calls).toBeLessThan(60);
    }
    expect(calls).toBeGreaterThan(1);
    for (const id of progressIds) expect(seen.has(id)).toBe(true);
  });

  it('default acknowledgement covers only records this session was shown', () => {
    const { a, b } = makePair();
    const alpha = b.append({ type: 'progress.reported', payload: { taskId: 'alpha', status: 'done', summary: 'alpha done' }, origin: 'agent' }).event;
    const beta = b.append({ type: 'progress.reported', payload: { taskId: 'beta', status: 'done', summary: 'beta done' }, origin: 'agent' }).event;
    sync(b, a);
    const r = getUpdates(a, { task: 'alpha' }, { session: 's1', sync: syncSummary('connected'), agent: 'lead' });
    expect(r.updates.map((u) => u.id)).toEqual([alpha.id]);
    acknowledge(a, {}, { session: 's1', sync: syncSummary('connected'), agent: 'lead' });
    expect(a.isAcknowledgedByMe(alpha.id)).toBe(true);
    expect(a.isAcknowledgedByMe(beta.id)).toBe(false);
  });
});
