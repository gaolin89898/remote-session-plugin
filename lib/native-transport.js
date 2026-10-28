/** Runs as a structured boot injection, before DSH installs its Connection. */
export function installNativeTransport(win = globalThis) {
  if (win.__DSH_REMOTE_SESSION__) return;
  const selectionKey = 'dsh.remote-session.machine.v1';
  const failureKey = 'dsh.remote-session.boot-failure.v1';
  const clientId = win.crypto.randomUUID();
  const fetchLocal = win.fetch.bind(win);
  const endpoint = () => new URL('remote-session/api/native', win.document.baseURI).href;
  let peerId = 'local';
  try { peerId = win.sessionStorage.getItem(selectionKey) || 'local'; } catch { /* storage unavailable */ }

  function validatePeer(info) {
    if (info?.protocol !== 1 || !Array.isArray(info.clientEntries)
      || !info.clientEntries.every(id => typeof id === 'string')) {
      throw new Error('请升级目标机器上的远程会话插件并重启 DSH');
    }
    const required = ['dsh-remote-session', '@deepseek-ai/dsh-client-ui-workspace', '@deepseek-ai/dsh-api-session-controller'];
    const missing = required.filter(id => !info.clientEntries.includes(id));
    if (missing.length) throw new Error('目标机器缺少 DSH 界面组件：' + missing.join(', ') + '。请更新 DSH 和远程会话插件后重启。');
    if (info.compositionProtocol !== 1 || !info.clientGraph || !Array.isArray(info.clientGraph.entries)
      || !Array.isArray(info.clientGraph.batches)) {
      throw new Error('请将目标机器上的远程会话插件更新到 1.2.1 或以上版本并重启 DSH');
    }
    if (info.httpProtocol !== 1) throw new Error('请将目标机器上的远程会话插件更新到 1.2.2 或以上版本并重启 DSH，以接管插件市场等插件功能');
  }

  async function request(operation, fields = {}, target = peerId, signal) {
    const response = await fetchLocal(endpoint(), {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ peerId: target, operation, clientId, ...fields }),
    });
    const payload = await response.json();
    if (!response.ok || payload.ok !== true) throw new Error(payload.error || 'Remote machine connection failed');
    return payload.result;
  }

  const bridge = {
    peerId, clientId, protocol: 1, request,
    bootError: win.sessionStorage.getItem(failureKey) || '',
    async switchMachine(id) {
      if (id === peerId) return;
      if (id !== 'local') {
        let info;
        try { info = await request('probe', {}, id); }
        catch (error) {
          if (/unknown rpc method: native/.test(error.message)) throw new Error('请升级这台机器上的远程会话插件并重启 DSH');
          throw error;
        }
        validatePeer(info);
      }
      // Reload creates fresh native controllers, stores, subscriptions and
      // session scopes. In-flight operations retain their original target.
      win.sessionStorage.setItem(selectionKey, id);
      win.location.reload();
    },
  };
  win.sessionStorage.removeItem(failureKey);
  win.__DSH_REMOTE_SESSION__ = bridge;
  if (peerId === 'local') return;

  // Replace the local composition before either shell creates native controllers.
  // Revisioned script URLs retain their /plugins shape for lazy chunk loading.
  const gate = win.__DSH_BOOT_READY__ ??= Promise.withResolvers();
  const resolveBoot = gate.resolve.bind(gate);
  const rejectBoot = gate.reject.bind(gate);
  let preparing;
  gate.resolve = () => preparing ??= (async () => {
    try {
      const info = await request('probe', {}, peerId, AbortSignal.timeout(15000));
      validatePeer(info);
      const graph = info.clientGraph;
      const resourceUrl = value => {
        const url = new URL(value, 'http://dsh.internal/');
        if (url.origin !== 'http://dsh.internal' || !url.pathname.startsWith('/plugins/') || url.username || url.password || url.hash) {
          throw new Error('目标机器的 DSH 界面资源地址无效');
        }
        return new URL('remote-session/api/resource/' + encodeURIComponent(peerId) + url.pathname + url.search, win.document.baseURI).href;
      };
      const entries = graph.entries.filter(entry => entry.id !== '@deepseek-ai/dsh-client-hmr')
        .map(entry => ({ ...entry, url: resourceUrl(entry.url) }));
      for (const required of ['dsh-remote-session', '@deepseek-ai/dsh-client-ui-workspace', '@deepseek-ai/dsh-api-session-controller']) {
        if (!entries.some(entry => entry.id === required)) throw new Error('目标机器的 DSH 界面组件不兼容，请更新 DSH 和远程会话插件');
      }
      const kept = new Set(entries.map(entry => entry.id));
      const remoteGraph = {
        ...graph, entries,
        batches: graph.batches.map(batch => ({ ...batch, url: resourceUrl(batch.url), entries: batch.entries.filter(id => kept.has(id)) }))
          .filter(batch => batch.entries.length),
      };
      const loader = win.__ModuleLoader__;
      if (loader?.mode !== 'queue' || !Array.isArray(loader.pendingQueue)) throw new Error('当前 DSH 无法切换完整客户端界面，请更新 DSH');
      loader.pendingQueue.length = 0;
      for (const batch of remoteGraph.batches.filter(batch => batch.phase === 'bootstrap')) {
        await new Promise((resolve, reject) => {
          const script = win.document.createElement('script');
          const finish = error => {
            clearTimeout(timer);
            script.remove();
            if (error) reject(error); else resolve();
          };
          const timer = setTimeout(() => finish(new Error('加载远端 DSH 界面超时')), 60000);
          script.src = batch.url;
          script.onload = () => finish();
          script.onerror = () => finish(new Error('无法加载远端 DSH 界面组件'));
          win.document.head.appendChild(script);
        });
      }
      win.__DSH_BOOT__ = remoteGraph;
      resolveBoot();
    } catch (error) {
      bridge.bootError = '连接远程机器失败，已返回本机：' + error.message;
      win.sessionStorage.setItem(failureKey, bridge.bootError);
      win.sessionStorage.setItem(selectionKey, 'local');
      // Keep the failed remote page behind the gate until navigation replaces
      // it, so desktop recovery never receives a partial remote boot failure.
      try { win.location.reload(); } catch (navigationError) { rejectBoot(navigationError); }
    }
  })();

  // Isolate DSH and third-party plugin caches and drafts by target machine.
  const storage = win.localStorage;
  const prefix = 'dsh.remote-session.host.' + encodeURIComponent(peerId) + '.';
  const storageKey = key => prefix + String(key);
  const visibleKeys = () => Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter(key => key?.startsWith(prefix))
    .map(key => key.slice(prefix.length));
  const scopedStorage = {
    getItem: key => storage.getItem(storageKey(key)),
    setItem: (key, value) => storage.setItem(storageKey(key), value),
    removeItem: key => storage.removeItem(storageKey(key)),
    key: index => visibleKeys()[index] ?? null,
    clear: () => { for (const key of visibleKeys()) storage.removeItem(storageKey(key)); },
  };
  try {
    Object.defineProperty(win, 'localStorage', { configurable: true, value: new Proxy({}, {
      get(_target, key) {
        if (key in scopedStorage) return scopedStorage[key];
        if (key === 'length') return visibleKeys().length;
        if (typeof key === 'string') return scopedStorage.getItem(key) ?? undefined;
      },
      set(_target, key, value) { scopedStorage.setItem(key, value); return true; },
      deleteProperty(_target, key) { scopedStorage.removeItem(key); return true; },
      ownKeys: visibleKeys,
      getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }),
    }) });
  } catch (error) {
    // Opening a second machine with shared draft keys could address the wrong
    // conversation, so a platform refusing isolated storage must fail visibly.
    throw new Error('Cannot isolate remote session storage: ' + error.message);
  }

  async function nativeFetch(input, init = {}) {
    const url = new URL(input instanceof Request ? input.url : String(input), win.document.baseURI);
    const base = new URL(win.document.baseURI);
    if (url.protocol !== base.protocol || url.host !== base.host) return fetchLocal(input, init);
    const directory = base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1);
    const relative = url.pathname.startsWith(directory) ? url.pathname.slice(directory.length) : url.pathname.slice(1);
    if (relative.startsWith('remote-session/')) return fetchLocal(input, init);
    const requestId = win.crypto.randomUUID();
    const outgoing = new Request(input instanceof Request ? input : url, init);
    const signal = outgoing.signal;
    const body = ['GET', 'HEAD'].includes(outgoing.method) ? undefined : new Uint8Array(await outgoing.arrayBuffer());
    let bodyBase64;
    if (body) {
      let binary = '';
      for (let offset = 0; offset < body.length; offset += 32768) binary += String.fromCharCode(...body.subarray(offset, offset + 32768));
      bodyBase64 = win.btoa(binary);
    }
    if (!relative.startsWith('api/')) return pluginFetch(relative + url.search, outgoing, bodyBase64);
    const abort = () => { void request('cancel', { requestId }).catch(() => {}); };
    signal.throwIfAborted();
    signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await request('fetch', {
        requestId, route: relative + url.search, method: outgoing.method,
        contentType: outgoing.headers.get('content-type'), bodyBase64,
      }, peerId, signal);
      const bytes = Uint8Array.from(win.atob(result.body), character => character.charCodeAt(0));
      return new Response([204, 205, 304].includes(result.status) ? null : bytes, {
        status: result.status, headers: result.headers,
      });
    } finally { signal.removeEventListener('abort', abort); }
  }

  async function pluginFetch(route, outgoing, bodyBase64) {
    const streamId = win.crypto.randomUUID();
    const lifetime = new AbortController();
    const signal = lifetime.signal;
    let controller;
    let closed = false;
    const close = () => { void request('close', { streamId }).catch(() => {}); };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      outgoing.signal.removeEventListener('abort', abort);
      lifetime.abort(outgoing.signal.reason);
      close();
    };
    const abort = () => {
      controller?.error(outgoing.signal.reason);
      controller = null;
      cleanup();
    };
    outgoing.signal.throwIfAborted();
    outgoing.signal.addEventListener('abort', abort, { once: true });
    async function *frames() {
      try {
        for (let sequence = 0; ; sequence += 1) {
          const batch = await request('pull', { streamId, sequence }, peerId, signal);
          signal.throwIfAborted();
          if (batch.sequence !== sequence) throw new Error('Remote HTTP sequence mismatch');
          for (const value of batch.values) yield value;
          if (batch.failure) throw new Error(batch.failure.message);
          if (batch.done) return;
        }
      } finally { cleanup(); }
    }
    const iterator = frames();
    try {
      await request('http-open', { streamId, route, method: outgoing.method, headers: [...outgoing.headers], bodyBase64 }, peerId, signal);
      const first = await iterator.next();
      if (first.done || first.value.kind !== 'head') throw new Error('Invalid remote plugin HTTP response');
      signal.throwIfAborted();
      const head = first.value;
      if (outgoing.method === 'HEAD' || [204, 205, 304].includes(head.status)) {
        await iterator.return();
        return new Response(null, { status: head.status, headers: head.headers });
      }
      const body = new ReadableStream({
        start(value) { controller = value; },
        async pull(value) {
          try {
            const next = await iterator.next();
            if (controller !== value) return;
            if (next.done) { controller = null; value.close(); return; }
            if (next.value.kind !== 'body') throw new Error('Invalid remote plugin HTTP body');
            value.enqueue(Uint8Array.from(win.atob(next.value.body), character => character.charCodeAt(0)));
          } catch (error) {
            if (controller === value) { controller = null; value.error(error); }
            cleanup();
          }
        },
        async cancel() { controller = null; cleanup(); await iterator.return(); },
      });
      return new Response(body, { status: head.status, headers: head.headers });
    } catch (error) {
      cleanup();
      await iterator.return();
      throw error;
    }
  }

  async function *openStream(endpoint, payload, signal, uplink) {
    const streamId = win.crypto.randomUUID();
    const abort = () => { void request('close', { streamId }).catch(() => {}); };
    const inputAbort = new AbortController();
    let inputTask;
    let inputFailure;
    signal.throwIfAborted();
    signal.addEventListener('abort', abort, { once: true });
    try {
      await request('open', { streamId, endpoint, payload, uplink: !!uplink }, peerId, signal);
      if (uplink) {
        inputTask = (async () => {
          let sequence = 0;
          for await (const value of uplink) {
            if (inputAbort.signal.aborted) return;
            await request('uplink', { streamId, sequence: sequence++, value }, peerId, inputAbort.signal);
          }
          if (!inputAbort.signal.aborted) await request('uplink', { streamId, sequence, done: true }, peerId, inputAbort.signal);
        })();
        // The output loop observes this rejection; attach immediately so an
        // upstream producer failing between pulls never becomes unhandled.
        inputTask.catch(error => { inputFailure = error; abort(); });
      }
      let partial = '';
      for (let sequence = 0; !signal.aborted; sequence += 1) {
        if (inputFailure) throw inputFailure;
        const batch = await request('pull', { streamId, sequence }, peerId, signal);
        signal.throwIfAborted();
        if (inputFailure) throw inputFailure;
        if (batch.sequence !== sequence) throw new Error('Remote stream sequence mismatch');
        for (const fragment of batch.values) {
          signal.throwIfAborted();
          partial += fragment.text;
          if (partial.length > 16 * 1024 * 1024) throw new Error('Remote stream snapshot exceeds relay limit');
          if (fragment.final) { const value = JSON.parse(partial); partial = ''; yield value; }
        }
        if (batch.failure) {
          const error = new Error(batch.failure.message);
          error.dshRemoteStreamFailure = { kind: 'remote', code: batch.failure.code, details: batch.failure.details };
          throw error;
        }
        if (batch.done) {
          if (partial) throw new Error('Incomplete remote stream snapshot');
          return;
        }
      }
      signal.throwIfAborted();
    } catch (error) {
      if (!signal.aborted && !error.dshRemoteStreamFailure) error.dshRemoteStreamFailure = { kind: 'carrier' };
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      inputAbort.abort();
      abort();
    }
  }

  const { rpc: _localRpc, ...shellTransport } = win.__DSH_TRANSPORT__ || {};
  win.__DSH_TRANSPORT__ = { ...shellTransport, ownsHost: false, fetch: nativeFetch, openStream };
  win.__DSH_FILE_UPLOAD__ = { fetch: nativeFetch };
  // Some native file and deliverable readers use fetch outside Connection.
  win.fetch = nativeFetch;
  win.addEventListener('pagehide', () => {
    void fetchLocal(endpoint(), {
      method: 'POST', headers: { 'content-type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ peerId, clientId, operation: 'release' }),
    }).catch(() => {});
  }, { once: true });
}
