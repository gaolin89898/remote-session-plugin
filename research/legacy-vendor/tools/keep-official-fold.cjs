/** Keep the last official fold when a light poll returns no new events. */
const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '../lib/client.js');
let source = fs.readFileSync(file, 'utf8');

source = source.replace(`      var rawTranscriptRef = React.useRef(null);
      var pollIndexRef = React.useRef(0);`, `      var rawTranscriptRef = React.useRef(null);
      var lastEnrichedRef = React.useRef(null);
      var pollIndexRef = React.useRef(0);`);

const oldTail = `        return Promise.all([transcriptPromise, eventsPromise])
          .then(function (results) {
            return enrichTranscriptWithOfficialFold(
              peerId,
              sessionId,
              results[0],
              windowSize,
              results[1] || undefined,
            );
          })
          .then(
          function (data) {
            busyRef.current = false;`;
if (!source.includes(oldTail)) throw new Error('load tail anchor missing');
source = source.replace(oldTail, `        return Promise.all([transcriptPromise, eventsPromise])
          .then(function (results) {
            return enrichTranscriptWithOfficialFold(
              peerId,
              sessionId,
              results[0],
              windowSize,
              results[1] || undefined,
            );
          })
          .then(function (folded) {
            var previous = lastEnrichedRef.current;
            // An incremental poll with no new events must not drop the official
            // fold that the previous poll produced.
            if (light && previous && folded && !folded.official && previous.official) {
              folded = Object.assign({}, previous, {
                session: folded.session || previous.session,
                messages: previous.messages,
                officialRunning:
                  typeof folded.officialRunning === 'boolean' ? folded.officialRunning : previous.officialRunning,
              });
            }
            if (folded && folded.official) lastEnrichedRef.current = folded;
            return folded;
          })
          .then(
          function (data) {
            busyRef.current = false;`);

// reset the folded cache when the selection changes
source = source.replace(`        rawTranscriptRef.current = null;
        pollIndexRef.current = 0;`, `        rawTranscriptRef.current = null;
        lastEnrichedRef.current = null;
        pollIndexRef.current = 0;`);

fs.writeFileSync(file, source);
console.log('light poll keeps official fold:', source.length, 'bytes');
