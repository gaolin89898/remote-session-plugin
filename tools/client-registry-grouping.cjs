/** Group sidebar sessions by the official Workspace registry instead of raw cwd. */
const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '../lib/client.js');
let source = fs.readFileSync(file, 'utf8');

// 1) new grouping helper after groupSessionsByWorkspace definition
const groupFnStart = '    function groupSessionsByWorkspace(sessions) {';
if (!source.includes(groupFnStart)) throw new Error('group function missing');
const helper = `    /**
     * Group one peer's sessions by its official Workspace registry snapshot.
     * Sessions whose Workspace was deleted (not in the registry) stay hidden,
     * matching the local sidebar; archived sessions are filtered out too.
     * @param sessions - visible sessions of the peer.
     * @param snapshot - peer.workspaces payload from the host.
     * @returns workspace groups in registry order.
     */
    function groupSessionsByWorkspaceRegistry(sessions, snapshot) {
      var lists = Array.isArray(snapshot.workspaces) ? snapshot.workspaces : [];
      var archived = {};
      (Array.isArray(snapshot.archivedSessionIds) ? snapshot.archivedSessionIds : []).forEach(function (sessionId) {
        archived[String(sessionId)] = true;
      });
      var byId = {};
      sessions.forEach(function (session, index) {
        if (session && session.id) byId[String(session.id)] = { session: session, index: index };
      });
      var groups = [];
      lists.forEach(function (workspace) {
        var entries = [];
        (Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []).forEach(function (sessionId) {
          var entry = byId[String(sessionId)];
          if (!entry) return;
          if (archived[String(sessionId)]) return;
          entries.push(entry);
        });
        if (entries.length === 0) return;
        var label = workspace.title || (workspace.path ? basename(String(workspace.path)) : '') || '未命名工作区';
        var group = {
          key: 'workspace:' + String(workspace.id || workspace.path || label),
          cwd: workspace.path || '',
          label: String(label),
          workspaceId: workspace.id ? String(workspace.id) : null,
          sessions: entries,
        };
        group.sessions.sort(function (x, y) {
          var tx = toTimestamp(x.session && x.session.updatedAt) || 0;
          var ty = toTimestamp(y.session && y.session.updatedAt) || 0;
          return ty - tx;
        });
        groups.push(group);
      });
      return groups;
    }

`;
source = source.replace(groupFnStart, helper + groupFnStart);

// 2) PeerSection: prefer registry grouping
const groupsAnchor = `      var visibleSessions = sessions.filter(function (session) {
        if (!session || session.blank === true) return false;
        if (!searchQuery) return true;
        var haystack = ((session.title || '') + ' ' + (session.cwd || '') + ' ' + (session.id || '')).toLowerCase();
        return haystack.indexOf(searchQuery) !== -1;
      });
      var groups = groupSessionsByWorkspace(visibleSessions);`;
if (!source.includes(groupsAnchor)) throw new Error('groups anchor missing');
source = source.replace(groupsAnchor, `      var visibleSessions = sessions.filter(function (session) {
        if (!session || session.blank === true) return false;
        if (!searchQuery) return true;
        var haystack = ((session.title || '') + ' ' + (session.cwd || '') + ' ' + (session.id || '')).toLowerCase();
        return haystack.indexOf(searchQuery) !== -1;
      });
      // The official sidebar groups by Workspace entities; the cwd heuristic is
      // only the legacy fallback for hosts that do not publish the registry.
      var registrySnapshot = peer && peer.workspaces && Array.isArray(peer.workspaces.workspaces)
        ? peer.workspaces
        : null;
      var groups = registrySnapshot
        ? groupSessionsByWorkspaceRegistry(visibleSessions, registrySnapshot)
        : groupSessionsByWorkspace(visibleSessions);`);

fs.writeFileSync(file, source);
console.log('client workspace grouping wired:', source.length, 'bytes');
