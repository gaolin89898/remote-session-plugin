/** Parallel first load + lighter steady-state polling for the transcript. */
const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '../lib/client.js');
let source = fs.readFileSync(file, 'utf8');

// 1) fold accepts an already-fetched events payload
source = source.replace(
  'function enrichTranscriptWithOfficialFold(peerId, sessionId, data, eventWindow) {',
  'function enrichTranscriptWithOfficialFold(peerId, sessionId, data, eventWindow, prefetchedEvents) {',
);
const fetchAnchor = `          var afterSeq = officialEventCache.cursor;
          return post('events', { peerId: peerId, sessionId: sessionId, afterSeq: afterSeq, limit: windowSize }).then(function (eventsData) {`;
if (!source.includes(fetchAnchor)) throw new Error('events fetch anchor missing');
source = source.replace(fetchAnchor, `          var afterSeq = officialEventCache.cursor;
          var eventsPromise = prefetchedEvents
            ? Promise.resolve(prefetchedEvents)
            : post('events', { peerId: peerId, sessionId: sessionId, afterSeq: afterSeq, limit: windowSize });
          return eventsPromise.then(function (eventsData) {`);

// 2) loadTranscript: prefetch events in parallel with the transcript; light polls reuse the last transcript
const oldLoad = `      var loadTranscript = React.useCallback(function () {
        if (!peerId || !sessionId) return Promise.resolve();
        if (busyRef.current) return Promise.resolve();
        busyRef.current = true;
        return post('transcript', { peerId: peerId, sessionId: sessionId })
          .then(function (data) {
            return enrichTranscriptWithOfficialFold(peerId, sessionId, data, eventWindowRef.current);
          })`;
if (!source.includes(oldLoad)) throw new Error('loadTranscript anchor missing');
source = source.replace(oldLoad, `      var loadTranscript = React.useCallback(function (options) {
        if (!peerId || !sessionId) return Promise.resolve();
        if (busyRef.current) return Promise.resolve();
        busyRef.current = true;
        var light = options && options.light === true;
        var windowSize = eventWindowRef.current;
        // The official fold needs the event window; start it alongside the
        // transcript instead of after it so the first paint does not wait twice.
        var eventsPromise = post('events', {
          peerId: peerId,
          sessionId: sessionId,
          afterSeq: officialEventCache.cursor,
          limit: windowSize,
        }).catch(function () {
          return null;
        });
        var transcriptPromise =
          light && rawTranscriptRef.current
            ? Promise.resolve(rawTranscriptRef.current)
            : post('transcript', { peerId: peerId, sessionId: sessionId }).then(function (data) {
                rawTranscriptRef.current = data;
                return data;
              });
        return Promise.all([transcriptPromise, eventsPromise])
          .then(function (results) {
            return enrichTranscriptWithOfficialFold(
              peerId,
              sessionId,
              results[0],
              windowSize,
              results[1] || undefined,
            );
          })`);

// 3) refs + poll cadence
const refAnchor = `      var loadTranscript = React.useCallback(function (options) {`;
source = source.replace(refAnchor, `      var rawTranscriptRef = React.useRef(null);
      var pollIndexRef = React.useRef(0);

${refAnchor}`);

const effectAnchor = `        setLoading(true);
        setTranscript(null);
        setError(null);
        setActionError(null);
        nearBottomRef.current = true;
        loadTranscript();
        var timer = setInterval(loadTranscript, TRANSCRIPT_POLL_MS);`;
if (!source.includes(effectAnchor)) throw new Error('poll effect anchor missing');
source = source.replace(effectAnchor, `        setLoading(true);
        setTranscript(null);
        setError(null);
        setActionError(null);
        nearBottomRef.current = true;
        rawTranscriptRef.current = null;
        pollIndexRef.current = 0;
        loadTranscript();
        // Every 5th tick re-reads the full transcript (title/running/fallback);
        // the rest fold only the incremental event window.
        var timer = setInterval(function () {
          var heavy = pollIndexRef.current % 5 === 0;
          pollIndexRef.current += 1;
          loadTranscript({ light: !heavy });
        }, TRANSCRIPT_POLL_MS);`);

fs.writeFileSync(file, source);
console.log('transcript loading optimised:', source.length, 'bytes');
