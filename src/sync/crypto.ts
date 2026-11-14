import { hkdfSync } from 'node:crypto';
import type { TLSSocket } from 'node:tls';

export function derivePairPsk(pairKeyB64: string, projectId: string, participantIds: string[]): Buffer {
  const ids = [...participantIds].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return Buffer.from(hkdfSync('sha256', Buffer.from(pairKeyB64, 'base64'), projectId, `catalyst-psk-v1|${ids.join('|')}`, 32));
}

export function deriveInvitePsk(secretB64url: string, projectId: string, inviteId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secretB64url, 'base64url'), projectId, `catalyst-invite-v1|${inviteId}`, 32));
}

export function confirmCode(socket: TLSSocket): string {
  // Node permits omitting context; the installed @types/node incorrectly requires it.
  const exportMaterial = socket.exportKeyingMaterial as (length: number, label: string) => Buffer;
  return exportMaterial.call(socket, 4, 'catalyst-confirm-v1').toString('hex');
}
