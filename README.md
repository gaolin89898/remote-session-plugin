# dsh-remote-session

DSH 跨端会话插件：把**公司**和**家里**两台 DSH 桌面客户端（或任意多台）的会话打通，经公网中转服务器（relay）互见会话列表、查看对话、继续对话。

> **设计原则**：会话文件只由"拥有该 `~/.dsh` 的那台机器"写入（DSH 每会话单写者锁）。插件**从不写**会话文件，所有执行都转发给会话所属实例，插件只做索引 / 读取 / 转发。

## 已验证能力（本机双实例 + 公网 relay 实测）

| 能力 | 结果 |
|---|---|
| 两台实例经公网 relay 互见（`https://118.196.78.91:8081/dsh-relay`） | ✅ `state.peers` 双向在线 |
| 对端会话列表（标题 / 工作区路径 / 更新时间 / 运行状态） | ✅ 标题与 cwd 来自投影缓存 + 日志头部轻量解析 |
| 跨端读取对话（100 条窗口 + total/truncated） | ✅ RPC `transcript` 返回 2282 条历史 |
| 跨端继续对话（A 端发消息 → B 端 agent 执行） | ✅ `prompt` accepted，远端会话追加 user 消息并启动 turn |
| 远端执行失败对前端可见 | ✅ 显示「执行失败：no adapter registered for provider "opencode-go"」 |
| 远端模型切换 | ✅ RPC `selectModel` → `{provider:'deepseek-official', model:'deepseek-flash'}` |
| 客户端 UI 进入 boot graph | ✅ `window.__DSH_BOOT__` 含 `{"id":"dsh-remote-session","url":"plugins/??dsh-remote-session/client.js&rev=..."}` |
| 断线重连 / 对端离线保留最后索引 | ✅ 指数退避重连，离线实例置灰 |

> 已知限制：远端会话里记录的模型 provider 必须在**远端机器**可用，否则 turn 会以「执行失败」结束（可用输入区的模型选择器或 `select-model` 接口切换）。测试时 opencode-go 会话在纯 base+web-app 测试实例上不可用，即上面那条错误行的来源。

## 组成

| 部分 | 位置 | 说明 |
|---|---|---|
| relay 中转 | 云服务器 `118.196.78.91`：`/opt/dsh-relay/server.js`（systemd `dsh-relay`，127.0.0.1:3098），nginx `https://118.196.78.91:8081/dsh-relay/` | 只转发在线状态 / 会话索引 / RPC，**不落盘、不保存会话内容**；共享令牌鉴权 |
| Host 半 | `lib/index.js` + `lib/session-bridge.js` | 连 relay、上报会话索引、应答 list/transcript/prompt/cancel/models/selectModel RPC、暴露 `/remote-session/api/*` |
| Client 半 | `lib/client.js` | 左侧栏「远程会话」图标 + 主面板（主机/会话列表、对话、输入框、停止、刷新） |

## 安装（每台机器一次）

源码仓库包含运行所需的 `lib/vendor` 构建文件，可以直接通过下方 CLI 从仓库目录安装。连接信息通过面板「设置」填写；仓库中的 `cordis.patch.yml` 不含令牌。

本地生成的两份分发目录用于跨机器安装，不提交到 Git：

- 家里：`dist/dsh-remote-session`（`instanceId: home` / 名称「家里」）— **本机已安装进 desktop profile**
- 公司：`dist/dsh-remote-session-company`（`instanceId: company` / 名称「公司」）— 拷贝到公司电脑安装

### 从源码构建

官方源码以 Git submodule 固定版本，首次克隆使用：

```sh
git clone --recurse-submodules git@github.com:gaolin89898/remote-session-plugin.git
cd remote-session-plugin
npm ci
node tools/build-vendor-assembler.mjs
node tools/build-vendor-chat.mjs
node tools/build-vendor-flow.mjs
```

已克隆的仓库可运行 `git submodule update --init` 获取官方源码。官方许可证保留在 `vendor/LICENSE.deepseek-harness`。

浏览器回归运行 `node research/browser/build.mjs`、`node research/browser/composer.mjs` 和 `node research/browser/run.mjs`；通过 `DSH_CHROMIUM` 指定 Chromium 可执行文件。需要生成本机分发包时运行 `node tools/bake-client.mjs`，该命令也会更新本机 desktop profile 的插件客户端文件。

### 1. 安装到 DSH 桌面应用

用 **DSH 桌面应用自带 CLI**（不要用 npm 全局 CLI，它会拒绝 desktop profile）：

```bat
"C:\Users\<用户>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" ^
  plugin --profile desktop add "file:C:\path\to\dsh-remote-session"
```

安装成功特征（`%USERPROFILE%\.dsh\profiles\desktop\package.json`）：

```jsonc
"dependencies": { "dsh-remote-session": "file:C:/.../dsh-remote-session" },
"dsh": { "profile": { "bundles": [ ..., "dsh-remote-session" ] } }
```

> `file:` 依赖会被硬链/复制进 profile 的 `node_modules`，**不要删除分发包目录**；改配置后建议重跑一次 `plugin add`。

### 2. 重启 DSH 桌面应用

Host 半不支持热更新，必须重启桌面应用才会加载插件。重启后：

- 左侧栏出现「远程会话」图标 → 点开
- 顶部显示本机实例名与 relay 连接状态

### 3. 配置（可选）

配置在 `cordis.patch.yml` 的 `config` 段（`dist` 已预填；安装后对应
`profiles/desktop/node_modules/dsh-remote-session/cordis.patch.yml`，也可在 profile 用户层按 id 覆盖）：

```yaml
- id: remote-session
  name: 'dsh-remote-session'
  config:
    relayUrl: 'https://118.196.78.91:8081/dsh-relay'
    token: '<relay 令牌；服务器 /etc/dsh-relay/token>'
    instanceId: 'home'        # 家里 home，公司 company（全局唯一）
    instanceName: '家里'
    indexMs: 10000            # 会话索引上报间隔
    maxSessions: 60
    maxMessages: 100
```

也可用环境变量覆盖：`DSH_RELAY_URL` / `DSH_RELAY_TOKEN` / `DSH_RELAY_INSTANCE_ID` / `DSH_RELAY_INSTANCE_NAME`。

## 使用

- 左列：在线主机（实例名）→ 其会话（标题 / 工作区 / 更新时间 / 运行中状态点），离线主机置灰
- 点击会话：右侧显示最近 100 条对话（user / assistant / 工具调用 / 执行失败），运行中每 2 秒刷新
- 底部输入框：Enter 发送，Shift+Enter 换行 → 转发给会话所属机器执行，结果自动刷新
- 顶部按钮：手动刷新对端索引；会话头部可取消运行中的 turn

## HTTP API（Client 半使用，插件私有，需 DSH 浏览器会话）

前缀 `/remote-session/api`，POST JSON：

| 端点 | 请求 | 响应 |
|---|---|---|
| `state` | `{}` | `{ok, relay:{connected,url,lastError}, self:{id,name}, peers:[{id,name,online,sessions:[{id,title,cwd,updatedAt,running,blank}]}]}` |
| `refresh` | `{}` | 同 `state`（强制刷新对端索引） |
| `transcript` | `{peerId, sessionId}` | `{ok, session:{id,title,cwd,updatedAt,running}, messages:[{role:'user'\|'assistant'\|'tool'\|'system',text,at,seq,tool?}], total, truncated}` |
| `send` | `{peerId, sessionId, text}` | `{ok, accepted:true}` |
| `cancel` | `{peerId, sessionId}` | `{ok}` |
| `models` | `{peerId}` | `{ok, catalog:{default, routableProviders, groups, failures}}` |
| `select-model` | `{peerId, sessionId, provider, model, reasoningEffort?}` | `{ok, result:{selected}}` |

`peerId = 'local'` 表示本机会话。

## relay 协议（v1）

- `POST /v1/register` `{id,name,token,sessions[],meta}` → `{ok, peers}`
- `GET /v1/stream?id=&token=`（SSE）→ `ready` / `peer` / `peer.index` / `message`
- `POST /v1/index` `{id,token,sessions[]}` → 广播给其他实例
- `POST /v1/publish` `{from,to,type,payload,id,token}` → 投递（离线 409）
- `POST /v1/peers`、`GET /health`

应用层 RPC：`{type:'rpc', payload:{method, params}}` → `{type:'rpc.result', payload:{ok, result|error}}`。
方法：`list` / `transcript` / `prompt` / `cancel` / `models` / `selectModel`。

## 运维

```bash
systemctl status dsh-relay
curl -s http://127.0.0.1:3098/health        # 服务器本机

# 轮换令牌（两端都要同步改 cordis.patch.yml 并重装/重启后生效）
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > /etc/dsh-relay/token && systemctl restart dsh-relay
```

## 回滚

```bash
<desktop-cli> plugin --profile desktop remove dsh-remote-session
# 重启 DSH 桌面应用
```

## 目录

```
dsh-remote-session/                    # 开发目录（research/ test/ 不分发）
├─ dist/dsh-remote-session/             # 家里分发包（已装在本机 desktop profile）
├─ dist/dsh-remote-session-company/     # 公司分发包（instanceId: company）
├─ lib/{index,session-bridge,client}.js
├─ package.json / cordis.patch.yml
├─ research/*.md                        # 调研笔记（插件机制 / 会话 API / 客户端 UI）
└─ test/                                # 双实例联调脚本（setup / run-a / run-b / verify / stop）
```

## 界面样式（v1.3，1:1 复刻官方）

「远程会话」面板不再自创样式，全部改读 DSH 官方设计平台变量（`--dsw-alias-*` / `--dsw-radius-*` / `--dsw-specific-*` / `--dsh-content-font-size*` / `--dsh-chat-content-width`），因此在浅色/深色主题下都与官方一致：

- **工作区列表**：主机行 34px、工作区行 34px（文件夹图标 + 折叠箭头 + 计数）、会话行 32px（16px 状态槽 + 标题 14px/20px + 右侧时间 10px）、圆角 `--dsw-radius-md`、悬停用 `--dsw-alias-interactive-bg-hover`、选中用 `-solid`
- **对话**：内容列宽 `--dsh-chat-content-width`(748px) 居中、正文 14px/24px、用户消息右对齐气泡（`--dsw-specific-bubble` + `--dsw-radius-lg`）、工具调用为 33px 行（底部 0.5px 分隔线 + 可展开等宽详情）、失败为官方样式错误行
- **输入区**：直接渲染 DSH Harness 官方 `InputBar`、`DraftEditorRuntime`、`ModelSelect`、`PermissionSelect` 与 `MenuView`；整块输入卡片、菜单、图标、键盘交互和主题样式均来自官方组件，远端适配层只连接会话数据与 RPC
- 左列宽度 264px、侧栏底色 `--dsw-specific-sidebar-fill`、分栏线 `--dsw-alias-border-l2` 0.5px

> 说明：官方左侧「工作区」列表是 `sidebar.workspaces` 这个 **single slot**，只属于官方工作区浏览器，没有"往列表里加行"的扩展点；因此远端会话仍在本插件自有面板内按「主机 → 工作区(cwd) → 会话」展示，只是样式 1:1 对齐官方。

### 工具调用行

同一回合里连续的多次工具调用会合并成**一行「运行 N 个工具」**（官方过程行观感），点击展开后每行显示：工具名 + 参数摘要，展开单行可看完整参数和结果/错误输出。这样不会再出现「调用工具 bash」+「bash 输出」成对重复的行。


### 整段会话流（v1.4）

对话区按官方 ChatView 的流程渲染，而不是简单消息列表：

- **按轮次分组**：用户消息开启新回合，回合之间 28px 间距、回合内 12px
- **用户消息**：右对齐气泡（官方 `--dsw-specific-bubble` + `--dsw-radius-lg`）
- **助手回复**：整列 Markdown（工具卡片/代码块由官方 MarkdownText 渲染）
- **思考行**：`思考 · <首行摘要>`，点击展开完整推理内容（来自 `assistant/message` 的 reasoning 内容块）
- **工具过程**：同一回合内连续工具调用合并成「运行 N 个工具」一行，点击展开每个工具（工具名 + 参数摘要 → 再点开看参数/结果/错误输出）
- **上下文注入行**：`Current runtime context…`、`Time sampled…`、`[model changed…` 等 harness 注入记录显示为小号 ⓘ 行，不再当成用户提问
- **失败行**：官方 turn error 观感（红点 + 红色标题 + 次要色详情 + 时间）
- **运行中状态**：末尾「● 运行中…」行
- 内容列宽、字号、间距、颜色全部取自官方设计变量

### 回合过程行（v1.5，照官方 TurnProcessNodeView 复刻）

会话流改为官方「回合」结构（源码对照：`packages/client/ui-chat/src/client/chat/TurnProcessNodeView.tsx/.module.css`、`message-chrome.ts` 的 `formatRunDuration`、`src/client/locale.ts`）：

- 每个回合：用户消息 → 「已完成，用时 X 分 Y 秒」行 → 助手 Markdown 回复
- 过程行样式与官方一致：33px 高、底部 0.5px `--dsw-alias-border-l2` 发丝线、`--dsw-alias-label-tertiary` 颜色、字号 14px、行高 24px、右侧 14px 箭头（展开时旋转 180°）、时长数字用等宽字体 + `tabular-nums`
- 文案照官方 locale：`已完成` / `已完成，用时 ` / `处理失败` / `已停止`；时长按官方 `formatRunDuration` 生成「X 小时 Y 分 Z 秒」分段
- 回合未结束时（运行中）**不显示过程行**——与官方一致（`turn.status !== 'closed'` 时过程行返回 null），思考/工具行直接展开显示
- 回合结束后默认折叠，点击过程行展开思考行与每次工具调用行（每条工具调用一行，参数摘要，点开看参数/结果/错误）
- 空白助手/用户消息不再渲染空行

### 工具活动行 / 消息动作（v1.6，照 DisclosureRow + GenericCommandCard + MessageIconActions）

- **工具活动行**（官方 `DisclosureRow` + `GenericCommandCard` 几何）：24px 行高、16px leading（14px 活动图标，悬停变 ›/展开变 ⌄）、工具名 13px/24、2px 圆点分隔、参数/结果摘要单行省略、右侧 10px 时间；错误行红色；点开正文为官方代码块样式（`width: calc(100% - 22px)`、`margin: 4px 0 0 22px`、`padding: 10px 16px 12px`、`border-radius: var(--dsw-radius-md)`、背景 `--dsw-alias-markdown-code-block`、`font: 400 11px/16px` 等宽字体）
- **消息动作行**（官方 `MessageIconActions`）：用户气泡下方、助手回复下方，28px 高，右侧时间（用户 13px / 助手 12px）+ 复制按钮，点击复制正文
- 每条工具调用单独一行（与官方活动列表一致，不再合并成「运行 N 个工具」）

### 全量复刻补充（v1.7）

- 活动图标换成官方图标语义的 SVG（read/readImage 书本、edit/write 铅笔、search 放大镜、commands/code 终端、webFetch 地球、subagents/plan/questions/tools/sparkle），leading 16px 盒内 14px，悬停换 chevron、展开换向上 chevron（DisclosureRow 行为）
- 思考行按官方 `ReasoningRow`：24px 行 + 16px leading + 「思考」+ 2px 圆点 + 摘要省略 + 时间，展开正文 `padding: 4px 0 4px 22px`、13px/20px tertiary
- 运行中的过程组头按官方 `ChatGroupSeat`：活动图标 + chevron（展开时上、悬停时下）+ 官方 locale 文案（正在读取文件/正在运行命令/正在编辑文件…）+ ` · 详情`；点击折叠活动列表
- 回合结束后展开时多一层官方 `processTitle` 摘要头（`已读取文件、修改了文件、执行了命令…`，超过 3 类加「等」），下面才是逐条活动行

### Markdown 渲染（v1.8）

官方 shell 的 `MarkdownText` 在插件上下文里渲染会抛错（缺官方 conversation context），之前回退成纯文本，所以表格/代码块显示成原始字符。现在内置渲染器用官方 token 阶梯渲染：标题（20/17/15）、段落 16px 块距、**粗体**、*斜体*、`行内代码`（官方 inline-code 底 + radius）、围栏代码块（`--dsw-alias-markdown-code-block`、`--dsw-radius-lg`、12/20 等宽）、表格（border-l2 细线 + header 底）、有序/无序/任务列表、引用块、链接、分割线。用户消息仍按纯文本气泡显示（与官方一致）。

### Vendor 官方会话流（v2.0 起步）

- `vendor/.src`：稀疏 clone 的官方源码（ui-primitives / ui-chat / ui-conversation / ui-renderer / ui-session / web / api / util）
- `tools/build-vendor-chat.mjs`：esbuild 打包官方 `ChatView` 组件树（含官方 Markdown、micromark/katex/shiki 垫片、CSS Modules 编译、React extern），产物 `vendor/dist/ui-chat.cjs`（约 1.3MB）
- `tools/vendor-chat-smoke.mjs`：bundle 求值 + 导出校验（PASS）
- Host 新增 `GET /remote-session/api/vendor-chat` 下发该 bundle；Client 新增 `loadVendorChat()` 在插件运行时求值（共享同一 React）
- 下一步：给官方 shell 做 relay 传输垫片（SessionBinding / connection），让 ChatView 真正挂载

### 官方折叠引擎接入（v2.1）

- 远端会话的「回合/step/思考/工具调用/用时」现在优先由 **官方 Conversation 源码**（`ui-conversation` assembler + `ui-chat` 全部 conversation-node 定义）折叠：客户端拉取 `events`（原始 SessionEvent 流）→ 官方 assembler → 投影为面板行；失败自动回退到原桥接投影
- Host 下发两个 vendor bundle：`/remote-session/api/vendor-chat`（官方 ChatView）与 `/remote-session/api/vendor-assembler`（官方折叠器）

### 官方 ChatFlow 渲染（v2.2）

- 远端会话面板现在优先渲染 **官方 ChatFlow**（vendor 自官方源码，含官方 UserMessage/Assistant/TurnProcess/TurnTail/Command/Context 渲染器与 ui-tool 的 ToolCallTree）
- 数据来自官方 Conversation assembler 折叠后的 ChatSnapshot；槽位（turn-tail 动作、图片、文件打开等）用垫片降级
- 渲染失败自动回退到内置手绘渲染器，面板不会白屏

## 连接设置（无需改配置文件）

面板顶部 **设置** 按钮可配置本机连接：

- **Relay 地址**：中转服务地址，例如 `http://127.0.0.1:3098`
- **访问令牌**：relay 的 token；已配置时留空表示保持不变
- **实例 ID / 实例名称**：本机在其它设备列表中的标识与显示名

保存后立即热重连 relay，并写入 `~/.dsh/remote-session-settings.json` 持久化（下次启动优先读取该文件；插件 `cordis.patch.yml` / 环境变量仍作为初始默认值）。公司电脑只需安装 zip、重启 DSH，打开面板点「设置」填地址与令牌即可，不用手改配置文件。

## 官方组件渲染（v3.0 现状）

远端会话面板的会话流现在由 **官方源码 vendor 树** 渲染：

- 数据：`/remote-session/api/events`（原始 SessionEvent 流）→ 官方 `ui-conversation` assembler + `ui-chat` conversation-node 定义折叠 → 官方 `ChatSnapshot`
- 渲染：官方 `ChatFlow` + 官方节点渲染器（用户气泡 / 助手 Markdown / 思考行 / 工具行 `ToolCallTree` / TurnProcess / TurnTail / Command / Context / SystemPrompt）
- 样式：官方主题样式表（design-platform / shiki / scrollbar 等）+ 官方 CSS Modules（构建时编译注入）+ 官方图标 sprite
- 代码高亮：真实 shiki v4（core + JS 引擎 + ts/bash/json 语法包），主题走 `--shiki-*` token
- 失败自动降级：`vendor-flow` 加载或渲染失败时回退内置渲染器，并在面板顶部提示原因
- 回归：`research/browser/build.mjs` + `run.mjs`（playwright-core 真实 Chromium 截图与断言）

### 官方完整输入区（v3.1）

输入卡片及弹出菜单使用 [DeepSeek Harness 官方源码](https://github.com/deepseek-ai/deepseek-harness)，上游组件文件保持原样：

- 编辑器、加号菜单、指令与文件引用：`InputBar` + `DraftEditorRuntime` + `MenuView`
- 模型、提供方搜索与推理等级：`ModelSelect`
- 权限预设与完全权限确认：`PermissionSelect`
- 发送、停止、Enter 引导与 Ctrl+Enter 排队：官方输入区按钮及键盘处理

`tools/remote-composer.tsx` 负责把官方 store / slot 接口接到远端 RPC。文件引用支持远端路径检索；远端协议尚未提供附件上传接口，因此上传入口禁用。切换失败保留原模型或权限，发送失败保留草稿；历史轮询读取最新 `model/selection` 和 `permission/preset` 事件。

专项回归：`node research/browser/composer.mjs`，覆盖菜单、键盘、输入法、失败恢复、深色主题及窄屏布局。
