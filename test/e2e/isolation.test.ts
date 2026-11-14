/**
 * Project isolation e2e (scenario 8): nodes of different projects never pair or exchange events.
 *
 * Run without npm:   node_modules/.bin/vitest run test/e2e/isolation.test.ts   (needs a build: dist/cli/index.js).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PublishResult } from '../../src/core/api.js';
import { assertBuilt, cleanupNodes, cli, cliOk, client, initNode, joinNode, pair, state, status, tempDir, waitFor } from './helpers.js';

function retargetToken(token: string, project: string): string {
  const body = JSON.parse(Buffer.from(token.slice('cat1_'.length), 'base64url').toString('utf8')) as { project: string };
  body.project = project;
  return `cat1_${Buffer.from(JSON.stringify(body)).toString('base64url')}`;
}

describe('project isolation e2e', { concurrent: false }, () => {
  let A = '';
  let C = '';
  let projA = '';
  let projC = '';

  beforeAll(async () => {
    assertBuilt();
    A = await initNode('iso-A', 'Alice');
    C = await initNode('iso-C', 'Carol');
    projA = (await status(A)).health.projectId;
    projC = (await status(C)).health.projectId;
    await client(A, 'e2e:a').tool<PublishResult>('set_goal', { title: 'Project A secret goal' });
  });
  afterAll(async () => {
    await cleanupNodes();
  }, 60_000);

  it('a checkout initialised for project C cannot join project A (and vice versa)', async () => {
    expect(projA).not.toBe(projC);
    const tokenA = await pair(A);
    const r = await cli(['join', tokenA, '--dir', C, '--name', 'Carol', '--peer-bind', '127.0.0.1', '--no-setup']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/already Catalyst project/);
    expect(r.stderr).toMatch(/separate checkout|--dir/);

    const tokenC = await pair(C);
    const r2 = await cli(['join', tokenC, '--dir', A, '--name', 'Alice', '--peer-bind', '127.0.0.1', '--no-setup']);
    expect(r2.code).not.toBe(0);
    expect(r2.stderr).toMatch(/already Catalyst project/);

    const [sa, sc] = await Promise.all([status(A), status(C)]);
    expect(sa.sync.peers).toEqual([]);
    expect(sc.sync.peers).toEqual([]);
    expect(sc.health.projectId).toBe(projC);
    expect((await state(C)).state.goal.current).toBeNull();
  });

  it('an invitation re-targeted to another project is rejected at the handshake and pairs nobody', async () => {
    const tokenA = await pair(A);
    const forged = retargetToken(tokenA, projC);
    const r = await cli(['join', forged, '--dir', tempDir('iso-forged'), '--name', 'Eve', '--peer-bind', '127.0.0.1', '--no-setup']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/Could not join|rejected/i);
    expect((await status(A)).sync.peers).toEqual([]);

    // The genuine token still works afterwards (the forged attempt did not consume it).
    const b = await cli(['join', tokenA, '--dir', tempDir('iso-B'), '--name', 'Bob', '--peer-bind', '127.0.0.1', '--no-setup']);
    expect(b.code, b.stderr).toBe(0);
  });

  it('a node paired in project C pointed at A\'s peer port is refused and ingests nothing from A', async () => {
    const { dir: D } = await joinNode(C, 'iso-D', 'Dave');
    const sd0 = await waitFor('D connected to C', async () => {
      const s = await status(D);
      return s.sync.peers[0]?.state === 'connected' ? s : null;
    });
    const carol = sd0.sync.peers[0]!.participant;
    const peerPortA = (await status(A)).health.peerPort;
    // Pause first so the live link to C is closed; then point "Carol" at A's listener and resume.
    await cliOk(['peer', 'pause', '--dir', D]);
    await cliOk(['peer', 'set-addr', carol, `127.0.0.1:${peerPortA}`, '--dir', D]);
    await cliOk(['peer', 'pause', '--dir', C]); // make sure C itself cannot be reached through some other path
    await cliOk(['peer', 'resume', '--dir', D]);

    const p = await waitFor('D reports its peer unreachable with an error', async () => {
      const peer = (await status(D)).sync.peers[0];
      return peer && peer.state === 'unreachable' && peer.lastError ? peer : null;
    });
    expect(p.addrs).toContain(`127.0.0.1:${peerPortA}`);
    const sD = await state(D);
    expect(sD.state.goal.current).toBeNull();
    expect(sD.recent.some((e) => e.summary.includes('Project A secret goal'))).toBe(false);
    expect(sD.health.projectId).toBe(projC);
    expect((await state(A)).state.participants.map((x) => x.name)).not.toContain('Dave');
  });
});
