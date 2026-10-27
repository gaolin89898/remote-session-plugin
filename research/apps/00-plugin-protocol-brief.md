# dsh-remote-session 协议与适配面速览（供 App 适配调研使用）

> 整理日期：2026-10-27 · 对象：本仓库 v1.0.0 · 本机 DSH：0.2.1-rc.3（插件要求 `dsh >=0.2.1-rc.2`）
> 目的：给"GitHub 上的 DSH App 能否与本插件适配"提供一份可对照的接口事实表。
> 证据均来自本仓库源码，行号以当前 main 为准（提交 39cd0ca）。

## 1. 拓扑与角色

```
浏览器（官方 Web UI 客户端 + 本插件 client 补丁）
   │  同源 HTTP：/api/**（官方 Gateway）、/remote-session/api/*（本插件）
   ▼
DSH 实例 A（本机，插件 Host 端 lib/index.js）
   │  POST /v1/{register,index,publish,peers}     GET /v1/stream (SSE)
   ▼
自建 relay（relay/server.cjs，共享令牌，只转发不落盘）
   ▲
   │  同上
DSH 实例 B（远端，同一插件）── native-gateway 把官方 Gateway 协议透传给 A 的页面
```

- 机器切换：页面把选中的 peerId 写入 `sessionStorage['dsh.remote-session.machine.v1']` 后整页 reload（`lib/native-transport.js:29-51`）。
- 远端页面 = 本地页面骨架 + 远端 Host 的官方协议：`lib/native-transport.js` 劫持 `window.fetch` / `__DSH_TRANSPORT__.fetch/openStream`，把 `/api/**` 请求换成 relay RPC `native` 转发到 B 执行（`native-transport.js:137-227`）。
- 因此"远程机器"在 UI 上是原生 DSH 体验；插件前端只做环境标识与机器选择菜单（`lib/client.js:542-560` 注入 `sidebar.footer.action`、`sidebar.panellist`、`settings.section`）。

## 2. relay HTTP 协议（relay/server.cjs）

认证：除 `GET /health` 外全部要共享令牌 `token`；`GET /v1/stream` 用 query `?id=&token=`，其余 POST body 里带 `token` 字段（`server.cjs:24-27,116-121,148-169`）。
端口 127.0.0.1:3098，由 nginx 前缀 `/dsh-relay/` 暴露；内存态、不落盘；离线实例 15 分钟后清除（`server.cjs:18-19,172-181`）。

| 端点 | 请求体 | 响应 | 说明 |
| --- | --- | --- | --- |
| `GET /health` | — | `{ok:true}` | 健康检查 |
| `GET /v1/stream?id&token` | — | `text/event-stream` | 每实例一条 SSE；20s 心跳 `: ping`；建立时发 `event: ready`（peers 快照） |
| `POST /v1/register` | `{id,name,sessions?,meta?,previousId?,token}` | `{ok,peers}` | 注册/更新本实例；可声明旧实例 ID 的迁移（server.cjs:65-88） |
| `POST /v1/index` | `{id,sessions,token}` | `{ok}` | 刷新会话索引，向其他实例广播 `peer.index` |
| `POST /v1/publish` | `{from,to,type,payload?,id?,token}` | `{ok}` / `409 target_offline` | `to:'*'` 广播；否则定向投递 SSE `message`（server.cjs:99-114） |
| `POST /v1/peers` | `{id,token}` | `{ok,peers}` | 权威实例快照 |

SSE event 类型：`ready`、`peer`（`{type:'online'|'offline',instance}`）、`peer.index`、`message`（envelope `{from,type,payload,id?,ts}`）。
限制：body ≤ 64MB，单实例 SSE 只保留 1 条（新连接顶掉旧连接），离线队列不缓存（`target_offline`）。

## 3. 插件 relay RPC（lib/index.js:1043-1129）

信封：请求 `{from, to, type:'rpc', id, payload:{method, params}}`；响应 `{from, to, type:'rpc.result', id, payload:{ok:true,result} | {ok:false,error}}`（index.js:867-884）。
调用方 = 任意已注册实例（含普通 DSH 插件实例；协议上没有限制"必须是 DSH"）。

| method | params | 作用 |
| --- | --- | --- |
| `version` | `{}` | `{version,nativeProtocol:1,pluginSyncProtocol:1}` |
| `native` | 官方 Gateway 载体操作对象（见 §4） | 把官方 Client 的 fetch/stream 请求转给远端 Host 执行（核心） |
| `pluginSync` | `{action:'inventory'|'start'|'status'|'cancel', ...}` | 远端插件清单/同步（lib/plugin-sync.js） |
| `list` | `{}` | 远端会话索引（title/cwd/running/updatedAt 等） |
| `transcript` | `{sessionId}` | 会话头 + 消息转录 |
| `events` | `{sessionId,afterSeq,limit}` | 增量事件（实时回复/工具调用/审批等原始事件） |
| `fork` | `{sessionId,atSeq}` | 分叉会话 |
| `attachment` | `{sessionId,attachmentId}` | 读取附件 |
| `fileReferences` | `{sessionId,query}` | 文件引用补全 |
| `workspaces` | `{}` | 远端工作区列表 |
| `commands` | `{sessionId}` | 可用斜杠命令 |
| `openPath` | `{sessionId,path,action}` | 打开文件/目录（引导到远端） |
| `files` | `{sessionId,query}` | 工作区文件搜索 |
| `create` | `{cwd}` | 新建会话 |
| `feedback` / `feedbackPut` / `feedbackDelete` | `{sessionId}` / `{request}` | 消息反馈 |
| `goalAction` | `{sessionId,action,goalId?,revision?,objective?}` | 目标操作 |
| `permissionCatalog` / `permissionSet` | `{}` / `{sessionId,preset}` | 权限预设目录/设置 |
| `executeCommand` | `{sessionId,line}` | 执行斜杠命令 |
| `prompt` | `{sessionId,text,mode}` | 发送用户消息（远端进程内执行） |
| `cancel` | `{sessionId}` | 取消当前运行 |
| `models` | `{}` | 模型目录 |
| `selectModel` | `{sessionId,selection:{provider,model,reasoningEffort}}` | 选择模型 |
| `pluginSync` | 见上 | 插件同步 |

注意：本 RPC 面**没有独立的 approval/审批方法**。远端页面的审批走官方 Gateway（`native` + 官方事件流），因为页面跑的是完整官方客户端协议。

## 4. 官方 Gateway 载体（lib/native-gateway.js）

`native` method 的 operation 字段（native-gateway.js:93-176）：

| operation | 字段 | 说明 |
| --- | --- | --- |
| `probe` | `{}` | 返回 `{protocol:1, clientEntries:[客户端模块 id]}`，用于校验目标机器版本/组合 |
| `fetch` | `{requestId, route:'api/...', method, contentType, bodyBase64}` | 走官方 `connection.createSharedFetchHandler('/api')`，等价页面同源 fetch；响应 `{status,headers,body(base64)}` |
| `open` | `{streamId, endpoint, payload, uplink?}` | 打开官方 `typertGateway.wireStream.open` 流（如会话事件流） |
| `pull` | `{streamId, sequence}` | 拉取流批次 `{sequence,values[],done,failure}`；每帧以 32KB 文本分片承载 |
| `uplink` | `{streamId, sequence, value?, done?}` | 客户端→Host 流上行 |
| `close` / `cancel` / `release` | `{streamId}` / `{requestId}` / `{}` | 关闭流 / 取消请求 / 释放客户端 |

限制：每客户端最多 64 请求、128 流；单条流快照 ≤16MB；请求响应 ≤8MB；客户端 60s 无活动回收（native-gateway.js:4-5,76-110,132-133,198）。
前置条件：DSH 必须提供 `ctx.typertGateway.wireStream` 与 `ctx.connection.createSharedFetchHandler`，且页面有 `__DSH_BOOT__` 客户端组合图（native-transport.js:56-92，native-gateway.js:95-103）。

## 5. 插件私有 HTTP API（lib/index.js:1290-1538，前缀 `/remote-session/api/`）

GET/POST 同源接口，供本插件前端使用；`peerId:'local'` 表示本机，否则内部转成 `rpcCall(peerId, ...)`：

`settings`、`settings-save`、`state`、`refresh`、`native`、`plugin-sync/{preview,start,status,cancel}`、`transcript`、`commands`、`execute-command`、`files`、`open-path`、`goal-action`、`permission-catalog`、`permission-set`、`feedback`、`feedback-put`、`feedback-delete`、`create`、`file-references`、`attachment`、`fork`、`events`、`send`、`models`、`select-model`、`cancel`。
`state` 返回 `{relay:{connected,url,lastError,...}, self:{id,name,version}, workspaces, peers:[{id,name,online,version,sessions,workspaces}]}`（index.js:1255-1277）。

## 6. 前端补丁依赖（lib/native-transport.js, lib/client.js）

- 页面必须提供官方 `__DSH_BOOT__`（客户端入口列表 + batches）与 `__DSH_TRANSPORT__`，否则远程启动失败并回退本机（native-transport.js:64-102）。
- 机器选择存在 `sessionStorage`；远程机器把 `localStorage` 中 `dsh.*` 键做前缀隔离（native-transport.js:104-135）。
- 请求劫持范围：同源且路径 `api/` 前缀的 fetch 才走 relay；其他（如插件静态资源、远程机器插件 bundle）仍在本地（native-transport.js:137-146）。
- 远程会话的客户端组合 = 目标机器 `probe` 返回的 clientEntries 与本地 `__DSH_BOOT__` 的交集（HMR 包被剔除，`dsh-remote-session` 强制保留），并要求 `@deepseek-ai/dsh-client-ui-workspace`、`@deepseek-ai/dsh-api-session-controller` 存在（native-transport.js:69-92）。
- UI 注入点：`sidebar.footer.action`（环境状态）、`sidebar.panellist`（机器/会话菜单）、`settings.section`（Relay 配置+插件同步）（client.js:542-560）。

## 7. 结论：外部 App 可用的三种接入面

1. **浏览器/WebView 面（零改码候选）**：任何能把"宿主 DSH 的官方 Web 页面 + 其同源 HTTP/SSE API + 插件路由"完整透传到手机/其他壳的方案，都能直接获得本插件 UI（含机器切换），因为插件前端只是普通 web 客户端补丁。关键要求：同源（或正确 base path）、不剥离 `/remote-session/api/*`、SSE 不缓冲、localStorage/sessionStorage 可用、页面启动时 `__DSH_BOOT__` 由官方 web bundle 注入。
2. **relay 原生客户端面（App 改造候选）**：App 自己实现 §2 + §3（共享令牌、SSE 长连、RPC 信封），即可成为一个"实例"，直接读写远端会话；不需要官方 Gateway。审批需另补接口（当前 RPC 面没有 approval 方法，可扩展）。
3. **官方 Gateway 面（最完整但最重）**：App 实现 §4 的 `native` 载体（fetch/open/pull/uplink…），即可复用官方 Client 的全套 Remote API；但要求 App 内嵌官方 Client 组合/协议版本，工程量大、且官方协议仍在快速演进。

> 兼容性提示：本插件客户端组合交集校验会拒绝缺少官方 client 包的宿主；DSH 官方处于 developer preview，README 明确"会有破坏性变更"，任何第三方 App 适配都应锚定具体 DSH 版本并做版本探测。
