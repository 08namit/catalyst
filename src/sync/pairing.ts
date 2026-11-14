import type { Logger } from '../core/log.js';
import type { PeerSecret } from '../core/config.js';
import { ID_PATTERNS, PROTOCOL_VERSION, participantIdFromPublicKey } from '../core/protocol.js';
import { confirmCode, deriveInvitePsk } from './crypto.js';
import { INVITE_IDENTITY_PREFIX, INVITE_PREFIX, type Frame, type InvitePayload } from './frames.js';
import { connectPeer, parseAddress, type FramedConnection } from './transport.js';

export function encodeInvite(payload: InvitePayload): string {
  return INVITE_PREFIX + Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function parseInvite(token: string): InvitePayload {
  const invalid = () => new Error('Invalid invitation; ask your peer to run `catalyst pair` again and copy the complete cat1_ token');
  if (!token.startsWith(INVITE_PREFIX) || !/^[A-Za-z0-9_-]+$/.test(token.slice(INVITE_PREFIX.length))) throw invalid();
  let p: InvitePayload;
  try { p = JSON.parse(Buffer.from(token.slice(INVITE_PREFIX.length), 'base64url').toString('utf8')) as InvitePayload; }
  catch { throw invalid(); }
  if (!p || p.v !== 1 || typeof p.project !== 'string' || !ID_PATTERNS.project.test(p.project)
    || typeof p.projectName !== 'string' || !p.projectName || typeof p.inviteId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(p.inviteId)
    || typeof p.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(p.secret) || Buffer.from(p.secret, 'base64url').length !== 32
    || !Array.isArray(p.addrs) || !p.addrs.length || !p.addrs.every(a => typeof a === 'string')
    || typeof p.exp !== 'string' || !Number.isFinite(Date.parse(p.exp)) || !p.inviter
    || typeof p.inviter.participant !== 'string' || !ID_PATTERNS.participant.test(p.inviter.participant)
    || typeof p.inviter.name !== 'string' || !p.inviter.name) throw invalid();
  try { p.addrs.forEach(parseAddress); } catch { throw invalid(); }
  if (Date.parse(p.exp) <= Date.now()) throw new Error(`Invitation expired at ${p.exp}; ask your peer to run \`catalyst pair\` again`);
  return p;
}

export async function joinWithInvite(token: string, opts: {
  identity: { participantId: string; name: string; publicKey: string }; addrs: string[]; timeoutMs?: number; logger: Logger;
}): Promise<{ projectId: string; projectName: string; inviter: PeerSecret; confirmCode: string }> {
  const invite = parseInvite(token);
  const errors: string[] = [];
  for (const addr of invite.addrs) {
    let conn: FramedConnection | undefined;
    try {
      conn = await connectPeer({ ...parseAddress(addr), identity: `${INVITE_IDENTITY_PREFIX}${invite.project}/${invite.inviteId}`,
        psk: deriveInvitePsk(invite.secret, invite.project, invite.inviteId), timeoutMs: opts.timeoutMs ?? 5000 });
      const socketCode = confirmCode(conn.socket);
      const active = conn;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Timed out waiting for invitation acceptance')), opts.timeoutMs ?? 5000);
        function cleanup() { clearTimeout(timer); active.off('frame', frame); active.off('error', finish); active.off('close', closed); }
        function finish(error: Error) { cleanup(); reject(error); }
        function closed() { finish(new Error('Inviter closed the connection before accepting; invitation may be expired or already used')); }
        function frame(f: Frame) {
          if (f.t === 'error') { finish(new Error(`${f.code}: ${f.message}`)); return; }
          if (f.t !== 'join_accept') { finish(new Error('Expected join_accept from inviter')); return; }
          if (f.project.id !== invite.project || f.inviter.participant !== invite.inviter.participant
            || participantIdFromPublicKey(f.inviter.publicKey) !== f.inviter.participant) {
            finish(new Error('Inviter identity or project does not match the invitation')); return;
          }
          if (f.confirmCode !== socketCode || Buffer.from(f.pairKey, 'base64').length !== 32) {
            finish(new Error('Invalid pairing key or TLS confirmation code')); return;
          }
          cleanup();
          resolve({ projectId: f.project.id, projectName: f.project.name, confirmCode: socketCode,
            inviter: { participantId: f.inviter.participant, name: f.inviter.name, publicKey: f.inviter.publicKey,
              pairKey: f.pairKey, addrs: f.inviter.addrs, addedAt: new Date().toISOString(), confirmCode: socketCode } });
        }
        active.on('frame', frame);
        active.on('error', finish);
        active.on('close', closed);
        active.send({ t: 'join_request', protocol: PROTOCOL_VERSION, project: invite.project, inviteId: invite.inviteId,
          participant: opts.identity.participantId, name: opts.identity.name, publicKey: opts.identity.publicKey, addrs: opts.addrs });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The inviter was reached but refused the invite PSK: the invite was used, expired or cancelled.
      // That is not a network problem, so report it directly instead of suggesting firewall fixes.
      if (/unknown psk identity|invite_invalid/i.test(message)) {
        throw new Error(`Invitation rejected by ${addr}: it has already been used, has expired, or was cancelled. Ask your peer to run \`catalyst pair\` again.`);
      }
      errors.push(`${addr}: ${message}`);
      opts.logger.debug('Invitation address failed', { addr, error: message });
    } finally { conn?.destroy(); }
  }
  const port = parseAddress(invite.addrs[0]!).port;
  throw new Error(`Could not join invitation:\n${errors.join('\n')}\nBoth laptops must be on the same network; allow inbound TCP ${port} through the firewall; or ask the inviter to run \`catalyst pair --host <reachable-ip>\`.`);
}
