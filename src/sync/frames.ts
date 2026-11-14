/**
 * Peer wire frames: newline-delimited JSON over TLS 1.2 PSK (ECDHE-PSK-CHACHA20-POLY1305).
 *
 * PSK identities (cleartext in the TLS handshake; not secret):
 *   paired peers:  "catalyst/1/<projectId>/<participantId of the CONNECTING side>"
 *   invitations:   "catalyst-invite/1/<projectId>/<inviteId>"
 * PSK derivation (HKDF-SHA256, 32 bytes):
 *   pairKey PSK  = HKDF(pairKey, salt=projectId, info="catalyst-psk-v1|" + sortedParticipantIds.join("|"))
 *   invite PSK   = HKDF(secret,  salt=projectId, info="catalyst-invite-v1|" + inviteId)
 * Confirmation code: tlsSocket.exportKeyingMaterial(4, "catalyst-confirm-v1") → 8 hex chars, shown on both sides.
 */
import type { CatalystEvent } from '../core/protocol.js';
import type { PeerStatusBody } from '../core/interfaces.js';

export const PSK_CIPHERS = 'ECDHE-PSK-CHACHA20-POLY1305:ECDHE-PSK-AES256-CBC-SHA384';
export const PEER_IDENTITY_PREFIX = 'catalyst/1/';
export const INVITE_IDENTITY_PREFIX = 'catalyst-invite/1/';
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const PING_INTERVAL_MS = 15_000;
export const IDLE_TIMEOUT_MS = 45_000;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
export const MAX_CONNECTIONS_PER_IP = 8;
export const INVITE_TTL_MINUTES_DEFAULT = 15;

export interface HelloFrame {
  t: 'hello';
  protocol: number;
  software: string;
  project: string;
  participant: string;
  name: string;
  /** "host:port" addresses where this node accepts peer connections. */
  addrs: string[];
  /** Per-author highest contiguous seq this node holds. */
  vector: Record<string, number>;
}
export interface EventsFrame {
  t: 'events';
  events: CatalystEvent[];
  /** true while replaying a backlog after hello; false for live pushes. */
  replay: boolean;
}
export interface AckFrame {
  t: 'ack';
  /** Ids durably stored by the sender of this frame (accepted, duplicate or parked). */
  ids: string[];
}
export interface StatusFrame extends PeerStatusBody {
  t: 'status';
}
export interface PingFrame {
  t: 'ping';
  at: string;
}
export interface PongFrame {
  t: 'pong';
  at: string;
}
export type ErrorCode = 'wrong_project' | 'incompatible_protocol' | 'unknown_participant' | 'bad_frame' | 'invite_invalid' | 'rate_limited' | 'internal';
export interface ErrorFrame {
  t: 'error';
  code: ErrorCode;
  message: string;
  fatal: boolean;
}
/** Joiner → inviter, first frame on an invite-PSK connection. */
export interface JoinRequestFrame {
  t: 'join_request';
  protocol: number;
  project: string;
  inviteId: string;
  participant: string;
  name: string;
  publicKey: string;
  addrs: string[];
}
/** Inviter → joiner. After this the invite is consumed and the connection closes; normal sync uses the pair key. */
export interface JoinAcceptFrame {
  t: 'join_accept';
  project: { id: string; name: string };
  inviter: { participant: string; name: string; publicKey: string; addrs: string[] };
  /** base64 32-byte random pair key. */
  pairKey: string;
  confirmCode: string;
}

export type Frame = HelloFrame | EventsFrame | AckFrame | StatusFrame | PingFrame | PongFrame | ErrorFrame | JoinRequestFrame | JoinAcceptFrame;

/** Invitation token payload: token = "cat1_" + base64url(JSON). Contains a bearer secret: share privately. */
export interface InvitePayload {
  v: 1;
  project: string;
  projectName: string;
  inviteId: string;
  /** base64url 32-byte secret */
  secret: string;
  /** "host:port" candidates to dial, in preference order */
  addrs: string[];
  /** ISO expiry */
  exp: string;
  inviter: { participant: string; name: string };
}
export const INVITE_PREFIX = 'cat1_';
