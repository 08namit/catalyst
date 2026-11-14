/** PeerDirectory over .catalyst/secrets.json (0600). Re-reads the file on every call so CLI edits are seen. */
import { loadSecrets, saveSecrets, type PeerSecret } from '../core/config.js';
import type { PeerDirectory } from '../core/interfaces.js';
import type { ProjectPaths } from '../core/paths.js';

export class SecretsPeerDirectory implements PeerDirectory {
  constructor(
    private readonly paths: ProjectPaths,
    private readonly projectId: string,
  ) {}

  listPeers(): PeerSecret[] {
    return Object.values(loadSecrets(this.paths, this.projectId).peers);
  }

  getPeer(id: string): PeerSecret | null {
    return loadSecrets(this.paths, this.projectId).peers[id] ?? null;
  }

  addPeer(peer: PeerSecret): void {
    const s = loadSecrets(this.paths, this.projectId);
    s.peers[peer.participantId] = peer;
    saveSecrets(this.paths, s);
  }

  updatePeerAddrs(id: string, addrs: string[]): void {
    const s = loadSecrets(this.paths, this.projectId);
    const peer = s.peers[id];
    if (!peer) return;
    if (peer.addrs.length === addrs.length && peer.addrs.every((a, i) => a === addrs[i])) return;
    peer.addrs = addrs;
    saveSecrets(this.paths, s);
  }
}
