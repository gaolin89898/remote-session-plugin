import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexAdapter, OpenCodeAdapter } from '../gateway/process-adapters.mjs';
import { AgentGateway } from '../gateway/core.mjs';

// Uses empty CLI homes. No real conversations, credentials or model calls.
const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-agent-probe-'));
try {
  for (const kind of ['codex', 'opencode']) {
    const directory = path.join(home, kind); await mkdir(directory);
    const Type = kind === 'codex' ? CodexAdapter : OpenCodeAdapter;
    const adapter = new Type(kind, { command: kind, env: { CODEX_HOME: directory, XDG_DATA_HOME: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, OPENCODE_CONFIG_CONTENT: '{}' } });
    const gateway = new AgentGateway({ id: 'probe', name: 'probe', workspaces: [{ id: 'probe', path: directory }] }, new Map([[kind, adapter]]));
    try {
      await gateway.initialize();
      const { sessions } = await gateway.call('sessions.list', { agentId: kind, workspaceId: 'probe' });
      console.log(`${kind}: ${adapter.status}, history=${adapter.capabilities.history}, isolated sessions=${sessions.length}`);
    } catch (error) { console.error(`${kind}: ${error.code || 'ERROR'} ${error.message}`); process.exitCode = 1; }
    finally { await gateway.close(); }
  }
} finally { await rm(home, { recursive: true, force: true }); }
