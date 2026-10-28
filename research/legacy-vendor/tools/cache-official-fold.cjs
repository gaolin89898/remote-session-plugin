/** Keep the last successful official fold so incremental polls cannot drop it. */
const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '../lib/client.js');
let source = fs.readFileSync(file, 'utf8');

// module-level fold cache beside the event cache
source = source.replace(`    var officialEventCache = { key: null, events: [], cursor: 0, hasOlder: false };`,
`    var officialEventCache = { key: null, events: [], cursor: 0, hasOlder: false };
    /** Last successful fold for the current session/window; reused when an
     *  incremental poll carries no new events. */
    var officialFoldCache = { key: null, data: null };`);

// helper to merge a cached fold into a fresh transcript payload
source = source.replace(`    function enrichTranscriptWithOfficialFold(peerId, sessionId, data, eventWindow, prefetchedEvents) {`,
`    /** Merge the last fold into a transcript payload that carried no events. */
    function mergeCachedFold(data, cacheKey) {
      if (!data || !officialFoldCache.data || officialFoldCache.key !== cacheKey) return data;
      var cached = officialFoldCache.data;
      return Object.assign({}, data, {
        messages: cached.messages,
        officialFold: true,
        official: cached.official,
        sessionModel: cached.sessionModel || data.sessionModel || null,
        sessionPermission: cached.sessionPermission || data.sessionPermission || null,
        sessionGoal: cached.sessionGoal,
        officialRunning: cached.officialRunning,
        officialHistory: cached.officialHistory,
      });
    }

    function enrichTranscriptWithOfficialFold(peerId, sessionId, data, eventWindow, prefetchedEvents) {`);

// empty-events / empty-rows paths reuse the cached fold
source = source.replace(`            if (events.length === 0) return data;`,
`            if (events.length === 0) return mergeCachedFold(data, cacheKey);`);
source = source.replace(`            if (!rows || rows.length === 0) return data;`,
`            if (!rows || rows.length === 0) return mergeCachedFold(data, cacheKey);`);

// remember successful folds
source = source.replace(`            return Object.assign({}, data, {
              messages: rows,`,
`            var folded = Object.assign({}, data, {
              messages: rows,`);
source = source.replace(`                window: windowSize,
              },
            });
          });
        })`, `                window: windowSize,
              },
            });
            if (folded.official) officialFoldCache = { key: cacheKey, data: folded };
            return folded;
          });
        })`);

// cache failures fall back to the previous fold too
source = source.replace(`        .catch(function () {
          return data;
        });
    }

    var vendorChatPromise = null;`, `        .catch(function () {
          return mergeCachedFold(data, cacheKey);
        });
    }

    var vendorChatPromise = null;`);

fs.writeFileSync(file, source);
console.log('official fold cache:', source.length, 'bytes');
