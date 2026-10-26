var BAKED_VENDOR = null; // bake-marker
// dsh-remote-session — Client half (hand-written, no build step).
//
// Format contract (same as dsh-client-modules plugin bundles): the shell-owned
// `window.__ModuleLoader__.load({ id, factory })` is called with `id` === the
// package name; the factory behaves like a CommonJS module and RETURNS
// `module.exports`. `require(spec)` resolves against the shell's shared module
// table (react + @deepseek-ai/dsh-client-* baseline packages).
//
// UI surface:
//   - `sidebar.panellist` icon row  → switches the main column to this panel;
//   - `main` keyed panel `remote-session` → the Remote Sessions page.
//
// Data plane: the Host half mounts POST routes under `/remote-session/api/*`.
// Every request resolves a RELATIVE url against `document.baseURI` so the page
// keeps working behind a reverse-proxy prefix and inside the Electron shell's
// `dsh-app://app/` origin (writing a leading-slash url would leave the prefix).
window.__ModuleLoader__.load({
  id: 'dsh-remote-session',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // ── baseline modules ────────────────────────────────────────────────────
    var React = require('react');
    var h = React.createElement;

    // Official markdown renderer (baseline shared module). Optional: any
    // failure — module missing, export renamed, render crash — degrades to
    // plain text instead of breaking the panel.
    var MarkdownText = null;
    try {
      var primitives = require('@deepseek-ai/dsh-client-ui-primitives');
      if (primitives && typeof primitives.MarkdownText === 'function') {
        MarkdownText = primitives.MarkdownText;
      }
    } catch (error) {
      MarkdownText = null;
    }

    // ── constants ───────────────────────────────────────────────────────────
    var PLUGIN_NAME = 'dsh-remote-session';
    var PANEL_ID = 'remote-session';
    var PANEL_TITLE = '远程会话';
    var API_BASE = 'remote-session/api/';
    var STATE_POLL_MS = 5000;
    var TRANSCRIPT_POLL_MS = 2000;

    // Theme-respecting tokens with safe fallbacks (DSH may not define any of
    // these in older shells; the fallbacks keep the panel legible in light and
    // dark themes because text colours are inherited from the shell).
    var ACCENT = 'var(--dsh-color-accent, #4d6bfe)';
    var SUCCESS = 'var(--dsh-color-success, #2ea043)';
    var DANGER = 'var(--dsh-color-danger, #d1242f)';
    var BORDER = 'var(--dsh-color-border, rgba(128, 128, 128, 0.26))';
    var SOFT_BG = 'var(--dsh-color-surface-subtle, rgba(128, 128, 128, 0.10))';
    var EMPTY_ARRAY = [];
    var MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    // ── tiny helpers ────────────────────────────────────────────────────────
    function merge() {
      var out = {};
      for (var i = 0; i < arguments.length; i += 1) {
        var source = arguments[i];
        if (!source) continue;
        for (var key in source) {
          if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
        }
      }
      return out;
    }

    function messageOf(error) {
      if (error === null || error === undefined) return '未知错误';
      if (typeof error === 'string') return error;
      if (error.message) return String(error.message);
      return String(error);
    }

    function apiUrl(method) {
      return new URL(API_BASE + method, document.baseURI).toString();
    }

    var vendorAssemblerPromise = null;
    /** Fetch + evaluate the vendored official Conversation assembler bundle. */
    function loadVendorAssembler() {
      if (vendorAssemblerPromise) return vendorAssemblerPromise;
      vendorAssemblerPromise = vendorSource('vendor-assembler', 'assembler')
        .then(function (source) {
          var module = { exports: {} };
          var factory = new Function('module', 'exports', 'require', source);
          factory(module, module.exports, require);
          return module.exports;
        })
        .catch(function (error) {
          vendorAssemblerPromise = null;
          throw error;
        });
      return vendorAssemblerPromise;
    }

    /** Replace bridge-projected messages with the official fold of raw events.
     *  Events are fetched incrementally (afterSeq cursor) and cached per panel;
     *  a cursor gap or session switch refolds the window from scratch. */
    var officialEventCache = { key: null, events: [], cursor: 0, hasOlder: false };
    /** Last successful fold for the current session/window; reused when an
     *  incremental poll carries no new events. */
    var officialFoldCache = { key: null, data: null };
    /** Remote attachment bytes as data URLs, cached for the panel lifetime. */
    var officialImageCache = new Map();
    function loadRemoteImage(peerId, sessionId, attachment) {
      var attachmentId = attachment && (attachment.attachmentId || attachment.id);
      if (!attachmentId) return Promise.reject(new Error('attachment id missing'));
      var cacheKey = String(peerId) + ':' + String(sessionId) + ':' + String(attachmentId);
      var cached = officialImageCache.get(cacheKey);
      if (cached) return Promise.resolve(cached);
      return post('attachment', { peerId: peerId, sessionId: sessionId, attachmentId: attachmentId }).then(function (result) {
        var data = result && result.data ? String(result.data) : '';
        var mediaType = (result && result.attachment && result.attachment.mediaType) || (attachment && attachment.mediaType) || 'image/png';
        if (!data) throw new Error('empty attachment');
        var url = 'data:' + mediaType + ';base64,' + data;
        if (officialImageCache.size > 64) officialImageCache.clear();
        officialImageCache.set(cacheKey, url);
        return url;
      });
    }

    /** Merge the last fold into a transcript payload that carried no events. */
    function mergeCachedFold(data, cacheKey) {
      if (!data || !officialFoldCache.data || officialFoldCache.key !== cacheKey) return data;
      var cached = officialFoldCache.data;
      return Object.assign({}, data, {
        messages: cached.messages,
        officialFold: true,
        official: cached.official,
        sessionModel: cached.sessionModel || data.sessionModel || null,
        sessionModelRevision: cached.sessionModelRevision,
        sessionPermission: cached.sessionPermission || data.sessionPermission || null,
        sessionPermissionRevision: cached.sessionPermissionRevision,
        sessionGoal: cached.sessionGoal,
        officialRunning: cached.officialRunning,
        officialHistory: cached.officialHistory,
      });
    }

    function enrichTranscriptWithOfficialFold(peerId, sessionId, data, eventWindow, prefetchedEvents) {
      var windowSize = Math.max(200, Number(eventWindow) || 800);
      var cacheKey = String(peerId) + ':' + String(sessionId) + ':' + String(windowSize);
      if (officialEventCache.key !== cacheKey) {
        officialEventCache = { key: cacheKey, events: [], cursor: 0, hasOlder: false };
      }
      return loadVendorAssembler()
        .then(function (vendor) {
          if (typeof vendor.createChatAssembler !== 'function') return data;
          var afterSeq = officialEventCache.cursor;
          var eventsPromise = prefetchedEvents
            ? Promise.resolve(prefetchedEvents)
            : post('events', { peerId: peerId, sessionId: sessionId, afterSeq: afterSeq, limit: windowSize });
          return eventsPromise.then(function (eventsData) {
            var fresh = eventsData && Array.isArray(eventsData.events) ? eventsData.events : [];
            if (afterSeq > 0) {
              fresh = fresh.filter(function (event) {
                return event && typeof event.seq === 'number' && event.seq > afterSeq;
              });
            }
            var events = fresh;
            if (afterSeq > 0) {
              var gap = eventsData.truncated === true;
              events = gap ? fresh : officialEventCache.events.concat(fresh);
            }
            if (events.length === 0) return mergeCachedFold(data, cacheKey);
            officialEventCache.events = events;
            officialEventCache.cursor = events.length > 0 ? events[events.length - 1].seq || 0 : afterSeq;
            if (afterSeq === 0) officialEventCache.hasOlder = eventsData.hasOlder === true;
            var sessionModel = null;
            var sessionPermission = null;
            var selectedModel = null;
            var usedModel = null;
            var selectedModelRevision = null;
            var usedModelRevision = null;
            var sessionPermissionRevision = null;
            var sessionGoal = null;
            var officialRunning = null;
            for (var runningIndex = events.length - 1; runningIndex >= 0; runningIndex -= 1) {
              var runningEvent = events[runningIndex];
              if (!runningEvent || typeof runningEvent.type !== 'string') continue;
              if (runningEvent.type === 'turn/end') { officialRunning = false; break; }
              if (runningEvent.type === 'turn/start') { officialRunning = true; break; }
            }
            for (var goalIndex = 0; goalIndex < events.length; goalIndex += 1) {
              var goalEvent = events[goalIndex];
              if (goalEvent && goalEvent.type === 'goal/change' && goalEvent.data) {
                sessionGoal = goalEvent.data.operation === 'clear' ? null : goalEvent.data.goal || null;
              }
            }
            for (var eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
              var candidateEvent = events[eventIndex];
              if (sessionPermission === null && candidateEvent && candidateEvent.type === 'permission/preset' && candidateEvent.data && candidateEvent.data.preset) {
                sessionPermission = String(candidateEvent.data.preset);
                sessionPermissionRevision = candidateEvent.seq;
              }
              if (selectedModel === null && candidateEvent && candidateEvent.type === 'model/selection'
                && candidateEvent.data && candidateEvent.data.provider && candidateEvent.data.model) {
                selectedModel = candidateEvent.data;
                selectedModelRevision = candidateEvent.seq;
              }
              if (sessionPermission !== null && selectedModel !== null) break;
              var header = candidateEvent && candidateEvent.type === 'request/header' && candidateEvent.data && candidateEvent.data.header;
              var config = header && header.config;
              if (usedModel === null && config && config.provider && config.model) {
                usedModel = {
                  provider: String(config.provider),
                  model: String(config.model),
                  reasoningEffort: config.reasoningEffort ? String(config.reasoningEffort) : undefined,
                };
                usedModelRevision = candidateEvent.seq;
              }
            }
            // A saved selection is the next model, even while the last request
            // header still describes the model used by the preceding turn.
            sessionModel = selectedModel || usedModel;
            var sessionModelRevision = selectedModel ? selectedModelRevision : usedModelRevision;
            var assembler = vendor.createChatAssembler();
            assembler.replace(events);
            var rows = typeof assembler.messages === 'function' ? assembler.messages() : [];
            if (!rows || rows.length === 0) return mergeCachedFold(data, cacheKey);
            var official = null;
            try {
              var snapshot = typeof assembler.chatSnapshot === 'function' ? assembler.chatSnapshot() : null;
              var grouped = typeof assembler.snapshot === 'function' ? assembler.snapshot() : null;
              var entries = grouped && grouped.entries ? grouped.entries : [];
              var groupSources = [];
              if (grouped && typeof grouped.groupSource === 'function') {
                entries.forEach(function (entry) {
                  if (entry && entry.kind === 'group') groupSources.push([entry.key, grouped.groupSource(entry.key)]);
                });
              }
              if (snapshot && entries.length > 0) official = { snapshot: snapshot, entries: entries, groupSources: groupSources };
            } catch (error) {
              official = null;
            }
            var folded = Object.assign({}, data, {
              messages: rows,
              officialFold: true,
              official: official,
              sessionModel: sessionModel || (data && data.sessionModel) || null,
              sessionModelRevision: sessionModelRevision,
              sessionPermission: sessionPermission || (data && data.sessionPermission) || null,
              sessionPermissionRevision: sessionPermissionRevision,
              sessionGoal: sessionGoal,
              officialRunning: officialRunning,
              officialHistory: {
                hasOlder: officialEventCache.hasOlder === true,
                hasMore: eventsData.hasMore === true,
                totalEvents: typeof eventsData.totalEvents === 'number' ? eventsData.totalEvents : null,
                window: windowSize,
              },
            });
            if (folded.official) officialFoldCache = { key: cacheKey, data: folded };
            return folded;
          });
        })
        .catch(function () {
          return mergeCachedFold(data, cacheKey);
        });
    }

    var vendorChatPromise = null;
    var vendorFlowPromise = null;
    /** One vendor bundle: use the copy baked into this client, else fetch it. */
    function vendorSource(endpoint, bakedKey) {
      if (BAKED_VENDOR && typeof BAKED_VENDOR[bakedKey] === 'string') {
        return Promise.resolve(BAKED_VENDOR[bakedKey]);
      }
      return fetch(apiUrl(endpoint), { credentials: 'same-origin' })
        .then(function (response) {
          if (!response.ok) throw new Error('vendor bundle: HTTP ' + response.status);
          return response.text();
        });
    }

    /** Fetch + evaluate the vendored official ChatFlow renderer bundle. */
    function loadVendorFlow() {
      if (vendorFlowPromise) return vendorFlowPromise;
      vendorFlowPromise = vendorSource('vendor-flow', 'flow')
        .then(function (source) {
          var module = { exports: {} };
          var factory = new Function('module', 'exports', 'require', source);
          factory(module, module.exports, require);
          return module.exports;
        })
        .catch(function (error) {
          vendorFlowPromise = null;
          throw error;
        });
      return vendorFlowPromise;
    }

    /** Fetch + evaluate the official chat bundle served by the host half.
     *  The bundle is the vendored upstream ChatView tree; it shares this
     *  plugin's React instance through the factory require below. */
    function loadVendorChat() {
      if (vendorChatPromise) return vendorChatPromise;
      vendorChatPromise = vendorSource('vendor-chat', 'chat')
        .then(function (source) {
          var module = { exports: {} };
          var factory = new Function('module', 'exports', 'require', source);
          factory(module, module.exports, require);
          return module.exports;
        })
        .catch(function (error) {
          vendorChatPromise = null;
          throw error;
        });
      return vendorChatPromise;
    }

    function post(method, body) {
      var payload = body === undefined || body === null ? {} : body;
      return fetch(apiUrl(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      }).then(
        function (response) {
          return response
            .json()
            .catch(function () {
              return null;
            })
            .then(function (data) {
              if (!response.ok) {
                var failure = new Error(data && data.error ? String(data.error) : 'HTTP ' + response.status);
                failure.payload = data;
                failure.status = response.status;
                throw failure;
              }
              if (!data || data.ok === false) {
                throw new Error(data && data.error ? String(data.error) : '请求失败');
              }
              return data;
            });
        },
        function (error) {
          throw new Error('无法连接 Host：' + messageOf(error));
        },
      );
    }

    function basename(value) {
      if (!value) return '';
      var text = String(value);
      var parts = text.split(/[\\/]+/);
      for (var i = parts.length - 1; i >= 0; i -= 1) {
        if (parts[i]) return parts[i];
      }
      return text;
    }

    function toTimestamp(value) {
      if (value === null || value === undefined || value === '') return NaN;
      if (value instanceof Date) return value.getTime();
      if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
      var parsed = Date.parse(String(value));
      return parsed;
    }

    function pad2(value) {
      return value < 10 ? '0' + value : String(value);
    }

    function formatClock(value) {
      var timestamp = toTimestamp(value);
      if (!isFinite(timestamp)) return '';
      var date = new Date(timestamp);
      return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
    }

    function formatRelativeTime(value) {
      var timestamp = toTimestamp(value);
      if (!isFinite(timestamp)) return '';
      var delta = Date.now() - timestamp;
      if (delta < 0) delta = 0;
      if (delta < 60 * 1000) return '刚刚';
      if (delta < 60 * 60 * 1000) return Math.floor(delta / 60000) + '分钟';
      if (delta < 24 * 60 * 60 * 1000) return Math.floor(delta / 3600000) + '小时前';
      if (delta < 30 * 24 * 60 * 60 * 1000) return Math.floor(delta / (24 * 60 * 60 * 1000)) + '天前';
      var date = new Date(timestamp);
      return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    // ── shared styles ───────────────────────────────────────────────────────
    // Every value mirrors the official design platform (design-platform.css):
    // the panel must look like the stock Workspace list and Conversation view
    // in both themes, so colors/sizes read the same variables the shell uses.
    // Neutral fallbacks keep the panel legible in older shells.
    var C = {
      labelPrimary: 'var(--dsw-alias-label-primary, inherit)',
      labelSecondary: 'var(--dsw-alias-label-secondary, rgba(128, 128, 128, 0.85))',
      labelTertiary: 'var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.7))',
      labelCaption: 'var(--dsw-alias-label-caption, rgba(128, 128, 128, 0.55))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.1))',
      hoverSolid: 'var(--dsw-alias-interactive-bg-hover-solid, rgba(128, 128, 128, 0.14))',
      borderL2: 'var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.18))',
      inputFill: 'var(--dsw-specific-input-major, transparent)',
      bubble: 'var(--dsw-specific-bubble, rgba(77, 107, 254, 0.08))',
      sidebarFill: 'var(--dsw-specific-sidebar-fill, transparent)',
      tip: 'var(--dsw-specific-tip, rgba(128, 128, 128, 0.06))',
      accent: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
      success: 'var(--dsw-alias-state-success-primary, #2ea043)',
      danger: 'var(--dsw-alias-state-error-primary, #d1242f)',
      warn: 'var(--dsw-alias-state-warn-primary, #b45309)',
      radiusXs: 'var(--dsw-radius-xs, 4px)',
      radiusSm: 'var(--dsw-radius-sm, 8px)',
      radiusMd: 'var(--dsw-radius-md, 12px)',
      radiusLg: 'var(--dsw-radius-lg, 16px)',
      radiusXl: 'var(--dsw-radius-xl, 20px)',
      font: 'var(--dsh-content-font-size, 14px)',
      fontSecondary: 'var(--dsh-content-font-size-secondary, 13px)',
      fontDelta: 'var(--dsh-content-font-delta, 0px)',
      fontDeltaSecondary: 'var(--dsh-content-font-delta-secondary, 0px)',
      chatWidth: 'var(--dsh-chat-content-width, 748px)',
    };
    var ACCENT = C.accent;
    var SUCCESS = C.success;
    var DANGER = C.danger;
    var BORDER = C.borderL2;
    var SOFT_BG = C.hover;
    var EMPTY_ARRAY = [];
    var MONO_STACK = 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)';

    // DSH's ui-theme scrollbar.css, scoped to this plugin's page so the
    // embedded session and workspace scrollers use the same official tokens
    // without changing scrollbars in other panels.
    var REMOTE_SCROLLBAR_STYLE_ID = 'dsh-remote-session-official-scrollbars';
    var REMOTE_SCROLLBAR_CSS = [
      '[data-remote-session-root] {',
      '  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l1);',
      '  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l1);',
      '  --dsh-scrollbar-thumb-border: 0px;',
      '  --dsh-scrollbar-track-margin: 0px;',
      '  --dsh-scrollbar-width: 5px;',
      '}',
      '@supports not selector(::-webkit-scrollbar) {',
      '  [data-remote-session-root],',
      '  [data-remote-session-root] * {',
      '    scrollbar-width: thin;',
      '    scrollbar-color: var(--dsh-scrollbar-thumb) transparent;',
      '  }',
      '}',
      '[data-remote-session-root] ::-webkit-scrollbar {',
      '  width: var(--dsh-scrollbar-width);',
      '  height: var(--dsh-scrollbar-width);',
      '}',
      '[data-remote-session-root] ::-webkit-scrollbar-track {',
      '  margin-block: var(--dsh-scrollbar-track-margin);',
      '  background: transparent;',
      '}',
      '[data-remote-session-root] ::-webkit-scrollbar-thumb {',
      '  border: var(--dsh-scrollbar-thumb-border) solid transparent;',
      '  border-radius: 999px;',
      '  corner-shape: round;',
      '  background: var(--dsh-scrollbar-thumb);',
      '  background-clip: content-box;',
      '}',
      '@media (hover: hover) {',
      '  [data-remote-session-root] ::-webkit-scrollbar-thumb:hover {',
      '    background-color: var(--dsh-scrollbar-thumb-hover);',
      '  }',
      '}',
      '[data-remote-session-root] ::-webkit-scrollbar-corner {',
      '  background: transparent;',
      '}',
    ].join('\n');

    function installOfficialScrollbarStyles() {
      if (typeof document === 'undefined' || !document.head) return function () {};
      var existing = document.getElementById(REMOTE_SCROLLBAR_STYLE_ID);
      if (existing) return function () {};
      var style = document.createElement('style');
      style.id = REMOTE_SCROLLBAR_STYLE_ID;
      style.textContent = REMOTE_SCROLLBAR_CSS;
      document.head.appendChild(style);
      return function () {
        if (style.parentNode) style.parentNode.removeChild(style);
      };
    }

    var mutedSmallStyle = { fontSize: 12, lineHeight: '18px', color: C.labelTertiary };
    var captionStyle = { fontSize: 10, lineHeight: '16px', color: C.labelCaption };
    var preWrapStyle = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: C.font, lineHeight: 'calc(24px + ' + C.fontDelta + ')' };
    var buttonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      padding: '3px 8px',
      borderRadius: C.radiusSm,
      border: 'none',
      background: 'transparent',
      color: C.labelSecondary,
      fontFamily: 'inherit',
      fontSize: 12,
      lineHeight: '18px',
      cursor: 'pointer',
    };
    var primaryButtonStyle = merge(buttonStyle, {
      padding: '5px 14px',
      background: ACCENT,
      color: '#fff',
      fontWeight: 500,
      fontSize: 13,
      borderRadius: C.radiusMd,
    });
    var pageStyle = {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      width: '100%',
      boxSizing: 'border-box',
      overflow: 'hidden',
      color: C.labelPrimary,
      background: 'var(--dsw-alias-bg-base, transparent)',
    };
    var topBarStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      padding: '10px 16px',
      borderBottom: '0.5px solid ' + BORDER,
      flex: '0 0 auto',
      minWidth: 0,
    };
    var contentStyle = {
      display: 'flex',
      flex: '1 1 auto',
      minHeight: 0,
      overflow: 'hidden',
    };
    var leftColumnStyle = {
      flex: '0 0 280px',
      width: 280,
      minWidth: 240,
      maxWidth: '42%',
      borderRight: 'none',
      background: 'var(--dsw-specific-sidebar-fill, ' + C.sidebarFill + ')',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      overflow: 'hidden',
      boxSizing: 'border-box',
      padding: '0 var(--dsh-sidebar-inline-padding, 8px) 8px',
    };
    var rightColumnStyle = {
      flex: '1 1 auto',
      minWidth: 0,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    };
    var columnHeaderStyle = {
      flex: '0 0 auto',
      display: 'flex',
      alignItems: 'center',
      height: 36,
      padding: '0 4px',
      marginTop: 2,
      marginBottom: 4,
      fontSize: 12,
      fontWeight: 500,
      letterSpacing: 'normal',
      color: 'var(--dsw-alias-label-tertiary, ' + C.labelTertiary + ')',
      whiteSpace: 'nowrap',
      boxSizing: 'border-box',
    };
    var emptyHintStyle = {
      padding: '16px 12px',
      fontSize: 12,
      lineHeight: '18px',
      color: C.labelTertiary,
    };
    var emptyPaneStyle = {
      flex: '1 1 auto',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      textAlign: 'center',
    };
    var errorBannerStyle = {
      flex: '0 0 auto',
      padding: '8px 16px',
      fontSize: 12,
      lineHeight: '18px',
      color: DANGER,
      background: C.tip,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    };
    var transcriptHeaderStyle = {
      flex: '0 0 auto',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      minHeight: 30,
      padding: '10px 28px 10px 20px',
      borderBottom: '0.5px solid var(--dsw-alias-border-l3, ' + BORDER + ')',
      minWidth: 0,
    };
    var headerTitleStyle = {
      display: 'inline-block',
      maxWidth: '100%',
      overflow: 'hidden',
      padding: '4px 8px',
      border: 'none',
      borderRadius: C.radiusMd,
      background: 'transparent',
      fontSize: 14,
      lineHeight: '20px',
      fontWeight: 500,
      color: C.labelPrimary,
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    };
    var composerAddStyle = {
      display: 'grid',
      placeItems: 'center',
      flex: 'none',
      width: 28,
      height: 28,
      border: 'none',
      borderRadius: 999,
      background: 'var(--dsw-specific-selector, ' + C.inputFill + ')',
      color: C.labelPrimary,
      cursor: 'pointer',
      fontSize: 16,
      lineHeight: 1,
    };
    var composerPrimaryStyle = {
      display: 'grid',
      placeItems: 'center',
      flex: 'none',
      width: 34,
      height: 34,
      border: 'none',
      borderRadius: 999,
      background: 'var(--dsw-alias-button-info-fill, ' + ACCENT + ')',
      color: '#fff',
      cursor: 'pointer',
      transform: 'translateY(-2px)',
      transition: 'background-color 100ms ease',
      padding: 0,
    };
    var headerIconButtonStyle = {
      flex: '0 0 auto',
      width: 28,
      height: 28,
      padding: 0,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: 'none',
      borderRadius: C.radiusSm,
      background: 'transparent',
      color: C.labelSecondary,
      cursor: 'pointer',
      fontSize: 14,
      lineHeight: 1,
    };
    var transcriptBodyStyle = {
      flex: '1 1 auto',
      minHeight: 0,
      overflowY: 'auto',
      overflowX: 'hidden',
      padding: '16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    };
    var rowColumnStyle = {
      width: '100%',
      maxWidth: C.chatWidth,
      margin: '0 auto',
      boxSizing: 'border-box',
      minWidth: 0,
    };
    var metaRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      minWidth: 0,
      fontSize: 12,
      lineHeight: '18px',
      color: C.labelTertiary,
    };
    var messageCardStyle = rowColumnStyle;
    var userCardStyle = {};
    var assistantBodyStyle = {
      fontSize: C.font,
      lineHeight: 'calc(24px + ' + C.fontDelta + ')',
      color: C.labelPrimary,
      overflowWrap: 'anywhere',
    };
    var userBubbleStyle = {
      display: 'flex',
      flexDirection: 'column',
      maxWidth: 'min(calc(' + C.chatWidth + ' * 0.702), 82%)',
      background: C.bubble,
      borderRadius: C.radiusLg,
      padding: '8px 12px',
      boxSizing: 'border-box',
    };
    var toolCardStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      width: '100%',
      minHeight: 'calc(33px + ' + C.fontDelta + ')',
      padding: '0 0 8px',
      border: 'none',
      borderBottom: '0.5px solid ' + BORDER,
      background: 'none',
      color: C.labelTertiary,
      font: 'inherit',
      fontSize: C.font,
      textAlign: 'left',
      cursor: 'pointer',
      boxSizing: 'border-box',
    };
    var toolErrorCardStyle = { color: DANGER, borderBottomColor: 'rgba(209, 36, 47, 0.35)' };
    var toolBodyStyle = {
      marginTop: 4,
      padding: '8px 10px',
      borderRadius: C.radiusSm,
      background: C.tip,
      fontFamily: MONO_STACK,
      fontSize: 12,
      lineHeight: '18px',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      maxHeight: 260,
      overflow: 'auto',
      color: C.labelSecondary,
    };
    var composerStyle = {
      flex: '0 0 auto',
      minWidth: 0,
      position: 'relative',
      // The panel sits outside ConversationRoot, so publish the same width
      // axis the official InputBar receives from its embedded body.
      '--dsh-chat-content-width': 'min(calc(100% - 32px), 920px)',
      '--dsh-composer-card-max-width': 'min(calc(100% - 16px), 952px)',
      '--dsh-composer-side-clearance': '8px',
      '--dsh-composer-text-max-height': '336px',
    };
    // Legacy fallback is used only when the official vendor bundle cannot load.
    var composerBoxStyle = {
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: 764,
      margin: '0 auto',
      border: '0.5px solid ' + BORDER,
      borderRadius: 'var(--dsw-radius-panel, 20px)',
      background: C.inputFill,
      boxShadow: 'var(--dsw-elevation-soft, 0 2px 12px rgba(0, 0, 0, 0.06))',
      paddingTop: 8,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      fontSize: C.font,
      lineHeight: 'calc(24px + ' + C.fontDelta + ')',
    };
    var textareaStyle = {
      width: '100%',
      boxSizing: 'border-box',
      resize: 'none',
      minHeight: 36,
      maxHeight: 200,
      padding: '4px 8px 0 14px',
      border: 'none',
      background: 'transparent',
      color: C.labelPrimary,
      fontFamily: 'inherit',
      fontSize: C.font,
      lineHeight: 'calc(24px + ' + C.fontDelta + ')',
      outline: 'none',
    };

    // ── primitives ──────────────────────────────────────────────────────────
    function hoverIn(event) {
      if (event && event.currentTarget) event.currentTarget.style.background = C.hover;
    }

    function hoverOut(event, idleBackground) {
      if (event && event.currentTarget) event.currentTarget.style.background = idleBackground || 'transparent';
    }

    function Dot(props) {
      var size = typeof props.size === 'number' ? props.size : 8;
      var color = props.color || 'transparent';
      return h('span', {
        'aria-hidden': 'true',
        style: {
          display: 'inline-block',
          flex: '0 0 auto',
          width: size,
          height: size,
          borderRadius: '50%',
          background: color,
        },
      });
    }

    // Catches a MarkdownText crash (unknown host version, bad node shape) and
    // renders the raw text instead of blanking the whole panel.
    class MarkdownBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[dsh-remote-session] MarkdownText failed, falling back to plain text:', error);
        }
      }

      render() {
        if (this.state.failed) {
          return h('div', { style: preWrapStyle }, String(this.props.text || ''));
        }
        return this.props.children;
      }
    }

    /* ------------------------------------------------------------------ *
     * Markdown (official token ladder: body 14/24, block gap 16, inline code
     * pill, fenced code block, bordered tables). The shell's MarkdownText is
     * not usable for remote content (it needs the official conversation
     * context), so this compact renderer keeps the same visual grammar.
     * ------------------------------------------------------------------ */

    var MD = {
      blockGap: 16,
      headingColor: 'inherit',
      inlineCode: {
        fontFamily: MONO_STACK,
        fontSize: '0.86em',
        padding: '1px 5px',
        borderRadius: 'var(--dsw-radius-xs, 4px)',
        background: 'var(--dsw-alias-markdown-inline-code, rgba(128, 128, 128, 0.14))',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      codeBlock: {
        margin: 0,
        padding: '12px 16px',
        overflow: 'auto',
        border: '0.5px solid ' + C.borderL2,
        borderRadius: C.radiusLg,
        background: 'var(--dsw-alias-markdown-code-block, rgba(128, 128, 128, 0.08))',
        color: C.labelPrimary,
        fontFamily: MONO_STACK,
        fontSize: 12,
        lineHeight: '20px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      table: {
        borderCollapse: 'collapse',
        width: '100%',
        fontSize: C.fontSecondary,
        lineHeight: '22px',
      },
      th: {
        padding: '6px 10px',
        border: '0.5px solid ' + C.borderL2,
        background: 'var(--dsw-alias-markdown-code-block-banner, rgba(128, 128, 128, 0.07))',
        textAlign: 'left',
        fontWeight: 600,
      },
      td: {
        padding: '6px 10px',
        border: '0.5px solid ' + C.borderL2,
        verticalAlign: 'top',
      },
      link: { color: ACCENT, textDecoration: 'none' },
    };

    /** Inline markdown: **bold**, *italic*, `code`, [text](link). */
    function renderInline(text, keyPrefix) {
      var nodes = [];
      var pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*\n]+\*)/u;
      var rest = String(text || '');
      var index = 0;
      while (rest.length > 0) {
        var match = pattern.exec(rest);
        if (!match) {
          nodes.push(rest);
          break;
        }
        if (match.index > 0) nodes.push(rest.slice(0, match.index));
        var token = match[0];
        var key = keyPrefix + '-i' + index++;
        if (token.startsWith('**')) {
          nodes.push(h('strong', { key: key }, token.slice(2, -2)));
        } else if (token.startsWith('`')) {
          nodes.push(h('code', { key: key, style: MD.inlineCode }, token.slice(1, -1)));
        } else if (token.startsWith('[')) {
          var linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(token);
          nodes.push(
            h('a', { key: key, href: linkMatch ? linkMatch[2] : '#', target: '_blank', rel: 'noreferrer', style: MD.link }, linkMatch ? linkMatch[1] : token),
          );
        } else {
          nodes.push(h('em', { key: key }, token.slice(1, -1)));
        }
        rest = rest.slice(match.index + token.length);
      }
      return nodes;
    }

    function mdBlocks(text) {
      var lines = String(text || '').replace(/\r\n?/gu, '\n').split('\n');
      var blocks = [];
      var index = 0;
      while (index < lines.length) {
        var line = lines[index];
        if (/^\s*$/u.test(line)) {
          index += 1;
          continue;
        }
        var fence = /^\s*```\s*([\w+-]*)\s*$/u.exec(line);
        if (fence) {
          var code = [];
          index += 1;
          while (index < lines.length && !/^\s*```\s*$/u.test(lines[index])) {
            code.push(lines[index]);
            index += 1;
          }
          index += 1;
          blocks.push({ kind: 'code', text: code.join('\n') });
          continue;
        }
        if (/^\s*([-*_])\s*(?:\1\s*){2}$/u.test(line)) {
          blocks.push({ kind: 'hr' });
          index += 1;
          continue;
        }
        var heading = /^(#{1,6})\s+(.*)$/u.exec(line);
        if (heading) {
          blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
          index += 1;
          continue;
        }
        if (/^\s*\|/u.test(line) && index + 1 < lines.length && /^\s*\|[\s:|-]+\|/u.test(lines[index + 1])) {
          var headCells = splitRow(line);
          var alignRow = splitRow(lines[index + 1]);
          var rows = [];
          index += 2;
          while (index < lines.length && /^\s*\|/u.test(lines[index])) {
            rows.push(splitRow(lines[index]));
            index += 1;
          }
          blocks.push({ kind: 'table', head: headCells, aligns: alignRow, rows: rows });
          continue;
        }
        if (/^\s*[-*+]\s+\[/u.test(line)) {
          var tasks = [];
          while (index < lines.length && /^\s*[-*+]\s+\[/u.test(lines[index])) {
            var task = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/u.exec(lines[index]);
            tasks.push({ done: task[1].toLowerCase() === 'x', text: task[2] });
            index += 1;
          }
          blocks.push({ kind: 'tasks', items: tasks });
          continue;
        }
        if (/^\s*[-*+]\s+/u.test(line)) {
          var bullets = [];
          while (index < lines.length && /^\s*[-*+]\s+/u.test(lines[index])) {
            bullets.push(lines[index].replace(/^\s*[-*+]\s+/u, ''));
            index += 1;
          }
          blocks.push({ kind: 'ul', items: bullets });
          continue;
        }
        if (/^\s*\d+[.)]\s+/u.test(line)) {
          var numbered = [];
          while (index < lines.length && /^\s*\d+[.)]\s+/u.test(lines[index])) {
            numbered.push(lines[index].replace(/^\s*\d+[.)]\s+/u, ''));
            index += 1;
          }
          blocks.push({ kind: 'ol', items: numbered });
          continue;
        }
        if (/^\s*>/u.test(line)) {
          var quote = [];
          while (index < lines.length && /^\s*>/u.test(lines[index])) {
            quote.push(lines[index].replace(/^\s*>\s?/u, ''));
            index += 1;
          }
          blocks.push({ kind: 'quote', text: quote.join('\n') });
          continue;
        }
        var paragraph = [];
        while (
          index < lines.length &&
          !/^\s*$/u.test(lines[index]) &&
          !/^\s*```/u.test(lines[index]) &&
          !/^#{1,6}\s/u.test(lines[index]) &&
          !/^\s*[-*+]\s+/u.test(lines[index]) &&
          !/^\s*\d+[.)]\s+/u.test(lines[index]) &&
          !/^\s*>/u.test(lines[index]) &&
          !/^\s*\|/u.test(lines[index])
        ) {
          paragraph.push(lines[index]);
          index += 1;
        }
        if (paragraph.length) blocks.push({ kind: 'p', text: paragraph.join('\n') });
      }
      return blocks;
    }

    function splitRow(line) {
      return line
        .trim()
        .replace(/^\|/u, '')
        .replace(/\|$/u, '')
        .split('|')
        .map(function (cell) {
          return cell.trim();
        });
    }

    /** Render markdown blocks with the official conversation typography. */
    function renderMarkdownBlocks(text) {
      var blocks = mdBlocks(text);
      return blocks.map(function (block, index) {
        var key = 'md-' + index;
        if (block.kind === 'code') return h('pre', { key: key, style: MD.codeBlock }, block.text);
        if (block.kind === 'hr') {
          return h('hr', { key: key, style: { margin: '4px 0', border: 0, borderTop: '0.5px solid ' + BORDER } });
        }
        if (block.kind === 'heading') {
          var sizes = { 1: 20, 2: 17, 3: 15, 4: 14, 5: 14, 6: 13 };
          return h(
            'div',
            {
              key: key,
              style: {
                fontSize: sizes[block.level] || 14,
                lineHeight: 'calc(28px + ' + C.fontDelta + ')',
                fontWeight: 600,
                color: MD.headingColor,
              },
            },
            renderInline(block.text, key),
          );
        }
        if (block.kind === 'table') {
          return h(
            'div',
            { key: key, style: { overflowX: 'auto', minWidth: 0 } },
            h(
              'table',
              { style: MD.table },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  block.head.map(function (cell, cellIndex) {
                    return h('th', { key: key + '-h' + cellIndex, style: MD.th }, renderInline(cell, key + '-h' + cellIndex));
                  }),
                ),
              ),
              h(
                'tbody',
                null,
                block.rows.map(function (row, rowIndex) {
                  return h(
                    'tr',
                    { key: key + '-r' + rowIndex },
                    row.map(function (cell, cellIndex) {
                      return h(
                        'td',
                        { key: key + '-r' + rowIndex + 'c' + cellIndex, style: MD.td },
                        renderInline(cell, key + '-r' + rowIndex + 'c' + cellIndex),
                      );
                    }),
                  );
                }),
              ),
            ),
          );
        }
        if (block.kind === 'ul' || block.kind === 'ol') {
          return h(
            block.kind,
            { key: key, style: { margin: 0, paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 4 } },
            block.items.map(function (item, itemIndex) {
              return h('li', { key: key + '-' + itemIndex }, renderInline(item, key + '-' + itemIndex));
            }),
          );
        }
        if (block.kind === 'tasks') {
          return h(
            'div',
            { key: key, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            block.items.map(function (item, itemIndex) {
              return h(
                'div',
                { key: key + '-' + itemIndex, style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
                h('span', { style: { flex: '0 0 auto', color: item.done ? SUCCESS : C.labelTertiary } }, item.done ? '☑' : '☐'),
                h('span', null, renderInline(item.text, key + '-' + itemIndex)),
              );
            }),
          );
        }
        if (block.kind === 'quote') {
          return h(
            'div',
            {
              key: key,
              style: {
                borderLeft: '3px solid ' + BORDER,
                paddingLeft: 12,
                color: C.labelSecondary,
              },
            },
            renderInline(block.text.replace(/\n+/gu, ' '), key),
          );
        }
        return h(
          'p',
          { key: key, style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
          renderInline(block.text, key),
        );
      });
    }

    function MessageBody(props) {
      var text = String(props.text || '');
      if (!text) return h('div', { style: mutedSmallStyle }, '（空消息）');
      if (props.role === 'assistant') {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: MD.blockGap } }, renderMarkdownBlocks(text));
      }
      return h('div', { style: preWrapStyle }, text);
    }

    /** Tool name → official process activity kind (step-process.ts vocabulary). */
    function activityKind(name) {
      var text = String(name || '').toLowerCase();
      if (/readimage/.test(text)) return 'readImage';
      if (/read|browse|view|cat|head|tail/.test(text)) return 'read';
      if (/search|grep|find/.test(text)) return 'search';
      if (/edit|patch|replace/.test(text)) return 'edit';
      if (/write/.test(text)) return 'write';
      if (/bash|run|exec|shell|cmd|terminal/.test(text)) return 'commands';
      if (/websearch/.test(text)) return 'webSearch';
      if (/webfetch|fetch|http|url/.test(text)) return 'webFetch';
      if (/agent|task|subagent/.test(text)) return 'subagents';
      if (/plan|todo/.test(text)) return 'plan';
      if (/ask|question/.test(text)) return 'questions';
      return 'tools';
    }

    var ACTIVITY_RUNNING = {
      thinking: '正在分析请求',
      read: '正在读取文件',
      readImage: '正在读取图片',
      write: '正在写入文件',
      search: '正在搜索代码',
      edit: '正在编辑文件',
      commands: '正在运行命令',
      code: '正在运行代码',
      webSearch: '正在搜索网页',
      webFetch: '正在访问网页',
      subagents: '正在协调子智能体',
      plan: '正在更新计划',
      questions: '等待你的操作',
      tools: '正在调用工具',
    };
    var ACTIVITY_DONE = {
      thinking: '已完成分析',
      read: '已读取文件',
      readImage: '已读取图片',
      write: '已写入文件',
      search: '已搜索代码',
      edit: '修改了文件',
      commands: '执行了命令',
      code: '运行了代码',
      webSearch: '已搜索网页',
      webFetch: '已访问网页',
      subagents: '已协调子智能体',
      plan: '更新了计划',
      questions: '向用户提出了问题',
      tools: '已调用工具',
    };

    /** 14px activity icons drawn in the official outline style. */
    function ActivityIcon(props) {
      var kind = props.kind || 'tools';
      var common = {
        width: 14,
        height: 14,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
      };
      if (kind === 'chevronDown') {
        return h('svg', common, h('path', { d: 'm8 10 4 4 4-4' }));
      }
      if (kind === 'chevronUp') {
        return h('svg', common, h('path', { d: 'm8 14 4-4 4 4' }));
      }
      if (kind === 'read' || kind === 'readImage') {
        return h('svg', common, h('path', { d: 'M2.5 5.5c3.5-1.2 6.5-1.2 9.5.8v12c-3-2-6-2-9.5-.8z' }), h('path', { d: 'M21.5 5.5c-3.5-1.2-6.5-1.2-9.5.8v12c3-2 6-2 9.5-.8z' }));
      }
      if (kind === 'edit' || kind === 'write') {
        return h('svg', common, h('path', { d: 'M15.5 4.5 19.5 8.5 8 20H4v-4z' }), h('path', { d: 'M13.5 6.5l4 4' }));
      }
      if (kind === 'search' || kind === 'webSearch') {
        return h('svg', common, h('circle', { cx: 10.5, cy: 10.5, r: 6.5 }), h('path', { d: 'm15.5 15.5 5 5' }));
      }
      if (kind === 'commands' || kind === 'code') {
        return h('svg', common, h('rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2.5 }), h('path', { d: 'm7 9 2.5 3L7 15' }), h('path', { d: 'M12.5 15h4' }));
      }
      if (kind === 'webFetch') {
        return h('svg', common, h('circle', { cx: 12, cy: 12, r: 8.5 }), h('path', { d: 'M3.5 12h17' }), h('path', { d: 'M12 3.5c4.5 4.8 4.5 12.2 0 17' }));
      }
      if (kind === 'subagents') {
        return h('svg', common, h('rect', { x: 4, y: 8, width: 7, height: 7, rx: 1.5 }), h('rect', { x: 13, y: 4, width: 7, height: 7, rx: 1.5 }), h('path', { d: 'M11 11h2V7.5' }));
      }
      if (kind === 'plan') {
        return h('svg', common, h('rect', { x: 4.5, y: 4, width: 15, height: 16, rx: 2 }), h('path', { d: 'M8.5 9h7M8.5 12.5h7M8.5 16h4' }));
      }
      if (kind === 'questions') {
        return h('svg', common, h('circle', { cx: 12, cy: 12, r: 8.5 }), h('path', { d: 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7' }), h('path', { d: 'M12 17h.01' }));
      }
      return h('svg', common, h('path', { d: 'M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 20.5l-1.9-5.7L4.5 11 10.1 9z' }));
    }

    function ToolRow(props) {
      var message = props.message || {};
      var tool = message.tool || {};
      var isError = !!tool.isError;
      var expandedState = React.useState(false);
      var hoverState = React.useState(false);
      var expanded = expandedState[0];
      var setExpanded = expandedState[1];
      var hovered = hoverState[0];
      var setHovered = hoverState[1];
      var toolName = tool.name ? String(tool.name) : 'tool';
      var args = tool.args ? String(tool.args) : '';
      var result = String(message.text || '');
      var summary = String(tool.detail || args || result).replace(/\s+/gu, ' ').trim();
      var time = formatClock(message.at);

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0 } },
        h(
          'div',
          {
            onMouseEnter: function () {
              setHovered(true);
            },
            onMouseLeave: function () {
              setHovered(false);
            },
            style: {
              display: 'flex',
              alignItems: 'center',
              minWidth: 0,
              height: 'calc(24px + ' + C.fontDelta + ')',
              color: isError ? DANGER : hovered ? C.labelSecondary : C.labelTertiary,
              transition: 'color 100ms ease',
              cursor: 'pointer',
            },
            onClick: function () {
              setExpanded(!expanded);
            },
          },
          h(
            'span',
            {
              style: {
                flex: 'none',
                width: 'calc(16px + ' + C.fontDelta + ')',
                height: 'calc(16px + ' + C.fontDelta + ')',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginRight: 6,
                color: 'inherit',
                fontSize: 13,
                lineHeight: 1,
              },
            },
            expanded ? h(ActivityIcon, { kind: 'chevronUp' }) : hovered ? h(ActivityIcon, { kind: 'chevronDown' }) : h(ActivityIcon, { kind: activityKind(toolName) }),
          ),
          h(
            'span',
            {
              style: {
                flex: 'none',
                fontSize: C.fontSecondary,
                lineHeight: 'calc(24px + ' + C.fontDelta + ')',
                color: 'inherit',
              },
            },
            '工具调用',
          ),
          h('span', {
            style: {
              flex: 'none',
              width: 2,
              height: 2,
              margin: '0 8px',
              borderRadius: 1,
              background: C.labelCaption,
            },
          }),
          h(
            'span',
            {
              style: {
                flex: 'none',
                fontSize: C.fontSecondary,
                lineHeight: 'calc(24px + ' + C.fontDelta + ')',
                color: 'inherit',
              },
            },
            toolName,
          ),
          h('span', {
            style: {
              flex: 'none',
              width: 2,
              height: 2,
              margin: '0 8px',
              borderRadius: 1,
              background: C.labelCaption,
            },
          }),
          h(
            'span',
            {
              title: summary,
              style: {
                flex: '1 1 auto',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: C.fontSecondary,
                lineHeight: 'calc(24px + ' + C.fontDelta + ')',
                color: isError ? DANGER : 'inherit',
              },
            },
            summary,
          ),
          time
            ? h(
                'span',
                {
                  style: {
                    flex: '0 0 auto',
                    marginLeft: 8,
                    fontSize: 10,
                    lineHeight: '16px',
                    color: C.labelCaption,
                    whiteSpace: 'nowrap',
                  },
                },
                time,
              )
            : null,
        ),
        expanded
          ? h(
              'div',
              {
                style: {
                  boxSizing: 'border-box',
                  width: 'calc(100% - 22px - ' + C.fontDelta + ')',
                  maxHeight: 141,
                  margin: '4px 0 4px calc(22px + ' + C.fontDelta + ')',
                  overflow: 'auto',
                  padding: '10px 16px 12px 12px',
                  borderRadius: C.radiusMd,
                  background: 'var(--dsw-alias-markdown-code-block, rgba(128, 128, 128, 0.1))',
                  color: isError ? DANGER : C.labelTertiary,
                  font: '400 11px/16px ' + MONO_STACK,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                },
              },
              args ? '参数\n' + args + (result ? '\n\n' : '') : '',
              result,
            )
          : null,
      );
    }

    /** Collapse consecutive tool calls into one official-style "process" row. */
    function ToolGroup(props) {
      var tools = props.tools || EMPTY_ARRAY;
      var expandedState = React.useState(false);
      var expanded = expandedState[0];
      var setExpanded = expandedState[1];
      var errorCount = 0;
      var running = false;
      for (var i = 0; i < tools.length; i += 1) {
        var tool = tools[i] && tools[i].tool ? tools[i].tool : {};
        if (tool.isError) errorCount += 1;
        if (!tool.done) running = true;
      }
      var last = tools[tools.length - 1] || {};
      var time = formatClock(last.at);
      return h(
        'div',
        { style: rowColumnStyle },
        h(
          'button',
          {
            type: 'button',
            onClick: function () {
              setExpanded(!expanded);
            },
            style: merge(toolCardStyle, errorCount ? { color: DANGER } : null),
          },
          h('span', { style: { flex: '0 0 12px', color: C.labelCaption, transform: expanded ? 'rotate(90deg)' : 'none' } }, '›'),
          h('span', { style: { flex: '0 0 auto', fontWeight: 500 } }, running ? '⏳' : '⚙'),
          h('span', { style: { flex: '0 0 auto', fontWeight: 500, color: C.labelSecondary } }, '运行 ' + tools.length + ' 个工具'),
          errorCount
            ? h('span', { style: merge(metaRowStyle, { flex: '0 0 auto', color: DANGER }) }, errorCount + ' 个失败')
            : null,
          h('span', { style: { flex: '1 1 auto' } }),
          time ? h('span', { style: merge(captionStyle, { flex: '0 0 auto' }) }, time) : null,
        ),
        expanded
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 14 } },
              tools.map(function (message, index) {
                var key = (message.tool && message.tool.callId) || 'tool-' + index;
                return h(ToolRow, { key: key, message: message });
              }),
            )
          : null,
      );
    }

    /** Thinking row: official ReasoningRow geometry (24px row + trace body). */
    function ReasoningRow(props) {
      var message = props.message || {};
      var text = String(message.text || '');
      var expandedState = React.useState(false);
      var hoverState = React.useState(false);
      var expanded = expandedState[0];
      var setExpanded = expandedState[1];
      var hovered = hoverState[0];
      var setHovered = hoverState[1];
      var firstLine = text.split(/\n+/u)[0].slice(0, 140);
      var time = formatClock(message.at);
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0 } },
        h(
          'div',
          {
            onMouseEnter: function () {
              setHovered(true);
            },
            onMouseLeave: function () {
              setHovered(false);
            },
            onClick: function () {
              setExpanded(!expanded);
            },
            style: {
              display: 'flex',
              alignItems: 'center',
              minWidth: 0,
              height: 'calc(24px + ' + C.fontDelta + ')',
              color: hovered ? C.labelSecondary : C.labelTertiary,
              transition: 'color 100ms ease',
              cursor: 'pointer',
            },
          },
          h(
            'span',
            {
              style: {
                flex: 'none',
                width: 'calc(16px + ' + C.fontDelta + ')',
                height: 'calc(16px + ' + C.fontDelta + ')',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginRight: 6,
                color: 'inherit',
              },
            },
            expanded ? h(ActivityIcon, { kind: 'chevronUp' }) : hovered ? h(ActivityIcon, { kind: 'chevronDown' }) : h(ActivityIcon, { kind: 'thinking' }),
          ),
          h(
            'span',
            {
              style: {
                flex: 'none',
                fontSize: C.fontSecondary,
                lineHeight: 'calc(24px + ' + C.fontDelta + ')',
                color: 'inherit',
              },
            },
            '思考',
          ),
          firstLine
            ? h('span', { style: { flex: 'none', width: 2, height: 2, margin: '0 8px', borderRadius: 1, background: C.labelCaption } })
            : null,
          firstLine
            ? h(
                'span',
                {
                  title: firstLine,
                  style: {
                    flex: '1 1 auto',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: C.fontSecondary,
                    lineHeight: 'calc(24px + ' + C.fontDelta + ')',
                    color: 'inherit',
                  },
                },
                firstLine,
              )
            : h('span', { style: { flex: '1 1 auto' } }),
          time
            ? h('span', { style: { flex: '0 0 auto', marginLeft: 8, fontSize: 10, lineHeight: '16px', color: C.labelCaption, whiteSpace: 'nowrap' } }, time)
            : null,
        ),
        expanded
          ? h(
              'div',
              {
                style: {
                  padding: '4px 0 4px calc(22px + ' + C.fontDelta + ')',
                  color: C.labelTertiary,
                  fontSize: C.fontSecondary,
                  lineHeight: 'calc(20px + ' + C.fontDeltaSecondary + ')',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 360,
                  overflow: 'auto',
                },
              },
              text,
            )
          : null,
      );
    }

    /** Countdown-free run duration parts, matching the official zh copy. */
    function runDurationParts(ms) {
      var total = Math.max(0, Math.floor(ms / 1000));
      var hours = Math.floor(total / 3600);
      var minutes = Math.floor(total / 60) % 60;
      var seconds = total % 60;
      var parts = [];
      if (hours > 0) parts.push({ text: String(hours), numeric: true }, { text: ' 小时' });
      if (total >= 60) parts.push({ text: String(minutes), numeric: true }, { text: ' 分' });
      parts.push({ text: String(seconds), numeric: true }, { text: ' 秒' });
      return parts;
    }

    /** Ordered activity kinds for one turn's process items (count desc). */
    function processKinds(items) {
      var counts = {};
      var order = [];
      (items || []).forEach(function (message) {
        if (!message || message.role !== 'tool') return;
        var kind = activityKind(message.tool && message.tool.name);
        if (!counts[kind]) {
          counts[kind] = 0;
          order.push(kind);
        }
        counts[kind] += 1;
      });
      return order
        .map(function (kind) {
          return { kind: kind, count: counts[kind] };
        })
        .sort(function (left, right) {
          return right.count - left.count;
        });
    }

    /** Official processTitle composition: top three done labels joined by 、 + 等. */
    function doneProcessTitle(items) {
      var kinds = processKinds(items);
      if (kinds.length === 0) return ACTIVITY_DONE.thinking;
      var labels = kinds.slice(0, 3).map(function (entry) {
        return ACTIVITY_DONE[entry.kind] || ACTIVITY_DONE.tools;
      });
      if (labels.length === 1) return labels[0];
      if (labels.length === 2) return labels[0] + '，' + labels[1];
      return labels[0] + '，' + labels[1] + '，' + labels[2] + (kinds.length > 3 ? '等' : '');
    }

    /** Last running activity of a turn (ChatGroupSeat live header). */
    function runningActivity(processItems) {
      var lastTool = null;
      (processItems || []).forEach(function (message) {
        if (message && message.role === 'tool') lastTool = message;
      });
      if (!lastTool) return { kind: 'thinking', detail: '' };
      var tool = lastTool.tool || {};
      // Official live detail: host 半已按官方字段提取（command/file_path/...）
      var summary = typeof tool.detail === 'string' ? tool.detail : '';
      var args = tool.args ? String(tool.args) : '';
      var args = '';
      var parsed = null;
      summary = summary || '';
      if (!summary) summary = String(lastTool.text || '');
      if (!summary) summary = '';
      return { kind: activityKind(tool.name), detail: summary };
    }

    /** Process group header, ported from ChatGroupSeat: leading icon/chevron swap. */
    function ProcessGroupHeader(props) {
      var open = props.open === true;
      var hoverState = React.useState(false);
      var hovered = hoverState[0];
      var setHovered = hoverState[1];
      var showChevron = open || hovered;
      return h(
        'button',
        {
          type: 'button',
          'aria-expanded': open,
          onClick: props.onToggle,
          onMouseEnter: function () {
            setHovered(true);
          },
          onMouseLeave: function () {
            setHovered(false);
          },
          style: {
            display: 'flex',
            maxWidth: '100%',
            alignItems: 'center',
            gap: 6,
            padding: open ? '0 0 8px' : 0,
            border: 0,
            background: 'none',
            color: hovered ? C.labelSecondary : C.labelTertiary,
            font: 'inherit',
            fontSize: C.font,
            lineHeight: 'calc(24px + ' + C.fontDelta + ')',
            textAlign: 'left',
            cursor: 'pointer',
            transition: 'color 100ms ease',
          },
        },
        h(
          'span',
          {
            style: {
              flex: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 'calc(16px + ' + C.fontDelta + ')',
              height: 'calc(16px + ' + C.fontDelta + ')',
              color: 'inherit',
            },
          },
          showChevron
            ? h(ActivityIcon, { kind: open ? 'chevronUp' : 'chevronDown' })
            : h(ActivityIcon, { kind: props.iconKind || 'thinking' }),
        ),
        h(
          'span',
          {
            style: {
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          },
          props.label,
          props.detail ? h('span', { style: { color: C.labelCaption } }, ' · ' + props.detail) : null,
        ),
      );
    }

    /** Collapsed Turn process row: official label + chevron + hairline. */
    function TurnProcessRow(props) {
      var open = props.open === true;
      var expandable = props.expandable !== false;
      return h(
        'button',
        {
          type: 'button',
          disabled: !expandable,
          onClick: function () {
            if (expandable && props.onToggle) props.onToggle();
          },
          onMouseEnter: expandable ? hoverIn : undefined,
          onMouseLeave: expandable
            ? function (event) {
                hoverOut(event);
              }
            : undefined,
          style: {
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            width: '100%',
            minWidth: 0,
            maxWidth: C.chatWidth,
            margin: '0 auto',
            height: 'calc(33px + ' + C.fontDelta + ')',
            padding: '0 0 8px',
            border: 'none',
            borderBottom: '0.5px solid ' + BORDER,
            background: 'none',
            color: C.labelTertiary,
            font: 'inherit',
            fontSize: C.font,
            textAlign: 'left',
            cursor: expandable ? 'pointer' : 'default',
          },
        },
        h(
          'span',
          {
            style: {
              minWidth: 0,
              overflow: 'hidden',
              fontSize: C.font,
              lineHeight: 'calc(24px + ' + C.fontDelta + ')',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          },
          props.label,
          (props.parts || []).map(function (part, index) {
            return h(
              'span',
              {
                key: 'dur-' + index,
                style: part.numeric ? { fontFamily: MONO_STACK, fontVariantNumeric: 'tabular-nums' } : null,
              },
              part.text,
            );
          }),
        ),
        expandable
          ? h(
              'span',
              {
                style: {
                  flex: 'none',
                  width: 14,
                  height: 14,
                  marginLeft: 4,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'inherit',
                  transform: open ? 'rotate(180deg)' : 'none',
                  transition: 'transform 100ms ease',
                },
              },
              '▾',
            )
          : null,
      );
    }

    /** Render a turn's process items (thinking rows and tool activity rows). */
    function renderProcessItems(items, keyPrefix) {
      var list = items || [];
      var steps = [];
      list.forEach(function (message) {
        var step = message && message.step ? message.step : 0;
        var group = steps[steps.length - 1];
        if (!group || group.step !== step) {
          group = { step: step, items: [] };
          steps.push(group);
        }
        group.items.push(message);
      });
      if (steps.length <= 1) return list.map(function (message, index) {
        if (message && message.role === 'tool') {
          return h(ToolRow, { key: keyPrefix + '-t-' + index, message: message });
        }
        return h(ReasoningRow, { key: keyPrefix + '-r-' + index, message: message });
      });
      var nodes = [];
      steps.forEach(function (group, groupIndex) {
        nodes.push(
          h(ProcessGroupHeader, {
            key: keyPrefix + '-sg-' + groupIndex,
            open: true,
            iconKind: (processKinds(group.items)[0] || {}).kind || 'thinking',
            label: doneProcessTitle(group.items),
          }),
        );
        group.items.forEach(function (message, index) {
          nodes.push(
            message.role === 'tool'
              ? h(ToolRow, { key: keyPrefix + '-s' + groupIndex + '-t' + index, message: message })
              : h(ReasoningRow, { key: keyPrefix + '-s' + groupIndex + '-r' + index, message: message }),
          );
        });
      });
      return nodes;
    }

    /** Running status row, ported from the official RunningStatus: sparkle icon,
     *  「深度求索中，用时 X 秒 ···」 with a live one-second clock. */
    function RunningStatus(props) {
      var startAt = Number(props.startAt) || Date.now();
      var tickState = React.useState(0);
      var setTick = tickState[1];
      React.useEffect(
        function () {
          var timer = setInterval(function () {
            setTick(function (value) {
              return value + 1;
            });
          }, 1000);
          return function () {
            clearInterval(timer);
          };
        },
        [startAt],
      );
      var elapsed = Math.max(0, Date.now() - startAt);
      var parts = runDurationParts(elapsed);
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            maxWidth: C.chatWidth,
            margin: '0 auto',
            width: '100%',
            minHeight: 'calc(24px + ' + C.fontDelta + ')',
            color: C.labelTertiary,
            fontSize: C.font,
            lineHeight: 'calc(24px + ' + C.fontDelta + ')',
          },
        },
        h('span', { style: { flex: 'none', display: 'inline-flex', alignItems: 'center' } }, h(ActivityIcon, { kind: 'tools' })),
        h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 0, minWidth: 0 } },
          '深度求索中，用时 ',
          parts.map(function (part, index) {
            return h(
              'span',
              {
                key: 'run-' + index,
                style: part.numeric ? { fontFamily: MONO_STACK, fontVariantNumeric: 'tabular-nums' } : null,
              },
              part.text,
            );
          }),
          ' ···',
        ),
      );
    }

    /** One conversation turn: user prompt, settled process row, assistant reply. */
    function TurnBlock(props) {
      var turn = props.turn || { items: [] };
      var userMessage = null;
      var processItems = [];
      var assistantItems = [];
      var failureItems = [];
      var contextItems = [];
      var turnEnd = null;
      turn.items.forEach(function (message) {
        var role = message && message.role;
        if (role === 'user') {
          if (!userMessage) userMessage = message;
          else assistantItems.push(message);
        } else if (role === 'tool' || role === 'reasoning') {
          processItems.push(message);
        } else if (role === 'system') {
          failureItems.push(message);
        } else if (role === 'context') {
          contextItems.push(message);
        } else if (role === 'turn-end') {
          turnEnd = message;
        } else if (role === 'assistant') {
          assistantItems.push(message);
        }
      });

      var openState = React.useState(null);
      var explicitOpen = openState[0];
      var setExplicitOpen = openState[1];
      var running = !turnEnd && !(props.isLast === true && props.sessionRunning === false);
      var open = explicitOpen === null ? running : explicitOpen;

      var label = '已完成';
      var parts = [];
      var expandable = false;
      if (turnEnd) {
        expandable = processItems.length > 0;
        if (turnEnd.reason === 'error') label = '处理失败';
        else if (turnEnd.reason === 'aborted' || turnEnd.reason === 'interrupted') label = '已停止';
        else if (turnEnd.durationMs > 0) {
          label = '已完成，用时 ';
          parts = runDurationParts(turnEnd.durationMs);
        }
      }

      var groupOpenState = React.useState(true);
      var groupOpen = groupOpenState[0];
      var setGroupOpen = groupOpenState[1];

      var processNode = null;
      if (running) {
        var live = runningActivity(processItems);
        processNode = processItems.length
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 2, maxWidth: C.chatWidth, margin: '0 auto', width: '100%' } },
              h(ProcessGroupHeader, {
                open: groupOpen,
                iconKind: live.kind,
                label: ACTIVITY_RUNNING[live.kind] || ACTIVITY_RUNNING.tools,
                detail: live.detail,
                onToggle: function () {
                  setGroupOpen(!groupOpen);
                },
              }),
              groupOpen ? renderProcessItems(processItems, turn.key) : null,
            )
          : null;
      } else {
        processNode = expandable
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 2, maxWidth: C.chatWidth, margin: '0 auto', width: '100%' } },
              h(TurnProcessRow, {
                label: label,
                parts: parts,
                open: open,
                expandable: expandable,
                onToggle: function () {
                  setExplicitOpen(!open);
                },
              }),
              open
                ? h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 4 } },
                    h(ProcessGroupHeader, {
                      open: groupOpen,
                      iconKind: (processKinds(processItems)[0] || {}).kind || 'thinking',
                      label: doneProcessTitle(processItems),
                      detail: '',
                      onToggle: function () {
                        setGroupOpen(!groupOpen);
                      },
                    }),
                    groupOpen ? renderProcessItems(processItems, turn.key) : null,
                  )
                : null,
            )
          : h(
              'div',
              { style: { maxWidth: C.chatWidth, margin: '0 auto', width: '100%' } },
              h(TurnProcessRow, { label: label, parts: parts, open: false, expandable: false }),
            );
      }

      var runStartAt = 0;
      if (userMessage && userMessage.at) runStartAt = userMessage.at;
      if (processItems.length > 0 && processItems[0].at) runStartAt = processItems[0].at;

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 28, minWidth: 0 } },
        userMessage ? h(MessageRow, { key: turn.key + '-user', message: userMessage }) : null,
        contextItems.length
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 2, maxWidth: C.chatWidth, margin: '0 auto', width: '100%' } },
              contextItems.map(function (message, index) {
                return h(MessageRow, { key: turn.key + '-ctx-' + index, message: message });
              }),
            )
          : null,
        processNode,
        running ? h(RunningStatus, { key: turn.key + '-running', startAt: runStartAt }) : null,
        assistantItems.map(function (message, index) {
          return h(MessageRow, { key: turn.key + '-a-' + index, message: message });
        }),
        failureItems.length
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 2, maxWidth: C.chatWidth, margin: '0 auto', width: '100%' } },
              failureItems.map(function (message, index) {
                return h(MessageRow, { key: turn.key + '-f-' + index, message: message });
              }),
            )
          : null,
      );
    }

    /** Split the transcript into turns: a user message starts a new turn. */
    function groupTurns(messages) {
      var turns = [];
      (messages || []).forEach(function (message, index) {
        var isUser = message && message.role === 'user';
        if (!turns.length || isUser) {
          var stamp = message && message.seq !== null && message.seq !== undefined ? message.seq : index;
          turns.push({ key: 'turn-' + stamp, items: [] });
        }
        turns[turns.length - 1].items.push(message);
      });
      return turns;
    }

    /** Copy visible text; silent no-op outside a secure browser context. */
    function copyMessageText(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(String(text || ''));
        }
      } catch (error) {
        /* clipboard is best-effort */
      }
    }

    /** Official MessageIconActions row: 28px high, time then icon buttons. */
    function MessageActions(props) {
      var align = props.align === 'start' ? 'flex-start' : 'flex-end';
      var time = props.time ? String(props.time) : '';
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: align,
            gap: 8,
            height: 'calc(28px + ' + C.fontDelta + ')',
            color: C.labelTertiary,
          },
        },
        time
          ? h(
              'span',
              {
                style: {
                  fontSize: props.small ? 'calc(' + C.fontSecondary + ' - 1px)' : C.fontSecondary,
                  lineHeight: 'calc(24px + ' + C.fontDelta + ')',
                  color: 'inherit',
                  whiteSpace: 'nowrap',
                },
              },
              time,
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            title: '复制',
            onClick: function () {
              copyMessageText(props.text || '');
            },
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 20,
              height: 20,
              padding: 0,
              border: 'none',
              borderRadius: C.radiusSm,
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 12,
            },
          },
          '⧉',
        ),
      );
    }

    function MessageRow(props) {
      var message = props.message || {};
      var role = message.role;
      if (role === 'tool') return h(ToolRow, { message: message });
      var isUser = role === 'user';
      var isContext = role === 'context';
      var isFailure = role === 'system' || (message.tool && message.tool.isError);
      var raw = String(message.text || '');
      var time = formatClock(message.at);
      if (!raw.trim() && (role === 'assistant' || role === 'user')) return null;

      if (isContext) {
        return h(
          'div',
          { style: rowColumnStyle },
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '2px 0',
                color: C.labelTertiary,
                fontSize: 12,
                lineHeight: '18px',
              },
              title: raw,
            },
            h('span', { style: { flex: '0 0 auto', color: C.labelCaption } }, 'ⓘ'),
            h(
              'span',
              {
                style: {
                  flex: '1 1 auto',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              raw.replace(/\s+/gu, ' ').slice(0, 160),
            ),
            time ? h('span', { style: merge(captionStyle, { flex: '0 0 auto' }) }, time) : null,
          ),
        );
      }

      if (isFailure) {
        var separator = raw.indexOf('：');
        var failureTitle = separator > 0 ? raw.slice(0, separator) : '执行失败';
        var failureText = separator > 0 ? raw.slice(separator + 1) : raw;
        return h(
          'div',
          {
            style: merge(rowColumnStyle, {
              display: 'grid',
              gridTemplateColumns: '10px minmax(0, 1fr) auto',
              gap: 8,
              alignItems: 'start',
              padding: '2px 0',
              fontSize: C.fontSecondary,
              lineHeight: 'calc(20px + ' + C.fontDeltaSecondary + ')',
            }),
          },
          h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: DANGER, marginTop: 7 } }),
          h(
            'div',
            { style: { minWidth: 0, overflowWrap: 'anywhere' } },
            h('span', { style: { color: DANGER, fontWeight: 600, marginRight: 6 } }, failureTitle),
            h('span', { style: { color: C.labelSecondary } }, failureText),
          ),
          time ? h('span', { style: captionStyle }, time) : null,
        );
      }

      if (isUser) {
        return h(
          'div',
          { style: rowColumnStyle },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 } },
            h(
              'div',
              { style: userBubbleStyle },
              h('div', { style: merge(assistantBodyStyle, { whiteSpace: 'pre-wrap' }) }, raw || '（空消息）'),
            ),
            h(MessageActions, { align: 'end', time: time, text: raw }),
          ),
        );
      }

      return h(
        'div',
        { style: rowColumnStyle },
        h('div', { style: assistantBodyStyle }, h(MessageBody, { role: role, text: raw })),
        h(MessageActions, { align: 'end', time: time, text: raw, small: true }),
      );
    }

    // ── composer ────────────────────────────────────────────────────────────
    function Composer(props) {
      function request(method, extra) {
        return post(method, Object.assign({ peerId: props.peerId, sessionId: props.sessionId }, extra || {}));
      }
      function sendLine(text, mode) {
        var line = String(text || '').trim();
        if (!line) return Promise.resolve(false);
        if (line.charAt(0) !== '/') return Promise.resolve(props.onSend(line, mode));
        return request('execute-command', { line: line }).then(function (response) {
          if (response && response.result && response.result.ok === false) {
            throw new Error(response.result.error && response.result.error.message || response.result.reason || '命令执行失败');
          }
          if (props.onMutated) props.onMutated();
          return true;
        }).catch(function (error) {
          if (props.onActionError) props.onActionError('命令执行失败：' + messageOf(error));
          return false;
        });
      }
      return h('div', { style: composerStyle, 'data-remote-composer': '1' },
        props.goalBar && props.goal ? h(props.goalBar, {
          goal: props.goal, onEdit: props.onGoalEdit, onPause: props.onGoalPause,
          onResume: props.onGoalResume, onClear: props.onGoalClear,
        }) : null,
        props.vendorComposer ? h(props.vendorComposer, Object.assign({}, props, { request: request, onSend: sendLine }))
          : h('div', { role: 'status' }, '正在加载输入栏…'),
      );
    }

    // ── transcript pane ─────────────────────────────────────────────────────
    /** Render the official flow without letting a single bad node blank the panel. */
    var FlowBoundaryBase = React.Component || function FlowBoundaryBase() {};
    function FlowBoundary(props) {
      FlowBoundaryBase.call(this, props);
      this.state = { failed: false };
    }
    FlowBoundary.prototype = Object.create(FlowBoundaryBase.prototype);
    FlowBoundary.prototype.constructor = FlowBoundary;
    FlowBoundary.getDerivedStateFromError = function () {
      return { failed: true };
    };
    FlowBoundary.prototype.componentDidCatch = function (error) {
      if (this.props && this.props.onError) this.props.onError(error);
    };
    FlowBoundary.prototype.render = function () {
      if (this.state && this.state.failed) return null;
      return h('div', { 'data-remote-official': '1' }, this.props.children);
    };

    /** Map transport errors onto actionable hints for version-skewed peers. */
    function describeRemoteError(prefix, error) {
      var message = messageOf(error);
      if (/unknown rpc method/i.test(message)) {
        return prefix + '：远端主机插件版本较旧（缺少该接口），请重启其 DSH 桌面应用后重试';
      }
      if (/not found|unknown method/i.test(message) && /commands|files|openPath/i.test(String(error && error.message))) {
        return prefix + '：远端主机插件版本较旧，请重启其 DSH 桌面应用后重试';
      }
      return prefix + '：' + message;
    }

    function TranscriptPane(props) {
      var selection = props.selection;
      var peer = props.peer;
      var sessionHint = props.sessionHint;
      var onMutated = props.onMutated;

      var peerId = selection && selection.peerId ? selection.peerId : null;
      var sessionId = selection && selection.sessionId ? selection.sessionId : null;

      var transcriptState = React.useState(null);
      var transcript = transcriptState[0];
      var setTranscript = transcriptState[1];

      var permissionState = React.useState({ catalog: null, current: null });
      var permission = permissionState[0];
      var setPermission = permissionState[1];


      React.useEffect(
        function () {
          var nextModel = transcript && transcript.sessionModel ? transcript.sessionModel : null;
          if (nextModel) setCurrentModel(nextModel);
        },
        [peerId, sessionId, transcript && transcript.sessionModelRevision,
          transcript && transcript.sessionModel && transcript.sessionModel.provider,
          transcript && transcript.sessionModel && transcript.sessionModel.model,
          transcript && transcript.sessionModel && transcript.sessionModel.reasoningEffort],
      );

      React.useEffect(
        function () {
          if (!peerId || !sessionId) return undefined;
          var cancelled = false;
          post('permission-catalog', { peerId: peerId }).then(
            function (response) {
              if (!cancelled && response && response.catalog) {
                setPermission(function (previous) {
                  return { catalog: response.catalog, current: previous.current };
                });
              }
            },
            function () {
              /* permission switching stays hidden without a catalog */
            },
          );
          return function () {
            cancelled = true;
          };
        },
        [peerId, sessionId],
      );

      React.useEffect(
        function () {
          var fromEvents = transcript && transcript.sessionPermission ? transcript.sessionPermission : null;
          var fallback = permission.catalog && permission.catalog.defaultPreset ? permission.catalog.defaultPreset : null;
          var next = fromEvents || fallback;
          if (next && next !== permission.current) {
            setPermission(function (previous) {
              return { catalog: previous.catalog, current: next };
            });
          }
        },
        [peerId, sessionId, transcript && transcript.sessionPermissionRevision,
          transcript && transcript.sessionPermission, permission.catalog],
      );

      function handlePermissionChange(preset) {
        if (!preset) return Promise.resolve(false);
        setActionError(null);
        return post('permission-set', { peerId: peerId, sessionId: sessionId, preset: preset }).then(
          function (response) {
            var result = response && response.result;
            if (result && result.ok === false) {
              setActionError(result.reason === 'session-not-live'
                ? '切换权限需要该会话处于活跃状态（先在远端打开或发送一条消息）'
                : '切换权限失败');
              return false;
            }
            setPermission(function (previous) {
              return { catalog: previous.catalog, current: preset };
            });
            if (onMutated) onMutated();
            return true;
          },
          function (error) {
            setActionError(describeRemoteError('切换权限失败', error));
            return false;
          },
        );
      }

      var feedbackFetchRef = React.useRef(0);
      var feedbackRefresh = React.useCallback(
        function () {
          if (!peerId || !sessionId) return;
          var now = Date.now();
          if (now - feedbackFetchRef.current < 4000) return;
          feedbackFetchRef.current = now;
          post('feedback', { peerId: peerId, sessionId: sessionId }).then(
            function (response) {
              var items = response && response.result && response.result.value && Array.isArray(response.result.value.items)
                ? response.result.value.items
                : [];
              var byId = {};
              items.forEach(function (item) {
                if (item && item.messageId) byId[item.messageId] = item;
              });
              setFeedback({ items: items, byId: byId });
            },
            function () {
              /* feedback stays unavailable when the host lacks the service */
            },
          );
        },
        [peerId, sessionId],
      );

      React.useEffect(
        function () {
          feedbackRefresh();
        },
        [feedbackRefresh, transcript],
      );

      function putFeedback(messageId, rating) {
        var existing = feedback.byId[messageId] || null;
        var run = existing && existing.rating === rating
          ? post('feedback-delete', {
              peerId: peerId,
              request: { sessionId: sessionId, messageId: messageId, ifVersion: existing.version },
            })
          : post('feedback-put', {
              peerId: peerId,
              request: {
                sessionId: sessionId,
                messageId: messageId,
                rating: rating,
                ifVersion: existing ? existing.version : null,
              },
            });
        run.then(
          function (response) {
            var result = response && response.result;
            if (result && result.ok === false) {
              var reason = result.error && result.error.code === 'version-conflict'
                ? '反馈版本冲突，请刷新后重试'
                : result.error && result.error.code === 'target-not-found'
                  ? '该消息不在当前会话日志中'
                  : '记录反馈失败：' + ((result.error && result.error.code) || 'unknown');
              setActionError(reason);
              feedbackRefresh();
              return;
            }
            setFeedback(function (previous) {
              var nextById = Object.assign({}, previous.byId);
              if (existing && existing.rating === rating) delete nextById[messageId];
              else {
                nextById[messageId] = {
                  messageId: messageId,
                  rating: rating,
                  version: result && result.value ? result.value.version : existing && existing.version,
                };
              }
              return { items: Object.keys(nextById).map(function (key) { return nextById[key]; }), byId: nextById };
            });
          },
          function (error) {
            setActionError(describeRemoteError('反馈失败', error));
          },
        );
      }

      // Official feedback dialog state machine; the submit callback reads the
      // current peer/session from a ref so one controller survives prop changes.
      var feedbackTargetRef = React.useRef({ peerId: null, sessionId: null });
      feedbackTargetRef.current = { peerId: peerId, sessionId: sessionId };
      var feedbackDialog = null;

      function renderFeedbackAction(messageId) {
        if (!messageId) return null;
        var item = feedback.byId[messageId] || null;
        var rating = item && item.rating ? item.rating : null;
        var button = function (kind, glyph, label) {
          var active = rating === kind;
          return h(
            'button',
            {
              key: kind,
              type: 'button',
              onClick: function () {
                if (active || !feedbackDialog) {
                  putFeedback(messageId, kind);
                  return;
                }
                feedbackDialog.open({ kind: 'message', messageId: messageId, rating: kind });
              },
              title: label,
              'aria-label': label,
              'data-feedback-rating': kind,
              'data-feedback-active': active ? '1' : undefined,
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 24,
                height: 24,
                padding: 0,
                border: 'none',
                borderRadius: 999,
                background: 'transparent',
                color: active ? 'var(--dsw-alias-button-info-fill, ' + ACCENT + ')' : 'var(--dsw-alias-label-tertiary, ' + C.labelTertiary + ')',
                cursor: 'pointer',
              },
            },
            h(
              'svg',
              { width: 16, height: 16, 'aria-hidden': 'true', 'data-icon': 'dsw-icon-' + glyph + '-regular' },
              h('use', { href: '#dsw-icon-' + glyph + '-regular' }),
            ),
          );
        };
        return h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 2 } },
          button('positive', 'like-outline', '有帮助'),
          button('negative', 'dislike-outline', '没帮助'),
        );
      }

      React.useEffect(
        function () {
          if (!currentModel && modelCatalog && modelCatalog.default) {
            setCurrentModel(modelCatalog.default);
          }
        },
        [currentModel, modelCatalog],
      );

      React.useEffect(
        function () {
          var nextGoal = transcript ? transcript.sessionGoal || null : null;
          setCurrentGoal(nextGoal);
        },
        [transcript],
      );

      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];

      var loadingState = React.useState(true);
      var loading = loadingState[0];
      var setLoading = loadingState[1];

      var actionErrorState = React.useState(null);
      var actionError = actionErrorState[0];
      var setActionError = actionErrorState[1];



      var refreshState = React.useState(0);
      var refreshTick = refreshState[0];
      var setRefreshTick = refreshState[1];

      React.useEffect(
        function () {
          if (!peerId || !sessionId) return undefined;
          var cancelled = false;
          post('models', { peerId: peerId }).then(
            function (result) {
              if (!cancelled) setModelCatalog(result && result.catalog ? result.catalog : null);
            },
            function () {
              /* model switching stays unavailable without a catalog */
            },
          );
          return function () {
            cancelled = true;
          };
        },
        [peerId, sessionId],
      );

      var flowState = React.useState(null);
      var flowVendor = flowState[0];
      var setFlowVendor = flowState[1];
      var feedbackDialogRef = React.useRef(null);
      if (!feedbackDialogRef.current && flowVendor && typeof flowVendor.createFeedbackDialog === 'function') {
        feedbackDialogRef.current = flowVendor.createFeedbackDialog(function (target, entry) {
          var scope = feedbackTargetRef.current;
          if (!scope.peerId || !scope.sessionId) {
            return Promise.resolve({ ok: false, error: { code: 'gateway/internal', message: '会话未选择' } });
          }
          var existing = feedback.byId[target.messageId] || null;
          var request = {
            sessionId: scope.sessionId,
            messageId: target.messageId,
            rating: target.rating,
            ifVersion: existing ? existing.version : null,
          };
          if (entry && entry.text) request.note = entry.text;
          if (entry && entry.category) request.category = entry.category;
          return post('feedback-put', { peerId: scope.peerId, request: request }).then(
            function (response) {
              var result = response && response.result;
              if (result && result.ok === false) {
                return {
                  ok: false,
                  error: {
                    code: (result.error && result.error.code) || 'gateway/internal',
                    message: (result.error && result.error.message) || '反馈保存失败',
                  },
                };
              }
              setFeedback(function (previous) {
                var nextById = Object.assign({}, previous.byId);
                nextById[target.messageId] = {
                  messageId: target.messageId,
                  rating: target.rating,
                  version: result && result.value ? result.value.version : existing && existing.version,
                  note: entry && entry.text,
                  category: entry && entry.category,
                };
                return { items: Object.keys(nextById).map(function (key) { return nextById[key]; }), byId: nextById };
              });
              return { ok: true };
            },
            function (error) {
              return { ok: false, error: { code: 'gateway/internal', message: messageOf(error) } };
            },
          );
        });
      }
      var feedbackDialog = feedbackDialogRef.current;

      var feedbackState = React.useState({ items: [], byId: {} });
      var feedback = feedbackState[0];
      var setFeedback = feedbackState[1];

      var modelState = React.useState(null);
      var modelCatalog = modelState[0];
      var setModelCatalog = modelState[1];
      var currentModelState = React.useState(null);
      var currentModel = currentModelState[0];
      var setCurrentModel = currentModelState[1];

      var goalState = React.useState(null);
      var currentGoal = goalState[0];
      var setCurrentGoal = goalState[1];

      var flowFailedState = React.useState(false);
      var flowFailed = flowFailedState[0];
      var setFlowFailed = flowFailedState[1];

      var flowErrorState = React.useState(null);
      var flowError = flowErrorState[0];
      var setFlowError = flowErrorState[1];

      var cancelState = React.useState(false);
      var cancelBusy = cancelState[0];
      var setCancelBusy = cancelState[1];

      var scrollRef = React.useRef(null);
      /** Event window for the official fold; growing it loads further history. */
      var eventWindowRef = React.useRef(800);
      var historyAnchorRef = React.useRef(null);
      var historyLoadingState = React.useState(false);
      var historyLoading = historyLoadingState[0];
      var setHistoryLoading = historyLoadingState[1];
      var nearBottomRef = React.useRef(true);
      var busyRef = React.useRef(false);
      var mountedRef = React.useRef(true);

      React.useEffect(function () {
        mountedRef.current = true;
        return function () {
          mountedRef.current = false;
        };
      }, []);

      React.useEffect(function () {
        var alive = true;
        loadVendorFlow()
          .then(function (module) {
            if (alive) setFlowVendor(module);
          })
          .catch(function (error) {
            if (alive) {
              setFlowVendor(null);
              setFlowError(messageOf(error));
            }
          });
        return function () {
          alive = false;
        };
      }, []);

      var rawTranscriptRef = React.useRef(null);
      var lastEnrichedRef = React.useRef(null);
      var foldRecoverRef = React.useRef(0);
      var pollIndexRef = React.useRef(0);
      var officialIssueRef = React.useRef(null);

      var loadTranscript = React.useCallback(function (options) {
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
        var prefetchedCount = null;
        return Promise.all([transcriptPromise, eventsPromise])
          .then(function (results) {
            prefetchedCount = results[1] && Array.isArray(results[1].events) ? results[1].events.length : (results[1] ? -1 : null);
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
            if (previous && folded && !folded.official && previous.official) {
              folded = Object.assign({}, previous, {
                session: folded.session || previous.session,
                messages: previous.messages,
                officialRunning:
                  typeof folded.officialRunning === 'boolean' ? folded.officialRunning : previous.officialRunning,
              });
            }
            if (folded && folded.official) lastEnrichedRef.current = folded;
            if (!folded || !folded.official) {
              var issue = prefetchedCount === null
                ? '会话事件数据加载失败（会话较大或中转超限）'
                : '事件窗口为空，无法构建官方渲染';
              if (officialIssueRef.current !== issue) {
                officialIssueRef.current = issue;
                setActionError('官方渲染未生效：' + issue);
              }
            } else if (officialIssueRef.current !== null) {
              officialIssueRef.current = null;
              setActionError(null);
            }
            // Heavy load that still cannot fold (e.g. stale cursor + no cached
            // fold) falls back to one full refold; bounded to avoid a loop.
            if (
              folded &&
              !folded.official &&
              !light &&
              !(previous && previous.official) &&
              foldRecoverRef.current < 2 &&
              !(folded.messages && folded.messages.length === 0)
            ) {
              foldRecoverRef.current += 1;
              officialEventCache = { key: null, events: [], cursor: 0, hasOlder: false };
              officialFoldCache = { key: null, data: null };
              setTimeout(function () {
                if (mountedRef.current) loadTranscript();
              }, 30);
            }
            return folded;
          })
          .then(
          function (data) {
            busyRef.current = false;
            if (!mountedRef.current) return;
            setTranscript(data || null);
            setError(null);
            setLoading(false);
          },
          function (fetchError) {
            busyRef.current = false;
            if (!mountedRef.current) return;
            setError(messageOf(fetchError));
            setLoading(false);
          },
        );
      }, [peerId, sessionId]);

      // Poll the selected transcript every 2s; the interval restarts when the
      // selection changes or the user presses refresh, so no interval leaks
      // past the component lifetime.
      React.useEffect(function () {
        if (!peerId || !sessionId) {
          setTranscript(null);
          setError(null);
          setLoading(false);
          return undefined;
        }
        setLoading(true);
        setTranscript(null);
        setError(null);
        setActionError(null);
        nearBottomRef.current = true;
        rawTranscriptRef.current = null;
        lastEnrichedRef.current = null;
        foldRecoverRef.current = 0;
        pollIndexRef.current = 0;
        officialIssueRef.current = null;
        loadTranscript();
        // Every 5th tick re-reads the full transcript (title/running/fallback);
        // the rest fold only the incremental event window.
        var timer = setInterval(function () {
          var heavy = pollIndexRef.current % 5 === 0;
          pollIndexRef.current += 1;
          loadTranscript({ light: !heavy });
        }, TRANSCRIPT_POLL_MS);
        return function () {
          clearInterval(timer);
        };
      }, [peerId, sessionId, refreshTick, loadTranscript]);

      var session = transcript && transcript.session ? transcript.session : sessionHint || null;
      var messages = transcript && Array.isArray(transcript.messages) ? transcript.messages : EMPTY_ARRAY;
      var total = transcript && typeof transcript.total === 'number' ? transcript.total : messages.length;

      // Follow the bottom unless the user scrolled up.
      var messageCount = messages.length;
      React.useEffect(function () {
        var element = scrollRef.current;
        if (!element) return;
        if (nearBottomRef.current) element.scrollTop = element.scrollHeight;
      }, [messageCount, sessionId]);

      var railActiveState = React.useState(null);
      var railActiveTurn = railActiveState[0];
      var setRailActiveTurn = railActiveState[1];

      /** Recompute the active turn mark from the settled turn anchors in view. */
      function updateRailActiveTurn() {
        var body = scrollRef.current;
        if (!body || !transcript || !transcript.official) return;
        var anchors = body.querySelectorAll('[data-turn-process]');
        if (anchors.length === 0) return;
        var middle = body.scrollTop + body.clientHeight / 2;
        var best = null;
        var bestDistance = Infinity;
        anchors.forEach(function (node) {
          var turn = Number(node.getAttribute('data-turn-process'));
          if (!isFinite(turn)) return;
          var distance = Math.abs(node.offsetTop - middle);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = turn;
          }
        });
        if (best !== null && best !== railActiveTurn) setRailActiveTurn(best);
      }

      function handleScroll(event) {
        var element = event.currentTarget;
        nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
      }

      var online = !peer || peer.online !== false;
      var blank = !!(session && session.blank);
      var sendDisabled = !online || blank;
      var disabledHint = !online ? '主机离线，暂时无法发送' : blank ? '空白会话暂不支持发送' : '';

      function handleLoadOlder() {
        if (historyLoading) return;
        var container = scrollRef.current;
        historyAnchorRef.current = container
          ? { height: container.scrollHeight, top: container.scrollTop }
          : null;
        setHistoryLoading(true);
        eventWindowRef.current = Math.min(60000, eventWindowRef.current + 800);
        officialEventCache = { key: null, events: [], cursor: 0, hasOlder: false };
        loadTranscript();
      }

      React.useEffect(
        function () {
          if (historyLoading && transcript) setHistoryLoading(false);
          var anchor = historyAnchorRef.current;
          if (!anchor) return;
          var container = scrollRef.current;
          if (!container) return;
          container.scrollTop = anchor.top + (container.scrollHeight - anchor.height);
          historyAnchorRef.current = null;
        },
        [transcript],
      );

      function runGoalAction(action, extra) {
        var goal = currentGoal;
        if (!goal || !goal.id) return Promise.resolve({ ok: false, error: { code: 'GOAL_MISSING', message: '当前没有目标' } });
        var request = {
          peerId: peerId,
          sessionId: sessionId,
          action: action,
          goalId: goal.id,
          revision: goal.revision,
        };
        if (extra && extra.objective !== undefined) request.objective = extra.objective;
        return post('goal-action', request).then(
          function () {
            loadTranscript();
            return { ok: true };
          },
          function (goalError) {
            return {
              ok: false,
              error: { code: 'GOAL_ACTION_FAILED', message: messageOf(goalError) },
            };
          },
        );
      }

      function handleSend(text, mode) {
        setActionError(null);
        return post('send', {
          peerId: peerId,
          sessionId: sessionId,
          text: text,
          mode: mode || (running ? 'steer' : 'queue'),
        }).then(
          function (response) {
            if (response && response.result && response.result.ok === false) {
              throw new Error(response.result.error && response.result.error.message || response.result.reason || '发送失败');
            }
            return loadTranscript();
          },
        ).then(
          function () {
            if (onMutated) onMutated();
            return true;
          },
          function (sendError) {
            if (mountedRef.current) setActionError(describeRemoteError('发送失败', sendError));
            return false;
          },
        );
      }

      function handleCancel() {
        if (cancelBusy) return;
        setCancelBusy(true);
        setActionError(null);
        post('cancel', { peerId: peerId, sessionId: sessionId }).then(
          function () {
            return loadTranscript();
          },
        ).then(
          function () {
            if (onMutated) onMutated();
          },
          function (cancelError) {
            if (mountedRef.current) setActionError('取消失败：' + messageOf(cancelError));
          },
        ).then(function () {
          if (mountedRef.current) setCancelBusy(false);
        });
      }

      function handleModelChange(selection) {
        if (!selection || !selection.provider || !selection.model) {
          return Promise.resolve({ ok: false, error: { code: 'remote/model', message: '模型选择无效' } });
        }
        setActionError(null);
        return post('select-model', {
          peerId: peerId, sessionId: sessionId,
          provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort,
        }).then(function (response) {
          if (response && response.result && response.result.ok === false) {
            throw new Error(response.result.error && response.result.error.message || response.result.reason || '切换模型失败');
          }
          setCurrentModel({ provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort });
          if (onMutated) onMutated();
          return { ok: true, value: undefined };
        }).catch(function (error) {
          setActionError(describeRemoteError('切换模型失败', error));
          return { ok: false, error: { code: 'remote/model', message: messageOf(error) } };
        });
      }

      function handleCreateSession() {
        var cwd = transcript && transcript.session && transcript.session.cwd ? transcript.session.cwd : undefined;
        post('create', { peerId: peerId, cwd: cwd }).then(
          function (result) {
            var nextId = result && result.result && result.result.sessionId ? result.result.sessionId : result && result.sessionId;
            if (!nextId) return;
            if (props.onCreated) props.onCreated(peerId, nextId);
            else setRefreshTick(function (value) { return value + 1; });
          },
          function (createError) {
            setActionError(describeRemoteError('新建会话失败', createError));
          },
        );
      }

      function handleFork(seq) {
        if (!peerId || !sessionId) return;
        post('fork', { peerId: peerId, sessionId: sessionId, atSeq: typeof seq === 'number' ? seq : undefined }).then(
          function (result) {
            var nextId = result && result.result && result.result.sessionId ? result.result.sessionId : result && result.sessionId;
            if (props.onForked) props.onForked(peerId, nextId || null);
          },
          function (forkError) {
            if (mountedRef.current) setActionError(describeRemoteError('分支失败', forkError));
          },
        );
      }

      var peerVersion = peer && peer.version ? String(peer.version) : null;
      var selfVersion = props.selfVersion ? String(props.selfVersion) : null;
      var peerOutdated = !!(peer && peer.online && peerVersion && selfVersion && peerVersion !== selfVersion);
      var versionNotice = peer || peerVersion
        ? peerOutdated
          ? '远端主机插件较旧（v' + (peerVersion === 'legacy' ? '0.x' : peerVersion) + '，本机 v' + selfVersion + '）：命令 / 文件引用 / 模型切换等需要重启对方 DSH 桌面应用'
          : null
        : null;

      var title = session ? session.title || session.id || '未命名会话' : '未选择会话';
      var hostRunning = !!(session && session.running);
      // The durable log is the authority: a trailing turn/end settles the state
      // even when the host's live flag has not cleared yet.
      var running = transcript && typeof transcript.officialRunning === 'boolean' ? transcript.officialRunning : hostRunning;
      var cwd = session && session.cwd ? String(session.cwd) : '';

      var subtitleText = [
        running ? '运行中' : null,
        peer && peer.name ? '主机：' + peer.name : null,
        cwd ? basename(cwd) : null,
        transcript && transcript.session && transcript.session.updatedAt ? '更新于 ' + formatRelativeTime(transcript.session.updatedAt) : null,
      ].filter(Boolean).join(' · ');
      var headerActions = [
        h(
          'button',
          {
            type: 'button',
            onClick: handleCreateSession,
            style: headerIconButtonStyle,
            title: '在远端新建会话',
            'aria-label': '在远端新建会话',
          },
          '＋',
        ),
        running
          ? h(
              'button',
              {
                type: 'button',
                onClick: handleCancel,
                disabled: cancelBusy,
                style: merge(headerIconButtonStyle, { opacity: cancelBusy ? 0.5 : 1 }),
                title: '停止当前回合',
                'aria-label': '停止当前回合',
              },
              cancelBusy ? '…' : '■',
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            onClick: function () {
              setRefreshTick(function (value) {
                return value + 1;
              });
            },
            style: headerIconButtonStyle,
            title: '刷新对话',
            'aria-label': '刷新对话',
          },
          '↻',
        ),
      ];
      var headerNode =
        flowVendor && typeof flowVendor.VendorSessionHeader === 'function'
          ? h(flowVendor.VendorSessionHeader, {
              title: title,
              subtitle: subtitleText,
              running: running,
              actions: headerActions,
            })
          : h(
              'div',
              { style: transcriptHeaderStyle },
              h(Dot, { color: running ? ACCENT : 'transparent', size: 8 }),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 auto' } },
                h('span', { style: headerTitleStyle, title: title }, title),
                h(
                  'span',
                  { style: merge(mutedSmallStyle, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }), title: cwd },
                  subtitleText,
                ),
              ),
              headerActions,
            );

      var renderComposer = function () {
        return h(Composer, {
          key: sessionId || 'none',
          variant: blankSession ? 'hero' : 'composer',
          disabled: sendDisabled,
          disabledHint: disabledHint,
          placeholder: sendDisabled
            ? (disabledHint || '会话不可用')
            : running
              ? '发送消息以引导当前回合'
              : '发消息或创建任务, / 调用指令, @ 文件或对话',
          onSend: handleSend,
          running: running,
          onCancel: handleCancel,
          vendorComposer: flowVendor && typeof flowVendor.VendorComposer === 'function' ? flowVendor.VendorComposer : null,
          peerId: peerId,
          sessionId: sessionId,
          onMutated: onMutated,
          onActionError: setActionError,
          modelCatalog: modelCatalog,
          currentModel: currentModel,
          onModelChange: handleModelChange,
          permissionCatalog: permission.catalog,
          currentPermission: permission.current,
          onPermissionChange: handlePermissionChange,
          goalBar: flowVendor && typeof flowVendor.VendorGoalBar === 'function' ? flowVendor.VendorGoalBar : null,
          goal: currentGoal,
          onGoalEdit: function (objective) { return runGoalAction('edit', { objective: objective }); },
          onGoalPause: function () { return runGoalAction('pause'); },
          onGoalResume: function () { return runGoalAction('resume'); },
          onGoalClear: function () { return runGoalAction('clear'); },
        });
      };

      var feedbackDialogNode =
        feedbackDialog && flowVendor && typeof flowVendor.VendorFeedbackDialog === 'function'
          ? h(flowVendor.VendorFeedbackDialog, { key: 'feedback-dialog', controller: feedbackDialog })
          : null;
      var turnRailItems = [];
      var turnRailNode = null;
      if (transcript && transcript.official && flowVendor && typeof flowVendor.VendorTurnRail === 'function') {
        var timeline = transcript.official.snapshot && transcript.official.snapshot.timeline;
        var turnOrder = timeline && Array.isArray(timeline.turnOrder) ? timeline.turnOrder : [];
        if (turnOrder.length >= 2) {
          var previews = {};
          var readText = function (content) {
            if (!Array.isArray(content)) return '';
            var text = '';
            content.forEach(function (block) {
              if (block && typeof block.text === 'string') text += block.text;
            });
            return text;
          };
          var snapshot = transcript.official.snapshot || {};
          var order = Array.isArray(snapshot.order) ? snapshot.order : [];
          order.forEach(function (key) {
            var node = snapshot.nodes && snapshot.nodes.get ? snapshot.nodes.get(key) : null;
            if (!node) return;
            var location = node.location && node.location.turn ? node.location.turn : null;
            var turnNo = location && typeof location.turn === 'number' ? location.turn : node.data && typeof node.data.turn === 'number' ? node.data.turn : null;
            if (typeof turnNo !== 'number') return;
            var entry = previews[turnNo] || (previews[turnNo] = { prompt: '', response: '' });
            var content = node.data && node.data.content ? node.data.content : node.content;
            if (node.kind === 'user' || node.kind === 'steering' || node.kind === 'turn-trigger') {
              if (!entry.prompt) entry.prompt = readText(content).slice(0, 120);
            } else if (node.kind === 'assistant-step' || node.kind === 'assistant') {
              var blocks = node.data && Array.isArray(node.data.blocks) ? node.data.blocks : content;
              var text = readText(blocks);
              if (text) entry.response = text.slice(0, 240);
            }
          });
          turnRailItems = turnOrder.map(function (turn) {
            var entry = previews[turn] || { prompt: '', response: '' };
            return { turn: turn, prompt: entry.prompt, response: entry.response };
          });
          var lastTurn = turnOrder[turnOrder.length - 1];
          var activeTurn = railActiveTurn === null ? lastTurn : railActiveTurn;
          turnRailNode = h(flowVendor.VendorTurnRail, {
            key: 'turn-rail',
            items: turnRailItems,
            activeTurn: running && typeof lastTurn === 'number' ? lastTurn : activeTurn,
            runningTurn: running ? lastTurn : null,
            onNavigate: function (turn) {
              var body = scrollRef.current;
              if (!body) return;
              var anchor = body.querySelector('[data-turn-process="' + String(turn) + '"]');
              if (anchor && typeof anchor.scrollIntoView === 'function') {
                anchor.scrollIntoView({ block: 'center', behavior: 'smooth' });
                return;
              }
              body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
            },
          });
        }
      }
      var vendorFlowReady = !!(flowVendor && typeof flowVendor.VendorChatFlow === 'function');
      // Official fold is authoritative: hold the body blank for the few ms the
      // inline bundle evaluates instead of flashing the hand-drawn fallback.
      var officialPending = !!(transcript && transcript.official && !flowFailed && !flowVendor);
      var officialHistory = transcript && transcript.officialHistory ? transcript.officialHistory : null;
      var blankSession = !loading && !error && messages.length === 0;
      var heroNode = flowVendor && typeof flowVendor.VendorHero === 'function'
        ? h(flowVendor.VendorHero, { key: 'hero' })
        : null;

      return h(
        'div',
        {
          style: {
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
            '--dsh-composer-height': '160px',
            '--dsh-composer-side-clearance': '0px',
          },
          'data-feedback-dialog': feedbackDialog ? '1' : '0',
        },
        headerNode,
        versionNotice
          ? h(
              'div',
              {
                style: merge(errorBannerStyle, {
                  background: 'transparent',
                  color: C.labelTertiary,
                  fontSize: 12,
                  lineHeight: '18px',
                  textAlign: 'center',
                  padding: '4px 16px 0',
                }),
              },
              versionNotice,
            )
          : null,
        error ? h('div', { style: errorBannerStyle }, '读取对话失败：' + error) : null,
        flowError
          ? h(
              'div',
              {
                style: merge(errorBannerStyle, {
                  background: 'transparent',
                  color: C.labelTertiary,
                  fontSize: 12,
                  lineHeight: '18px',
                  textAlign: 'center',
                  padding: '4px 16px 0',
                }),
              },
              '官方渲染降级：' + flowError,
            )
          : null,
        actionError ? h('div', { style: errorBannerStyle }, actionError) : null,
        feedbackDialogNode,
        h(
          'div',
          { ref: scrollRef, onScroll: handleScroll, style: transcriptBodyStyle, 'data-conversation-scroll': '' },
          loading && !transcript
            ? h('div', { style: emptyHintStyle }, '正在加载对话…')
            : blankSession
              ? h(
                  'div',
                  {
                    style: {
                      flex: '1 1 auto',
                      minHeight: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 18,
                      padding: '24px 16px',
                    },
                  },
                  h('div', { style: { width: '100%', maxWidth: C.chatWidth, margin: '0 auto', flex: '0 0 auto' } }, heroNode),
                  h('div', { style: { width: '100%', maxWidth: '100%', margin: '0 auto', flex: '0 0 auto' } }, renderComposer()),
                )
              : messages.length === 0
                ? h('div', { style: emptyHintStyle }, '（暂无消息）')
              : officialPending
                ? null
              : transcript && transcript.official && !flowFailed && vendorFlowReady
                ? h(
                    FlowBoundary,
                    { onError: function (flowRenderError) { setFlowFailed(true); setFlowError(messageOf(flowRenderError)); } },
                    officialHistory && officialHistory.hasOlder && flowVendor && typeof flowVendor.VendorLoadOlder === 'function'
                      ? h(flowVendor.VendorLoadOlder, {
                          key: 'load-older',
                          loading: historyLoading,
                          onLoad: handleLoadOlder,
                        })
                      : null,
                    h(
                      'div',
                      {
                        'data-slot': 'conversation.chat.flow',
                        style: {
                          display: 'flex',
                          flexDirection: 'column',
                          width: '100%',
                          maxWidth: C.chatWidth,
                          margin: '0 auto',
                          padding: '8px 0 28px',
                          '--dsh-chat-flow-gap': '4px',
                        },
                      },
                      h(flowVendor.VendorChatFlow, {
                        key: sessionId + '-official',
                        snapshot: transcript.official.snapshot,
                        entries: transcript.official.entries,
                        groupSources: new Map(transcript.official.groupSources),
                        running: running,
                        cwd: transcript.session && transcript.session.cwd ? transcript.session.cwd : undefined,
                        openFile: function (path, options) {
                          return post('open-path', {
                            peerId: peerId,
                            sessionId: sessionId,
                            path: String(path || ''),
                            action: options && options.reveal ? 'reveal' : undefined,
                          }).then(function () {});
                        },
                        forkAt: handleFork,
                        useAccess: function (permission) {
                          return permission === 'session/fork';
                        },
                        loadImage: function (attachment) {
                          return loadRemoteImage(peerId, sessionId, attachment);
                        },
                        renderAssistantActions: renderFeedbackAction,
                      }),
                    ),
                  )
                : (function () {
                    var visibleMessages = messages.filter(function (message) {
                      return message && message.role !== 'context';
                    });
                    var turns = groupTurns(visibleMessages);
                    return turns.map(function (turn, turnIndex) {
                      return h(TurnBlock, {
                        key: turn.key,
                        turn: turn,
                        isLast: turnIndex === turns.length - 1,
                        sessionRunning: running,
                      });
                    });
                  })(),
        ),
        turnRailNode,
        blankSession ? null : renderComposer(),
      );
    }

    // ── session list ────────────────────────────────────────────────────────
    /** Group sessions of one peer by their workspace directory (cwd). */
    /**
     * Group one peer's sessions by its official Workspace registry snapshot.
     * Sessions whose Workspace was deleted (not in the registry) stay hidden,
     * matching the local sidebar; archived sessions are filtered out too.
     * @param sessions - visible sessions of the peer.
     * @param snapshot - peer.workspaces payload from the host.
     * @returns workspace groups in registry order.
     */
    function groupSessionsByWorkspaceRegistry(sessions, snapshot) {
      var lists = Array.isArray(snapshot.workspaces) ? snapshot.workspaces : [];
      var archived = {};
      (Array.isArray(snapshot.archivedSessionIds) ? snapshot.archivedSessionIds : []).forEach(function (sessionId) {
        archived[String(sessionId)] = true;
      });
      var byId = {};
      sessions.forEach(function (session, index) {
        if (session && session.id) byId[String(session.id)] = { session: session, index: index };
      });
      var groups = [];
      lists.forEach(function (workspace) {
        var entries = [];
        (Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []).forEach(function (sessionId) {
          var entry = byId[String(sessionId)];
          if (!entry) return;
          if (archived[String(sessionId)]) return;
          entries.push(entry);
        });
        if (entries.length === 0) return;
        var label = workspace.title || (workspace.path ? basename(String(workspace.path)) : '') || '未命名工作区';
        var group = {
          key: 'workspace:' + String(workspace.id || workspace.path || label),
          cwd: workspace.path || '',
          label: String(label),
          workspaceId: workspace.id ? String(workspace.id) : null,
          sessions: entries,
        };
        group.sessions.sort(function (x, y) {
          var tx = toTimestamp(x.session && x.session.updatedAt) || 0;
          var ty = toTimestamp(y.session && y.session.updatedAt) || 0;
          return ty - tx;
        });
        groups.push(group);
      });
      return groups;
    }

    function groupSessionsByWorkspace(sessions) {
      var groups = [];
      var byKey = {};
      (sessions || []).forEach(function (session, index) {
        if (!session || session.blank === true) return;
        var cwd = session && session.cwd ? String(session.cwd) : '';
        var group = byKey[cwd];
        if (!group) {
          group = {
            key: cwd,
            cwd: cwd,
            label: cwd ? basename(cwd) || cwd : '未关联工作区',
            sessions: [],
          };
          byKey[cwd] = group;
          groups.push(group);
        }
        group.sessions.push({ session: session, index: index });
      });
      groups.sort(function (a, b) {
        if (!a.key && b.key) return 1;
        if (a.key && !b.key) return -1;
        return String(a.label).localeCompare(String(b.label), 'zh-Hans-CN');
      });
      groups.forEach(function (group) {
        group.sessions.sort(function (x, y) {
          var tx = toTimestamp(x.session && x.session.updatedAt) || 0;
          var ty = toTimestamp(y.session && y.session.updatedAt) || 0;
          return ty - tx;
        });
      });
      return groups;
    }

    function PeerSection(props) {
      var peer = props.peer || {};
      var sidebarVendor = props.vendor || null;
      var vendorProjectRow =
        sidebarVendor && typeof sidebarVendor.VendorSidebarProjectRow === 'function'
          ? sidebarVendor.VendorSidebarProjectRow
          : null;
      var vendorSessionRow =
        sidebarVendor && typeof sidebarVendor.VendorSidebarSessionRow === 'function'
          ? sidebarVendor.VendorSidebarSessionRow
          : null;
      var vendorOverflowButton =
        sidebarVendor && typeof sidebarVendor.VendorSidebarOverflowButton === 'function'
          ? sidebarVendor.VendorSidebarOverflowButton
          : null;
      var workspaceTime = function (updatedAt) {
        if (!updatedAt) return '';
        if (sidebarVendor && typeof sidebarVendor.workspaceTimeLabel === 'function') {
          return sidebarVendor.workspaceTimeLabel({ at: updatedAt, now: Date.now() });
        }
        return formatRelativeTime(updatedAt);
      };
      var sessions = Array.isArray(peer.sessions) ? peer.sessions : EMPTY_ARRAY;
      var online = peer.online === true;
      var expanded = props.expanded === true;
      var isLocal = peer.id === 'local';
      var name = peer.name || peer.id || '未知主机';
      var displayName = isLocal ? name + '（本机）' : name;

      var collapsedState = React.useState({});
      var collapsedGroups = collapsedState[0];
      var setCollapsedGroups = collapsedState[1];

      // Official sidebar watermark: five sessions at rest, +5 per expand.
      var limitState = React.useState({});
      var groupLimits = limitState[0];
      var setGroupLimits = limitState[1];

      var searchQuery = typeof props.searchQuery === 'string' ? props.searchQuery.trim().toLowerCase() : '';
      var visibleSessions = sessions.filter(function (session) {
        if (!session || session.blank === true) return false;
        if (!searchQuery) return true;
        var haystack = ((session.title || '') + ' ' + (session.cwd || '') + ' ' + (session.id || '')).toLowerCase();
        return haystack.indexOf(searchQuery) !== -1;
      });
      // The official sidebar groups by Workspace entities; the cwd heuristic is
      // only the legacy fallback for hosts that do not publish the registry.
      var registrySnapshot = peer && peer.workspaces && Array.isArray(peer.workspaces.workspaces)
        ? peer.workspaces
        : null;
      var groups = registrySnapshot
        ? groupSessionsByWorkspaceRegistry(visibleSessions, registrySnapshot)
        : groupSessionsByWorkspace(visibleSessions);
      var summary =
        groups.length > 0
          ? groups.length + ' 工作区 · ' + visibleSessions.length
          : String(visibleSessions.length);

      var vendorSectionHeader =
        sidebarVendor && typeof sidebarVendor.VendorSidebarSectionHeader === 'function'
          ? sidebarVendor.VendorSidebarSectionHeader
          : null;
      // Peers are hosts, not workspaces: render them as the official section
      // label so they cannot be mistaken for another folder row.
      var peerRow = vendorSectionHeader
        ? h(vendorSectionHeader, {
            key: 'peer-row',
            label: '主机 · ' + displayName,
            meta: (online ? '' : '离线 · ') + summary,
            expanded: expanded,
            title: online ? displayName : displayName + '（离线，显示上次同步的会话）',
            onToggle: props.onToggle,
            dim: !online,
          })
        : vendorProjectRow
        ? h(vendorProjectRow, {
            key: 'peer-row',
            label: displayName,
            title: (online ? '' : '主机离线 · ') + summary,
            expanded: expanded,
            online: online,
            onToggle: props.onToggle,
          })
        : h(
            'div',
            {
              role: 'button',
              tabIndex: 0,
              onClick: props.onToggle,
              title: online ? displayName : displayName + '（离线）',
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                height: 30,
                padding: '0 8px',
                boxSizing: 'border-box',
                fontSize: 12,
                lineHeight: '20px',
                color: 'var(--dsw-alias-label-tertiary, ' + C.labelTertiary + ')',
                cursor: 'pointer',
                opacity: online ? 1 : 0.55,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
              },
            },
            h('span', { style: { flex: '0 0 auto', fontSize: 10, lineHeight: 1 } }, expanded ? '▾' : '▸'),
            h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, displayName),
            h('span', { style: { flex: '0 0 auto', opacity: 0.72 } }, summary),
          );
      return h(
        'div',
        { style: { padding: '2px 0' } },
        peerRow,
        expanded || searchQuery
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 0, paddingBottom: 4 } },
              sessions.length === 0
                ? h('div', { style: merge(emptyHintStyle, { padding: '6px 8px 10px 26px' }) }, online ? '该主机暂无会话' : '主机离线')
                : visibleSessions.length === 0
                  ? h('div', { style: merge(emptyHintStyle, { padding: '6px 8px 10px 26px' }) }, '无匹配会话')
                : groups.map(function (group) {
                    var collapsed = collapsedGroups[group.key] === true;
                    var toggleGroup = function () {
                      setCollapsedGroups(function (previous) {
                        var next = merge(previous);
                        next[group.key] = !collapsed;
                        return next;
                      });
                    };
                    var limit = Math.max(5, Number(groupLimits[group.key]) || 5);
                    var shownSessions = group.sessions.slice(0, limit);
                    var hiddenCount = group.sessions.length - shownSessions.length;
                    var groupActive = !!(
                      props.selection &&
                      props.selection.peerId === peer.id &&
                      group.sessions.some(function (entry) {
                        return entry.session && entry.session.id === props.selection.sessionId;
                      })
                    );
                    var groupHeader = vendorProjectRow
                      ? h(vendorProjectRow, {
                          key: 'workspace-row',
                          label: group.label,
                          title: group.cwd || '该会话未记录工作区',
                          expanded: !collapsed,
                          active: groupActive,
                          online: online,
                          onToggle: toggleGroup,
                          onCreate: function () {
                            if (props.onCreateInWorkspace) props.onCreateInWorkspace(peer, group);
                          },
                        })
                      : h(
                          'div',
                          {
                            role: 'button',
                            tabIndex: 0,
                            title: group.cwd || '该会话未记录工作区',
                            onClick: toggleGroup,
                            style: {
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              height: 34,
                              padding: '0 8px',
                              boxSizing: 'border-box',
                              borderRadius: 'var(--dsw-radius-md, 8px)',
                              fontSize: 14,
                              lineHeight: '20px',
                              color: 'var(--dsw-alias-label-primary, ' + C.labelPrimary + ')',
                              cursor: 'pointer',
                              opacity: online ? 1 : 0.55,
                              overflow: 'hidden',
                              whiteSpace: 'nowrap',
                            },
                          },
                          h('span', { style: { flex: '0 0 auto', fontSize: 10, lineHeight: 1, opacity: 0.7 } }, collapsed ? '▸' : '▾'),
                          h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, group.label),
                        );
                    return h(
                      'div',
                      { key: 'group-' + (group.key || 'ungrouped'), style: { '--dsh-workspace-indent': '12px' } },
                      groupHeader,
                      collapsed
                        ? null
                        : h(
                            'div',
                            { style: { display: 'flex', flexDirection: 'column', gap: 0 } },
                            shownSessions.map(function (entry) {
                              var session = entry.session;
                              var sessionId = session && session.id ? session.id : 'session-' + entry.index;
                              var selected = !!(
                                props.selection &&
                                props.selection.peerId === peer.id &&
                                props.selection.sessionId === sessionId
                              );
                              var openSession = function () {
                                if (props.onSelect) props.onSelect(peer, session);
                              };
                              if (vendorSessionRow) {
                                return h(vendorSessionRow, {
                                  key: sessionId,
                                  title: (session && session.title) || sessionId,
                                  selected: selected,
                                  running: !!(session && session.running),
                                  online: online,
                                  time: workspaceTime(session && session.updatedAt),
                                  onClick: openSession,
                                });
                              }
                              return h(
                                'div',
                                {
                                  key: sessionId,
                                  role: 'button',
                                  tabIndex: 0,
                                  title: (session && session.title) || sessionId,
                                  onClick: openSession,
                                  style: {
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    height: 32,
                                    padding: '0 8px',
                                    paddingInlineStart: 24,
                                    boxSizing: 'border-box',
                                    borderRadius: 'var(--dsw-radius-md, 8px)',
                                    background: selected
                                      ? 'var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12))'
                                      : 'transparent',
                                    color: 'var(--dsw-alias-label-primary, ' + C.labelPrimary + ')',
                                    opacity: online ? 1 : 0.55,
                                    cursor: 'pointer',
                                    overflow: 'hidden',
                                    whiteSpace: 'nowrap',
                                  },
                                },
                                h(
                                  'span',
                                  { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 14, lineHeight: '20px' } },
                                  (session && session.title) || sessionId,
                                ),
                                h(
                                  'span',
                                  { style: { flex: '0 0 auto', fontSize: 10, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, ' + C.labelTertiary + ')' } },
                                  workspaceTime(session && session.updatedAt),
                                ),
                              );
                            }),
                            vendorOverflowButton && hiddenCount > 0
                              ? h(vendorOverflowButton, {
                                  key: 'overflow-' + (group.key || 'ungrouped'),
                                  hiddenCount: hiddenCount,
                                  expanded: false,
                                  onClick: function () {
                                    setGroupLimits(function (previous) {
                                      var next = merge(previous);
                                      next[group.key] = limit + 5;
                                      return next;
                                    });
                                  },
                                })
                              : vendorOverflowButton && limit > 5
                                ? h(vendorOverflowButton, {
                                    key: 'overflow-' + (group.key || 'ungrouped'),
                                    hiddenCount: 0,
                                    expanded: true,
                                    onClick: function () {
                                      setGroupLimits(function (previous) {
                                        var next = merge(previous);
                                        next[group.key] = 5;
                                        return next;
                                      });
                                    },
                                  })
                                : null,
                          ),
                    );
                  }),
            )
          : null,
      );
    }

    // ── main page ───────────────────────────────────────────────────────────
    function RemoteSessionsPage() {
      var snapshotState = React.useState(null);
      var snapshot = snapshotState[0];
      var setSnapshot = snapshotState[1];

      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];

      var loadingState = React.useState(true);
      var loading = loadingState[0];
      var setLoading = loadingState[1];

      var tickState = React.useState(0);
      var stateTick = tickState[0];
      var setStateTick = tickState[1];

      var expandedState = React.useState({});
      var expanded = expandedState[0];
      var setExpanded = expandedState[1];

      var selectionState = React.useState(null);
      var selection = selectionState[0];
      var setSelection = selectionState[1];

      var loadedAtState = React.useState(0);
      var loadedAt = loadedAtState[0];
      var setLoadedAt = loadedAtState[1];

      var initializedRef = React.useRef(false);

      // The official Workspace row components live in the vendored flow bundle;
      // the sidebar loads the same bundle the transcript renders with.
      var searchOpenState = React.useState(false);
      var searchOpen = searchOpenState[0];
      var setSearchOpen = searchOpenState[1];
      var searchQueryState = React.useState('');
      var searchQuery = searchQueryState[0];
      var setSearchQuery = searchQueryState[1];

      var settingsOpenState = React.useState(false);
      var settingsOpen = settingsOpenState[0];
      var setSettingsOpen = settingsOpenState[1];
      var settingsFormState = React.useState({ relayUrl: '', token: '', instanceId: '', instanceName: '' });
      var settingsForm = settingsFormState[0];
      var setSettingsForm = settingsFormState[1];
      var settingsMetaState = React.useState(null);
      var settingsMeta = settingsMetaState[0];
      var setSettingsMeta = settingsMetaState[1];
      var settingsErrorState = React.useState(null);
      var settingsError = settingsErrorState[0];
      var setSettingsError = settingsErrorState[1];
      var settingsBusyState = React.useState(false);
      var settingsBusy = settingsBusyState[0];
      var setSettingsBusy = settingsBusyState[1];

      function openSettingsDialog() {
        setSettingsError(null);
        setSettingsBusy(true);
        setSettingsOpen(true);
        post('settings', {}).then(
          function (data) {
            setSettingsBusy(false);
            setSettingsMeta(data || null);
            setSettingsForm({
              relayUrl: data && data.relayUrl ? String(data.relayUrl) : '',
              token: '',
              instanceId: data && data.instanceId ? String(data.instanceId) : '',
              instanceName: data && data.instanceName ? String(data.instanceName) : '',
            });
          },
          function (settingsLoadError) {
            setSettingsBusy(false);
            setSettingsError(messageOf(settingsLoadError));
          },
        );
      }

      function saveSettingsDialog() {
        if (settingsBusy) return;
        setSettingsError(null);
        setSettingsBusy(true);
        post('settings-save', {
          relayUrl: settingsForm.relayUrl,
          token: settingsForm.token,
          instanceId: settingsForm.instanceId,
          instanceName: settingsForm.instanceName,
        }).then(
          function (saved) {
            setSettingsBusy(false);
            setSettingsOpen(false);
            setSettingsMeta(saved || null);
            setLoadedAt(Date.now());
            setStateTick(function (value) {
              return value + 1;
            });
          },
          function (saveError) {
            setSettingsBusy(false);
            setSettingsError(messageOf(saveError));
          },
        );
      }

      var settingsInputStyle = {
        height: 32,
        padding: '0 10px',
        borderRadius: 8,
        border: '1px solid ' + BORDER,
        background: 'var(--dsw-alias-input-fill, transparent)',
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
        outline: 'none',
      };

      function settingsField(label, key, options) {
        var config = options || {};
        return h(
          'label',
          { style: { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, color: C.labelSecondary } },
          h('span', null, label),
          h('input', {
            type: config.secret ? 'password' : 'text',
            value: settingsForm[key] || '',
            placeholder: config.placeholder || '',
            disabled: settingsBusy,
            onChange: function (event) {
              var value = event.target.value;
              setSettingsForm(function (previous) {
                var next = merge(previous);
                next[key] = value;
                return next;
              });
            },
            style: merge(settingsInputStyle, { width: '100%', boxSizing: 'border-box' }),
          }),
          config.hint
            ? h('span', { style: { fontSize: 11, color: C.labelTertiary } }, config.hint)
            : null,
        );
      }

      var settingsDialog = settingsOpen
        ? h(
            'div',
            {
              style: {
                position: 'fixed',
                inset: 0,
                zIndex: 1000,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0, 0, 0, 0.35)',
              },
              onMouseDown: function (event) {
                if (event.target === event.currentTarget) setSettingsOpen(false);
              },
            },
            h(
              'div',
              {
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': '远程会话设置',
                style: {
                  width: 460,
                  maxWidth: 'calc(100vw - 48px)',
                  maxHeight: 'calc(100vh - 80px)',
                  overflowY: 'auto',
                  boxSizing: 'border-box',
                  padding: 20,
                  borderRadius: 14,
                  background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
                  border: '1px solid ' + BORDER,
                  boxShadow: '0 18px 48px rgba(0, 0, 0, 0.28)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 14,
                },
              },
              h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
                h('span', { style: { fontSize: 15, fontWeight: 600 } }, '远程会话设置'),
                h('span', { style: merge(mutedSmallStyle, { whiteSpace: 'nowrap' }) },
                  settingsMeta && settingsMeta.relay && settingsMeta.relay.connected ? 'relay 已连接' : 'relay 未连接'),
              ),
              h('div', { style: merge(mutedSmallStyle, { lineHeight: '18px' }) },
                '设置本机连接的中转 relay。保存后会立即重连；其它设备需使用同一个 relay 与令牌。'),
              settingsField('Relay 地址', 'relayUrl', { placeholder: 'http://127.0.0.1:3098' }),
              settingsField('访问令牌', 'token', {
                secret: true,
                placeholder: settingsMeta && settingsMeta.hasToken ? '已设置（留空保持不变）' : '填写 relay 令牌',
              }),
              settingsField('实例 ID', 'instanceId', { placeholder: 'company' }),
              settingsField('实例名称', 'instanceName', { placeholder: '公司' }),
              settingsMeta && settingsMeta.relay && settingsMeta.relay.lastError
                ? h('div', { style: { fontSize: 12, color: DANGER, lineHeight: '18px' } }, '上次连接错误：' + String(settingsMeta.relay.lastError))
                : null,
              settingsError
                ? h('div', { style: { fontSize: 12, color: DANGER, lineHeight: '18px' } }, settingsError)
                : null,
              h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 2 } },
                h('button', { type: 'button', style: buttonStyle, disabled: settingsBusy, onClick: function () { setSettingsOpen(false); } }, '取消'),
                h('button', {
                  type: 'button',
                  style: merge(buttonStyle, { background: ACCENT, borderColor: ACCENT, color: '#fff', opacity: settingsBusy ? 0.6 : 1 }),
                  disabled: settingsBusy,
                  onClick: saveSettingsDialog,
                }, settingsBusy ? '连接中…' : '保存并重连'),
              ),
            ),
          )
        : null;

      var sidebarVendorState = React.useState(null);
      var sidebarVendor = sidebarVendorState[0];
      var setSidebarVendor = sidebarVendorState[1];
      React.useEffect(function () {
        var alive = true;
        loadVendorFlow().then(
          function (vendor) {
            if (alive) setSidebarVendor(vendor);
          },
          function () {
            /* fallback rows stay when the bundle is unavailable */
          },
        );
        return function () {
          alive = false;
        };
      }, []);

      function createSessionInWorkspace(peer, group) {
        if (!peer || !peer.id) return;
        post('create', { peerId: peer.id, cwd: group && group.cwd ? group.cwd : undefined }).then(
          function (result) {
            var created = result && result.result ? result.result : result;
            var nextSessionId = created && (created.sessionId || created.id);
            if (nextSessionId) {
              setSelection({ peerId: peer.id, sessionId: nextSessionId });
            }
            setStateTick(function (value) {
              return value + 1;
            });
          },
          function (createError) {
            setError('新建会话失败：' + messageOf(createError));
          },
        );
      }

      // Poll `state` every 5s. A manual refresh bumps `stateTick`, which
      // restarts this effect and therefore triggers an immediate `refresh`
      // (Host re-scan); the polls after it keep reading `state`.
      React.useEffect(function () {
        var alive = true;
        var busy = false;
        var firstLoad = true;
        function load() {
          if (busy) return;
          busy = true;
          var method = firstLoad && stateTick > 0 ? 'refresh' : 'state';
          firstLoad = false;
          post(method, {}).then(
            function (data) {
              busy = false;
              if (!alive) return;
              setSnapshot(data || null);
              setError(null);
              setLoading(false);
              setLoadedAt(Date.now());
            },
            function (fetchError) {
              busy = false;
              if (!alive) return;
              setError(messageOf(fetchError));
              setLoading(false);
            },
          );
        }
        load();
        var timer = setInterval(load, STATE_POLL_MS);
        return function () {
          alive = false;
          clearInterval(timer);
        };
      }, [stateTick]);

      // Expand the first online peer once so the page has visible content.
      React.useEffect(function () {
        if (!snapshot || initializedRef.current) return;
        var peers = Array.isArray(snapshot.peers) ? snapshot.peers : EMPTY_ARRAY;
        if (peers.length === 0) return;
        initializedRef.current = true;
        var target = null;
        for (var i = 0; i < peers.length; i += 1) {
          if (peers[i] && peers[i].online === true) {
            target = peers[i];
            break;
          }
        }
        if (!target) target = peers[0];
        if (target && target.id) {
          var next = {};
          next[target.id] = true;
          setExpanded(next);
        }
      }, [snapshot]);

      function refresh() {
        setStateTick(function (value) {
          return value + 1;
        });
      }

      function togglePeer(peerId) {
        setExpanded(function (previous) {
          var next = merge({}, previous);
          if (next[peerId]) delete next[peerId];
          else next[peerId] = true;
          return next;
        });
      }

      function selectSession(peer, session) {
        if (!peer || !peer.id || !session || !session.id) return;
        setSelection({ peerId: peer.id, sessionId: session.id });
      }

      var relay = snapshot && snapshot.relay ? snapshot.relay : null;
      var self = snapshot && snapshot.self ? snapshot.self : null;
      var peers = snapshot && Array.isArray(snapshot.peers) ? snapshot.peers : EMPTY_ARRAY;
      var connected = !!(relay && relay.connected === true);

      var selectedPeer = null;
      var selectedSession = null;
      if (selection) {
        for (var i = 0; i < peers.length; i += 1) {
          var peer = peers[i];
          if (!peer || peer.id !== selection.peerId) continue;
          selectedPeer = peer;
          var list = Array.isArray(peer.sessions) ? peer.sessions : EMPTY_ARRAY;
          for (var j = 0; j < list.length; j += 1) {
            if (list[j] && list[j].id === selection.sessionId) {
              selectedSession = list[j];
              break;
            }
          }
          break;
        }
      }

      var selfLabel = self ? self.name || self.id : '';
      var relayLabel = relay ? (connected ? 'relay 已连接' : 'relay 未连接') : 'relay 状态未知';

      return h(
        'div',
        { style: pageStyle, 'data-remote-session-root': '' },
        h(
          'div',
          { style: topBarStyle },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: '1 1 auto' } },
            h('span', { style: { fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap' } }, PANEL_TITLE),
            h(
              'span',
              {
                style: merge(metaRowStyle, {
                  padding: '2px 8px',
                  border: '1px solid ' + BORDER,
                  borderRadius: 999,
                  background: SOFT_BG,
                  maxWidth: 380,
                  minWidth: 0,
                }),
                title: (relay && relay.url ? String(relay.url) + '\n' : '') + (relay && relay.lastError ? '错误：' + String(relay.lastError) : ''),
              },
              h(Dot, { color: connected ? SUCCESS : DANGER, size: 8 }),
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, relayLabel),
              h('span', { style: { opacity: 0.4 } }, '·'),
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '本机：' + (selfLabel || '未知')),
            ),
            relay && relay.url
              ? h(
                  'span',
                  {
                    style: merge(mutedSmallStyle, {
                      fontFamily: MONO_STACK,
                      maxWidth: 340,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }),
                    title: String(relay.url),
                  },
                  String(relay.url),
                )
              : null,
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' } },
            loadedAt ? h('span', { style: merge(mutedSmallStyle, { whiteSpace: 'nowrap' }) }, '更新于 ' + formatClock(loadedAt)) : null,
            h('button', { type: 'button', onClick: refresh, style: buttonStyle, title: '立即刷新主机与会话状态' }, '刷新'),
            h('button', { type: 'button', onClick: openSettingsDialog, style: buttonStyle, title: '远程会话连接设置' }, '设置'),
          ),
        ),
        relay && relay.lastError
          ? h('div', { style: errorBannerStyle }, 'relay 错误：' + String(relay.lastError))
          : null,
        error
          ? h(
              'div',
              { style: errorBannerStyle },
              '读取状态失败：' + error,
              h('button', { type: 'button', onClick: refresh, style: merge(buttonStyle, { marginLeft: 'auto' }) }, '重试'),
            )
          : null,
        settingsDialog,
        h(
          'div',
          { style: contentStyle },
          h(
            'div',
            { style: leftColumnStyle },
            h(
              'div',
              { style: merge(columnHeaderStyle, { display: 'flex', alignItems: 'center', gap: 6 }) },
              searchOpen && sidebarVendor && typeof sidebarVendor.VendorSidebarSearchPill === 'function'
                ? h(sidebarVendor.VendorSidebarSearchPill, {
                    value: searchQuery,
                    placeholder: '搜索会话…',
                    onChange: setSearchQuery,
                    onClose: function () {
                      setSearchOpen(false);
                      setSearchQuery('');
                    },
                  })
                : h(
                    React.Fragment,
                    null,
                    h('span', { style: { flex: '1 1 auto' } }, '工作区'),
                    sidebarVendor && typeof sidebarVendor.VendorSidebarHeaderActions === 'function'
                      ? h(sidebarVendor.VendorSidebarHeaderActions, {
                          onSearch: function () {
                            setSearchOpen(true);
                          },
                          onCreate: function () {
                            if (peers.length > 0) createSessionInWorkspace(peers[0], null);
                          },
                        })
                      : h(
                          'span',
                          { style: { display: 'flex', alignItems: 'center', gap: 4, color: C.labelTertiary } },
                          h('span', { title: '搜索', style: { padding: 2 } }, '⌕'),
                          h('span', { title: '筛选', style: { padding: 2 } }, '☰'),
                          h('span', { title: '新建工作区', style: { padding: 2 } }, '＋'),
                        ),
                  ),
            ),
            h(
              'div',
              { style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden' } },
              loading && !snapshot
                ? h('div', { style: emptyHintStyle }, '正在读取主机状态…')
                : !sidebarVendor
                  ? null
                : peers.length === 0
                  ? h('div', { style: emptyHintStyle }, '暂无远端主机。请确认 relay 已连接，并在另一台实例中完成配对。')
                  : peers.map(function (peer, index) {
                      var peerId = peer && peer.id ? peer.id : 'peer-' + index;
                      return h(PeerSection, {
                        key: peerId,
                        peer: peer,
                        expanded: expanded[peerId] === true,
                        selection: selection,
                        vendor: sidebarVendor,
                        searchQuery: searchQuery,
                        onCreateInWorkspace: createSessionInWorkspace,
                        onToggle: function () {
                          togglePeer(peerId);
                        },
                        onSelect: selectSession,
                      });
                    }),
            ),
          ),
          h(
            'div',
            { style: rightColumnStyle },
            selection
              ? h(TranscriptPane, {
                  selection: selection,
                  peer: selectedPeer,
                  selfVersion: snapshot && snapshot.self ? snapshot.self.version : null,
                  sessionHint: selectedSession,
                  relayConnected: connected,
                  onMutated: refresh,
                  onCreated: function (peerId, nextSessionId) {
                    if (!nextSessionId) return;
                    setSelection({ peerId: peerId, sessionId: nextSessionId });
                    refresh();
                  },
                  onForked: function (peerId, nextSessionId) {
                    if (!nextSessionId) return;
                    setSelection({ peerId: peerId, sessionId: nextSessionId });
                    refresh();
                  },
                })
              : h(
                  'div',
                  { style: emptyPaneStyle },
                  h('div', { style: { fontSize: 13, opacity: 0.8 } }, '在左侧选择一个会话查看对话'),
                  h(
                    'div',
                    { style: merge(mutedSmallStyle, { marginTop: 6, lineHeight: 1.8 }) },
                    connected ? '对话内容每 2 秒自动刷新，发送消息后立即刷新。' : 'relay 未连接；本机会话仍可直接查看。',
                  ),
                ),
          ),
        ),
      );
    }

    // ── official Settings page section ──────────────────────────────────────
    var settingsSectionInputStyle = {
      height: 32,
      padding: '0 10px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.26))',
      background: 'var(--dsw-alias-button-elevated-fill, transparent)',
      color: 'inherit',
      font: 'inherit',
      fontSize: 13,
      outline: 'none',
      boxSizing: 'border-box',
      width: '100%',
    };

    /** One labelled row inside the official Settings page. */
    function SettingsSectionField(props) {
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
        h('span', null, props.label),
        h('input', {
          type: props.secret ? 'password' : 'text',
          value: props.value || '',
          placeholder: props.placeholder || '',
          disabled: props.disabled,
          onChange: function (event) {
            props.onChange(event.target.value);
          },
          'aria-label': props.label,
          style: settingsSectionInputStyle,
        }),
        props.hint ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, props.hint) : null,
      );
    }

    /**
     * Official Settings page section for the relay connection. Registered into
     * the shell's `settings.section` list so the panel is configured next to
     * the other product settings.
     */
    function RemoteConnectionSettingsSection(props) {
      // The slot renderer spreads the registered inject face into the component
      // props; the panel harness and older shells may nest it under `injected`.
      var injected = props && props.injected && typeof props.injected === 'object' ? props.injected : props || {};
      var formState = React.useState({ relayUrl: '', token: '', instanceId: '', instanceName: '' });
      var form = formState[0];
      var setForm = formState[1];
      var metaState = React.useState(null);
      var meta = metaState[0];
      var setMeta = metaState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];

      var load = function () {
        if (typeof injected.load !== 'function') {
          setError('设置服务不可用：插件未注入设置接口');
          return;
        }
        setBusy(true);
        setError(null);
        injected.load().then(
          function (data) {
            setBusy(false);
            setMeta(data || null);
            setForm({
              relayUrl: data && data.relayUrl ? String(data.relayUrl) : '',
              token: '',
              instanceId: data && data.instanceId ? String(data.instanceId) : '',
              instanceName: data && data.instanceName ? String(data.instanceName) : '',
            });
          },
          function (loadError) {
            setBusy(false);
            setError(String((loadError && loadError.message) || loadError));
          },
        );
      };

      React.useEffect(load, []);

      var update = function (key) {
        return function (value) {
          setForm(function (previous) {
            var next = Object.assign({}, previous);
            next[key] = value;
            return next;
          });
        };
      };

      var save = function () {
        if (busy) return;
        if (typeof injected.save !== 'function') {
          setError('设置服务不可用：插件未注入设置接口');
          return;
        }
        setBusy(true);
        setError(null);
        injected.save(form).then(
          function (saved) {
            setBusy(false);
            setMeta(saved || null);
            setForm(function (previous) {
              var next = Object.assign({}, previous);
              next.token = '';
              return next;
            });
            if (!saved || !saved.relay || saved.relay.connected !== true) {
              setError('配置已保存，但 relay 仍未连接：' + ((saved && saved.relay && saved.relay.lastError) || '连接超时，请检查地址/令牌或网络'));
            }
          },
          function (saveError) {
            setBusy(false);
            setError(String((saveError && saveError.message) || saveError));
          },
        );
      };

      var connected = !!(meta && meta.relay && meta.relay.connected);
      return h(
        'div',
        {
          'aria-label': '远程会话设置',
          style: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 },
        },
        h(
          'p',
          { style: { margin: 0, fontSize: 12, lineHeight: '19px', color: 'var(--dsw-alias-label-tertiary)' } },
          '设置本机连接的中转 relay。保存后立即重连；其它设备需使用同一个 relay 与令牌。',
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
          h('span', {
            style: {
              width: 8,
              height: 8,
              borderRadius: 999,
              background: connected ? 'var(--dsw-alias-state-success-primary, #2da44e)' : 'var(--dsw-alias-state-warning-primary, #d4a72c)',
            },
          }),
          h('span', null, connected ? 'relay 已连接' : 'relay 未连接'),
          meta && meta.relay && meta.relay.lastError
            ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary, #d1242f)' } }, '· ' + String(meta.relay.lastError))
            : null,
        ),
        SettingsSectionField({
          label: 'Relay 地址',
          value: form.relayUrl,
          placeholder: 'http://127.0.0.1:3098',
          disabled: busy,
          onChange: update('relayUrl'),
        }),
        SettingsSectionField({
          label: '访问令牌',
          value: form.token,
          secret: true,
          placeholder: meta && meta.hasToken ? '已设置（留空保持不变）' : '填写 relay 令牌',
          disabled: busy,
          onChange: update('token'),
        }),
        SettingsSectionField({ label: '实例 ID', value: form.instanceId, placeholder: 'company', disabled: busy, onChange: update('instanceId') }),
        SettingsSectionField({ label: '实例名称', value: form.instanceName, placeholder: '公司', disabled: busy, onChange: update('instanceName') }),
        error ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #d1242f)' } }, error) : null,
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
          h(
            'button',
            {
              type: 'button',
              disabled: busy,
              onClick: save,
              style: {
                height: 30,
                padding: '0 14px',
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-button-primary-fill, #4d6bfe)',
                background: 'var(--dsw-alias-button-primary-fill, #4d6bfe)',
                color: 'var(--dsw-alias-button-primary-label, #fff)',
                font: 'inherit',
                fontSize: 13,
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.6 : 1,
              },
            },
            busy ? '连接中…' : '保存并重连',
          ),
        ),
      );
    }

    // ── sidebar icon ────────────────────────────────────────────────────────
    function PanellistIcon(props) {
      var size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 16;
      var active = !!(props && props.active);
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: active ? ACCENT : 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('rect', { x: 2.5, y: 4, width: 8, height: 6, rx: 1.4 }),
        h('rect', { x: 13.5, y: 14, width: 8, height: 6, rx: 1.4 }),
        h('path', { d: 'M10.5 7V15.4C10.5 16.3 11.2 17 12.1 17H13.5' }),
      );
    }

    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false, message: '' };
      }

      static getDerivedStateFromError(error) {
        return { failed: true, message: String((error && error.message) || error) };
      }

      componentDidCatch(error) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[dsh-remote-session] panel crashed:', error);
        }
      }

      render() {
        if (this.state.failed) {
          return h(
            'div',
            {
              style: {
                padding: 16,
                fontSize: 13,
                lineHeight: '20px',
                color: 'var(--dsw-alias-state-error-primary, #d1242f)',
              },
            },
            '远程会话面板渲染出错：' + this.state.message,
          );
        }
        return this.props.children;
      }
    }

    function RemotePanel() {
      return h(PanelBoundary, null, h(RemoteSessionsPage));
    }

    // ── client plugin entry ─────────────────────────────────────────────────
    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function') {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[dsh-remote-session] client slots service unavailable; UI not mounted');
        }
        return;
      }

      var disposers = [];

      function registerIcon() {
        return ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 50,
            label: function () {
              return PANEL_TITLE;
            },
          },
          PanellistIcon,
        );
      }

      function registerPage() {
        return ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
          },
          RemotePanel,
        );
      }

      function mountWhenDeclared(slotName, register) {
        if (typeof ctx.slots.inject === 'function') {
          disposers.push(
            ctx.slots.inject(slotName, function () {
              var dispose = register();
              return typeof dispose === 'function' ? dispose : function () {};
            }),
          );
          return;
        }
        disposers.push(register());
      }

      function disposeAll() {
        for (var i = disposers.length - 1; i >= 0; i -= 1) {
          var dispose = disposers[i];
          if (typeof dispose !== 'function') continue;
          try {
            dispose();
          } catch (error) {
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('[dsh-remote-session] slot dispose failed:', error);
            }
          }
        }
        disposers.length = 0;
      }

      function mount() {
        try {
          disposers.push(installOfficialScrollbarStyles());
          // Declarations may arrive after this plugin activates (ui-layout /
          // ui-sidebar load order), so wait for each slot declaration first.
          mountWhenDeclared('sidebar.panellist', registerIcon);
          mountWhenDeclared('main', registerPage);
          mountWhenDeclared('settings.section', function () {
            return ctx.slots.register(
              {
                name: 'settings.section',
                id: 'remote-session',
                order: 90,
                label: function () {
                  return '远程会话';
                },
                inject: function () {
                  return {
                    load: function () {
                      return post('settings', {});
                    },
                    save: function (form) {
                      return post('settings-save', {
                        relayUrl: form.relayUrl,
                        token: form.token,
                        instanceId: form.instanceId,
                        instanceName: form.instanceName,
                      });
                    },
                  };
                },
              },
              RemoteConnectionSettingsSection,
            );
          });

        } catch (error) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[dsh-remote-session] slot registration failed:', error);
          }
        }
        return disposeAll;
      }

      if (typeof ctx.effect === 'function') {
        ctx.effect(mount, 'dsh-remote-session: client slots');
      } else {
        mount();
      }
    }

    exports.name = PLUGIN_NAME;
    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
