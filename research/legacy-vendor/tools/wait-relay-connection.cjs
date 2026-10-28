/** Let settings-save settle on an actual relay connection before answering. */
const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '../lib/index.js');
let source = fs.readFileSync(file, 'utf8');

// async wait helper before saveRelaySettings
const fnAnchor = '  function saveRelaySettings(body) {';
if (!source.includes(fnAnchor)) throw new Error('save fn anchor missing');
source = source.replace(fnAnchor, `  /** Poll until the relay stream is up so the settings dialog can report success. */
  async function waitForRelayConnection(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (state.relay.connected) return true;
      await sleep(120);
    }
    return state.relay.connected;
  }

  async function saveRelaySettings(body) {`);

// await connection after restart
source = source.replace(`    restartRelay();
    log(\`relay settings updated -> \${cfg.relayUrl} as \${cfg.instanceId} (\${cfg.instanceName})\`);
    return relaySettingsSnapshot();`, `    restartRelay();
    log(\`relay settings updated -> \${cfg.relayUrl} as \${cfg.instanceId} (\${cfg.instanceName})\`);
    await waitForRelayConnection();
    return relaySettingsSnapshot();`);

// await at call sites
source = source.replace('        const saved = saveRelaySettings(body);', '        const saved = await saveRelaySettings(body);');

fs.writeFileSync(file, source);
console.log('settings-save waits for connection:', source.length, 'bytes');
