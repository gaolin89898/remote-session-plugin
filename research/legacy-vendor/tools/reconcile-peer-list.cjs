/** Reconcile the local peer cache with the relay's authoritative list (drops retired ids). */
const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '../lib/index.js');
let source = fs.readFileSync(file, 'utf8');

// relay peer-snapshot fetch + reconcile inside refreshPeers
const anchor = `  async function refreshPeers() {
    const online = [...state.peers.values()].filter((peer) => peer.online);
    await Promise.all(online.map((peer) => refreshPeer(peer.id)));
  }`;
if (!source.includes(anchor)) throw new Error('refreshPeers anchor missing');
source = source.replace(anchor, `  /** Ask the relay for its authoritative instance list. */
  async function relayPeerSnapshot() {
    if (!cfg.relayUrl || !cfg.token) return null;
    try {
      const snapshot = await relayPost('/v1/peers', { id: cfg.instanceId, token: cfg.token }, 8000);
      return Array.isArray(snapshot?.peers) ? snapshot.peers : null;
    } catch {
      return null;
    }
  }

  async function refreshPeers() {
    // The relay owns membership: an instance it no longer lists (retired id,
    // expired offline entry) must leave our cache too.
    const snapshot = await relayPeerSnapshot();
    if (snapshot) applyPeerList(snapshot);
    const online = [...state.peers.values()].filter((peer) => peer.online);
    await Promise.all(online.map((peer) => refreshPeer(peer.id)));
  }`);

// poll faster so a retired peer disappears within ~10s
source = source.replace("    }, Math.max(20000, cfg.indexMs * 2));", "    }, Math.max(10000, cfg.indexMs));");

fs.writeFileSync(file, source);
console.log('peer membership reconcile:', source.length, 'bytes');
