/** Cache the decoded session log per file stat so transcript+events share one parse. */
const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '../lib/index.js');
let source = fs.readFileSync(file, 'utf8');

// shared cache helper before readLocalTranscript
const anchor = '  async function readLocalTranscript(sessionId) {';
if (!source.includes(anchor)) throw new Error('transcript anchor missing');
source = source.replace(anchor, `  /** Decoded session log keyed by file identity; transcript and events reads share it. */
  const sessionParseCache = new Map();
  function parsedSessionFile(file) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      stat = null;
    }
    const cached = sessionParseCache.get(file);
    if (cached && stat && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
    const parsed = decodeSessionLogFileSync(file);
    const entry = {
      header: parsed.header,
      events: parsed.events,
      mtimeMs: stat ? stat.mtimeMs : 0,
      size: stat ? stat.size : 0,
    };
    sessionParseCache.set(file, entry);
    return entry;
  }

${anchor}`);

// transcript uses cache
source = source.replace(`    const { header, events } = decodeSessionLogFileSync(file);`, `    const { header, events } = parsedSessionFile(file);`);

// events uses cache
source = source.replace(`    const all = readSessionEventsSync(dshHome, sessionId, { limit: 60000 }) || [];`, `    const cached = parsedSessionFile(file);
    const all = Array.isArray(cached.events) ? cached.events : [];`);

fs.writeFileSync(file, source);
console.log('session parse cache:', source.length, 'bytes');
