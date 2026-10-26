/** Refresh a peer's sessions/workspaces as soon as it comes online; surface offline state. */
const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '../lib/index.js');
let source = fs.readFileSync(file, 'utf8');

// 1) shared per-peer refresh helper + rewrite refreshPeers
const oldRefresh = `  async function refreshPeers() {
    const online = [...state.peers.values()].filter((peer) => peer.online);
    await Promise.all(
      online.map(async (peer) => {
        try {
          peer.sessions = await rpcCall(peer.id, 'list', {}, 8000);
        } catch {
          /* keep the last known list */
        }
        try {
          peer.workspaces = await rpcCall(peer.id, 'workspaces', {}, 8000);
        } catch {
          /* keep the last known workspaces */
        }
      }),
    );
  }`;
if (!source.includes(oldRefresh)) throw new Error('refreshPeers anchor missing');
source = source.replace(oldRefresh, `  /** Re-read one online peer's session index and workspace registry. */
  async function refreshPeer(peerId) {
    const peer = state.peers.get(peerId);
    if (!peer || !peer.online) return;
    try {
      peer.sessions = await rpcCall(peer.id, 'list', {}, 8000);
    } catch {
      /* keep the last known list */
    }
    try {
      peer.workspaces = await rpcCall(peer.id, 'workspaces', {}, 8000);
    } catch {
      /* keep the last known workspaces */
    }
  }

  async function refreshPeers() {
    const online = [...state.peers.values()].filter((peer) => peer.online);
    await Promise.all(online.map((peer) => refreshPeer(peer.id)));
  }`);

// 2) on peer online: refresh immediately instead of waiting for the next poll
source = source.replace(`    if (data.type === 'online' && !state.peerVersions.has(instance.id)) probePeerVersion(instance.id);`,
`    if (data.type === 'online') {
      if (!state.peerVersions.has(instance.id)) probePeerVersion(instance.id);
      // A reconnect means the cached session list is stale; pull it now so the
      // panel stops showing the previous run's sessions.
      refreshPeer(instance.id).catch(() => {});
    }`);

// 3) ready frame also refreshes workspaces for peers that registered earlier
source = source.replace(`    if (event === 'ready') return applyPeerList(data.peers);`,
`    if (event === 'ready') {
      applyPeerList(data.peers);
      refreshPeers().catch(() => {});
      return;
    }`);

fs.writeFileSync(file, source);
console.log('peer refresh on reconnect:', source.length, 'bytes');
