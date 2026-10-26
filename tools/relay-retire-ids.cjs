/** Relay: drop an instance that explicitly hands over from a previous id, and expire stale offline entries. */
const fs = require('node:fs');

const file = '/opt/dsh-relay/server.js';
let source = fs.readFileSync(file, 'utf8');

// offline expiry constant
if (!source.includes('OFFLINE_TTL_MS')) {
  source = source.replace("const MAX_ID = 64;", "const MAX_ID = 64;\n/** Offline instances leave the peer snapshot after this quiet period. */\nconst OFFLINE_TTL_MS = 15 * 60 * 1000;");
}

// peersSnapshot hides expired offline entries
source = source.replace(`function peersSnapshot(excludeId) {
  return [...instances.values()]
    .filter((i) => i.id !== excludeId)`, `function peersSnapshot(excludeId) {
  const now = Date.now();
  return [...instances.values()]
    .filter((i) => i.id !== excludeId && (i.sse || now - i.lastSeen < OFFLINE_TTL_MS))`);

// handleRegister: retire the previous id when an instance renames itself
source = source.replace(`  if (typeof msg.name === 'string') inst.name = msg.name.slice(0, 64);`, `  if (typeof msg.previousId === 'string' && msg.previousId.length > 0 && msg.previousId !== id && validId(msg.previousId)) {
    const previous = instances.get(msg.previousId);
    if (previous) {
      if (previous.sse) { try { previous.sse.end(); } catch { /* ignore */ } }
      instances.delete(msg.previousId);
      fanout('peer', { type: 'offline', instance: { id: msg.previousId, name: previous.name, online: false } }, id);
    }
  }
  if (typeof msg.name === 'string') inst.name = msg.name.slice(0, 64);`);

// periodic sweep of expired offline entries
if (!source.includes('offline sweep')) {
  source = source.replace("server.listen(PORT, HOST, () =>", `// offline sweep: forget instances that stayed offline past the TTL
setInterval(() => {
  const now = Date.now();
  for (const [id, inst] of instances) {
    if (inst.sse) continue;
    if (now - inst.lastSeen < OFFLINE_TTL_MS) continue;
    instances.delete(id);
    fanout('peer', { type: 'offline', instance: { id, name: inst.name, online: false } }, id);
  }
}, 60_000).unref();

server.listen(PORT, HOST, () =>`);
}

fs.writeFileSync(file, source);
console.log('relay updated:', source.length, 'bytes');
