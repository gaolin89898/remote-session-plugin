# Host 侧会话能力调研（DSH 跨端会话互通插件）

> 调研日 2026-10-26 · 官方包版本 `0.2.1-rc.2` · 只读调研，未改任何配置/会话。
> 路径缩写 **`$M`** = `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`（服务器官方包）。
> 本地桌面端等价目录 `C:\Users\32891\.dsh\profiles\desktop\node_modules\`（只有少数插件包，无 core 类型）。

## 0. 结论速览

| # | 需求 | 推荐入口 | 要点 |
|---|---|---|---|
| 1 | 枚举会话 | `ctx.sessionQuery`（`listSessions`/`filterSessions`）+ `ctx.sessionController.list()` | 真实源=`~/.dsh/sessions/**/session.v4.jsonl.zstd`；SQLite 只是**可丢弃派生索引** |
| 2 | 读完整对话 | `readColdSessionLog()` / `ctx.sessionQuery.readSession()` | 官方已做 zstd 多帧解压 + v3→v4 迁移 + 撕裂尾修复，**不要自己解压** |
| 3 | 实时事件 | `ctx.on('session/event' \| 'agent/status' \| 'api-session/*')` | `api-session/*` 已在跨端转发白名单里 |
| 4 | 追加用户消息 | `ctx.sessionController.prompt()`（自动 resume 冷会话）或进程内 `agent.followup()/steer()` | 必须在**持有该会话写锁**的进程内执行 |
| 5 | 多进程 | `session.lock`：POSIX flock / Win32 命名信号量，单写者 | 读可并行；**远端继续会话必须由远端进程执行**，不能本地代写 |
| 6 | 暴露给 Client | Typert Remote：`TypertRemoteService` + `@Remote()`，namespace=服务名 | 现成 `ctx.remote.session.*` 已覆盖 list/page/follow/prompt，可直接复用 |

## 1. 环境事实（本机已实测）

- 会话目录：一个会话一个目录，内含 `session.v4.jsonl.zstd`。**目录名两种并存**：`session-<uuid>/`（旧）与 `<uuid>/`（新，直接 uuid）；不要按路径拼 id，一律走 persistence 服务。
- 行格式：首行 `{"type":"session","version":4,"id":...,"createdAt":...,"cwd":...}` 是非事件 header，其后每行一个 `SessionEvent`。
- 实测样例：1,176,815 B 文件 → 2,297 行 / 38 种事件类型：`session, turn/start|end, step/start|end, user/message, assistant/message, assistant/attempt, tool/call, tool/result, system/message, request/header|context, session/title, agent/inbox/spliced, job/registered|settled, workspace/changes, session/end-seed, permission/preset, sandbox/mode, approval/policy`。
- `~/.dsh/storages/` 本机**没有** sqlite 索引文件，只有 `session_projcache.json`（projection 缓存）、`workspace.json`（workspace→`sessionIds`）——两者均为实现私有存储，勿直接读写。

## 2. 枚举会话（Q1）

### 2.1 可用的 ctx 服务（Host 插件里 `static inject = [...]` 注入）

| ctx key | 类型 | 定义 | 关键成员 |
|---|---|---|---|
| `ctx.sessionQuery` | `SessionQueryEngine` | `$M/dsh-session-query/lib/types/index.d.ts:25` | `listSessions:67` `filterSessions:81` `readSession:74` `readTitle:88` `listEvents:111` `readSurface:127` `observeSession:47` |
| `ctx.sessionController` | `SessionController`（Remote `session` 命名空间宿主） | `$M/dsh-api-session-controller/lib/types/index.d.ts:18` | `list:86` `inspect:79` `prompt:171` `page:196` `follow:204` `resolveAgent:72` |
| `ctx.sessionPersistence` | `SessionPersistence` | `$M/dsh-session-persistence/lib/types/index.d.ts:78` | `list:159` `stat:153` `open:126` `create:112` |
| `ctx.sessions` | `SessionStore`（仅**本进程已 live** 的会话） | `$M/dsh-session/lib/types/index.d.ts:27`（class :378） | `get(id)` / `list()` |
| `ctx.sessionProjections` | `SessionProjectionRegistry` | `$M/dsh-session-projection/lib/types/index.d.ts:27` | `snapshot(session, keys):185` |
| `ctx.sessionProjectionCache` | 冷会话 projection 缓存 | `$M/dsh-session-projection-cache/lib/types/index.d.ts:27` | — |
| `ctx.sessionTitle` | `SessionTitleService` | `$M/dsh-session-title/lib/types/index.d.ts:114` | `get(session):129` `rename:141` |
| `ctx.agents` | `AgentRegistry`（live Agent） | `$M/dsh-agent/lib/types/index.d.ts:20` | `get(id):343` `resume:286` `create:278` |
| `ctx.workspaceRegistry` | `WorkspaceRegistry` | `$M/dsh-workspace/lib/types/index.d.ts:82` | workspace↔session 归属 |

### 2.2 数据从哪来：文件系统，不是 sqlite

- `sessionQuery` 的 list/filter/exact-read 是 "backend-independent" 的具体实现，只有 FTS 搜索由后端提供（`$M/dsh-session-query/lib/types/index.d.ts:29-35` 类注释）。
- 唯一具体后端 `SqliteSessionQueryEngine`（`$M/dsh-session-query-sqlite/lib/types/index.d.ts:88`）的索引路径由 launcher 传入（`SESSION_QUERY_SQLITE_PATH_KEY:16`，注释明确 *disposable derived query index*），`openAt:'never'` 时仍可做精确读/过滤，只关掉 FTS。
- **结论**：枚举不依赖 sqlite；若部署没挂 `dsh-session-query-sqlite`，`ctx.sessionQuery` 不存在，退化为 `ctx.sessionPersistence.list()/stat()`（返回 header、`eventCount`、`sizeBytes`、`formatStatus`）。
- 元数据缺口：`SessionSummary` **不含标题/消息数**（`.../types/types.d.ts:160-173`：`agentAvailable, running, blank, cwd, updatedAt, parentSessionId, projections?`）。标题取 projection `title`（`$M/dsh-session-title/lib/types/types.d.ts:74-80`）或 `sessionQuery.readTitle(id)`；轮次/步骤统计取 `sessionStats` projection（`$M/dsh-session-stats/lib/types/projection.d.ts`）。

### 2.3 枚举代码（Host 插件内）

```ts
import { Service } from '@deepseek-ai/cordis';

export class SessionBridge extends Service {
  static inject = ['sessionQuery', 'sessionProjections', 'sessions', 'agents'];

  async listByCwd(cwd: string) {
    // cwd 过滤与 sqlite 无关；全量用 this.ctx.sessionQuery.listSessions()
    const records = await this.ctx.sessionQuery.filterSessions([{ kind: 'cwd', values: [cwd] }]);
    const rows = [];
    for (const r of records) {                         // SessionRecord = { header, live, persisted }
      const live = this.ctx.sessions.get(r.header.id); // 仅本进程 live 时有值
      const stats = live
        ? this.ctx.sessionProjections.snapshot(live, ['title', 'sessionStats', 'inbox']).values
        : undefined;                                   // 冷会话请看投影的标题/统计
      rows.push({
        id: r.header.id, createdAt: r.header.createdAt, cwd: r.header.cwd,
        parentSession: r.header.parentSession, title: stats?.title ?? null,
        turns: (stats as any)?.sessionStats?.turns, eventCount: undefined,
        live: r.live, persisted: r.persisted,
        running: this.ctx.agents.get(r.header.id)?.status === 'running',
      });
    }
    return rows;                                        // 新→旧（listSessions 保证）
  }
}
```

## 3. 读取完整对话（Q2）

### 3.1 官方解析 API（首选）

- `readColdSessionLog(persistence, sessionId, signal?)` → `{ header, inheritedEventCount, eventState, events: SessionEvent[] }`；**不取写锁、不落盘、不改变会话**，内部处理多帧 zstd、v3→v4 迁移、撕裂物理尾、interrupted-turn closers：`$M/dsh-session-query/lib/types/cold-read.d.ts:5-26`。
- `ctx.sessionQuery.readSession(id)` → `SessionLogSnapshot`（replay 校验后的完整日志，`:74`）
- `ctx.sessionQuery.listEvents(id)` → 轻量 `{sessionId, seq, type, time, surface}`（`:111`）
- `ctx.sessionQuery.readSurface(id)` → 模型视角的 `SurfaceEvent[]`（`:127`）
- 折成消息/工具调用：`foldSurface(...)` / `deriveEventMessage(...)`（`$M/dsh-session/lib/types/surface.ts`，index 导出 `$M/dsh-session/lib/types/index.d.ts:16`）；也可只按 `event.type` 过滤 `user/message`、`assistant/message`、`tool/call`、`tool/result`。
- `dsh-session-log-export` 的 `readSessionLogText/serializeSessionLog` 是**导出/下载**用（`$M/dsh-session-log-export/lib/types/index.d.ts`），不是解析入口。

### 3.2 zstd：用 Node 内置，但必须逐帧（实测坑）

- 官方用 `node:zlib`（`$M/dsh-session-persistence-jsonl/lib/index.js:16`）。本机 Node **v24.16.0** 已内置 `zstdDecompressSync/createZstdDecompress`，无需第三方解码包。
- ⚠️ 会话日志是**追加式多帧 zstd**：`zstdDecompressSync(整个文件)` 或 `createZstdDecompress` **只解出第一帧**——实测 1,176,815 B 只得到 210 B（仅 header 行）。官方因此实现了 `scanZstdFrames`（`:1299`）与逐帧 `PublicZstdFrameDecoder`（`:1270`）。
- 结论：插件内用 3.1 的官方 API；下面的解码器仅用于离线工具/兜底。

### 3.3 可运行多帧解码器（已在本机真实文件验证：2,297 行/38 种事件）

```js
const fs = require('node:fs'), zlib = require('node:zlib');
const MAGIC = 0xFD2FB528;                 // 磁盘字节 28 B5 2F FD
const frameEnd = (buf, off) => {          // 返回从 off 起的完整帧结束偏移
  let p = off + 4; const d = buf[p++];
  const fcsFlag = d >>> 6, single = (d & 32) !== 0, checksum = (d & 4) !== 0, dictFlag = d & 3;
  p += (single ? 0 : 1) + (dictFlag === 3 ? 4 : dictFlag) + (fcsFlag === 0 ? (single ? 1 : 0) : 1 << fcsFlag);
  for (;;) {                              // 逐 block 走到 last-block（3 字节小端头）
    const h = buf.readUIntLE(p, 3); p += 3;
    p += ((h >>> 1) & 3) === 1 ? 1 : (h >>> 3);   // RLE block payload 只 1 字节
    if (h & 1) break;
  }
  return checksum ? p + 4 : p;
};
const decodeSessionLog = (bytes) => {     // 全部帧拼接 → UTF-8 文本
  const out = [];
  for (let off = 0; off < bytes.length;) {
    if (bytes.readUInt32LE(off) !== MAGIC) throw new Error(`bad zstd magic @${off}`);
    const end = frameEnd(bytes, off);
    out.push(zlib.zstdDecompressSync(bytes.subarray(off, end))); off = end;
  }
  return Buffer.concat(out).toString('utf8');
};
const lines = decodeSessionLog(fs.readFileSync(path)).split('\n').filter(Boolean);
const header = JSON.parse(lines[0]);                       // { type:'session', version:4, ... }
const events = lines.slice(1).map((l) => JSON.parse(l));    // SessionEvent[]
```

## 4. 实时事件（Q3）

| 事件 | payload | 位置 |
|---|---|---|
| `session/event` | `(session: Session, event: SessionEvent)` 每次追加后（fire-and-forget，可含流式 chunk） | `$M/dsh-session/lib/types/index.d.ts:61` |
| `session/created` / `session/disposed` / `session/flush` | `(session)`；flush 为并行 await 的持久化屏障 | 同上 `:44-70` |
| `agent/status` | Agent 生命周期转换（idle/running…，镜像到 `agent.status`） | `$M/dsh-agent/lib/types/runtime-types.d.ts:252`（`status` 读取点 :147） |
| `agent/created` | `{ agent, source, signal }`，serial 监听 | `$M/dsh-agent/lib/types/runtime-types.d.ts:~228` |
| `api-session/added` | `(summary: SessionSummary)` | `$M/dsh-api-session-controller/lib/types/types.d.ts:577` |
| `api-session/removed` | `(sessionId: SessionId)` | 同上 `:583` |
| `api-session/status` | `(sessionId, running: boolean)` | 同上 `:590` |
| `api-session/activity` | `(sessionId, updatedAt: number)` | 同上 `:597` |
| `api-session/error` | `(sessionId, message: string)` | 同上 `:604` |

```ts
export function apply(ctx: Context) {
  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/message' || event.type === 'tool/call') { /* 增量转发 */ }
  });
  ctx.on('agent/status', (payload) => { /* 会话忙闲变化 */ });
  ctx.on('api-session/added', (summary) => { /* 与桌面列表同构的摘要 */ });
  ctx.on('api-session/status', (sessionId, running) => { });
}
```

- `session/*` 与 `agent/*` 是 **scope-filtered**：agent 作用域内的监听只收到该 agent 进入过的会话。
- `api-session/*` 由 `SessionController` 在 `$M/dsh-api-session-controller/lib/index.js:2981-3003` emit，并列在跨端转发白名单 `API_REMOTE_FORWARDED_EVENTS`（`$M/dsh-api-remotes/lib/index.js:21`）→ Client 侧可用 `ctx.remote.$on('api-session/status', ...)` 直接收到。

## 5. 向已有会话追加用户消息（Q4）

### 5.1 协议级：`ctx.sessionController.prompt()`（推荐）

签名 `prompt(request: SessionPromptRequest, signal): Promise<SessionPromptValue>`（`$M/dsh-api-session-controller/lib/types/index.d.ts:171`）；请求/响应：`types.d.ts:332-344`。

```ts
const { accepted } = await ctx.sessionController.prompt({
  requestId: crypto.randomUUID(),           // 客户端生成，幂等（重复 requestId 直接返回 accepted）
  sessionId,
  mode: 'queue',                            // 'queue' = 新起一轮；'steer' = 插到当前 turn 的下一个 step
  content: [{ type: 'text', text: '继续' }], // 至少一个非空 text 或附件
  clientTimeZone: 'Asia/Shanghai',
}, signal);
```

- 内部 `resolveAgent(sessionId)`（`:72`）：live 直接返回；**冷会话自动 `ctx.agents.resume()`**（实现 `$M/dsh-api-session-controller/lib/index.js:397-465`）——"发消息即续会话"已现成。
- 错误语义：`session/agent-busy`（`:202`）、`session/writer-held`（`:199`，底层 `SessionAlreadyOwnedError` 映射，实现 `index.js:243`）、`session/not-found`。
- 流式消费结果：`follow(request, signal): AsyncIterable<SessionFollowFrame>`（`:204`；帧类型 `types.d.ts:539-550`：`snapshot` / 事件帧 / `assistant-stream`）；历史用 `page()`（`:196`）；中断用 `cancel()`（`:189`）。
- 忙闲判断：`ctx.agents.get(id)?.status === 'running'`；待发队列见 projection `inbox`（`$M/dsh-agent/lib/types/types.d.ts:66-70`）。

### 5.2 进程内直连 Agent（同进程、需要更低延迟/更多控制）

```ts
const handle = await ctx.agents.resume({ resumeSessionId: sessionId });  // AgentRegistry:286
const agent = handle.agent;
agent.followup(createUserMessage({ content, source: 'user-rpc' }));      // runtime-types.d.ts:192
// 或 agent.steer(message) :200 / agent.send(message, 'next-turn', true) :190 / agent.inject(message)
await agent.whenIdle();                                                  // 或订阅 session/event 消费流
await handle.dispose();                                                  // 释放写锁（重要）
```

- 会话创建/恢复底层：`ctx.agentLoop.create(id, opt, meta)` / `createAgent(ctx, opt)` / `resume(ctx, opt)`（`$M/dsh-agent-loop/lib/types/index.d.ts:135/164/174`）。
- **锁约束**：`resume` 即持有写锁，`dispose()` 才释放；桌面端正在用的会话抢锁会抛 `SessionAlreadyOwnedError`。

## 6. 多进程 / 多实例（Q5）

- 每会话一把跨进程写锁：POSIX 非阻塞 `flock(2)`（`session.lock`）；Windows 用命名内核信号量 `Local\dsh-session-lock-<sha256(realpath.toLowerCase())>`（`$M/dsh-session-persistence-jsonl/lib/index.js:551-563, 619-634`）。争用 → `SessionAlreadyOwnedError`（`$M/dsh-session-persistence/lib/types/errors.d.ts:22`）；进程崩溃由内核释放，不残留。
- 读不取锁：`open(id,'read')` *"never takes ownership and works while another handle (or process) holds write"*（`$M/dsh-session-persistence/lib/types/index.d.ts:126-131`）→ 多进程**并发读**同一 `~/.dsh/sessions` 是支持的。
- **不支持网络共享**：flock 语义、Windows 命名信号量都是本机/本 FS 概念；两台机器共享同一个 `~/.dsh`（UNC/网盘）没有可靠性保证。
- 对插件的结论：
  1. "远端继续会话" = 把 prompt **转发给持有该 `~/.dsh` 的那台机器上的 DSH 进程**执行；本地进程不能代替远端写。
  2. 同一 sessionId 在任一时刻只能被一个进程持有写锁，另一进程只能读（`readColdSessionLog`/`sessionQuery`）。
  3. 禁止两端同步/复制 `session*.jsonl.zstd` 后各自续写（seq 连续 + header + 锁都会冲突）；迁移只能整目录拷贝后由目标端重新 list。

## 7. 暴露给插件的 Client 端（Q6）

- **官方推荐通道 = Typert Remote**：Host 侧 `class X extends TypertRemoteService`（`$M/dsh-typert-protocol/lib/types/index.d.ts:105`），构造 `super(ctx, '<serviceKey>', { namespace: '<ns>' })`；方法加 `@Remote()`（`:121/:127`）或 `@Remote({ mode: 'stream' })`；Gateway 负责鉴权、参数编解码与流（`$M/dsh-api-gateway/lib/types/index.d.ts:90-110` 的 `invoke/stream`）。
- Client 侧：`ctx.remote.<ns>.<method>(args)`（unary）、流方法返回 `AsyncIterable`、事件用 `ctx.remote.$on('<ns>/<event>', cb)`。
- 事件要跨端，必须在 `API_REMOTE_FORWARDED_EVENTS` 白名单中（`$M/dsh-api-remotes/lib/index.js:21`，已含全部 `api-session/*`、`agent-preset/selected`、`approval/request`），或用 `gateway.registerRemoteEvents(source, host)` 注册自有事件源（gateway d.ts:88）。
- **可直接复用**：`ctx.remote.session` 命名空间已由 `SessionController` 提供 `list/create/prompt/page/follow/cancel/rename/fork/projections/control`，跨端插件多数场景无需新增 Host API。
- 自建 HTTP 路由有先例：`dsh-session-log-export` 的 `/export` 下载路由（`$M/dsh-session-log-export/lib/types/routes.d.ts` 的 `SESSION_LOG_EXPORT_PATH`），但鉴权自理、官方定位为 Web-only 下载，不推荐用于通用会话 API。

## 8. 风险与未验证

- **版本面**：`$M/*/lib/types/*.d.ts` 是包内类型面，非公共 semver API；插件只应注入 ctx 服务，避免 deep-import 内部文件。当前 `0.2.1-rc.2` 仍在 rc。
- 本机 vs 服务器：桌面端会话已是 v4，服务器包同版本；但目录命名 `session-<uuid>` 与 `<uuid>` 混用，说明规则曾变更，勿依赖路径格式。
- `~/.dsh/storages/*.json`（`workspace.json`、`session_projcache.json`）是实现私有存储，不能当接口。
- 未验证：`follow()` 的 `assistant-stream` 帧节奏/背压；`prompt` 对超大冷会话 resume 的耗时（建议加超时）；`api-session/*` 跨端转发的资源可见性（`resources: { session: sessionId }` 已声明）。
- 远端正在跑该会话时 `prompt` 是排队/插入下一步，不会打断；要停用 `sessionController.cancel()`。

## 9. 关键文件索引（服务器只读）

- `$M/dsh-session/lib/types/{index,types,surface}.d.ts` — SessionStore、`session/event`、`SessionHeader`、折叠
- `$M/dsh-session-query/lib/types/{index,cold-read,types}.d.ts` — 统一查询引擎、`readColdSessionLog`、过滤/记录类型
- `$M/dsh-session-query-sqlite/lib/types/index.d.ts` — SQLite FTS 派生索引后端（`path`/`launcherSessionQueryPath`）
- `$M/dsh-session-persistence/lib/types/{index,handle,errors}.d.ts` — 持久化契约、`SessionHandle.read/append/flush`、锁错误
- `$M/dsh-session-persistence-jsonl/lib/index.js` — jsonl+zstd 实现（`:16` node:zlib、`:551-563` 锁名、`:1270/:1299` 逐帧解码）
- `$M/dsh-session-format*` — 纯格式/迁移（`filename.d.ts`: `session.vN.jsonl`；`v3-to-v4`: codec/validation）
- `$M/dsh-session-projection*`、`dsh-session-title`、`dsh-session-stats` — projection 值（`title`/`sessionStats`/`inbox`）
- `$M/dsh-api-session-controller/lib/{index.js,types/{index,types}.d.ts}` — Host Session Remote API + `api-session/*`
- `$M/dsh-agent/lib/types/{index,runtime-types,types}.d.ts`、`dsh-agent-loop/lib/types/index.d.ts` — Agent 注册表/运行时方法/resume
- `$M/dsh-api-gateway`、`dsh-api-remotes`、`dsh-typert-protocol` — Client 通道与转发白名单
- 本地样例：`C:\Users\32891\.dsh\sessions\--C-Users-32891-Desktop-dsh--\<id>\session.v4.jsonl.zstd`
