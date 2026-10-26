/** Expose the official Workspace registry so remote grouping matches the local sidebar. */
const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '../lib/index.js');
let source = fs.readFileSync(file, 'utf8');

// 1) local workspace snapshot helper
const sessionAnchor = '  async function listLocalSessions() {';
if (!source.includes(sessionAnchor)) throw new Error('session list anchor missing');
source = source.replace(sessionAnchor, `  /** Official Workspace registry snapshot: titles, paths and session membership. */
  function localWorkspaceSnapshot() {
    try {
      const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
      if (!registry || typeof registry.list !== 'function') return null;
      const archived = Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : [];
      const workspaces = registry.list().map((workspace) => ({
        id: String(workspace.id),
        title: typeof workspace.title === 'string' ? workspace.title : null,
        path: typeof workspace.path === 'string' ? workspace.path : null,
        sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [],
      }));
      return { workspaces, archivedSessionIds: archived.map(String) };
    } catch {
      return null;
    }
  }

  async function listLocalWorkspaces() {
    return localWorkspaceSnapshot() || { workspaces: [], archivedSessionIds: [] };
  }

${sessionAnchor}`);

// 2) RPC method
const rpcAnchor = "      else if (method === 'commands') result = await listLocalCommands(params?.sessionId);";
if (!source.includes(rpcAnchor)) throw new Error('rpc anchor missing');
source = source.replace(rpcAnchor, "      else if (method === 'workspaces') result = await listLocalWorkspaces();\n" + rpcAnchor);

// 3) state: local + peers workspace snapshots
source = source.replace(`      self: { id: cfg.instanceId, name: cfg.instanceName, version: PLUGIN_VERSION },
      peers: [...state.peers.values()].map((peer) => ({
        id: peer.id,
        name: peer.name,
        online: !!peer.online,
        version: state.peerVersions.get(peer.id) || null,
        sessions: peer.sessions || [],
      })),`, `      self: { id: cfg.instanceId, name: cfg.instanceName, version: PLUGIN_VERSION },
      workspaces: localWorkspaceSnapshot(),
      peers: [...state.peers.values()].map((peer) => ({
        id: peer.id,
        name: peer.name,
        online: !!peer.online,
        version: state.peerVersions.get(peer.id) || null,
        sessions: peer.sessions || [],
        workspaces: peer.workspaces || null,
      })),`);

// 4) refreshPeers also fetches peer workspaces
const refreshAnchor = `          peer.sessions = await rpcCall(peer.id, 'list', {}, 8000);
        } catch {
          /* keep the last known list */
        }`;
if (!source.includes(refreshAnchor)) throw new Error('refresh anchor missing');
source = source.replace(refreshAnchor, `          peer.sessions = await rpcCall(peer.id, 'list', {}, 8000);
        } catch {
          /* keep the last known list */
        }
        try {
          peer.workspaces = await rpcCall(peer.id, 'workspaces', {}, 8000);
        } catch {
          /* keep the last known workspaces */
        }`);

// 5) refresh peers right after registration so grouping is available on first state
const regAnchor = `        applyPeerList(registered.peers);
        await openStream();`;
if (!source.includes(regAnchor)) throw new Error('register anchor missing');
source = source.replace(regAnchor, `        applyPeerList(registered.peers);
        refreshPeers().catch(() => {});
        await openStream();`);

fs.writeFileSync(file, source);
console.log('workspace registry exposed:', source.length, 'bytes');
