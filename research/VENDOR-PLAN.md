# Vendor 计划：把官方会话流组件原样搬进插件

## 目标
远端会话面板使用与官方完全相同的组件树（ChatView / ChatGroupSeat / ChatNodeSeat / node views / DisclosureRow / Markdown），
不再手绘；数据层用 relay 事件流实现一个本地 `SessionBinding` 垫片。

## 步骤
1. **拉源码**：从 `deepseek-ai/deepseek-harness`（MIT）vendor 以下包到 `vendor/`：
   - `packages/client/ui-primitives/src`（DisclosureRow、icons、TextShimmer、Markdown）
   - `packages/client/ui-chat/src/client`（ChatView、flow、node views、process groups、markdown）
   - `packages/client/ui-conversation/src/client`（assembler、registries、contract）
   - 连带 `@deepseek-ai/dsh-api-session-controller/client` 的 contract 类型（仅用于类型/接口对齐）
2. **构建**：用 esbuild 把 vendor 目录 + 适配层打成我们的 `lib/client.js`（替换现有手绘组件）；React/ReactDOM 继续 extern 到 shell 基线模块。
3. **垫片 `RemoteSessionBinding`**：实现官方 `SessionBinding` 接口：
   - `sessionId`：镜像 id（`remote:<peer>:<session>`）
   - `session: SessionFace`：提供 `list`/`projections`/`status` 的最小实现，数据来自 relay RPC `transcript`/`status`
   - `eventSource: SessionEventSource`：把远端事件按 seq 喂给 assembler，支持 follow/poll
   - `ctx: AgentContext`：提供只读能力，阻断写操作（prompt 走我们的 `/send`）
4. **挂载**：在插件 client `apply` 中注册 `main` 面板 key，渲染官方 `ChatView` 组件；把 composer 输入接到 relay `/send`。
5. **回退开关**：配置 `renderer: 'vendor' | 'lite'`，vendor 失败时回落到现有手绘实现。
6. **验证**：无头渲染测试跑 vendor 树（jsdom 不可用则用 fake runtime），再在桌面/云端实机截图对比。

## 风险
- vendor 代码依赖官方 bundle 内部运行时（约 20+ 个 package 互相 import），需要大量 import 重写/shims
- 官方组件对 `SessionBinding` 的假设很深（eventSource 必须支持 live follow、snapshot、turn 状态），垫片工作量最大
- 升级 DSH 后 vendor 源码要同步更新

## 进度（round 2）

- [x] 稀疏 clone 官方仓库（`vendor/.src`，5MB，含 ui-primitives / ui-chat / ui-conversation 三个包的 src）
- [x] esbuild 构建管线（`tools/build-vendor.mjs`）：CJS 输出 + 自研 CSS Modules 编译（类名映射 + 运行时 <style> 注入）+ `clsx` shim + React extern
- [x] 首个产物 `vendor/dist/ui-primitives.cjs`（99.6KB）：官方 `DisclosureRow` + `TextShimmer` + chevron 图标
- [x] 冒烟测试 `tools/vendor-smoke.mjs`：bundle 求值 → 导出校验 → 渲染 `DisclosureRow`（标题/折叠内容）→ CSS 编译注入校验，全 PASS
- [ ] 扩大 vendor 集：ui-chat（ChatView/flow/node views/process groups）、ui-conversation（assembler/registries）、依赖的 slots/store/api-session-controller contract
- [ ] 用 `RemoteSessionBinding` 垫片（`lib/vendor/remote-binding.js`）驱动官方 ChatView
- [ ] 插件切换渲染器（`renderer: vendor | lite`）并部署验证

## 进度（round 3）

- [x] 稀疏检出扩到官方全 `packages/client` + `packages/api` + `packages/util` + `vendor/cordis`（3700+ 文件 / 35MB）
- [x] `vendor/dist/ui-chat.cjs` 构建成功（1.3MB）：官方 **ChatView** 组件树 + 官方 Markdown（真 micromark/mdast/katex）+ CSS Modules；shiki 用无高亮垫片；`@tanstack/*`、zustand 等第三方用可调用 Proxy 垫片
- [x] `tools/vendor-chat-smoke.mjs`：bundle 求值（需要 react/react-dom 基线）→ `ChatView` 导出存在 → 48 个 CSS Modules 注入，PASS
- [x] Host 半新增 `GET /remote-session/api/vendor-chat` 下发 bundle（同源浏览器会话内可用；裸 curl 无 DSH 会话返回 403，符合预期）
- [x] Client 半新增 `loadVendorChat()`：fetch bundle 后 `new Function` 求值，注入插件同一个 `require`（共享 React 实例）
- [ ] 下一步：官方 shell 传输垫片 —— 需要实现 `connection` / `sessions` / `SessionBinding` 服务，驱动 `AppWebEntry` 官方 boot（或语法等价的最小渲染器），把 relay 事件喂给官方 ChatView

## 进度（round 4）✅ 官方折叠逻辑跑通

- [x] Bridge 新增 `readSessionEventsSync`（原始 SessionEvent 流）；Host 新增 `events` RPC + `POST /remote-session/api/events`
- [x] `tools/vendor-entry-assembler.ts` + `tools/build-vendor-assembler.mjs` → `vendor/dist/assembler.cjs`（287KB），内含官方：
  `ConversationNodeAssembler` / Event・View・Group 三个 Registry / ui-chat 全部 conversation-node 定义（message、assistant、tool、turn-process、turn-tail、command、compaction、retry、turn-error、turn-max-tokens、inbox、fallback、request-prompt）/ chat-snapshot-builder / process-group 规则
- [x] 垫片：`clsx`、`shiki`、`token-meter`、`cordis`/`schemastery` 别名、未知 registry 方法 Proxy
- [x] **冒烟 PASS**：用本机真实会话（61 个中挑含 user/message 的）1200 条原始事件喂官方 assembler → `grouped('chat')` 返回 **44 条 entries（28 nodes + 16 process groups）**
- [ ] 下一步：客户端用同一 bundle 折叠 `events` 接口数据 → 构造 ChatSnapshot → 渲染官方 ChatFlow/ChatNodeSeat（或先把官方节点数据映射到现有渲染器）

## 进度（round 5）✅ 官方折叠接入面板

- [x] `readSessionEventsSync` 补 `surfaceOp:'append'`（官方客户端会话 API 会补算该字段，日志本身不存；缺它时 user/assistant 节点不会生成）
- [x] `buildMessages(snapshot)`：官方 ChatSnapshot → 面板行（user / context / reasoning / tool / assistant / turn-end），tool 行带 name/callId/isError/args/detail，turn-end 带 turn/durationMs/reason
- [x] 真实会话验证：官方 assembler 投影出 `{user:2, reasoning:3, tool:1, assistant:2, turn-end:2}`
- [x] Host 新增 `GET /remote-session/api/vendor-assembler`；Client 新增 `loadVendorAssembler()`，并在 `TranscriptPane.loadTranscript` 里用官方折叠结果替换桥接消息（失败自动回退桥接投影，不阻塞）
- [x] 回归：bridge-test 全绿、client-render-test 全绿
- [ ] 下一步：把官方 ChatView 直接渲染（需要 slot props 垫片），或先把官方 turn-process/turn-tail 的数据接进现有渲染器以显示官方「用时/分组」

## 进度（round 6）✅ 官方 ChatFlow 渲染跑通

- [x] `tools/vendor-entry-flow.tsx`：**官方 ChatFlow 适配层** —— 直接渲染官方 `ChatFlow`，节点分发到官方渲染器（UserMessageNodeView / AssistantNodeView / ContextMessageNodeView / TurnProcessNodeView / TurnTailNodeView / CommandNodeView / SystemPromptNodeView / UnknownNodeView），工具调用走官方 `ui-tool` 的 `ToolCallTree`（缺 toolview 时回退官方 GenericToolCard）
- [x] 槽位垫片：`renderFactorySlot`（user.content / reasoning.content / user.text）、`useDisclosure`、`useTurnData`、`useGroupAction`、`usePresentation`、`useAccess`、`usePerformanceUsage`、`useHostInfo`、`useChatNode*`、`useChatGroup`（接 GroupStore 的 groupSource）
- [x] `tools/vendor-flow-smoke.mjs` PASS：真实装配出的 snapshot + entries + group sources → 渲染出 **用户提示 / 助手回复（官方 Markdown）/ 工具活动 / 已完成用时行**，零错误标记
- [x] 面板接线：Host 新增 `GET /remote-session/api/vendor-flow`；Client `loadVendorFlow()`，在有官方折叠数据时用官方 `VendorChatFlow` 渲染（失败自动回退现有手绘渲染器）
- [ ] 下一步：官方 composer/turn-tail 动作、图片与文件打开、滚动锚点等外围

## 进度（round 8）✅ 真实会话端到端渲染 + 失败隔离

- [x] 真实会话端到端：从本机会话文件读 600 条原始事件 → 官方 assembler → 官方 ChatFlow 渲染，产出 **27,641 字符**的流内容（思考 / 工具调用 / 已完成 行齐全）
- [x] `FlowBoundary`（React 错误边界）：官方 Flow 任一点渲染失败 → 自动降级回内置渲染器，面板不白屏
- [x] 折叠交互：官方 store 语义（turnProcesses + setTurnProcessOpen），已完成回合默认折叠、点击展开
- [x] 布局契约：`data-slot="conversation.chat.flow"` + `--dsh-chat-flow-gap` + `data-conversation-scroll`，官方间距规则按原样生效
- [ ] 下一步：把官方 flow 的滚动锚点/图片读取接上（官方 `use-chat-scroll` / `loadImage`），再考虑官方 composer

## 进度（round 9）

- [x] 输入框按官方 `InputBar.module.css` 卡片样式重做：`--dsw-specific-input-major` 背景、`--dsw-radius-panel` 圆角、`--dsw-elevation-soft` 阴影、8px 顶距 + 12px 行距、764px 卡片宽、14px/24 字号
- [x] 发送按钮改为官方 28px 圆形图标按钮（启用 accent / 禁用 hover 底），不再是文字按钮
- [x] 真实会话端到端渲染测试保留（27k 字符 / 零错误）
- [ ] 下一步：输入区上方工具行（模型选择、上下文用量）与官方 session header

## 进度（round 10）

- [x] 运行态验证：open turn（无 turn/end）渲染出官方 RunningStatus「深度求索中，用时 …」—— smoke PASS
- [x] 面板头部按官方 ConversationRoot header 几何：padding 10/22/10/20、border-bottom 0.5 border-l3
- [x] 官方渲染**降级诊断**：vendor-flow 加载/渲染失败时，面板顶部显示「官方渲染降级：<原因>」，方便定位家端未重启/端点缺失等问题
- [ ] 下一步：官方 session header（标题/模型/上下文用量插槽）、turn-tail extra actions

## 进度（round 11）

- [x] 输入区文案对齐官方 locale：placeholder = 「发消息或创建任务, / 调用指令, @ 文件或对话」；不可用态 = 「会话不可用」
- [x] 底栏去掉自造提示文案，保留弹性占位 + 圆形发送按钮（官方卡片只有输入区 + 工具/发送行）
- [ ] 待办：官方 session header（面包屑/视图 tab/更多菜单）与模型选择 pill —— 需要会话级模型投影，当前索引未暴露

## 进度（round 12）✅ 真实 Chromium 验证 + clsx 修复

- [x] 新增浏览器集成测试：`research/browser/build.mjs`（把插件 client bundle + vendor flow/assembler + 官方整套主题 CSS 装进一个页面，mock relay 数据）+ `run.mjs`（playwright-core 驱动真实 Chromium，点开会话、断言官方 flow、截图 `research/browser/panel.png`）
- [x] **发现并修复关键 bug**：esbuild 代理插件把 `clsx` 也代理成了 Proxy，导致 `clsx(...)` 返回对象、所有组合类名（`clsx(css.block, 'md-code-block')`）全部丢失 → 官方 CodeBlock/气泡等样式失效。修复后真实浏览器渲染：用户气泡、已完成用时行、分组头、工具行、代码块、消息时间全部正确
- [x] 浏览器断言：`official=true, flowItems=6, turnProcess=1, toolCall=1, degraded=false`
- [ ] 待办：turn-tail 复制/分支按钮的 hover 显示、官方 session header

## 进度（round 13）✅ 真浏览器截图 + 错误边界修复

- [x] 浏览器 harness 完善：注入官方 **图标 sprite**（194 个 symbol，从 `ICON_ARTWORK` 生成），复制图标、分组图标、复制/分支按钮全部可见
- [x] 修复 `FlowBoundary.componentDidCatch` 的 `props` → `this.props`（此前渲染抛错时边界自身崩溃，导致整面板错误页）
- [x] 真实 Chromium 断言稳定：`official=true, flowItems=6, degraded=false`；截图 `research/browser/panel.png`
- [~] 语法高亮：尝试接入真实 shiki（core + JS engine + ts/bash/json），浏览器里 lang 解析未生效（退回 plain 分支），已回退到稳定 shim；高亮作为后续单独处理
- [ ] 待办：turn-tail 复制/分支按钮 hover 行为、官方 session header

## 进度（round 14）✅ 真语法高亮接入

- [x] 根因：构建代理插件把 `oniguruma-to-es` / `oniguruma-parser` / `regex-recursion` / `regex` 也代理掉了，shiki 的 JS 正则引擎编译失败 → tokenizer 只产出单个 plain token（代码块无颜色）
- [x] 修复：这些正则引擎依赖加入 REAL_PACKAGES；shiki 升级到官方同版本 `^4.4.3`（`@shikijs/core|primitive|types|engine-javascript|vscode-textmate` 全放行），懒加载语言保持 shim（default 导出空语法表）
- [x] 验证：浏览器 DOM 出现 `--shiki-token-keyword/constant` 分色 span，截图里 `export const answer = 42` 已有官方配色；flow-bundle 2.1MB
- [ ] 待办：turn-tail 的 hover 动作、官方 session header

## 进度（round 15/16）

- [x] 会话头部：官方 `.crumbCurrent` 指标（14/20 500 primary、padding 4/8、radius md）、header 几何 30px/10-28-10-20、ghost 图标按钮
- [x] Composer 底部行按官方 `InputBar` 结构重做：行内 `padding: 2px 8px 6px`、左 `+` 28px 圆形工具按钮（`--dsw-specific-selector`）、右 34px 蓝色圆形发送按钮（`--dsw-alias-button-info-fill`，官方 arrow path；运行中变为停止 ■ 方块）
- [x] 回归：bridge / client-render / flow-smoke / 浏览器 harness 全部通过
- [ ] 待办：官方 contenteditable 编辑器（chips/命令菜单/附件）、官方 session header 插槽

## 进度（round 17）

- [x] **事件流增量拉取**：Host `events` 支持 `afterSeq` 游标（RPC + HTTP），返回新事件 + `cursor`；Client 按 `session` 缓存事件窗口、每 2s 只拉增量并 concat 后 refold（上限 4000 条，gap 自动全量重取）—— 轮询带宽从「每次全量 ~数千事件」降到「只传增量」
- [x] 图片加载兜底：官方 `loadImage` 垫片改为显式 reject，图片组件走官方失败态而不是坏图
- [x] 回归：client-render-test、浏览器 harness（official=true, degraded=false）通过
- [ ] 待办：官方 contenteditable 编辑器、session header 插槽、远端 fork/attachment API

## 进度（round 18）✅ 官方 Lexical 编辑器接入

- [x] 安装 lexical ^0.49 + @lexical/{plain-text,history,utils,text,clipboard,selection,html,dragon}，构建白名单放行
- [x] `tools/vendor-entry-flow.tsx` 新增 `VendorComposer`：官方 `DraftEditorRuntime` + `DraftEditor` + `InputBar.module.css`（真实 contenteditable、占位符、官方样式），文字通过 `onTextChange` 同步给面板、发送成功后清空草稿
- [x] 面板 Composer 优先使用 `VendorComposer`（Lexical 编辑器），textarea 作为流程不可用时的回退
- [x] 浏览器 harness 实测：`editor=true, sendCalls=1`（点击编辑器 → 输入中文 → Enter → 触发 send 请求）；flow bundle 2.98MB
- [x] 回归：bridge-test / client-render-test / flow-smoke 全绿
- [ ] 待办：chips（/ 命令、@ 引用、附件）、session header 插槽、远端 fork/attachment API

## 进度（round 19）✅ 远端分支（fork）打通

- [x] Host 新增 `fork` RPC + `POST /remote-session/api/fork`：调用官方 `sessionController.fork({sessionId, atSeq})`（atSeq = 官方回合边界 seq）
- [x] Client：官方 turn-tail 的「在新对话中分支」按钮现在可用（`useAccess('session/fork')` 放行 + `forkAt(seq)` → 远端 fork → 自动切换到新会话并刷新列表）
- [x] 浏览器 harness 实测：分支按钮 aria-label「在新对话中分支」存在，点击后 `forkCalls=1`
- [x] 回归：flow-smoke / client-render / bridge 全绿
- [ ] 待办：`/` 命令菜单、`@` 文件引用、远端附件字节读取、session header 插槽

## 进度（round 20）✅ 远端图片/附件加载

- [x] Host 新增 `attachment` RPC + `POST /remote-session/api/attachment`：调用官方 `sessionController.attachment({sessionId, attachmentId})` 返回 base64
- [x] Flow：注册官方图片槽位（`conversation.chat.user.images` / `conversation.chat.message.images`）+ `conversation.images.content` 工厂 → 官方 `MessageImages` / `ImageGallery` / 灯箱
- [x] Client：`loadImage` 走远端 attachment 接口，返回 `data:` URL，并按附件 id 缓存（面板生命周期）
- [x] 浏览器 harness：用户消息里的图片成功渲染（`imgCount=1`, `attachmentCalls=1`，src 为 data URL）
- [ ] 待办：`/` 命令菜单、`@` 文件引用、session header 插槽

## 进度（round 21）✅ @ 文件引用

- [x] Host 新增 `fileReferences` RPC + `POST /remote-session/api/file-references`：解析会话 Agent 后调用官方 `fileReferences.list(agent, query)`（5s 超时）
- [x] Flow `VendorComposer` 新增 `insertFile()`：用官方 `DraftEditorRuntime.insertReference` 把 `@query` 替换成官方 ReferenceChip（file/folder appearance）
- [x] Client：输入框内 `@` 触发官方候选弹层（防抖 140ms、↑↓/Enter/Tab/Esc 键盘操作、点击选择），选中后插入官方 chip；发送时使用 clipboard 文本（含 `@path`）
- [x] 浏览器 harness：`MENTION {open:true, picked:true, calls:1, sent:true}`（弹层出现、chip 插入、发送内容包含路径）
- [ ] 待办：`/` 命令菜单、session header 插槽、历史会话的文件候选（需 resume agent）

## 进度（round 22）✅ 官方会话头（官方 CSS Modules）

- [x] 新增 `VendorSessionHeader`：直接使用官方 `ConversationRoot.module.css` 的 `.header / .headerLeading / .titleRow / .titleCluster / .crumbs / .crumb / .crumbCurrent / .headerUtilities / .headerActions / .headerCorner`
- [x] 面板头部切换为官方组件：标题走官方 crumb 排版，副标题（主机/目录/更新时间/运行态）在 utilities 区，刷新/停止按钮进官方 headerActions
- [x] 浏览器验证：头部官方 DOM + 渲染正常；会话流/@ chip/编辑器/图片/分支全部保持
- [x] `@` 文件引用（round 21 已部署）：官方 chip + 候选弹层
- [ ] 待办：`/` 命令菜单（需要宿主命令注册表 RPC）、turn-tail 图标 sprite 补全

## 进度（round 23）✅ `/` 命令菜单

- [x] 宿主接口：`commands`（官方 `ctx.get('commands').list(...)` 命令目录）+ `execute-command`（官方 `commands.execute(...)`），RPC + HTTP 双通道
- [x] Flow：`VendorComposer.insertCommand()` 用官方 `DraftEditorRuntime.insertCommand` 插入官方 CommandChip（`data-composer-command`）
- [x] Client：`/` 触发命令弹层（官方目录 + 名称/描述两行、前缀过滤、↑↓/Enter/Tab/Esc）；发送时识别命令 chip → 走 `execute-command`，执行成功后清空草稿并刷新
- [x] 浏览器验证：`COMMAND {menu:true, picked:true, ran:true}`，请求体 `{"line":"/compact"}` 正确
- [x] 回归：bridge / client-render / flow-smoke 全绿
- [ ] 待办：命令参数输入态、历史会话命令目录（需 agent resume）、附件卡片点击打开

## 进度（round 24）✅ 远端打开文件 / Markdown 文件链接

- [x] Host 新增 `openPath` RPC + `POST /remote-session/api/open-path`：调用官方 `sessionController.openWorkspacePath({path, action})`，相对路径按会话 cwd 解析（Windows/POSIX 双风格）
- [x] Flow 接入官方 `MarkdownDelegateProvider`：助手回复里的本地文件链接渲染为官方 `fileLink` 按钮（带图标），点击回调 owner `openFile`
- [x] Client `openFile` 走 `open-path`（相对路径远端解析），点击失败会在面板提示
- [x] 浏览器验证：`OPENFILE {calls:1}`；`@`/`/`/图片/会话流全部保持
- [ ] 待办：文件附件卡片点击、命令参数输入态、历史会话 @ 候选

## 进度（round 25）

- [x] **历史会话 `@` 兜底**：宿主新增 `files` RPC（工作区受限扫描 depth 4 / 400 条 / 30s 缓存，跳过 node_modules 等）；file-references 为空时客户端自动回退（历史会话无 live Agent 也能选文件）
- [x] **Composer 模型切换**：从事件流读当前 `provider/model`，宿主 `models` 目录做 pill + 下拉（官方目录分组/描述），选择时调 `select-model`；无会话头时回退 catalog.default
- [x] 浏览器验证：`MENTION {calls:1, scans:1}`、`MODEL {pill:"DeepSeek-V4-Pro", switched:true}`
- [x] 回归：bridge / client-render / flow-smoke 全绿
- [ ] 待办：命令参数 hint、附件卡片、会话头 tabs

## 进度（round 26）

- [x] **版本握手**：插件版本 `3.0.0`；relay `hello` meta + 新 RPC `version`；宿主对每个在线 peer 懒探测版本（失败标记 `legacy`），`state` 返回 `self.version` / `peer.version`
- [x] **版本提示**：客户端在面板顶部提示「远端主机插件较旧…请重启对方 DSH 桌面应用」；接口缺失错误（unknown rpc method）翻译成可操作提示
- [x] **引导（steer）**：运行中发送自动用 `mode: 'steer'`，输入框 placeholder 切为「发送消息以引导当前回合」
- [x] 浏览器验证：`SEND {calls:1, mode:"queue"}`、`MODEL`/`MENTION`/`COMMAND` 全绿
- [ ] 待办：命令参数 hint、消息反馈（点赞/点踩）、header tabs

## 进度（round 27）

- [x] `/` 命令支持**参数输入**：选中命令 chip 后继续键入参数，回车提交完整命令行（`/feedback the button is good`）；客户端不再用 pending name 覆盖整行
- [x] 官方 **command hint** 生效：命令 catalog 的 `input.hint`（如 `<text>`）通过 `DraftEditor` 的 `--dsh-composer-hint` 机制显示（官方 CSS pseudo content）
- [x] 浏览器验证：`COMMAND {compact:true, feedback:true, line:"/feedback the button is good"}`
- [x] 回归：bridge / client-render / flow-smoke / 浏览器全部通过
- [ ] 待办：消息反馈点赞/点踩（官方 feedback dialog 依赖 feedback 服务）、header tabs

## 进度（round 28）

- [x] **远端新建会话**：Header 新增 `＋`（在远端主机新建会话）→ 宿主 `create` RPC（官方 `sessionController.create({cwd})`）→ 自动切到新会话
- [x] **官方空会话 Hero**：无消息时渲染官方 `HeroShell`（fish logo + 「探索未至之境」+ 预览版 badge），composer 居中跟随；发首条消息后回到正常会话布局
- [x] 移除临时 feedback 探针端点（反馈服务还需宿主内部接口，暂不做点赞/点踩）
- [x] 浏览器验证：`HERO {hero:true, editor:true}` + 全部旧断言通过
- [ ] 待办：消息反馈（需 feedback dialog/服务）、header 视图 tabs

## 进度（round 29/30）✅ 消息反馈（点赞/点踩）

- [x] 通过 `app.asar` 抽取官方 `dsh-message-feedback` 源码，确认宿主服务契约：
      `list({sessionId})` / `put({sessionId,messageId,rating,note?,category?,ifVersion})` / `delete({sessionId,messageId,ifVersion})`
- [x] Host 新增 `feedback` / `feedbackPut` / `feedbackDelete` RPC + HTTP 路由（relay peer 双通道）
- [x] Flow：`conversation.chat.assistant-actions` 槽位转给客户端 `renderAssistantActions(messageId)`
- [x] Client：官方 tail 动作条渲染 like/dislike 官方图标；点击记录/撤销反馈（乐观更新 + 版本冲突提示），4s 节流刷新
- [x] 浏览器验证：`FEEDBACK {present:true, dislike:true, put:1, active:1}`（点赞蓝色高亮）
- [ ] 待办：反馈 dialog（写备注/分类）、header 视图 tabs、composer plan/permission chips

## 进度（round 31）✅ Composer 权限预设 chip

- [x] 从 asar 确认官方 `permissionPresets` 服务契约：`catalog()` → `{options, defaultOptions, defaultPreset}`；切换走 `set(session, preset)`（写 `permission/preset` 事件）
- [x] Host：`permissionCatalog` / `permissionSet` RPC + HTTP 路由（仅活跃会话可切换，历史会话返回提示）
- [x] Client：从事件流推导当前权限（`permission/preset`），回退 catalog.defaultPreset；composer 渲染官方权限 chip（官方 PermissionIcon + 名称 + chevron）+ 选项菜单（名称/描述/当前高亮）
- [x] 浏览器验证：`PERMISSION {present:true, label:"只读", opened:1, set:1, after:"工作区写入"}`
- [x] 回归：bridge / client-render / flow-smoke / 全部浏览器断言通过
- [ ] 待办：plan 模式 chip、反馈 dialog、header 视图 tabs

## 进度（round 32）✅ 去掉条数限制提示 + 官方「加载更早」

- [x] 删除面板底部「仅显示最近 N 条，共 M 条」计数（用户要求不显示）
- [x] Host `events` 支持 `limit` 窗口参数（200–60000），返回 `totalEvents` / `hasOlder`；transcript 默认消息上限 100 → 2000
- [x] Client：官方折叠使用可增长事件窗口（默认 4000，每次「加载更早」+4000 至 60000），窗口变化时重取并重新折叠，保留滚动位置
- [x] Flow：新增 `VendorLoadOlder`，直接使用官方 `ChatView.module.css` 的 `.older` 样式与 `chat.loadOlder` 文案
- [x] 浏览器验证：`HISTORY {initial:1, after:0, limits:[4000…,8000]}`（按钮出现 → 点击加载 → 全部加载后消失）
- [x] 回归：bridge / client-render / flow-smoke / 全部浏览器断言通过

## 进度（round 32/33）✅ 隐藏系统提示 / 普通上下文行（官方可见性规则）

- [x] 用户截图中的「Time sampled…」「model changed…」行 = 官方 `system/message` / `developer/message` 折叠出的 system-prompt / context 节点
- [x] 官方 ChatView 的真实可见性规则：`isVisibleChatNode()` 隐藏 system-prompt、普通 Context（保留 tool-addition/removal）、permission 命令
- [x] Flow `dispatchNode` 直接调用官方 `isVisibleChatNode` 过滤，不再渲染这些行；fallback 渲染器同步过滤 context 行
- [x] 浏览器验证：`VISIBILITY {systemPrompt:false, context:false}`，其余断言（历史/命令/模型/反馈/权限）全部通过
- [x] 回归：bridge / client-render / flow-smoke 全绿

## 进度（round 33）✅ 目标通知/目标条 + 降级模式不再显示原始 goal 文本

- [x] 用户截图里的 `<goal_round>` 原始气泡：官方用 `turn-trigger` 通知卡展示；降级渲染器此前把非人类 user/message 当普通用户消息 → 已改为 context（隐藏），只有 `source.kind=user/steering` 才渲染为用户气泡
- [x] 官方 **GoalBar 目标条**接入：flow 导出 `VendorGoalBar`（官方 GoalBar + goal 中文字典），composer 上方渲染「进行中的目标 继续吧」
- [x] 目标状态从事件流 `goal/change` 推导（create/edit/pause/resume/clear）；操作走宿主官方 `goals` 服务（pause/resume/clear/edit，仅活跃会话）
- [x] 浏览器验证：`GOAL {present:true, text:"进行中的目标 继续吧"}`，点击「清除目标」→ `{"action":"clear","goalId":"goal-1","revision":1}`
- [x] 回归：bridge / client-render / flow-smoke / 全量浏览器断言通过
- 注意：第一张图的「官方渲染降级 vendor flow bundle: HTTP 404」+「仅显示最近 100 条」= 那一端 DSH 还在用旧插件，重启 DSH 桌面应用即消失

## 进度（round 34）✅ 隐藏 Hindsight 记忆提醒注入

- [x] 用户截图里 `<hindsight_knowledge_refresh>` 长块 = Hindsight 记忆插件自动注入的「用户角色提醒」（提示 agent 何时使用记忆工具），官方客户端按用户消息显示
- [x] 远端面板过滤：Flow `dispatchNode` 对文本以 `<hindsight_` 开头的节点直接不渲染；桥接层把这类注入标记为 context（降级渲染器也不显示）
- [x] 浏览器验证：`VISIBILITY {systemPrompt:false, context:false, hindsight:false}`
- [x] 回归：bridge / client-render / flow-smoke 全绿

## 进度（round 35）✅ 运行状态以会话日志为准

- [x] 「已完成」后仍显示「深度求索中，用时 5分…」：宿主的 live running 标记有滞后，客户端此前直接使用
- [x] 现在从事件流推导权威运行态：末尾事件是 `turn/end` → 未运行；是 `turn/start` → 运行中；官方 flow / 降级 flow / composer / 头部状态全部使用该值
- [x] 浏览器验证（模拟宿主 running=true 但日志已 turn/end）：`RUNNING {runningRow:false, runningStatus:false}`
- [x] 位置问题根因是「hindsight 注入」被当成一条用户消息形成了额外空 turn；上一轮已过滤该类注入，空 turn 不再产生，运行状态回到 flow 末尾
- 注意：截图顶部 `bundle: HTTP 404` = 该端桌面应用仍在跑旧宿主（vendor 路由未注册），重启 DSH 桌面应用后走官方渲染

## 进度（round 36）✅ 工作区侧栏改成官方样式

- [x] 侧栏行改用官方组件：`Rows.module.css` 的 projectRow（34px，文件夹+悬停箭头+悬停新建按钮）与 sessionRow（32px，状态点+标题+时间，选中 hover 背景）
- [x] 分组标题改为官方 WorkspaceBrowser sectionHeader（12px 三级色 + 折叠箭头），头部右侧换成官方图标按钮（搜索/视图/新建会话）
- [x] 去掉官方没有的「展开其余 N 个会话 / 收起」分页，工作区会话完整列出（侧栏滚动）
- [x] 当前会话所在工作区文件夹图标高亮（官方 folderActive 业务色）
- [x] 浏览器验证：`SIDEBAR {treeItems:3, showMore:false}`，截图 `research/browser/out/sidebar.png`；其余官方渲染断言全绿

## 进度（round 37）✅ 工作区搜索（官方搜索框 + 实时过滤）

- [x] 侧栏头部搜索按钮启用：点开变成官方 WorkspaceBrowser 搜索框样式（search/searchExpanded/searchButton/searchInput/clearButton），Esc 或清除按钮收起
- [x] 输入即时过滤会话（标题 / cwd / id，忽略大小写）；搜索时自动展开主机、无结果时显示「无匹配会话」
- [x] 浏览器验证：`SEARCH {opened:true, filtered:3, empty:true}`，其余断言全绿

- [x] 修复 `searchQuery` 作用域（第一处替换误伤 ToolRow/过程行，已还原并只在 PeerSection 展开判断使用）
- [x] 回归：bridge / client-render（含 ToolRow 展开断言）/ flow-smoke / 全量浏览器断言全部通过

## 进度（round 38）✅ 对齐官方「展开其余 N 个会话」与相对时间格式

- [x] 之前误删的官方分页控件恢复：每工作区默认 5 条，官方 `sessionOverflowButton` 样式（28px 高、三级色 12px），点击 +5 / 全部展开后显示「收起」
- [x] 会话行右侧时间改用官方 workspace 字典：`刚刚 / N分钟 / N小时 / N天 / N个月 / N年`（不再带「前」后缀）
- [x] 分组标题右侧计数加省略号，避免窄侧栏溢出
- [x] 浏览器验证：`SIDEBAR {overflow:"展开其余 2 个会话", officialTimes:true, relativeWithSuffix:false}`，截图 research/browser/out/sidebar.png
- [x] 回归：bridge / client-render / flow-smoke / 全量浏览器断言通过

## 进度（round 39）✅ 官方消息反馈弹窗（分类 + 详情 + Toast）

- [x] 点赞/点踩改为打开官方 `FeedbackDialog`：分类 chips（任务结果/指令遵循/产品交互/稳定性/资源费用/安全隐私/其他）、详情 textarea、提交按钮、致谢 Toast、失败 Toast
- [x] flow 导出 `createFeedbackDialog(submit)` + `VendorFeedbackDialog`（内置官方对话框状态机 FeedbackDialogController 的等价实现 + 官方中文 feedback 字典 + 通用 submit/submitting/close 文案）
- [x] 客户端提交走宿主 `feedback-put`（携带 note/category/ifVersion），成功后刷新反馈条；再次点击已选评分仍走取消标记
- [x] 修了一个真实 bug：控制器创建代码原本位于 `flowVendor` 变量赋值之前（JS 顺序执行读不到该状态），移到 flow bundle 加载之后
- [x] 浏览器验证：`FEEDBACK {available:["1"], dialog:true, put:1, putHasNote:true, active:1}`
- [x] 回归：bridge / client-render / flow-smoke / 全量浏览器断言通过

## 进度（round 40）✅ 侧栏图标不再依赖宿主图标精灵

- [x] 用户截图里工作区没有文件夹图标：侧栏行图标用 `<use href="#dsw-icon-…">` 依赖宿主文档的 icon sprite；在部分 DSH 实例/版本里该 symbol 缺失 → 图标空白
- [x] 改为内联渲染：flow 内置 `InlineIcon`，从 vendored 官方 `ICON_SYMBOLS` 解析出根属性 + 内部路径，直接渲染 `<svg>`（文件夹开/关、折叠箭头、搜索/视图/新建、清除），不再依赖宿主 sprite
- [x] 浏览器验证：`SIDEBAR ... inlineIcons:[{id:"dsw-icon-folder-open-regular",children:3,width:16}]`，截图可见蓝色文件夹与头部图标

## 进度（round 41）✅ 官方轮次导航栏（TurnNavigator）

- [x] 用户指出的「会话区域右侧一列刻度」= 官方 TurnNavigator：每个刻度代表一轮对话，活动轮刻度更长更深，悬停显示该轮 prompt/回复预览，运行中轮次刻度闪烁，点击跳转
- [x] flow 引入官方 TurnNavigator.module.css，导出 VendorTurnRail（官方 mark/active/preview/frame 样式与 10px 定距）；容器窄于官方阈值时强制显示
- [x] 客户端从官方 snapshot timeline.turnOrder + 节点内容构建 rail items（prompt/response 预览），滚动时按 `[data-turn-process]` 锚点计算活动轮，点击滚动到对应轮（无锚点则滚到底）
- [x] 浏览器验证：`TURNRAIL {present:true, marks:2, current:true}`，截图 panel.png 右侧可见刻度轨道
- [x] 修复：rail 状态声明原本插到了错误的函数作用域；内联图标 kebab-case 属性转 React camelCase（消除 SVG 属性告警）

## 进度（round 42）✅ 远程会话「设置」：连接配置 UI + 持久化 + 热重连

- [x] 面板顶部新增「设置」按钮，打开连接设置弹窗：Relay 地址、访问令牌（留空保持）、实例 ID、实例名称，显示 relay 连接状态与上次错误
- [x] 宿主新增 `/remote-session/api/settings`（读取，令牌只回末 4 位）与 `settings-save`（校验 http(s)、必填、写 `~/.dsh/remote-session-settings.json`、更新 cfg、重启 relay 连接代际）
- [x] 启动时优先读取该设置文件（覆盖 cordis/env，作为 UI 修改的持久层）
- [x] 浏览器验证：`SETTINGS {opened:true, fields:4, saved:1, relayUrl:"http://10.0.0.5:3098", closed:true}`
- [x] 回归：bridge / client-render / flow-smoke / 全量浏览器断言通过

## 进度（round 43）✅ 设置入口放进官方设置页（settings.section）

- [x] 客户端注册官方 `settings.section`：在「设置」左侧导航（侧边卡片下方）新增「远程会话」页
- [x] 页面内容：relay 连接状态、Relay 地址、访问令牌（留空保持）、实例 ID、实例名称、保存并重连；复用宿主 settings/settings-save RPC
- [x] 面板顶部「设置」按钮保留为快捷入口（同一弹窗表单）
- [x] 浏览器验证：`SETTINGS-SECTION {registered:true, mounted:true, fields:4, saved:2, relayUrl:"http://10.0.0.8:3098"}`，官方 Settings 页注册生效
- [x] 回归：bridge / client-render / flow-smoke / 全量浏览器断言通过

## 进度（round 44）✅ 权限预设菜单：中文 + 锚定芯片

- [x] 菜单跑到窗口右下角：权限/模型菜单原本是 composer 容器里的绝对定位兄弟节点（right:8/bottom:100%），锚点落到了整条 composer 容器右侧；现在包在各自芯片的相对定位 wrapper 内，菜单贴着芯片上方弹出
- [x] 中文化：官方 permission.access 文案映射（仅可查看 / 工作区内修改 / 完全权限 / 自动审查），catalog 只回 id 时也能显示；auto 带官方描述
- [x] 浏览器验证：`PERMISSION {labels:["仅可查看","工作区内修改","完全权限","自动审查…"], anchored:{horizontalGap:0, menuAboveChip:true}}`
- [x] 回归：bridge / client-render / flow-smoke / 全量浏览器断言通过

## 进度（round 45）🧹 去掉旧的工作区样式（全量官方）

- [x] 侧栏容器改用官方 token：宽 280、`--dsw-specific-sidebar-fill` 背景、`--dsh-sidebar-inline-padding` 内边距、去掉自绘边框
- [x] 顶部「工作区」行改为官方 sectionHeader 度量（36px 高、12px 三级色、500 weight，去掉旧 11px/600/letter-spacing 样式）
- [x] 删除旧手绘组件与样式：`SessionRow`/`FolderGlyph`/`Chevron` 及 `hostRowStyle`/`workspaceHeaderStyle`/`sessionRowStyle` 全部移除（客户端 -4.2KB）
- [x] 兜底路径也不再使用旧样式：vendor 不可用时用官方字号的纯行（30/34/32px、官方 label token），不会闪回旧 UI
- [x] 回归：client-render / bridge / flow-smoke / 全量浏览器断言通过（侧栏 7 行、官方图标、展开其余、时间格式等不变）

## 进度（round 46）🐞 设置页「保存并重连」无反应

- [x] 根因：官方 slot 渲染器把注册的 `inject` face **展开进组件 props**；我们的设置页组件只读 `props.injected`，于是 load/save 都是 undefined → 点击保存静默 return（load 失败也没报错，所以字段是用户手填的）
- [x] 修复：组件优先读 `props.injected`，否则直接用 props（兼容官方展开式注入）；load/save 缺失时显式报错，不再静默
- [x] 浏览器测试改为官方展开式绑定验证：`SETTINGS-SECTION {mounted:true, fields:4, saved:2}`

## 进度（round 47）🐞 降级渲染排查 + 内置 bundle 优先

- [x] 用户截图里的「工具调用 · ops_bash …」「执行了命令」「已读取文件」行 = 手绘降级渲染，不是官方 TurnProcess/ToolCallTree
- [x] 说明：出现降级 = 该实例仍跑旧 client.js（未重启/未装新包）；relay peers 确认公司实例未注册、家里为 3.0.0
- [x] 进一步加固：`vendorSource` 改为**优先直接使用内置官方 bundle**（不再先 fetch 宿主路由），更新后的 client 任何环境都直接官方渲染，不依赖宿主 vendor 路由
- [x] 回归通过：official=true / flowItems=9 / 侧栏官方行 / 设置页 / 轮次轨道

## 进度（round 48）⚡ 去掉侧栏/会话首帧样式闪烁

- [x] 现象：官方工作区样式加载前会先渲染一帧旧的降级样式，然后被官方行替换（一闪而过）
- [x] 侧栏：官方 bundle 未就绪时不再渲染主机/工作区行（只保留「正在读取主机状态…」/空白），就绪后一次性渲染官方行
- [x] 会话区：官方折叠可用前不再渲染降级消息行；`officialPending` 时保持空白，只有真正渲染失败（flowFailed）才显示降级
- [x] 新版 client 仍优先使用内置官方 bundle（加载几乎同步），所以空白窗口只有极短一瞬
- [x] 回归：official=true / flowItems=9 / 侧栏官方行 / 设置页 / 轮次轨道 全绿

## 进度（round 49）🗂 按官方 Workspace 注册表分组（不再按 cwd 猜工作区）

- [x] 用户现象：本地侧栏 4 个工作区，远程面板 7 个——远程此前按会话 cwd 去重分组，还显示已删除/归档工作区的残留会话
- [x] 宿主新增 `workspaces` RPC 与 `state.workspaces`：读取官方 `workspaceRegistry`（id/title/path/sessionIds + archivedSessionIds）
- [x] 对端 refresh 时同步抓取 `workspaces`，`state.peers[].workspaces` 一并下发；注册后立刻 refreshPeers 一次
- [x] 客户端侧栏优先用注册表分组：只显示注册表里的工作区、按 sessionIds 归属、过滤 archived 会话、注册表顺序；宿主不支持时回退 cwd 分组
- [x] 浏览器验证：`SIDEBAR {overflow:"展开其余 1 个会话", archivedHidden:true}`（归档会话不显示、工作区归属正确）
- [x] 回归：client-render / bridge / flow-smoke / 全量断言通过

## 进度（round 50）🐞 保存并重连后一直「未连接」

- [x] 竞态：`restartRelay()` 提升 generation 并 abort 旧 SSE；旧 `runRelayLoop` 的 catch 仍会写 `connected=false/lastError`，若发生在新连接建立之后，UI 永远停在未连接
- [x] 修复：旧 generation 的 catch 直接 `break`（不再写状态）；`openStream` 在 abort 后的响应上抛错，不发布 connected=true
- [x] `settings-save` 现在等待 relay 真正连上（最长 8s）再返回；客户端设置页在保存成功但未连接时显示具体原因
- [x] 回归：client-render / bridge / flow-smoke / 全量浏览器断言通过

## 进度（round 51）🧭 主机行与工作区行视觉区分

- [x] 用户把 peer 行误认为「新增的工作区」：主机行之前与官方工作区行同样式（folder/section 行 + 「N 工作区 · M」），加上新接入的 `公司` 主机行，看起来像多了一个工作区
- [x] 主机行标签改为 `主机 · 家里` / `主机 · 公司`，计数保留在右侧；工作区仍是文件夹行，层级一眼可分
- [x] 事实核对：本机 `~/.dsh/storages/workspace.json` 只有 4 个工作区、mtime 09:45 未变；relay 上 company 与 home 均上报 60 个会话/4 工作区，说明公司实例跑在同一台 Windows 用户目录（同一 DSH home），不是新增了工作区而是多了一个接入的主机

## 进度（round 52）🔄 对端重启后列表仍是旧数据

- [x] 现象：家里实例重启后，远端面板里「家里」仍显示重启前的会话/工作区（缓存旧快照），且主机行没有离线提示
- [x] 宿主：收到 relay `peer online` 事件立即 `refreshPeer(id)` 拉取最新 sessions/workspaces（不再等 20s 轮询）；`ready` 帧后也刷新全部在线对端
- [x] 客户端：主机行显示 `主机 · 名字`，离线时 meta 前缀「离线 ·」并置灰、title 提示「显示上次同步的会话」
- [x] 版本 3.1.0 保留（旧端会出现插件较旧提示）

## 进度（round 53）🧹 改实例信息后旧主机残留在中继

- [x] 现象：编辑本机客户端实例信息（ID/名称）后，远端面板仍能看到旧实例和它的旧会话缓存
- [x] relay：`/v1/register` 新增 `previousId`，实例改名时立即移除旧注册并广播 offline；离线实例 15 分钟后从 peer 快照清除（每分钟扫一次）
- [x] 宿主：settings-save 记录并随下一次 register 上报 previousId（仅首次注册后清空）
- [x] relay 已重启（内存缓存里旧的 home 离线条目已清除）；host 已同步到 dist/本机 profile

## 进度（round 54）⚡ 加载对话提速 + 轮询不再丢官方折叠

- [x] 宿主：按文件 mtime+size 缓存解码后的会话日志，transcript 与 events 共用一次解析（原来同一文件解析两次）
- [x] 客户端：首屏并行请求 transcript + events（不再串行等两个 RTT），官方折叠先出
- [x] 轮询：每 2s 只拉增量 events，每第 5 次（约 10s）才重读完整 transcript；轻量轮询复用上次 transcript
- [x] 修复优化引入的回归：增量 events 为空时用 `officialFoldCache` 回填官方折叠；重载仍无法折叠时做一次有界全量重建（≤2 次）
- [x] 浏览器验证：`HARNESS {official:true, flowItems:9, turnProcess:2}`；首屏官方渲染 `firstOfficialPaintMs ≈ 396ms`（测试夹具）
- [x] 回归：client-render / bridge / flow-smoke / 全量断言全绿

## 进度（round 55）🧨 大会话降级根因：事件窗口超过 relay 体积上限

- [x] 根因：本会话 14,334 个事件、完整 JSON 33MB；旧首屏窗口 4000 事件 ≈ 8.5MB，超过 relay `MAX_BODY=8MB` → `/v1/publish` 413 → 事件拉取失败 → 客户端静默降级渲染
- [x] relay：`MAX_BODY` 提升到 64MB；nginx `/dsh-relay/` 的 `client_max_body_size` 16m → 64m（nginx -t 通过、服务已恢复）
- [x] 客户端：首屏事件窗口 4000 → **800**（约 1.6MB），「加载更早」每次 +800；大会话首屏不再超限、传输量减半以上
- [x] 客户端：官方渲染失败时显示具体原因「官方渲染未生效：会话事件数据加载失败（会话较大或中转超限）」而不是静默降级
- [x] 实测（云端面板拉 company 的 1200 窗口）：2.8MB / 2.39s；800 窗口约 1.6MB
- [x] 浏览器验证：`official:true, flowItems:9`；HISTORY limits `[800,…,1600]`

## 进度（round 56）🩹 官方渲染崩溃：import_notice.hasSpillNotice is not a function

- [x] 现象：真实大会话渲染出「官方渲染降级：i0: import_notice.hasSpillNotice is not a function」；含被 spill 截断的 bash 输出时官方 flow 抛错
- [x] 根因：`@deepseek-ai/dsh-spill-policy/notice` 之前用万能 proxy shim 顶替；esbuild `__toESM` 只拷贝自有属性，命名导入 `hasSpillNotice` 变成 undefined
- [x] 修复：新增 `tools/shims/spill-notice.ts`，逐字实现官方 `formatSpillNotice` / `hasSpillNotice`（含 describeOmitted 语义），并替换 flow 构建别名
- [x] 夹具：把 bash 工具结果改成官方 spill notice 文本，覆盖该渲染路径；断言 `official:true, degraded:false`
- [x] 回归：flow smoke / client-render / bridge / 全量浏览器断言全绿
