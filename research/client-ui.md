# Client 端 UI 扩展机制调研（远程会话插件前置）

> 调研时间 2026-10-26；基线：本机 DSH Desktop（Electron + web shell），官方包版本 `0.2.1-rc.2`（npm npx 缓存与服务器 `/usr/lib/node_modules` 一致），现成插件 `dsh-better-sidebar@0.28.0`、`dshmarket`。只读调研，未改环境。

**路径缩写**（下文引用用这些前缀）
- `SB` = `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-better-sidebar`
- `MK` = `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dshmarket`
- `OFF` = `C:\Users\32891\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai`（rc.2 官方包）
- `SLOTS` = `research\vendor\dsh-client-ui-slots@0.2.1-rc.2`（本次从 npm 拉取的 rc.2 类型包）
- `SRV` = 服务器 `118.196.78.91:/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 扩展 API | `ctx.slots.register(options, Component)` / `ctx.slots.inject(slotKey, cb)`；slot 契约由 `declare module '@deepseek-ai/dsh-client-ui-slots'` 的 `SlotMap` 声明合并定义（kind: single/list/keyed/chain；scope: root/session-maybe/session） |
| 会话列表 | **不能新增行**。官方只给行内装饰/操作 seat：`sidebar.session.row.leading`、`sidebar.session.row.hover`、`sidebar.workspaces.session.menu.item`、`sidebar.workspaces.session.row.action`（都只作用于已存在的本地 session） |
| 侧边栏入口 + 自定义页 | 官方推荐 = `main`(keyed) 主面板 + `sidebar.panellist` 图标行 + `ctx.layout.selectPanel(id)`（dshmarket 现成实现）；会话头部入口用 `conversation.session.header.utilities`；右侧栏用 `sidebar.right.pane.tab` |
| 对话渲染 | 官方 chat/conversation **组件不导出**（只导出 `UiConversation` 服务与类型）；最小可行：自绘 transcript + `MarkdownText`（`@deepseek-ai/dsh-client-ui-primitives`，baseline 模块） |
| Client↔Host | 二选一：**A. 自建 HTTP 路由**（`ctx.webServer.register` + 客户端相对 URL fetch，better-sidebar/dshmarket 都用）——插件私有 API 首选；**B. Typert Remote**（`@Remote` + `ctx.remote.<ns>.<method>`）——需要跨端/跨 Peer 的类型化 RPC 时才用 |
| 最小骨架 | host 半：`name/inject/apply` + `cordis.patch.yml`；client 半：`export const inject=[服务名]` + `export function apply(ctx)`，构建成 `lib/client.js`（`window.__ModuleLoader__.load({id, factory})` 包装），`dsh.client.platform='web'` |

## 1. `@deepseek-ai/dsh-client-ui-slots` 确切 API

**包定位**：纯 core（无 React 运行时依赖），导出 `SlotCore`、`SlotMap`/`SlotFactoryMap`/`LocaleNamespaceMap` 合并点、props 推导类型；React 渲染层在 `@deepseek-ai/dsh-client-ui-renderer` 的 `SlotRegistry`（`ctx.slots`）。类型在 `SLOTS/lib/types/index.d.ts`、`renderer.d.ts`；运行时服务由 shell 提供——插件 bundle **只 `import type`**，不要 `require` 这个包（证据：`SB/lib/client.js` 的 require 只有 `react`、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives`，类型包被擦除）。

```ts
// 注册（核心签名；KindOptions 按 SlotMap[K].kind 收窄）
register<K extends keyof SlotMap & string>(
  options: {
    name: K
    key?: string; id?: string; order?: number; label?: string | (() => string)  // keyed/list/chain 各自必需
    priority?: number; select?: (owner) => unknown                                // 打散/链式路由
    children?: ChildrenDecl          // 声明子 slot（声明即独占渲染权）
    store?: StoreDecl; locale?: N; registrant?: string
    inject?: (...args) => I          // 注入业务面，进入组件 props
  },
  component: (props: ComposedProps<...>) => ReactNode,
): () => void

// 等声明出现再注册（声明可能来自后加载的官方插件）
inject(key: keyof SlotMap & string, callback: () => (() => void) | Iterable<() => void>): () => void

// 读侧
entries(key); entriesOfSlot(key); subscribe(key, fn); spec(key); snapshot()
```
出处：`SLOTS/lib/types/index.d.ts:82-87`（kind/scope）、`:564-617`（KindOptions/BaseOptions）、`:793-808`（两个 register 重载）、`:226,317`（`PropsRuntime`/`PropsRenderSlots`）、`:78`（`PropsLocale`）；`OFF/dsh-client-ui-renderer/lib/types/client/registry.d.ts:46,85,111,118`（`SlotRegistry` 走 `ctx.effect`、`register` 是 `SlotCore['register']`、`inject` 语义、`install`）；`ctx.slots` 的类型声明在 `OFF/dsh-client-ui-renderer/lib/types/client/index.d.ts:27`。组件 props = owner 分享 + 标准 kit（如 `usePanelInfo`）+ inject 面 + `t`（声明 `locale:` 时）+ `renderSlot`（声明 children 时）。

**与本需求相关的 slot 清单**（`kind`/`scope` 摘自各自 `contract/slots.d.ts`；文件均在 `OFF/<pkg>/lib/types/client/...`）

| Slot id | kind | 位置 / 用途 |
|---|---|---|
| `main` | keyed | 主区域页面；`key='conversation'` 是保留会话页，其它 key 自定义页。`dsh-client-ui-layout/.../client/index.d.ts:53` |
| `sidebar.panellist` | list | 左栏全局面板图标行（id 对应一个 `main` key）。`dsh-client-ui-sidebar/.../contract/slots.d.ts:46` |
| `sidebar.workspaces` | single | 左栏会话浏览区（**已被 ui-workspace 占用**，不要再注册）。同文件 `:57` |
| `sidebar.session.row.leading` | list | 会话行标题前 16px 徽标位（仅本地 session、且该行主状态为 idle）。`dsh-client-ui-workspace/.../contract/slots.d.ts:123` |
| `sidebar.session.row.hover` | list | 会话行 hover 卡片插槽。同文件 `:132` |
| `sidebar.workspaces.session.menu.item` | list | 会话行“…”菜单项（d.ts 内有完整示例）。同文件 `:171` |
| `sidebar.workspaces.session.row.action` | list | 会话行尾部 hover 图标按钮。同文件 `:191` |
| `sidebar.right.pane.tab` / `.tab.title` | keyed | 右侧栏 tab 主体/标题（better-sidebar 全套 tab 都注册在这）。`dsh-client-ui-sidebar-right/.../contract/slots.d.ts:53,67` |
| `conversation.session.header.utilities` | list | 会话头部工具按钮（better-sidebar 的底部面板开关）。`dsh-client-ui-conversation/.../contract/slots.d.ts:237` |
| `conversation.session.header.actions` / `.lineage` / `.corner` | list/list/single | 头部动作区/血缘/右上角。同文件 `:225,231,254` |
| `conversation.input.left` / `.right` / `.activity` / `.model` / `conversation.composer` | 多种 | 输入框周边座位。同文件 `:306-395` |
| `shell.overlay` | list | 全 frame 浮层（弹窗/toast），点击穿透，需自行开 pointer-events。`dsh-client-ui-layout/.../client/index.d.ts:95` |
| `shell.bottom` | single | 三栏下方通栏（better-sidebar 底部面板）。同文件 `:81` |
| `settings.section` | list | 设置页 section。`dsh-client-ui-settings/.../contract/slots.d.ts:73` |
| `settings.plugins.tab` / `settings.action` | list | 插件设置页 tab / 头部动作。同文件 `:86,47` |

## 2. 会话列表：能加什么、不能加什么

- 官方会话列表整体是 `sidebar.workspaces`（single，ui-sidebar 声明、ui-workspace 注册 browser，见 `ui-sidebar` slots.d.ts:57-61 注释）。**没有“追加一行 session”的 slot**；注册 `sidebar.workspaces` 只会 shadow 掉整个官方列表。
- 可用的“会话区入口”：`sidebar.session.row.leading`（远程/本地标记）、`sidebar.workspaces.session.row.action`（hover 按钮）、`sidebar.workspaces.session.menu.item`（“…”菜单，d.ts:149-170 给了可复制的注册示例）。owner props 只有 `sessionId`（`SessionRowScheduleOwnerProps`）或整行 `SessionRowOwnerProps`。
- better-sidebar 并没有往 session 列表加行：它加的是右侧栏 tab（`SB/src/client/native/index.ts:290-311` 注册 `sidebar.right.pane.tab`+`.title`）、会话头按钮（`SB/src/client/sidebar/bottom-toggle.tsx:22-28`）、底部 panel，并通过自有服务 `ctx.betterSidebar.registerTab/registerFileViewer` 给第三方复用（`SB/README.md:131-140`）。
- **推荐**：远程会话入口做成“全局页面”而不是伪造 session 行 —— 左栏图标（`sidebar.panellist`）+ 主面板（`main`），远程会话列表画在自己的页面里；若要与本地 session 关联，用 `sidebar.workspaces.session.menu.item` 加“在此打开远程会话”菜单项。

## 3. 自定义页面/路由（可复用模式）

DSH Web 是单页应用，**没有 URL 路由**；页面 = `main` keyed slot + `ctx.layout.selectPanel(id)`。dshmarket 的现成写法（`MK/src/client/index.ts:233-252`）：

```ts
const PANEL = 'dsh-market'   // 同时作为 main 的 key 和 sidebar.panellist 的 id
const offPanel = ctx.slots.register({
  name: 'main', key: PANEL, locale: NS, inject: () => ({ t }),
}, () => h('div', { className: css.panelHost }, pageElement))
const offRow = ctx.slots.register({
  name: 'sidebar.panellist', id: PANEL, order: SIDEBAR_PANEL_ORDER,
  label: () => t('nav'), locale: NS,
}, ({ size }) => h(Logo, { size: size ?? 16 }))
// 卸载顺序：先离开页面再撤面板，避免主栏指向不存在的 key
return () => { if (layout?.panelInfo.getSnapshot().activePanelId === PANEL) layout.selectPanel(null); offRow(); offPanel() }
```
要点：`main` 在 ui-layout 里没有 owner props（`kind:'keyed'; scope:'root'`，见 layout index.d.ts:53）；应用要拿 `ctx.layout` 需 `ctx.inject(['layout'], scoped => layout = scoped.layout)`（`MK/src/client/index.ts:265-266`，`ctx.layout` 类型见 layout index.d.ts:18-22）。入口按钮从 `sidebar.panellist` 点击后由官方 sidebar 调 `ctx.layout.selectPanel(id)`，无需自己处理。

- `SB/src/archive-route.ts`、`SB/src/html-route.ts` 是 **Host HTTP** 资源（zip 下载、sandboxed HTML 预览，注册见 `SB/src/index.ts:1682` 附近），不是客户端页面路由；做“独立全屏 HTML 页面”可用同款 `ctx.webServer.register`，但本需求建议用 `main` 面板（保持应用内导航/主题/会话上下文）。
- 弹窗/挑选器类 UI 用 `shell.overlay`（dshmarket 也注册了，`MK/src/client/index.ts:382`），不要劫持 `root`（插件注册会被分配更低 priority 反而 shadow 整个 AppFrame；见 `OFF/dsh-client-ui-renderer/.../registry.d.ts:17-36` 注释）。

## 4. 对话渲染：能否复用官方组件

- **不能直接复用**：`@deepseek-ai/dsh-client-ui-conversation/client` 只导出服务与类型（`UiConversation`、`ConversationController`、`ConversationSnapshot` 等，`OFF/dsh-client-ui-conversation/lib/types/client/index.d.ts:21-49`）；`dsh-client-ui-chat/client` 只导出 `apply/inject` + 类型（`OFF/dsh-client-ui-chat/lib/types/client/index.d.ts:2-26`），没有可嵌入的 `ChatFlow`/`ConversationView` 公共组件。
- `UiConversation.binding(source: SessionBinding | SessionId)` 只接受**本 Host 的 session controller 绑定**（`OFF/dsh-client-ui-conversation/.../conversation/assembly.d.ts:38,61`）；远端主机的会话不是它的 session，无法绑定。
- 最小可行方案（推荐 v1）：
  1. 自己在 `main` 面板渲染“远程会话列表 + transcript”；
  2. 消息 Markdown 用 `MarkdownText`（`@deepseek-ai/dsh-client-ui-primitives`，baseline 运行时模块；better-sidebar 这样用：`SB/src/client/MarkdownHtml.tsx:18`），样式用 CSS Module（`SB/src/client/*.module.css` 同款）；
  3. 事件分页/流式：自己 Host 路由提供 JSON/SSE/WS（见 §5），客户端用 `useSyncExternalStore` 或自建 store。
- 进阶（不建议 v1）：把远端事件镜像成本地投影，再用 `UiConversation` 的 View 机制渲染——但官方 view 组件仍不导出，收益低。

## 5. Client ↔ Host 通信

### 方式 A：插件自建 HTTP 路由（推荐给插件私有 API）

Host 半（`apply` 内用 `ctx.effect` 托管生命周期，duplicate path 会抛错）：

```ts
export const name = 'x-remote-session'
export const inject = ['webServer', 'connection']       // 服务名，不是包名
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',                                     // 'exact' | 'prefix'；最长前缀匹配
    path: '/remote-session/api',                        // 必须独占前缀，冲突即启动失败
    handler: async (req, res) => {
      if (ctx.connection.requestRejection(req) !== undefined) { res.writeHead(403); res.end(); return }
      const method = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice('/remote-session/api/'.length)
      // 只接受 POST + JSON，按 method 分发表（参考 SB/src/index.ts:1447-1488）
    },
  }), 'x-remote-session: /remote-session/api')
}
```
客户端（关键：**相对 URL**；Reverse-proxy 前缀与 Electron `dsh-app://` 都靠 page base 兜住，写死 `/xxx` 会 404，详见 `SB/src/client/host-route-url.ts:1-48`）：

```ts
const res = await fetch(new URL('remote-session/api/sessions', document.baseURI), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
})
```
鉴权/规则（官方 README `SRV/dsh-host-webserver/README.md:61-65,130`）：webserver **没有统一鉴权/Origin 策略**，route owner 自己判——better-sidebar 用 `ctx.connection.requestRejection(req)`（`SB/src/context-types.ts:120-128`）；dshmarket 用 `refuseUnadmitted` + `config.desktopHost` 例外（`MK/src/routes.ts:2066-2077`）。每条路由唯一 `path`；路由离 Web 根挂载（反向代理前缀由浏览器相对解析处理）。

### 方式 B：Typert Remote（类型化 RPC，官方对跨端能力的正式通道）

Host：业务 Service 继承 `TypertRemoteService`，方法加 `@Remote` / `@RemoteScope`（装饰器来自 `dsh-typert-protocol`），由 API Gateway 编译的 descriptor 校验；stream 用 `@Remote({ mode: 'stream' })`（`SRV/dsh-api-gateway/README.md:27-39`）。Client：`@deepseek-ai/dsh-api-gateway/client` 提供 `ctx.remote`，插件 `inject` 里声明 `remote`/`remote.session` 后直接 `ctx.remote.session.xxx(args)`；访问控制由 `dsh-api-remote-access` 按资源策略裁决（`SRV/dsh-api-session-controller/README.md:13,36`）。真实调用证据：better-sidebar 客户端调用 `ctx.remote.session.openWorkspacePath({action:'reveal'})`（`SB/src/client/Sidebar.tsx:545`），服务名声明见 `SB/src/client/index.tsx:50`。
代价：需要 api 包 + Typert 代码生成 + remote-access 策略，**本机第三方插件中未发现自建 namespace 的实例**（只消费官方 namespace）。远程会话插件的私有 UI 数据用方式 A 更轻；只有要暴露给其它 peer/agent 时才升级到 B。

## 6. 最小 Client 入口骨架（与 plugin-anatomy 对齐）

`SB`/`MK`/`dsh-ops` 的 package.json 形状（`dsh.client.inject` 按官方 manifest 类型只是**信息性包名依赖**，不是服务注入；服务注入是 client 入口导出的 `inject` 数组——`SRV/dsh-package-manifest/lib/types/types.d.ts:80-105`）：

```jsonc
{
  "main": "lib/index.js",
  "exports": { ".": {...}, "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
               "./locale/*.json": "./locale/*.json" },
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },        // 安装时挂 Host 半，见 SB/cordis.patch.yml
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-conversation"],
      "external": []                                    // 非 baseline 模块请求（如懒加载 chunk 所在包）
    }
  }
}
```

```ts
// src/client/index.tsx —— client 半
import { createElement as h } from 'react'
import css from './page.module.css'
import './layout.css'
export const inject = ['slots', 'locale', 'sessions', 'remote.session']   // Cordis 服务名
export function apply(ctx: Context): void {
  ctx.slots.register({ name: 'main', key: 'remote-session', locale: NS }, RemotePage)
}
```
构建产物要求：`lib/client.js` 必须已构建（`OFF/dsh-client-modules/README.md` "Build requirements"：缺 bundle 激活即报错），产物是 `window.__ModuleLoader__.load({ id: '<pkg-name>', factory: (require) => { ... exports.apply=...; exports.inject=... } })` 的 CJS 包装（`MK/client/client.js:1`、`SB/lib/client.js` 尾部）；可用 tsdown/rolldown。React 18；样式 CSS Module/全局 CSS 由 bundle 工厂注入；locale 用 `@deepseek-ai/dsh-client-locale`，注册处声明 `locale: NS` 即获得类型化 `t`（better-sidebar 的 `src/client/locales.ts` 是完整范例）。

## 7. 推荐给「远程会话」的 UI 方案

1. **入口**：`sidebar.panellist` 一个图标（`id='remote-session'`, `order≈50`）+ `main` 面板；点击后 `ctx.layout.selectPanel('remote-session')`。
2. **页面**：左列“远端主机/会话列表”（自绘），右列 transcript（`MarkdownText` 渲染 assistant/user 文本；工具调用先折叠展示）；顶部连接状态 + 刷新。
3. **可选增强**：会话头 `conversation.session.header.utilities` 加“推送到远程会话”；本地会话行菜单 `sidebar.workspaces.session.menu.item` 加“在远程打开”；右侧栏 tab 可复用 better-sidebar 的 `ctx.betterSidebar.registerTab`（若已安装）而不是硬依赖。
4. **数据面**：Host 路由 `/remote-session/api/*`（list/transcript/send/stream）+ 可选 WS（`ctx.webServer.registerUpgrade`，参考 `SB/src/index.ts:1741` 起）；客户端全部相对 URL。
5. **不要**：不要注册 `root`/`sidebar.workspaces`/`sidebar`，不要伪造成本地 session 行。

## 8. 证据路径清单（可复查）

- Slots 类型：`SLOTS/lib/types/index.d.ts:{78,82,226,564-617,793-808}`、`SLOTS/lib/types/renderer.d.ts:{129-151}`、`OFF/dsh-client-ui-renderer/lib/types/client/{registry.d.ts:46-118,index.d.ts:27}`
- Slot 目录：`OFF/dsh-client-ui-layout/.../client/index.d.ts:{44-98}`、`OFF/dsh-client-ui-sidebar/.../contract/slots.d.ts:{46-80}`、`OFF/dsh-client-ui-sidebar-right/.../contract/slots.d.ts:{53,67,105}`、`OFF/dsh-client-ui-conversation/.../contract/slots.d.ts:{198-395}`、`OFF/dsh-client-ui-workspace/.../contract/slots.d.ts:{96-195}`、`OFF/dsh-client-ui-settings/.../contract/slots.d.ts:{47,73,86}`
- 现成实现：`SB/src/client/index.tsx:{50,454-465}`、`SB/src/client/sidebar/bottom-toggle.tsx:{22-28}`、`SB/src/client/native/index.ts:{290-335}`、`SB/src/index.ts:{96,112,1447-1488,1682,1741}`、`SB/src/client/host-route-url.ts:{1-48}`、`SB/src/client/MarkdownHtml.tsx:18`、`SB/src/client/Sidebar.tsx:545`、`SB/README.md:{131-140}`
- dshmarket 页面模式：`MK/src/client/index.ts:{202-214,233-266,382}`、`MK/src/routes.ts:{2066-2082}`
- 官方说明：`SRV/dsh-host-webserver/README.md:{61,65,130}`、`SRV/dsh-api-gateway/README.md:{27-39}`、`SRV/dsh-api-session-controller/README.md:{13,36}`、`SRV/dsh-package-manifest/lib/types/types.d.ts:{80-105}`
- 构建产物样例：`SB/lib/client.js` 尾部（`exports.apply/inject` + `__ModuleLoader__` 包装）、`MK/client/client.js:1`、`SB/package.json` 的 `dsh.client.inject`

## 9. 未决 / 风险

- `dsh.client.inject` 语义在 rc.1↔rc.2 有漂移（rc.2 manifest 文档称“信息性”）；安装到目标 profile 前用 `dsh plugin --profile <p> add` 实装验证一次。
- `sidebar.session.row.leading` 只在行主状态 idle 时挂载（d.ts 注释），不适合做“远程”常驻标记；常驻标识建议放行操作/菜单项。
- 未找到官方“新增会话行/分组”的扩展点；若产品强要求混排在官方列表内，需要改 ui-workspace（不可接受）或等官方新 slot。
