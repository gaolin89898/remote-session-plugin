window.__ModuleLoader__.load({ id: 'dsh-remote-session', factory: (require) => { var module = { exports: {} }; var exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// tools/machine-client.tsx
var machine_client_exports = {};
__export(machine_client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(machine_client_exports);
var import_react = __toESM(require("react"), 1);
var import_react_dom = require("react-dom");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_jsx_runtime = require("react/jsx-runtime");
var name = "dsh-remote-session";
var inject = ["slots"];
async function post(method, body = {}) {
  const response = await fetch(new URL("remote-session/api/" + method, document.baseURI), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(`\u8FDC\u7A0B\u4F1A\u8BDD\u8BF7\u6C42\u672A\u901A\u8FC7\u8BA4\u8BC1\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u6216\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5\uFF08HTTP ${response.status}\uFF09`);
  }
  const text = await response.text();
  if (!text.trim()) throw new Error(`\u8FDC\u7A0B\u4F1A\u8BDD\u63A5\u53E3\u8FD4\u56DE\u7A7A\u54CD\u5E94\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5\uFF08HTTP ${response.status}\uFF09`);
  if (/text\/html/i.test(response.headers.get("content-type") || "") || /^\s*</.test(text)) {
    throw new Error("\u8FDC\u7A0B\u4F1A\u8BDD\u63A5\u53E3\u8FD4\u56DE\u4E86\u767B\u5F55\u9875\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u540E\u91CD\u8BD5");
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`\u8FDC\u7A0B\u4F1A\u8BDD\u63A5\u53E3\u54CD\u5E94\u65E0\u6548\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5\uFF08HTTP ${response.status}\uFF09`);
  }
  if (!response.ok || !data || typeof data !== "object" || data.ok !== true) {
    throw new Error(data?.error || `\u8FDC\u7A0B\u4F1A\u8BDD\u8BF7\u6C42\u5931\u8D25\uFF08HTTP ${response.status}\uFF09`);
  }
  return data;
}
var machineState = { snapshot: null, error: "" };
var machineListeners = /* @__PURE__ */ new Set();
var machineTimer;
var machineRead;
function refreshMachineState(method = "state") {
  if (method === "state" && machineRead) return machineRead;
  const task = post(method).then((snapshot) => {
    machineState = { snapshot, error: "" };
  }, (failure) => {
    machineState = { ...machineState, error: failure.message };
  }).then(() => {
    for (const listener of machineListeners) listener();
  });
  if (method === "state") {
    machineRead = task;
    void task.finally(() => {
      if (machineRead === task) machineRead = void 0;
    });
  }
  return task;
}
function subscribeMachineState(listener) {
  machineListeners.add(listener);
  if (machineListeners.size === 1) {
    void refreshMachineState();
    machineTimer = setInterval(() => {
      void refreshMachineState();
    }, 5e3);
  }
  return () => {
    machineListeners.delete(listener);
    if (!machineListeners.size) {
      clearInterval(machineTimer);
      machineTimer = void 0;
    }
  };
}
var getMachineState = () => machineState;
function useMachineState() {
  return import_react.default.useSyncExternalStore(subscribeMachineState, getMachineState);
}
function currentEnvironment(snapshot, error) {
  const peerId = window.__DSH_REMOTE_SESSION__?.peerId || "local";
  const local = peerId === "local";
  const machine = local ? snapshot?.self : snapshot?.peers?.find((peer) => peer.id === peerId);
  const name2 = machine?.name || (local ? "" : peerId);
  const environment = (local ? "\u672C\u673A" : "\u8FDC\u7A0B") + (name2 ? " \xB7 " + name2 : "");
  const mode = typeof window.dshDesktopBoot?.ready === "function" ? "\u5BA2\u6237\u7AEF" : "Web \u7AEF";
  const online = !!snapshot && !error && (local || snapshot.relay?.connected && machine?.online);
  const state = error ? "\u72B6\u6001\u672A\u77E5" : !snapshot ? "\u8FDE\u63A5\u4E2D" : online ? "\u5DF2\u8FDE\u63A5" : "\u79BB\u7EBF";
  const label = environment + " \xB7 " + mode + " \xB7 " + state;
  return { peerId, local, name: name2 || (local ? "\u672C\u673A" : peerId), environment, mode, online, state, label };
}
function EnvironmentStatus({ wide = true }) {
  const { snapshot, error } = useMachineState();
  const { peerId, local, environment, mode, online, state, label } = currentEnvironment(snapshot, error);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "div",
    {
      role: "status",
      "aria-label": label,
      title: label,
      "data-remote-environment": peerId,
      className: "dsh-remote-environment" + (wide ? "" : " dsh-remote-environment-compact"),
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: `
      /* Footer occupants share a horizontal slot; keep full-width widgets on separate rows. */
      div:has(> div > .dsh-remote-environment) { flex-direction: column; gap: 4px; }
      .dsh-remote-environment { box-sizing: border-box; display: flex; flex: none; align-items: center; gap: 7px; width: 100%; min-width: 0; min-height: 32px; padding: 6px 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
      .dsh-remote-environment-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsh-remote-environment-mode { flex: 0 0 auto; white-space: nowrap; }
      .dsh-remote-environment-compact { width: 40px; min-height: 56px; padding: 4px 0; flex-direction: column; justify-content: center; gap: 0; font-size: 10px; line-height: 16px; }
    ` }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: online ? "done" : "idle" }),
        wide && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-remote-environment-name", children: [
          environment,
          !online && snapshot ? " \xB7 " + state : ""
        ] }),
        !wide && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: local ? "\u672C\u673A" : "\u8FDC\u7A0B" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-remote-environment-mode", children: mode })
      ]
    }
  );
}
function MachineMenu({ size = 16 }) {
  const [open, setOpen] = import_react.default.useState(false);
  const { snapshot, error: stateError } = useMachineState();
  const [error, setError] = import_react.default.useState(() => window.__DSH_REMOTE_SESSION__?.bootError || "");
  const [busy, setBusy] = import_react.default.useState(false);
  const icon = import_react.default.useRef(null);
  const [trigger, setTrigger] = import_react.default.useState(null);
  const bridge = window.__DSH_REMOTE_SESSION__;
  const selected = bridge?.peerId || "local";
  const current = currentEnvironment(snapshot, stateError);
  import_react.default.useLayoutEffect(() => {
    const button = icon.current?.closest("button");
    if (!button) return;
    setTrigger(button);
    const previous = ["aria-haspopup", "aria-expanded", "title"].map((key) => [key, button.getAttribute(key)]);
    const toggle = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen((value) => !value);
    };
    button.addEventListener("click", toggle, true);
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("title", "\u8FDC\u7A0B\u4F1A\u8BDD");
    return () => {
      button.removeEventListener("click", toggle, true);
      for (const [key, value] of previous) {
        if (value === null) button.removeAttribute(key);
        else button.setAttribute(key, value);
      }
    };
  }, []);
  import_react.default.useLayoutEffect(() => {
    icon.current?.closest("button")?.setAttribute("aria-expanded", String(open));
  }, [open]);
  const choose = async (id) => {
    if (busy) return;
    if (id === selected) {
      setOpen(false);
      return;
    }
    setError("");
    setBusy(true);
    try {
      if (!bridge) throw new Error("\u8BF7\u91CD\u542F DSH \u4EE5\u52A0\u8F7D\u673A\u5668\u5207\u6362\u670D\u52A1");
      await bridge.switchMachine(id);
    } catch (failure) {
      setError("\u5207\u6362\u5931\u8D25\uFF1A" + failure.message);
      setBusy(false);
    }
  };
  const peers = (snapshot?.peers || []).filter((peer) => peer.id !== "local" && peer.id !== snapshot?.self?.id);
  const items = [
    { id: "local", label: "\u672C\u673A" + (snapshot?.self?.name ? " \xB7 " + snapshot.self.name : ""), icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: "idle" }), disabled: busy },
    ...peers.map((peer) => ({
      id: peer.id,
      label: peer.name + (peer.online ? "" : "\uFF08\u79BB\u7EBF\uFF09"),
      icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: peer.online ? "done" : "idle" }),
      disabled: busy || !peer.online
    })),
    ...!peers.length ? [{ type: "label", id: "empty", text: snapshot ? "\u6682\u65E0\u8FDC\u7A0B\u673A\u5668" : "\u6B63\u5728\u8BFB\u53D6\u673A\u5668\u2026" }] : [],
    { type: "separator", id: "actions" },
    { id: "$refresh", label: "\u5237\u65B0\u673A\u5668", icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconRefreshOutlineRegular, {}), disabled: busy },
    ...busy ? [{ type: "label", id: "busy", text: "\u6B63\u5728\u8FDE\u63A5\u2026" }] : [],
    ...error || stateError ? [{ type: "label", id: "error", text: error || stateError }] : []
  ];
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: `
    .dsh-remote-machine-menu { width: 288px; max-width: calc(100vw - 24px); }
    .dsh-remote-machine-current { display: flex; align-items: center; gap: 5px; margin-left: auto; min-width: 0; max-width: 50%; flex: 0 1 auto; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 18px; }
    .dsh-remote-machine-current-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dsh-remote-machine-current-mode { flex: none; white-space: nowrap; }
  ` }),
    trigger && size === 16 && !current.local && (0, import_react_dom.createPortal)(
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-remote-machine-current", title: current.label, "data-remote-machine-current": selected, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-remote-machine-current-name", children: current.name }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-remote-machine-current-mode", children: [
          "\xB7 ",
          current.mode
        ] })
      ] }),
      trigger
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      import_dsh_client_ui_primitives.Menu,
      {
        open,
        onClose: () => setOpen(false),
        portal: true,
        autoFocus: true,
        selectedId: selected,
        listClassName: "dsh-remote-machine-menu",
        getAnchorRect: () => icon.current?.closest("button")?.getBoundingClientRect() || null,
        anchor: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { ref: icon, style: { display: "inline-flex" }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconLinkOutlineRegular, { size }) }),
        items,
        onSelect: (id) => {
          if (id !== "$refresh") {
            void choose(id);
            return;
          }
          setError("");
          void refreshMachineState("refresh");
        }
      }
    )
  ] });
}
var syncStorageKey = "dsh.remote-session.plugin-sync.v1";
var syncActions = { install: "\u5B89\u88C5", update: "\u66F4\u65B0", enable: "\u542F\u7528", disable: "\u505C\u7528", current: "\u5DF2\u4E00\u81F4", skip: "\u8DF3\u8FC7" };
var syncStates = { pending: "\u7B49\u5F85\u4E2D", running: "\u540C\u6B65\u4E2D", done: "\u5DF2\u5B8C\u6210", failed: "\u5931\u8D25", cancelled: "\u5DF2\u53D6\u6D88", skipped: "\u8DF3\u8FC7" };
function savedSync() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(syncStorageKey) || "null");
    return typeof saved?.peerId === "string" && typeof saved?.id === "string" ? saved : null;
  } catch {
    return null;
  }
}
function PluginSyncSettings() {
  const initial = import_react.default.useRef(savedSync()).current;
  const [snapshot, setSnapshot] = import_react.default.useState(null);
  const [peerId, setPeerId] = import_react.default.useState(initial?.peerId || "");
  const [rows, setRows] = import_react.default.useState(null);
  const [selected, setSelected] = import_react.default.useState([]);
  const [job, setJob] = import_react.default.useState(initial ? { id: initial.id, state: "running", rows: [] } : null);
  const [busy, setBusy] = import_react.default.useState(false);
  const [error, setError] = import_react.default.useState("");
  const requestId = import_react.default.useRef(initial?.id || null);
  const generation = import_react.default.useRef(0);
  const running = job?.state === "running";
  const onlinePeers = (snapshot?.peers || []).filter((peer) => peer.id !== snapshot?.self?.id && peer.id !== "local");
  const target = onlinePeers.find((peer) => peer.id === peerId);
  const refreshMachines = async () => {
    const data = await post("state");
    setError("");
    setSnapshot(data);
    const peers = data.peers.filter((peer) => peer.online && peer.id !== data.self.id && peer.id !== "local");
    setPeerId((value) => value || peers.find((peer) => peer.id === window.__DSH_REMOTE_SESSION__?.peerId)?.id || peers[0]?.id || "");
  };
  import_react.default.useEffect(() => {
    let alive = true;
    post("state").then((data) => {
      if (!alive) return;
      setSnapshot(data);
      const peers = data.peers.filter((peer) => peer.online && peer.id !== data.self.id && peer.id !== "local");
      setPeerId((value) => value || peers.find((peer) => peer.id === window.__DSH_REMOTE_SESSION__?.peerId)?.id || peers[0]?.id || "");
    }, (failure) => {
      if (alive) setError(failure.message);
    });
    return () => {
      alive = false;
      generation.current++;
    };
  }, []);
  import_react.default.useEffect(() => {
    if (!running || !peerId || !job?.id) return;
    let alive = true;
    let timer;
    const poll = async () => {
      try {
        const status = await post("plugin-sync/status", { peerId, id: job.id });
        if (!alive) return;
        setJob(status);
        setError("");
        if (status.state !== "running") {
          sessionStorage.removeItem(syncStorageKey);
          return;
        }
      } catch (failure) {
        if (!alive) return;
        if (/同步任务不存在/.test(failure.message)) {
          sessionStorage.removeItem(syncStorageKey);
          setJob(null);
          requestId.current = null;
          setError("\u540C\u6B65\u4EFB\u52A1\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u6BD4\u8F83\u63D2\u4EF6");
          return;
        }
        setError("\u6682\u65F6\u65E0\u6CD5\u8BFB\u53D6\u8FDB\u5EA6\uFF0C\u76EE\u6807\u673A\u5668\u4E0A\u7684\u4EFB\u52A1\u53EF\u80FD\u4ECD\u5728\u8FD0\u884C\uFF1A" + failure.message);
      }
      if (alive) timer = setTimeout(poll, 2e3);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [peerId, job?.id, running]);
  const compare = async () => {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    setJob(null);
    requestId.current = null;
    try {
      const data = await post("plugin-sync/preview", { peerId });
      if (current !== generation.current) return;
      setRows(data.rows);
      setSelected(data.rows.filter((row) => ["install", "update", "enable", "disable"].includes(row.action)).map((row) => row.name));
    } catch (failure) {
      if (current === generation.current) setError(failure.message);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const start = async () => {
    setBusy(true);
    setError("");
    requestId.current ||= crypto.randomUUID();
    sessionStorage.setItem(syncStorageKey, JSON.stringify({ peerId, id: requestId.current }));
    try {
      const status = await post("plugin-sync/start", { peerId, id: requestId.current, names: selected });
      sessionStorage.setItem(syncStorageKey, JSON.stringify({ peerId, id: status.id }));
      setJob(status);
      if (status.state !== "running") sessionStorage.removeItem(syncStorageKey);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  const displayed = job?.rows.length ? job.rows : rows;
  const actionableCount = rows ? rows.filter((r) => ["install", "update", "enable", "disable"].includes(r.action)).length : 0;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { "aria-label": "\u63D2\u4EF6\u540C\u6B65", className: "dsh-remote-card dsh-plugin-sync", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-card-header", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-card-header-left", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-card-header-icon", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: "15", height: "15", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.25", strokeLinecap: "round", strokeLinejoin: "round", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M13.5 9.5a5 5 0 0 1-8.7 3.5M2.5 6.5a5 5 0 0 1 8.7-3.5" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M2.5 10v-3.5H6M13.5 6v3.5H10" })
      ] }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "dsh-card-title", children: "\u63D2\u4EF6\u540C\u6B65" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-card-desc", children: "\u6BD4\u5BF9\u5E76\u540C\u6B65\u672C\u673A\u4E0E\u8FDC\u7A0B\u8BBE\u5907\u4E0A\u7684\u63D2\u4EF6\u5B89\u88C5\u4E0E\u542F\u7528\u72B6\u6001" })
      ] })
    ] }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-sync-route-bar", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-sync-source", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: "\u6765\u6E90\uFF1A" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-sync-source-tag", children: snapshot ? "\u672C\u673A" + (snapshot.self?.name ? " \xB7 " + snapshot.self.name : "") : "\u672A\u8BFB\u53D6" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-sync-arrow", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { width: "13", height: "13", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M3 8h10M9 4l4 4-4 4" }) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        "select",
        {
          "aria-label": "\u540C\u6B65\u76EE\u6807\u673A\u5668",
          className: "dsh-sync-target-select",
          value: peerId,
          disabled: busy || running,
          onChange: (event) => {
            generation.current++;
            setPeerId(event.target.value);
            setRows(null);
            setSelected([]);
            setJob(null);
            setError("");
            requestId.current = null;
          },
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", disabled: true, children: "\u9009\u62E9\u76EE\u6807\u673A\u5668" }),
            onlinePeers.map((peer) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: peer.id, disabled: !peer.online, children: [
              peer.name,
              peer.online ? "" : "\uFF08\u79BB\u7EBF\uFF09"
            ] }, peer.id))
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-sync-buttons", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "outline", disabled: busy || running || !target?.online, icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconRefreshOutlineRegular, {}), onClick: () => {
          void compare();
        }, children: busy && !job ? "\u5904\u7406\u4E2D\u2026" : "\u6BD4\u8F83\u63D2\u4EF6" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "toolbar", title: "\u5237\u65B0\u673A\u5668", "aria-label": "\u5237\u65B0\u540C\u6B65\u673A\u5668", disabled: busy || running, icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconRefreshOutlineRegular, {}), onClick: () => {
          void refreshMachines().catch((failure) => setError(failure.message));
        } })
      ] })
    ] }),
    snapshot && !onlinePeers.length && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { role: "status", className: "dsh-alert-banner", style: { background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.03))" }, children: "\u6682\u65E0\u8FDC\u7A0B\u673A\u5668" }),
    displayed && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-sync-results", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-sync-list-header", children: [
        !job ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          import_dsh_client_ui_primitives.Checkbox,
          {
            label: "\u5168\u9009\u53EF\u540C\u6B65\u63D2\u4EF6",
            checked: !!selected.length && selected.length === actionableCount,
            disabled: busy,
            onChange: (checked) => setSelected(checked ? rows.filter((row) => ["install", "update", "enable", "disable"].includes(row.action)).map((row) => row.name) : [])
          }
        ) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontWeight: 500 }, children: "\u540C\u6B65\u660E\u7EC6" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-sync-list-count", children: rows ? `\u5171 ${rows.length} \u4E2A\u63D2\u4EF6` + (actionableCount ? ` \xB7 \u53EF\u540C\u6B65 ${selected.length}/${actionableCount}` : "") : "" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-plugin-sync-list", "aria-label": "\u63D2\u4EF6\u540C\u6B65\u5217\u8868", children: displayed.map((row) => {
        const actionText = job ? syncStates[row.state] : syncActions[row.action];
        const pillClass = `dsh-status-pill dsh-status-pill-${job ? row.state : row.action}`;
        return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-plugin-sync-row", "data-plugin-sync-name": row.name, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-plugin-row-top", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              import_dsh_client_ui_primitives.Checkbox,
              {
                label: row.name,
                checked: job ? row.state !== "skipped" : selected.includes(row.name),
                disabled: busy || !!job || !["install", "update", "enable", "disable"].includes(row.action),
                onChange: (checked) => setSelected((value) => checked ? [...value, row.name] : value.filter((name2) => name2 !== row.name))
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: pillClass, children: actionText })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-plugin-sync-detail", children: [
            "\u672C\u673A ",
            row.localVersion || "\u2014",
            " \xB7 ",
            row.enabled ? "\u542F\u7528" : "\u505C\u7528",
            " / \u76EE\u6807 ",
            row.remoteVersion || "\u672A\u5B89\u88C5",
            " \xB7 ",
            row.remoteEnabled ? "\u542F\u7528" : "\u505C\u7528",
            row.version && row.version !== row.localVersion ? " \xB7 \u5B89\u88C5 " + row.version : ""
          ] }),
          (row.reason || row.error) && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-plugin-sync-detail" + (row.error ? " dsh-plugin-sync-error" : ""), children: row.error || row.reason })
        ] }, row.name);
      }) }),
      !job && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-card-actions", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        import_dsh_client_ui_primitives.Button,
        {
          size: "sm",
          variant: "primary",
          icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconDownloadOutlineRegular, {}),
          disabled: busy || !selected.length || !target?.online,
          onClick: () => {
            void start();
          },
          children: [
            "\u540C\u6B65\u5230",
            target?.name || "\u8FDC\u7A0B\u673A\u5668",
            selected.length ? `\uFF08${selected.length}\uFF09` : ""
          ]
        }
      ) })
    ] }),
    job && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { role: "status", className: "dsh-sync-job-info", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-sync-job-status-line", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: running ? "idle" : job.state === "done" ? "done" : "error" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: running ? `\u6B63\u5728\u540C\u6B65 ${job.rows.filter((row) => row.state === "done").length}/${job.rows.length}` : job.state === "done" ? "\u63D2\u4EF6\u540C\u6B65\u5B8C\u6210" : job.state === "cancelled" ? "\u540C\u6B65\u5DF2\u53D6\u6D88" : "\u90E8\u5206\u63D2\u4EF6\u540C\u6B65\u5931\u8D25" })
      ] }),
      job.restartRequired && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-restart-hint", children: "\u76EE\u6807\u673A\u5668\u9700\u8981\u91CD\u542F DSH \u540E\u751F\u6548" })
    ] }),
    running && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-card-actions", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      import_dsh_client_ui_primitives.Button,
      {
        size: "sm",
        variant: "outline",
        disabled: busy || job.cancelRequested,
        onClick: async () => {
          setBusy(true);
          try {
            setJob(await post("plugin-sync/cancel", { peerId, id: job.id }));
          } catch (failure) {
            setError(failure.message);
          } finally {
            setBusy(false);
          }
        },
        children: job.cancelRequested ? "\u6B63\u5728\u53D6\u6D88\u2026" : "\u53D6\u6D88\u540C\u6B65"
      }
    ) }),
    error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { role: "alert", className: "dsh-alert-banner dsh-alert-error dsh-plugin-sync-error", children: error })
  ] });
}
function ConnectionSettings() {
  const [form, setForm] = import_react.default.useState({ relayUrl: "", token: "", instanceId: "", instanceName: "" });
  const [meta, setMeta] = import_react.default.useState(null);
  const [busy, setBusy] = import_react.default.useState(true);
  const [error, setError] = import_react.default.useState("");
  const [savedSuccess, setSavedSuccess] = import_react.default.useState(false);
  const [readAttempt, setReadAttempt] = import_react.default.useState(0);
  const [loaded, setLoaded] = import_react.default.useState(false);
  import_react.default.useEffect(() => {
    let alive = true;
    setBusy(true);
    setError("");
    setLoaded(false);
    setSavedSuccess(false);
    post("settings").then((data) => {
      if (!alive) return;
      setMeta(data);
      setForm({ relayUrl: data.relayUrl || "", token: "", instanceId: data.instanceId || "", instanceName: data.instanceName || "" });
      setLoaded(true);
    }, (failure) => {
      if (alive) setError(failure.message);
    }).finally(() => {
      if (alive) setBusy(false);
    });
    return () => {
      alive = false;
    };
  }, [readAttempt]);
  const mode = typeof window.dshDesktopBoot?.ready === "function" ? "\u5BA2\u6237\u7AEF" : "Web \u7AEF";
  const currentDisplayName = form.instanceName || form.instanceId || (meta?.instanceName || meta?.instanceId) || "\u5F53\u524D\u673A\u5668";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { "aria-label": "\u8FDC\u7A0B\u4F1A\u8BDD\u8BBE\u7F6E", className: "dsh-remote-settings", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: `
      .dsh-remote-settings { box-sizing: border-box; display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 600px; color: var(--dsw-alias-label-primary); font-family: inherit; }
      .dsh-remote-card { box-sizing: border-box; width: 100%; min-width: 0; border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1)); border-radius: var(--dsw-radius-xl, 10px); padding: 16px; display: flex; flex-direction: column; gap: 14px; }
      .dsh-card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
      .dsh-card-header-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .dsh-card-header-icon { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: var(--dsw-radius-md, 6px); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04)); color: var(--dsw-alias-label-secondary); flex-shrink: 0; }
      .dsh-card-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 20px; color: var(--dsw-alias-label-primary); }
      .dsh-card-desc { margin: 2px 0 0; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
      .dsh-status-hero { box-sizing: border-box; width: 100%; min-width: 0; border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1)); border-radius: var(--dsw-radius-xl, 10px); padding: 12px 14px; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
      .dsh-status-hero-left { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1 1 auto; font-size: 13px; font-weight: 500; }
      .dsh-status-hero-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
      .dsh-env-badge { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: var(--dsw-radius-md, 6px); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04)); border: 0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.08)); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .dsh-env-badge-name { font-weight: 500; color: var(--dsw-alias-label-primary); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsh-env-badge-mode { color: var(--dsw-alias-label-tertiary); }
      .dsh-fields-stack { display: flex; flex-direction: column; gap: 12px; width: 100%; }
      .dsh-grid-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; width: 100%; }
      .dsh-field-item { display: flex; flex-direction: column; gap: 6px; min-width: 0; width: 100%; font-size: 12px; }
      .dsh-field-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--dsw-alias-label-secondary); font-weight: 500; line-height: 16px; }
      .dsh-configured-tag { font-size: 10.5px; padding: 1px 6px; border-radius: var(--dsw-radius-xs, 4px); background: rgba(82,196,26,0.1); color: var(--dsw-alias-state-success-primary); border: 0.5px solid rgba(82,196,26,0.25); font-weight: normal; }
      .dsh-text-input { box-sizing: border-box; width: 100%; height: 32px; padding: 0 10px; border-radius: var(--dsw-radius-md, 6px); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-background-primary); color: inherit; font: inherit; font-size: 12.5px; transition: border-color 0.15s ease; }
      .dsh-text-input:hover:not(:disabled) { border-color: var(--dsw-alias-border-l4); }
      .dsh-text-input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 1px var(--dsw-alias-state-business-primary); }
      .dsh-text-input:disabled { opacity: 0.55; cursor: not-allowed; }
      .dsh-input-mono { font-family: var(--dsw-font-mono, monospace); font-size: 12px; }
      .dsh-field-tip { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
      .dsh-card-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 2px; }
      .dsh-alert-banner { box-sizing: border-box; display: flex; align-items: flex-start; gap: 6px; padding: 8px 12px; border-radius: var(--dsw-radius-md, 6px); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; width: 100%; }
      .dsh-alert-error { background: rgba(255,77,79,0.08); border: 0.5px solid rgba(255,77,79,0.25); color: var(--dsw-alias-state-error-primary); }
      .dsh-alert-success { background: rgba(82,196,26,0.08); border: 0.5px solid rgba(82,196,26,0.25); color: var(--dsw-alias-state-success-primary); }
      .dsh-sync-route-bar { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: var(--dsw-radius-lg, 8px); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.02)); border: 0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.06)); flex-wrap: wrap; }
      .dsh-sync-source { font-size: 12px; display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .dsh-sync-source-tag { font-weight: 500; color: var(--dsw-alias-label-primary); }
      .dsh-sync-arrow { color: var(--dsw-alias-label-tertiary); display: flex; align-items: center; flex-shrink: 0; }
      .dsh-sync-target-select { flex: 1 1 140px; min-width: 120px; height: 32px; border-radius: var(--dsw-radius-md, 6px); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-background-primary); color: inherit; font: inherit; font-size: 12px; padding: 0 8px; }
      .dsh-sync-buttons { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
      .dsh-sync-results { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      .dsh-sync-list-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 2px; font-size: 12px; }
      .dsh-sync-list-count { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
      .dsh-plugin-sync-list { max-height: 320px; overflow-y: auto; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 6px); background: var(--dsw-alias-background-primary); display: flex; flex-direction: column; }
      .dsh-plugin-sync-row { padding: 9px 12px; border-bottom: 0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.06)); display: flex; flex-direction: column; gap: 3px; font-size: 12px; transition: background 0.1s ease; }
      .dsh-plugin-sync-row:last-child { border-bottom: none; }
      .dsh-plugin-sync-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.02)); }
      .dsh-plugin-row-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
      .dsh-plugin-row-top > :first-child { min-width: 0; overflow-wrap: anywhere; }
      .dsh-status-pill { display: inline-flex; align-items: center; padding: 1px 7px; border-radius: var(--dsw-radius-xs, 4px); font-size: 11px; font-weight: 500; white-space: nowrap; }
      .dsh-status-pill-install, .dsh-status-pill-update { background: rgba(24,144,255,0.1); color: var(--dsw-alias-state-business-primary); border: 0.5px solid rgba(24,144,255,0.25); }
      .dsh-status-pill-enable, .dsh-status-pill-done { background: rgba(82,196,26,0.1); color: var(--dsw-alias-state-success-primary); border: 0.5px solid rgba(82,196,26,0.25); }
      .dsh-status-pill-disable { background: rgba(250,173,20,0.1); color: var(--dsw-alias-state-warn-primary); border: 0.5px solid rgba(250,173,20,0.25); }
      .dsh-status-pill-current, .dsh-status-pill-skip, .dsh-status-pill-skipped { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04)); color: var(--dsw-alias-label-tertiary); border: 0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.06)); }
      .dsh-status-pill-running { background: rgba(24,144,255,0.1); color: var(--dsw-alias-state-business-primary); }
      .dsh-status-pill-failed { background: rgba(255,77,79,0.1); color: var(--dsw-alias-state-error-primary); }
      .dsh-plugin-sync-detail { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
      .dsh-plugin-sync-error { color: var(--dsw-alias-state-error-primary); }
      .dsh-sync-job-info { display: flex; flex-direction: column; gap: 4px; padding: 8px 12px; border-radius: var(--dsw-radius-md, 6px); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.02)); border: 0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.06)); font-size: 12px; }
      .dsh-sync-job-status-line { display: flex; align-items: center; gap: 6px; font-weight: 500; }
      .dsh-restart-hint { color: var(--dsw-alias-state-warn-primary); font-size: 11px; }
    ` }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-status-hero", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-status-hero-left", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: meta?.relay?.connected ? "done" : "idle" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: busy ? "\u6B63\u5728\u8BFB\u53D6\u914D\u7F6E\u2026" : !loaded ? "\u914D\u7F6E\u8BFB\u53D6\u5931\u8D25" : meta.relay?.connected ? "relay \u5DF2\u8FDE\u63A5" : "relay \u672A\u8FDE\u63A5" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-status-hero-right", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-env-badge", title: "\u5F53\u524D\u8BBE\u5907\u8EAB\u4EFD\u4E0E\u8FD0\u884C\u6A21\u5F0F", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.StateDot, { state: meta?.relay?.connected ? "done" : "idle" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-env-badge-name", children: [
            "\u672C\u673A \xB7 ",
            currentDisplayName
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-env-badge-mode", children: [
            "\xB7 ",
            mode
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          import_dsh_client_ui_primitives.Button,
          {
            size: "sm",
            variant: "toolbar",
            title: "\u91CD\u65B0\u8BFB\u53D6\u914D\u7F6E",
            "aria-label": "\u91CD\u65B0\u8BFB\u53D6\u914D\u7F6E",
            disabled: busy,
            icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconRefreshOutlineRegular, {}),
            onClick: () => setReadAttempt((value) => value + 1)
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-remote-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-card-header", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-card-header-left", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-card-header-icon", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: "15", height: "15", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.25", strokeLinecap: "round", strokeLinejoin: "round", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "8", cy: "8", r: "6" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M2 8h12M8 2c2 2 3 4 3 6s-1 4-3 6M8 2c-2 2-3 4-3 6s1 4 3 6" })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "dsh-card-title", children: "\u4E2D\u7EE7\u670D\u52A1" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-card-desc", children: "\u914D\u7F6E\u4E2D\u592E\u8F6C\u53D1 Relay \u670D\u52A1\u5730\u5740\u4E0E\u5B89\u5168\u9274\u6743\u5BC6\u94A5" })
        ] })
      ] }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-fields-stack", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dsh-field-item", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-field-header", children: "Relay \u5730\u5740" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              "aria-label": "Relay \u5730\u5740",
              disabled: busy || !loaded,
              type: "text",
              value: form.relayUrl,
              placeholder: "\u4F8B\u5982 https://118.196.78.91:8081/dsh-relay",
              onChange: (event) => setForm((value) => ({ ...value, relayUrl: event.target.value })),
              className: "dsh-text-input"
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-field-tip", children: "\u7528\u4E8E\u591A\u673A\u5668\u4FE1\u4EE4\u8DEF\u7531\u4E0E\u4F1A\u8BDD\u96A7\u9053\u8F6C\u53D1\u7684\u4E2D\u7EE7 URL" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dsh-field-item", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-field-header", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "\u8BBF\u95EE\u4EE4\u724C" }),
            meta?.hasToken && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-configured-tag", children: "\u5DF2\u914D\u7F6E" })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              "aria-label": "\u8BBF\u95EE\u4EE4\u724C",
              disabled: busy || !loaded,
              type: "password",
              value: form.token,
              placeholder: meta?.hasToken ? "\u5DF2\u8BBE\u7F6E\uFF08\u7559\u7A7A\u4FDD\u6301\u4E0D\u53D8\uFF09" : "\u8BF7\u8F93\u5165\u8BBF\u95EE\u4EE4\u724C",
              onChange: (event) => setForm((value) => ({ ...value, token: event.target.value })),
              className: "dsh-text-input"
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-field-tip", children: "\u4E0E Relay \u670D\u52A1\u5EFA\u7ACB\u957F\u8FDE\u63A5\u6240\u9700\u7684\u5B89\u5168\u8BA4\u8BC1 Token" })
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-remote-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-card-header", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-card-header-left", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-card-header-icon", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: "15", height: "15", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.25", strokeLinecap: "round", strokeLinejoin: "round", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", { x: "2", y: "2.5", width: "12", height: "9", rx: "1.5" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M5 14.5h6M8 11.5v3" })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "dsh-card-title", children: "\u5B9E\u4F8B\u6807\u8BC6" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-card-desc", children: "\u8BBE\u5B9A\u5F53\u524D\u8BBE\u5907\u5728\u4E2D\u7EE7\u7F51\u7EDC\u4E2D\u7684\u552F\u4E00\u4EE3\u53F7\u4E0E\u597D\u53CB\u5C55\u793A\u540D\u79F0" })
        ] })
      ] }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-grid-fields", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dsh-field-item", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-field-header", children: "\u5B9E\u4F8B ID" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              "aria-label": "\u5B9E\u4F8B ID",
              disabled: busy || !loaded,
              type: "text",
              value: form.instanceId,
              placeholder: "\u4F8B\u5982 company, home, macbook",
              onChange: (event) => setForm((value) => ({ ...value, instanceId: event.target.value })),
              className: "dsh-text-input dsh-input-mono"
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-field-tip", children: "\u5168\u5C40\u552F\u4E00\u673A\u5668 ID\uFF0C\u5EFA\u8BAE\u4F7F\u7528\u5C0F\u5199\u5B57\u6BCD\u548C\u8FDE\u5B57\u7B26" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dsh-field-item", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-field-header", children: "\u5B9E\u4F8B\u540D\u79F0" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              "aria-label": "\u5B9E\u4F8B\u540D\u79F0",
              disabled: busy || !loaded,
              type: "text",
              value: form.instanceName,
              placeholder: "\u4F8B\u5982 \u516C\u53F8\u3001\u5BB6\u91CC\u53F0\u5F0F\u673A",
              onChange: (event) => setForm((value) => ({ ...value, instanceName: event.target.value })),
              className: "dsh-text-input"
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-field-tip", children: "\u5728\u5207\u6362\u83DC\u5355\u4E0E\u63D2\u4EF6\u540C\u6B65\u5217\u8868\u4E2D\u5C55\u793A\u7684\u53CB\u597D\u8BBE\u5907\u540D" })
        ] })
      ] }),
      error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { role: "alert", className: "dsh-alert-banner dsh-alert-error", style: { color: "var(--dsw-alias-state-error-primary)" }, children: error }),
      savedSuccess && !error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-alert-banner dsh-alert-success", children: "\u2713 \u914D\u7F6E\u5DF2\u4FDD\u5B58\u5E76\u8FDE\u63A5\u6210\u529F" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-card-actions", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        import_dsh_client_ui_primitives.Button,
        {
          size: "sm",
          variant: "outline",
          disabled: busy || !loaded,
          icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconRefreshOutlineRegular, {}),
          onClick: async () => {
            setBusy(true);
            setError("");
            setSavedSuccess(false);
            try {
              const saved = await post("settings-save", form);
              setMeta(saved);
              setForm((value) => ({ ...value, token: "" }));
              if (!saved.relay?.connected) {
                setError(saved.relay?.lastError || "relay \u5C1A\u672A\u8FDE\u63A5");
              } else {
                setSavedSuccess(true);
              }
            } catch (failure) {
              setError(failure.message);
            } finally {
              setBusy(false);
            }
          },
          children: busy ? "\u8FDE\u63A5\u4E2D\u2026" : "\u4FDD\u5B58\u5E76\u91CD\u8FDE"
        }
      ) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PluginSyncSettings, {})
  ] });
}
function apply(ctx) {
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action",
    id: "remote-session-environment",
    order: 100
  }, EnvironmentStatus));
  ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: "remote-session",
    order: 50,
    label: () => "\u8FDC\u7A0B\u4F1A\u8BDD"
  }, MachineMenu));
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "remote-session",
    order: 90,
    label: () => "\u8FDC\u7A0B\u4F1A\u8BDD"
  }, ConnectionSettings));
}
return module.exports; } });
