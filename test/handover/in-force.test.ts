// Found in the live demo: proposed revisions (or a conflict between them) must not hide the accepted
// decision that is still in force — neither in IMPORTANT.md nor in the briefing.
import { describe, expect, it } from 'vitest';
import { renderHandoverBlock } from '../../src/handover/important.js';
import { buildBriefing } from '../../src/store/index.js';
import { makePair, sync, syncSummary } from '../store/helpers.js';

const decide = (title: string, status: 'accepted' | 'proposed') => ({
  type: 'decision.recorded' as const,
  payload: { topic: 'api/create-task', title, decision: `${title} details`, rationale: 'r', status },
  origin: 'agent' as const,
});

describe('decision in force', () => {
  it('keeps showing the accepted version while conflicting proposals are pending', () => {
    const { a, b } = makePair();
    const accepted = a.append(decide('Bearer auth contract', 'accepted')).event;
    sync(a, b);
    a.append(decide('Add priority', 'proposed'));
    b.append(decide('Add due date', 'proposed'));
    sync(a, b);
    sync(b, a);
    const block = renderHandoverBlock(a.getState());
    expect(block).toMatch(/\*\*api\/create-task\*\* — Bearer auth contract.*conflicting revisions pending/);
    const briefing = buildBriefing(a, { topic: 'api/create-task' }, { sync: syncSummary('connected'), now: new Date(), agent: 'lead' });
    expect(briefing.relevant.map((r) => r.id)).toContain(accepted.id);
    expect(briefing.text).toContain('Bearer auth contract details');
  });
});
