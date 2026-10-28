/** Fix the relay-restart race: a stale generation must not overwrite the new state. */
const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '../lib/index.js');
let source = fs.readFileSync(file, 'utf8');

// 1) openStream: never publish connected state for an aborted generation
const streamAnchor = `    if (!res.ok || !res.body) throw new Error(\`relay stream http \${res.status}\`);
    state.relay.connected = true;`;
if (!source.includes(streamAnchor)) throw new Error('stream anchor missing');
source = source.replace(streamAnchor, `    if (!res.ok || !res.body) throw new Error(\`relay stream http \${res.status}\`);
    // A restart may have aborted this generation while the request was in flight.
    if (abort.signal.aborted) throw new Error('relay stream aborted');
    state.relay.connected = true;`);

// 2) runRelayLoop: only the current generation may report failures / retry
const loopAnchor = `      } catch (error) {
        state.relay.connected = false;
        state.relay.lastError = String(error?.message || error);
        if (!state.stopped) {
          log('relay loop error:', state.relay.lastError);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 30000);
        }
      }
    }
  }`;
if (!source.includes(loopAnchor)) throw new Error('relay loop anchor missing');
source = source.replace(loopAnchor, `      } catch (error) {
        // A restarted relay owns the state now; the retired generation just exits.
        if (generation !== state.relayGen || state.stopped) break;
        state.relay.connected = false;
        state.relay.lastError = String(error?.message || error);
        if (!state.stopped) {
          log('relay loop error:', state.relay.lastError);
          await sleep(backoff);
          if (generation !== state.relayGen || state.stopped) break;
          backoff = Math.min(backoff * 2, 30000);
        }
      }
    }
  }`);

fs.writeFileSync(file, source);
console.log('relay restart race fixed:', source.length, 'bytes');
