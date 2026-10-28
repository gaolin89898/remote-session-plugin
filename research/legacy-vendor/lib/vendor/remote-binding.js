/**
 * Shims between the vendored official chat tree and this plugin.
 *
 * The official client components are written against the shell's own
 * SessionBinding / plugin context. This module builds an equivalent object
 * from relay data so the vendored ChatView can render a REMOTE session:
 *
 *   sessionId  → `remote:<peerId>:<sessionId>` (stable local identity)
 *   session    → minimal SessionFace (id, title, cwd, status, updatedAt)
 *   eventSource→ polls the relay `/transcript` + `/events` RPCs and replays
 *                entries with monotonic seq (follow = poll loop)
 *   ctx        → read-only AgentContext: capability checks return undefined,
 *                writes are routed to the plugin's own `/send` endpoint.
 *
 * Nothing here renders yet; it is the data contract the vendored tree needs.
 */

export const REMOTE_PREFIX = 'remote:';

export function remoteSessionId(peerId, sessionId) {
  return `${REMOTE_PREFIX}${peerId}:${sessionId}`;
}

export function parseRemoteSessionId(id) {
  const text = String(id || '');
  if (!text.startsWith(REMOTE_PREFIX)) return null;
  const rest = text.slice(REMOTE_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) return null;
  return { peerId: rest.slice(0, separator), sessionId: rest.slice(separator + 1) };
}

/**
 * Poll one remote transcript and expose it in the shape the conversation
 * assembler consumes: ordered event-like entries with monotonic seq.
 * @param {(method: string, body: object) => Promise<any>} post - plugin API poster
 */
export function createRemoteEventSource(post, peerId, sessionId, options = {}) {
  const pollMs = Math.max(500, Number(options.pollMs) || 2000);
  let cursor = 0;
  let timer = null;
  let subscribers = new Set();
  let disposed = false;

  async function pollOnce() {
    try {
      const transcript = await post('transcript', { peerId, sessionId });
      const messages = Array.isArray(transcript && transcript.messages) ? transcript.messages : [];
      const fresh = [];
      for (const message of messages) {
        const seq = typeof message.seq === 'number' ? message.seq : cursor + 1;
        if (seq <= cursor) continue;
        cursor = seq;
        fresh.push({ ...message, seq });
      }
      if (fresh.length > 0) {
        for (const listener of subscribers) {
          try {
            listener(fresh);
          } catch {
            /* a listener must not break polling */
          }
        }
      }
      return messages;
    } catch {
      return [];
    }
  }

  return {
    sessionId,
    get cursor() {
      return cursor;
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    async start() {
      timer = setInterval(() => {
        if (!disposed) pollOnce();
      }, pollMs);
      await pollOnce();
    },
    async follow() {
      return pollOnce();
    },
    dispose() {
      disposed = true;
      subscribers.clear();
      if (timer) clearInterval(timer);
    },
  };
}

/** Minimal read-only AgentContext face used by the vendored tree. */
export function createRemoteAgentContext(peerId, sessionId, post) {
  return {
    peerId,
    sessionId,
    readOnly: true,
    capabilities: () => [],
    send: (text) => post('send', { peerId, sessionId, text }),
    cancel: () => post('cancel', { peerId, sessionId }),
    models: () => post('models', { peerId }),
    selectModel: (selection) => post('select-model', { peerId, sessionId, ...selection }),
  };
}
