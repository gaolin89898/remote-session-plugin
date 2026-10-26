/** Host: tell the relay which instance id this process replaces after a settings change. */
const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '../lib/index.js');
let source = fs.readFileSync(file, 'utf8');

// state field
source = source.replace("    relayGen: 0,", "    relayGen: 0,\n    previousInstanceId: null,");

// register payload carries the retired id once
source = source.replace(`        const registered = await relayPost('/v1/register', {
          id: cfg.instanceId,
          name: cfg.instanceName,
          sessions,
          meta: { plugin: PLUGIN, version: PLUGIN_VERSION, platform: process.platform },
        });`, `        const registered = await relayPost('/v1/register', {
          id: cfg.instanceId,
          ...(state.previousInstanceId ? { previousId: state.previousInstanceId } : {}),
          name: cfg.instanceName,
          sessions,
          meta: { plugin: PLUGIN, version: PLUGIN_VERSION, platform: process.platform },
        });
        state.previousInstanceId = null;`);

// settings save records the old id when renamed
source = source.replace(`    cfg.relayUrl = relayUrl;
    cfg.token = token;
    cfg.instanceId = instanceId;
    cfg.instanceName = instanceName;`, `    const previousInstanceId = cfg.instanceId !== instanceId ? cfg.instanceId : null;
    cfg.relayUrl = relayUrl;
    cfg.token = token;
    cfg.instanceId = instanceId;
    cfg.instanceName = instanceName;`);

source = source.replace(`    restartRelay();
    log(\`relay settings updated`, `    state.previousInstanceId = previousInstanceId;
    restartRelay();
    log(\`relay settings updated`);

fs.writeFileSync(file, source);
console.log('host announces replaced instance id:', source.length, 'bytes');
