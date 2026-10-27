# 桌面 App 与 Web/手机网关的集成可行性（task-3）

> 调研日期：2026-10-27。范围：8 个 DSH 桌面壳（其中 5 个必选）+ 4 个 Web/手机远程方案 + 1 个补充方案 + 1 个本机对照实现。
> 方法：`gh api` 取元数据/README，`git clone --depth 1 --filter=blob:none` 浅克隆后只读分析 DSH 集成/插件加载/web server/代理代码；**未 `npm install`、未构建、未改本仓库源码、未 commit**。
> 仓库落盘：桌面 App 在 `research/apps/repos-desktop/<owner>__<repo>/`，Web 方案在 `research/apps/repos-web/<owner>__<repo>/`。行号均以克隆到的 HEAD 为准，引用格式 `仓库相对路径:行号`。

## 0. 结论速览

| 对象 | 类型 | 内嵌 DSH 内核 | 官方 Web UI / `__DSH_BOOT__` | 第三方插件安装 | 已有远程/多机 | 装本插件可用性 |
|---|---|---|---|---|---|---|
| dataelement/dsh-desktop | Electron | 固定 `0.2.1-rc.2`（随包） | 是（官方 web profile） | `dsh plugin --profile web` / 插件市场 | 手机桥（自绘移动页 + CF/Pinggy 隧道），非官方 UI | **高** |
| anywhere-labs/dsh-desktop | Electron（桌面本身是插件） | 固定 `0.2.1-rc.3` + 上游 submodule | 是（compatibility 模式原样上游客户端） | `dsh plugin --profile desktop` / dshmarket | Agents Anywhere bridge / 官方 remotes | **高**（仅 compatibility；extended/advanced 中/低） |
| dsh-tauri/deepseek-harness-desktop | Tauri | 固定 `0.2.1-rc.2`（可换内核） | 是（`dsh web` + 打包前端 + preload） | 本地路径/npm/github/社区市场 | dsh-tauri-remote（SSH 远端 + 局域网/CF 分享）、原生手机 App | **高** |
| ningbainb/deepseek-harness-desktop | Electron | 固定 `0.2.1-rc.2` | 是（`dsh-runtime://app` 自定义协议转发） | 插件中心（npm/git/local） | 自带 SSH、手机远程、remote-web-ui | **中**（自定义协议 + 自定义 transport 需实测） |
| whitelonng/dshcode | Electron（DSH 源码 fork） | `0.1.2-alpha.4`（源码整体内置） | 是（但内核过旧） | 插件管理（npm/git） | 无远程 | **低**（版本门槛不满足） |
| vibeinging/dsh-desktop | Electron | `0.1.5-rc.1`（随包） | 是（官方 Web + 社区 bundles） | 插件市场 / Profile Bundles | 默认内置 ds-harness-remote 0.4.1 | **低**（内核低于 `>=0.2.1-rc.2`） |
| chokwinlee/deepseek-harness-desktop | Tauri | `0.1.5-rc.2`（随包） | 是 | npm/github/local 安装 | 原生 iOS/Android Remote（LAN/Tailscale） | **低**（内核低 + 原生客户端协议） |
| RongleCat/deepseek-app | Electron | `0.1.0-rc.6` | **否**（自绘 renderer，`window.desktop.*`） | Host 插件卡片/Cordis 控制台 | 无 | **不可行** |
| shaobeichen/dsh-pocket | DSH 插件 + 同源反代 | 取决于宿主机 | 是（整页透传，含 `__DSH_BOOT__`） | 与本插件同为 profile 插件 | 局域网 + cloudflared 隧道 | **高** |
| summer1238/dsh-remote-web-gateway | DSH 插件 + 反代 | 宿主机 | 是（整页透传） | 同上 | CF Quick Tunnel + 配对/JWT/GitHub | **中高** |
| wenbin-wb/dsh-bridge | DSH 插件 + 反代 | 宿主机 | 是（整页透传 + polyfill） | 同上 | LAN/CF/自建隧道/PWA/IM Bot | **中高** |
| april-jk/dsh-mobile-suite | DSH 插件 + E2EE Relay + App | 宿主机 | 是（App 内 WebView 打开官方 UI，本地回环网关） | 同上 | 出站 WSS Relay，手机 App | **高潜力**（未真机验证） |
| liguobao/ds-harness-remote | DSH 插件 + P2P 客户端 | 宿主机 | 否（Typert allowlist 客户端，含 Android 原生 UI） | 同上 | P2P/WebRTC/Relay/Android/VS Code | **不适用** |

排序（桌面）：**dataelement ≈ dsh-tauri ≈ anywhere-labs(compatibility) > ningbainb > vibeinging ≈ chokwinlee > whitelonng > RongleCat**。
排序（手机零改码）：**dsh-pocket > dsh-bridge ≈ summer1238 > dsh-mobile-suite（待真机）> ds-harness-remote（架构不匹配）**。

## 1. 判定基线：本插件对运行环境的硬性要求

先固化“能装进去并工作”的判据，后面的每个结论都对照这张清单（证据均在本仓库）：

### 1.1 Host 半（`lib/index.js`）

1. **DSH 版本门槛**：`package.json:36` `"dsh": { "engines": { "dsh": ">=0.2.1-rc.2" } }`，`dsh plugin add` 会据此拦截。
2. **必须存在的 Host 服务**：`lib/index.js:33` `inject = ['webServer','sessionController','agents','connection','typertGateway','clientModules']`。缺一个就整棵插件树加载失败；`typertGateway` 是 0.2.x 才稳定的服务。
3. **必须有官方 web server 的 index 注入钩子**：`lib/index.js:255-257` 监听 `webserver/index-inject`，把 `installNativeTransport` 序列化成 `<head>` 内联脚本；桌面壳若把页面包在自己的 HTML 里、或换掉 web server，则脚本不执行。
4. **必须能注册前缀 HTTP 路由**：`lib/index.js:1545-1549` `ctx.webServer.register({ kind:'prefix', path:'/remote-session/api' })`；`handleApi`（`lib/index.js:1290-1538`）提供 state/settings/transcript/send/fork/events/native 等约 30 个端点。
5. **插件机制**：`cordis.patch.yml:16-25` 一条 `insert` 行 + `package.json:33-45` `dsh.bundle.patch` / `dsh.client.platform="web"` / `immediately:true`；必须能通过 profile bundle 安装并被 clientModules 发现。

### 1.2 Client 半（`lib/client.js` + `lib/native-transport.js`）

6. **官方 client 模块图协议**：`native-transport.js:64-92` 读取并改写 `__DSH_BOOT__ = { entries, batches }`，按远端机器 `clientEntries` 过滤；`native-transport.js:84-86` 还硬性要求过滤后仍含 `dsh-remote-session`、`@deepseek-ai/dsh-client-ui-workspace`、`@deepseek-ai/dsh-api-session-controller`。=> 页面必须由宿主自己的 DSH web server 渲染，且 client bundle 图能被改写。
7. **`__DSH_TRANSPORT__` 可写**：`native-transport.js:225-226` 先 `{...win.__DSH_TRANSPORT__}` 再覆盖 `ownsHost:false`、`fetch`、`openStream`；`native-transport.js:229` 还替换 `window.fetch`。=> 桌面壳提供的 shell transport 会被“继承+覆盖”，顺序必须晚于页面自己的 transport 定义。
8. **同源相对 API**：`client.js:45` `fetch(new URL('remote-session/api/'+method, document.baseURI))`；`native-transport.js:8,137-142` 同样以 `document.baseURI` 为基准，只接管 `api/` 前缀。=> 反代必须保持路径不变、页面 origin 必须能到达宿主 web server。
9. **浏览器存储**：`native-transport.js:10` 用 `sessionStorage` 存机器选择（`dsh.remote-session.machine.v1`），`native-transport.js:106-135` 用 Proxy 重定义 `localStorage` 做按机器命名空间隔离；`defineProperty` 失败会直接抛错终止远程 boot。
10. **`crypto.randomUUID`**：`native-transport.js:6,143,169` 启动即调用；`AbortSignal.timeout`（`:62`）用于 probe 超时。=> 非安全上下文（http://局域网 IP）或老 WebView 会缺 API。
11. **桌面壳识别（仅 UI 文案）**：`client.js:116` `typeof window.dshDesktopBoot?.ready === 'function' ? '客户端' : 'Web 端'`，不影响功能。
12. **机器切换 = 存 sessionStorage + 整页 reload**：`native-transport.js:32-47` `switchMachine()` 探测远端协议版本后 `win.location.reload()`；切换后页面从“本地图”过滤成“远端图”。=> 反代必须支持整页重载（含 launch-token cookie 握手）与二次请求。

### 1.3 由此得到的三条否决线

- **否决线 A（版本）**：内核 < `0.2.1-rc.2` 或没有 `typertGateway` → 装不上/加载失败。
- **否决线 B（界面形态）**：自绘 renderer / 非官方 DSH web 页面 → 没有 `__DSH_BOOT__` 可过滤，client 半不运行。
- **否决线 C（HTML 与路由控制权）**：页面 HTML 不经官方 `webserver/index-inject`、`/remote-session/api/*` 到不了 Host → native transport 注入或 API 失效。

## 2. 桌面 App 逐个分析

### 2.1 dataelement/dsh-desktop（17k★，Electron）—— 兼容性：高

- **内嵌方式/版本**：Electron 主进程拉起“随包”的 Harness 子进程，`package.json` 依赖固定 `@deepseek-ai/dsh@0.2.1-rc.2`（整棵官方包闭包）；入口 `src/main/index.ts:559` 定位 `bundledRuntimeRoot()/node_modules/@deepseek-ai/dsh/lib/bin.js`，`src/main/runtime/harness-runtime.ts:242-259` 解析 `dsh web:` 就绪行并以 `web` profile 启动（`buildHarnessArguments` 在 `:393-399`）。不依赖系统 Node/系统 dsh。
- **官方 Web UI**：`docs/architecture.md:3` 明确定位“Electron host for the existing DeepSeek Harness runtime and Web UI”；`:24-33` 启动流程“poll 健康后 load 进主窗口”；主窗口加载 `http://127.0.0.1:<随机端口>` 官方页面（沙箱 renderer，`:56-68`）。=> `__DSH_BOOT__` / `__DSH_TRANSPORT__` 官方协议完整。
- **第三方插件**：`profiles/web` 即官方 profile；`src/main/runtime/profile-plugin-command.ts:105` 用 `dsh plugin --profile web install --no-frozen-lockfile` 修复/安装；`docs/architecture.md:78-86` 有 plugin manager / Safe Mode / 兼容性恢复。配套 `patches/` 是对 `dsh-client-modules` 等官方包的 patch-package（`docs/architecture.md:86,111`），属“解析锚点/缓存”级，不动 index 注入与 client graph 协议。
- **远程能力**：自带“手机控制”，但移动端是**自绘轻量页**（`src/main/mobile/lan-mobile-pages.ts`，内联 CSS/JS 直接 `fetch('/api/status')`），不是官方 Web UI；隧道 `cloudflared-tunnel.ts` / `pinggy-tunnel.ts`，配对 PIN（`docs/architecture.md:90-101`）。与本插件“官方 UI 多机切换”不冲突，但也不是其替代。
- **装本插件结论**：**高**。唯一需要实测的是它 `patches/` 对 `dsh-client-modules` 的改动是否改变 `webserver/index-inject` 的注入位置/顺序（`:86` 说明只针对 Safe Mode 解析锚点）；以及 Electron 主窗口会加载 `dsh-desktop-client-ui` 等自有 client 插件，但官方 `sidebar.footer.action` 槽位仍存在（compatibility 模式不动 layout）。

### 2.2 anywhere-labs/dsh-desktop（33k★，Electron，桌面本身是 DSH 插件）—— 兼容性：高（compatibility）/ 中低（extended、advanced）

- **形态**：Electron 只是 launcher，真正的桌面壳是 Host/Client 双面 Cordis 插件 `dsh-plugin-desktop@2.0.18`；`dsh-plugin-desktop/package.json:168` 固定 `@deepseek-ai/dsh@0.2.1-rc.3`，仓库还带 `vendor/dsh-runtime/0.2.1-rc.3/*.tgz` 与上游 `deepseek-harness/` submodule（README.zh.md:279 的 0.1.7-rc.1 说法已过时，以锁文件为准）。
- **官方 Web UI**：`dsh-plugin-desktop/README.zh.md:11` “三种呈现模式都复用现有 Web carrier，profile 挂普通 `dsh-base` + `dsh-web-app`，Host 把 HTTP/WS 绑到 127.0.0.1 临时端口，Electron 从 loopback 同源页面加载”；`:57` compatibility 模式“原样保留官方 row，不替换 layout/sidebar/conversation”。`docs/plugin-services.zh.md:111` 进一步写明“compatibility 模式原样运行上游客户端并保留上游 frame”。
- **关键风险**：`docs/plugin-services.zh.md:100` “extended 与 advanced 模式用 Desktop 自有 root 替换上游 Web frame，因此 `@deepseek-ai/dsh-client-ui-layout` **不在** client boot 图中”。本插件 client 半注册在 `sidebar.footer.action` / `sidebar.panellist`（`lib/client.js:543-549`），并硬性要求 `ui-workspace`/`api-session-controller` 条目（`native-transport.js:84`）——extended/advanced 下可能可加载但 UI 无处挂载/被过滤掉。=> 建议只支持 compatibility（默认值）。
- **第三方插件**：官方 profile 机制，`README.zh.md:125-138` 直接给出 `dsh plugin --profile desktop add third-party-plugin`，并提供 `desktopPnpm` / `desktopProfiles` 服务（`docs/plugin-services.zh.md:200-207`）。`dsh-plugin-desktop:113-123` 声明自己的 `dsh.client`（platform web）。
- **远程能力**：仓库 `resolutions` 引入 `@agents-anywhere/dsh-bridge-next-2.1.0-desktop`（`package.json:18`），依赖含 `@deepseek-ai/dsh-api-remote-access` / `dsh-api-remotes`（`dsh-plugin-desktop/package.json:178-179`）；属于官方/AA 远程访问链路，非本插件形态。
- **结论**：**compatibility 模式下高**：官方 `dsh web` 页面、官方 profile、官方 index 注入、`__DSH_BOOT__` 图都在。若用户切到 extended/advanced（自定义标题栏+root layout），本插件 UI 与 boot 过滤都会遇到问题，需在文档里写死“仅 compatibility”。另一个待测点：`dsh-plugin-desktop` 自带 client 条目会出现在 boot graph 里，远端机器过滤时会被剔除（正常行为），但会改变“本地首屏 vs 远端首屏”的 graph 差异。

### 2.3 dsh-tauri/deepseek-harness-desktop（3.3k★，Tauri）—— 兼容性：高

- **内嵌方式/版本**：Tauri 2 + WebView2/WKWebView；SRE 层托管 node 内核（`src-tauri/src/config/dependencies.rs:299` `node_modules/@deepseek-ai/dsh/lib/bin.js`；`:366` `managedRoot` 可换内核），以 `dsh web --profile web --port <n> --no-open` 启动（`src-tauri/src/service/workflow/launch.rs:129` 与 process.rs 里大量同形命令）。README:142-145：推荐内核 `0.2.1-rc.2`，最低 `0.1.7-rc.1`。
- **官方 Web UI**：主页面是 `dsh web` 的 127.0.0.1 HTTP 页面（`config/constants.rs:53` `DSH_HOST=http://127.0.0.1`）；`desktop/frontend_preload.rs:38-46,104-115` 从随包 `@deepseek-ai/dsh-web-frontend` 读取前端静态资源并注入 preload；`desktop/frontend_preload.rs:11-15` 只允许 `http://127.0.0.1:*` 页面注入。`src-tauri/src/service/workflow/utils.rs:52-58` 还从页面 HTML 里解析 `__DSH_BOOT__` 提取 bundle 地址做补丁——说明它深度绑定官方 boot 协议。
- **第三方插件**：README:50 “12 个内置插件；支持本地路径安装、内置插件停用、社区插件安装、升级、卸载”；`src-tauri/src/bridge/plugin.rs:53-60` `install_plugin_specs`，`bridge/lifecycle.rs:104` 注释“Windows 空白环境必须有 Git 才能安装 github:/git+ssh: 插件”。=> 支持 `file:` / npm / github 三种来源。
- **远程能力**：`packages/dsh-tauri-remote`（README:71）“SSH 远端 Harness 连接与同步，并把本机 Harness 分享到局域网或公网隧道”；另有官方手机 App（README:123-132）。这些是“另一套远程 UI/客户端”，与本插件只存在 UI 竞争，不互斥。
- **结论**：**高**。风险点：它的前端 preload 会先占位 `__DSH_TRANSPORT__` 类全局（`frontend_preload.rs`），本插件脚本必须晚于它执行（官方 index 注入在 head 后段，通常满足）；需要实测“本插件 head 注入 + Tauri preload”叠加后 `__DSH_BOOT__` 过滤与 `/remote-session/api/*` 的 fetch 是否都能到 `dsh web`。另注意它提供“换内核”，用户升到高于本插件验证范围时以官方 engines 为准。

### 2.4 ningbainb/deepseek-harness-desktop（870★，Electron）—— 兼容性：中

- **内嵌方式/版本**：仓库是 `dsh-web-ui` 聚合仓（皮肤/插件集合，root `package.json` 为 `dsh-web-ui@5.1.0`），桌面在 `apps/dsh-desktop`（`@linxin666/dsh-desktop@5.1.0`，`main: src/main.mjs`）。README:47 说明使用官方 NPM Runtime `0.2.1-rc.2` + Electron 44；`pnpm-lock.yaml:3115` 可佐证 `@deepseek-ai/dsh-client-modules@0.2.1-rc.2`；另用公开 `@linxin666/dsh-web-all@0.4.4` 载体做桌面适配（README:87）。
- **官方 Web UI（但换了 origin）**：窗口加载的是自定义协议 `dsh-runtime://app/`（`apps/dsh-desktop/src/runtime-electron-transport.mjs:17-31,42-88`：注册 privileged scheme，`protocol.handle` 把**任意 path** 转发给 runtime provider 的 `fetch(new URL(path,'http://dsh.internal'))`）；`runtime-launcher.mjs:106-108` 把 `/api`、`/plugins` 路由到 `ctx.webServer` / `ctx.clientModules`。`runtime-renderer-bootstrap.mjs:167-175` 在 renderer 注入 `Object.freeze({ ownsHost:true, fetch, openStream })` 作为 `__DSH_TRANSPORT__`。
- **对插件的直接影响**：(a) `document.baseURI` 是 `dsh-runtime://app/`，本插件 `client.js:45` 会生成 `dsh-runtime://app/remote-session/api/*`，经 `fetch` 走自定义协议 → 只要 `protocol.handle` 把该 path 转发给 DSH web server，API 就能通；从代码看它转发任意 path（`runtime-electron-transport.mjs:33-40`），**但仍需实测**。(b) `__DSH_TRANSPORT__` 是 frozen 对象，本插件是“展开后整体重新赋值”（`native-transport.js:225`），赋值不会被冻结阻止，但 `Object.freeze` 语义 + Setter 是否存在需实测。(c) `window.fetch` 已被 Electron/自定义协议接管，本插件 `native-transport.js:229` 会再次覆盖，只接管 `api/` 前缀、其余回落 `fetchLocal`，与它的 remap 逻辑（`runtime-renderer-bootstrap.mjs:158-165`）叠加顺序敏感。
- **第三方插件**：有插件中心/插件市场（`apps/dsh-desktop/src/extensions/plugins.mjs`、`extension-ipc.mjs:214+`），支持 npm/git/https/local（`external-plugin-source.mjs:238-259,322-378`），并提供兼容性检查与恢复；`profile.mjs:89,92` 还预置 `@linxin666/dsh-remote-web-ui`、`@linxin666/dsh-ssh`（自带 SSH/手机远程，README:290,304）。
- **结论**：**中**。宿主内核版本与官方 UI 都对，但“自定义协议 origin + 自定义 transport + 自有 web UI 聚合层”三处都可能与 native transport 的“同源相对 fetch / transport 覆盖 / boot 图过滤”打架；需要一次真机 smoke（切远端机器 + 刷新 + 看 `/remote-session/api/native` 请求）才能定级。

### 2.5 whitelonng/dshcode（700★，Electron；DSH 源码整包 fork）—— 兼容性：低

- **内嵌方式/版本**：仓库根就是官方 DSH 单仓 fork，`package.json` name `@deepseek-ai/dsh-root`、version `0.1.2-alpha.4`（`packages/**/package.json:4` 全部 `0.1.2-alpha.4`），另加 `apps/desktop`（`@dshcode/desktop@1.1.0`，Electron shell）与 `apps/web`、`apps/cli`。桌面 shell 直接跑内置 DSH web（README 自述“把 Web UI 与插件运行时打包成 Electron 应用”）。最后 push 2026-09-13，内核停在上古版本。
- **官方 Web UI**：是（内置 `@deepseek-ai/dsh-client-modules` / `dsh-web-app` workspace 依赖），但 **0.1.2-alpha.4 没有 `typertGateway` 这个 0.2.x 服务**，本插件 `inject` 第 5 项直接失败；`package.json:36` 的 `dsh.engines.dsh>=0.2.1-rc.2` 也会在安装时拦截。
- **插件/远程**：具备插件管理（npm/Git 安装、禁用、安全模式，README 功能节），无远程多机。
- **结论**：**低**。除非本插件单独维护一个 0.1.x 兼容分支，否则不可用；即使强行忽略 engines，`clientModules`/`typertGateway`/`webServer.register` 协议差异也会导致加载失败。

### 2.6 vibeinging/dsh-desktop（485★，Electron）—— 兼容性：低

- **内嵌方式/版本**：官方 DSH npm 运行时 + 官方 `dsh-web-app`，随包固定（README:24）；徽章标注 DSH `0.1.5-rc.1`（README:16），`server/package-lock.json:1964-1966` 可佐证 `dsh-client-modules@0.1.5-rc.1`。
- **官方 Web UI**：是。`electron/main.js:584` 注释“DSH modules injects the reviewed `window.__DSH_BOOT__` graph as one inline…”，`:1387/:1506` 健康检查用 `document.querySelector('#root') && globalThis.__DSH_BOOT__`，`:1458/:1614` `mainWindow.loadURL(surfaceUrl)`；`:778` 在 `server/` 目录 spawn 本地 server。
- **插件/远程**：Profile Bundles + 官方设置页插件市场（README:56-57,94-98）；默认内置 `ds-harness-remote@0.4.1` 做手机远程（README:106-113）。
- **结论**：**低**。形态完全匹配（官方 UI + 官方 boot 图 + profile），但内核 0.1.5 低于本插件门槛；`typertGateway` 缺失风险高。若作者升级内核，可升为“高”。

### 2.7 chokwinlee/deepseek-harness-desktop（284★，Tauri）—— 兼容性：低

- **内嵌方式/版本**：Tauri + 系统 WKWebView，随包完整 Harness 运行时（README:28,40）；`src/harness-supervisor.ts:73-75` spawn `node <script> web --host 127.0.0.1 --port 0 --no-open`；对齐 `@deepseek-ai/dsh@0.1.5-rc.2`（README:28,41）。
- **官方 Web UI**：是（README:28 “runs the official DSH Web UI and runtime in a desktop window”），但同样受 0.1.5 内核限制。
- **插件/远程**：插件安装支持 npm 包 / `github:owner/repo` / GitHub HTTPS / 完整 `dsh plugin --profile web add` 命令，且有失败回滚（README:151-159）。远程是**原生 iOS SwiftUI + Android Kotlin** 客户端（LAN/Tailscale，README:43,71-72,113），不是浏览器里的官方 UI。
- **结论**：**低**。版本门槛不满足；其远程半边与本插件目标用户重叠但架构不同（原生客户端协议），无法复用。

### 2.8 RongleCat/deepseek-app（34★，Electron）—— 兼容性：不可行

- **形态**：自绘工作台（Grok App 视觉），主进程里跑官方 `dsh-base`/`dsh-web-app` **bundle** 作为 engine host（`src/main/dsh-host.ts:59` 注释“dependencies 直接含 dsh-base/dsh-web-app bundle”），但 renderer 是自研 React：`src/main/index.ts:157` `win.loadURL(process.env.ELECTRON_RENDERER_URL)`；README:41 明确“not an iframe around `dsh web`”；README:73 “renderer never talks to `/api` directly. It only uses `window.desktop.*`”。
- **官方 Web UI**：**否**。没有官方 `__DSH_BOOT__` 图、没有 `__DSH_TRANSPORT__`，本插件 client 半（`window.__ModuleLoader__.load`）根本没有加载入口；Host 半即使装上，页面也不会出现任何 UI。
- **结论**：**不可行**（除非该 App 增加“加载官方 web 页面”的模式）。列在报告里是为了说明“官方 UI 是硬前提”。

### 2.9 桌面 App 落地建议

1. **首选 dataelement/dsh-desktop 或 dsh-tauri**：二者都是“固定 0.2.1-rc.2 + 官方 web profile + `dsh plugin` 安装”，与本插件验证基线完全一致；装法就是 `dsh plugin --profile web add <本插件路径>` 后重启。
2. **anywhere-labs** 必须写明“只在 `dsh-desktop.mode: compatibility` 下验证”，并且注意远端机器 boot 图会剔除 desktop 自有 client 条目（正常）。
3. **ningbainb** 作为“中”案例，给一次性 smoke 清单：安装 → 看 boot graph 是否含 `dsh-remote-session` → 手机/另一窗口选远端机器 → 观察 `/remote-session/api/native` 是 200 还是 404（自定义协议是否转发了非 `/api` 前缀）。
4. 其余（whitelonng/vibeinging/chokwinlee）只建议“升级内核后再试”；RongleCat 不建议。

## 3. Web/手机网关方案

### 3.1 判定要点（对本插件前端零改码意味着什么）

1. **同源整页透传**：手机浏览器拿到的必须是宿主 `dsh web` 的 HTML（含 `__DSH_BOOT__`、`__DSH_MODULE_LOADER__`、`/plugins/...` 与 `/remote-session/api/*`），路径不能加前缀（本插件用 `document.baseURI` 相对路径，`client.js:45`）。
2. **Host/Origin/Referer 重写 + DSH 私有 cookie 注入**：DSH 的 `/api` 有 loopback 信任栅栏，远程页面必须伪装成回环请求；否则 `/remote-session/api/*` 也会被 `connection.requestRejection` 拦成 403（本插件 `lib/index.js:1279-1294`）。
3. **DSH launch-token→cookie 握手**：新版 `dsh web` 要求先 `GET /?token=` 换 cookie，再放行 `/api` 与 WebSocket；反代必须替手机完成这一步（或把手机 303 到带 token 的 URL）。
4. **HTTP + SSE + WebSocket 全透传**：官方 UI 的会话流走 WebSocket（`/api/events.mux`、`events.host`），插件/终端等功能走 SSE；任何缓冲/剥离 hop-by-hop 头都可能让“实时”变“卡住”。
5. **客户端 polyfill**：非安全上下文（http://局域网IP）缺 `crypto.randomUUID`；老 Android WebView 还缺 `AbortSignal.any`；本插件还用到 `AbortSignal.timeout`（`native-transport.js:62`）。本插件 native transport 一启动就 `win.crypto.randomUUID()`（`:6`），失败即整页脚本抛错。
6. **移动端 UI**：官方 UI 窄屏变成抽屉；本插件机器切换入口在 `sidebar.footer.action`（`lib/client.js:543-547`），机器菜单元数据宽 288px（`client.js:220`），切机器=整页 reload（`native-transport.js:45-47`）。
7. **鉴权模型**：至少要有 PIN/配对态、限速、cookie/session 绑定；否则等于把“可执行代码的 DSH”裸奔到公网。

### 3.2 对照组：本机 `dsh-vps-remote`（完整透传的“黄金样本”）

本机已有（不在 GitHub）`C:\Users\32891\Documents\deepseek-harness\default-workspace\dsh-vps-remote`，其拓扑是 `nginx(HTTPS) → ssh -R → gate(127.0.0.1:17864) → dsh web(127.0.0.1:<随机>)`：

- `README.md:26-31`：HTTP/SSE/WebSocket（`/api/remote.mux`）全代理，Host/Origin 重写为 loopback authority，注入私有 DSH cookie；“The index gets `globalThis.__DSH_TRANSPORT__={ownsHost:true}` so the official client runs with full (not read-only) settings.”
- `lib/gate.js:42` 即该 pin：`TRANSPORT_PIN = '<script>globalThis.__DSH_TRANSPORT__={ownsHost:true};</script>'`；`:729-733` 把它插到 `<head>` 之后；`:599-671` 代理逻辑（删 hop-by-hop、X-Forwarded-*、重写 Host/Origin/Referer、注入 cookie、index 特殊处理）；`:681-706` WebSocket upgrade 透传。
- 它证明了“**同源整页透传 + transport pin**”这条路可以让官方 UI 在手机浏览器里完整工作；本插件的 `/remote-session/api/*` 是同一 `dsh web` 上的前缀路由，因此**理论上同样透传**；机器切换触发的整页 reload 也就是“再走一次 gate 握手”。
- 与 pocket 的差异：gate 的 pin 只给 `ownsHost:true`（本插件脚本会覆盖成 `ownsHost:false` 并补 `fetch/openStream`），没有 pocket 那种 setter shim，因而**没有 ownsHost 冲突**；代价是 gate 自己不做 polyfill（它假设 HTTPS + 现代浏览器），老 WebView 上本插件的 `crypto.randomUUID`/`AbortSignal.timeout` 仍是风险。

### 3.3 shaobeichen/dsh-pocket（2.4k★，DSH 插件 + 本机反代 + cloudflared）—— 兼容性：高

- **机制**：插件装在宿主 profile 里（`package.json:99-126` `dsh.bundle.patch` + `dsh.client`；`lib/index.js:27` `inject=['connection','webServer']`），用 `ctx.webServer.port` 取真实端口（`lib/index.js:260`），在本机起 `0.0.0.0:<3081>` 反向代理转发到 `127.0.0.1:3080`（`lib/service.mjs:280-283`；`lib/proxy.mjs:19`），公网入口用 cloudflared quick/named tunnel（`lib/tunnel.mjs`）。手机扫码拿到的是 `http://<LAN-IP>:3081` 或 `https://<随机>.trycloudflare.com`。
- **完整透传**：普通 HTTP 与 WebSocket upgrade 都“原样透传”（`lib/proxy.mjs:1-12`、`:1095-1196`），SSE 在压缩分支被显式跳过（`:1045-1055`）；Host/Origin/Referer/sec-fetch-site 全改写成 loopback（`:536-551`、`policyHost` `:364-377`）；还代手机完成 DSH launch-token 握手（`:560-610`）并给 Safari 做 303→200 过渡页（`:671-700`）。
- **对插件友好的地方**：`lib/proxy.mjs:30-31` 注入 `crypto.randomUUID` 与 `AbortSignal.any` polyfill（非安全上下文必需）；`:75` 注入 `TRANSPORT_API_CLIENT_SHIM`：给 `__DSH_TRANSPORT__` 补 `createApiClient` 并**强制 `ownsHost=true`**；`:1024` 把注入插到 `<head>` 之后，`:1016-1043` 只对未压缩 HTML 注入（SSE/WS/JS/CSS 不动）。
- **鉴权**：PIN（公网/局域网各自 8 位，可自定义）、HttpOnly+持久 cookie（sha256(PIN:sessionKey)）、IP 限速/全局锁（`lib/proxy.mjs:124-193`）、fail-closed 公网判定（README:121）。安全设计成熟。
- **卡点**：① 其 transport shim 是 getter/setter 包装，**本插件把 `__DSH_TRANSPORT__` 整体赋值时会被它 patch 成 `ownsHost=true`**（`lib/proxy.mjs:75` 的 `patch()` 只在该字段非 true 时强写），于是“远端机器的官方设置页”会被当成“本机可写”，插件自身 `remote-session/api/*` 不受影响，但官方设置/模型页可能写错机器——建议在文档里标注；② `crypto.randomUUID` polyfill 覆盖了 `:6`，但 `AbortSignal.timeout` 未 polyfill（本插件 `:62`），老 Android 上远端 probe 可能直接抛错；③ 移动端 UI：手机需先拉开侧栏抽屉才能看到 `sidebar.footer.action` 里的机器状态/切换入口，288px 菜单在 320px 屏上几乎占满（`client.js:220`），切换后整页 reload 会清滚动位置——功能可用但体验一般；④ DSH Desktop advanced 模式明确不支持（README:126-129），需 compatibility。
- **结论**：**高**。这是“宿主装本插件 + 手机扫码”最短路径；推荐写进 README 的“手机访问”组合。

### 3.4 summer1238/dsh-remote-web-gateway（165★，独立 gateway + DSH 插件）—— 兼容性：中高

- **机制**：仓库分两层：`src/` 是独立 Node 网关（可单独跑），`plugin/` 是 DSH 插件封装（`plugin/src/index.ts:42` `inject=['connection','webServer']`，`:63` upstream=`http://127.0.0.1:${ctx.webServer.port}`）。网关用 `http-proxy-3` 做透明反代（`src/gateway.ts:146-154`：`ws:true`、`changeOrigin:false`、`prependPath:false`、`ignorePath:false` —— **路径不变**），公网入口 Cloudflare Quick Tunnel（`src/quick-tunnel.ts`），管理面独立 loopback 端口 + `/healthz`（`gateway.ts:264-277`）。
- **透传/安全**：`:107-115` `normalizeUpstreamHeaders` 重写 Host/Origin、剥 `authorization`/`cf-*`/`x-forwarded-*`（`src/headers.ts:29-44`）、cookie 清洗；`:98-105` 响应加 HSTS/nosniff/frame-ancestors none；`:177-224` 每个 HTTP 请求都过 `authenticator.authenticate`，`:229-262` 每个 WebSocket upgrade 也鉴权；`src/request-policy.ts:34-64` 强制同源（Host 精确匹配、非 GET 与 WS 必须带匹配 Origin）。鉴权是**一次性配对票据（默认 5 分钟）+ JWT 设备会话（可撤销）+ 可选 GitHub 身份绑定**（`plugin/src/runtime.ts:68-74`、`plugin/src/github.ts`）。
- **DSH 兼容细节**：`plugin/src/runtime.ts:68-74` 专门处理 DSH 的 `?token=` launch URL（`authRootUrl`，来自 `ctx.connection.authenticatedUrl`），配对成功后把手机 303 到带 token 的根路径，从而拿到 DSH 自己的 session cookie——这点和 pocket 一致，是本插件页面能正常发 API 的前提。
- **相对 pocket 的缺口**：① 没有 HTML 注入/transport shim/polyfill（`src/` 里搜不到 `__DSH_TRANSPORT__`/`createApiClient`），手机页面的 `__DSH_TRANSPORT__` 仍是 undefined，官方 UI 设置镜像会退化成 memory 模式（`ctx.remote.$host.isLoopback` 为 false）——对本插件无直接影响，但“手机端改模型/设置”可能不可用；② 没有移动端窄屏适配（`plugin/src/client/mobile/*` 只做 FAB/overlay），官方三栏在手机上是硬挤；③ 依赖 DSH 同源策略与 `authenticatedUrl`，DSH 升级时是本仓库最脆的一环（其 peerDeps 仍写 `^0.1.0-rc.5`，最后 push 2026-08-28）。
- **结论**：**中高**。对“本插件 API + 机器切换”零改码成立（路径不变 + 同源 + cookie/token 处理正确）；主要风险在锁版本漂移与移动端 UI；建议作为“要安全配对/设备撤销”场景的备选。

### 3.5 wenbin-wb/dsh-bridge（221★，DSH 插件 + 反代 + 隧道 + IM Bot）—— 兼容性：中高

- **机制**：单插件全家桶（`lib/index.js` 2500+ 行），`inject` 含 webServer/connection；本机起反向代理（`lib/index.js:597` `createServer`，`:790` `path: req.url` 保持路径），入口支持局域网、Cloudflare 临时/固定域名、自建隧道（`lib/tunnel-client.mjs`），另有 PWA 独立全屏与微信/QQ/飞书/Telegram Bot 通道（README 功能节）。
- **透传/安全**：`:241-262` `loopbackHeaders()`：Host/Origin 改写成 `127.0.0.1:<port>`、注入由本机凭证派生的 DSH loopback 签名 cookie（`lib/auth/dsh-native-cookie.js`）、并**删除 accept-encoding 以确保拿到未压缩 HTML**；`:208-218` HTML_HEAD_ASSETS（viewport/PWA/theme + randomUUID polyfill），`:221-225` 三段可判重 polyfill（randomUUID、AbortSignal、PromiseIterator），`:818` 插到 `<head>` 之后；`:843-859` 对未压缩事件流注入 `: keepalive` 防 CF 空闲回收（`lib/sse-keepalive.js:3-17`）；`:874-920` WebSocket upgrade 鉴权 + 代理。
- **拼装细节**：注释声称“稳定注入 ownsHost”（`lib/index.js:257`），但代码里未搜到 `__DSH_TRANSPORT__` 写入——说明其 ownsHost 处理可能藏在客户端插件或已重构，需要实测（若它确实不 pin transport，官方 UI 设置页在手机上会退化，与本插件无关）。
- **独特价值**：① 它自带 `lib/connection-compat.js`，专门修 DSH 0.1.5+ `connection.rpc.handle` 缺 webServer inject 的上游回归（`connection-compat.js:1-35`），这类“深度适配”经验对本插件有参考价值；② IM Bot 通道让“手机不在浏览器也能用”，与本插件多机切换是互补关系。
- **结论**：**中高**。同源透传 + 路径保持 + HTML 注入点齐全，本插件 API/机器切换应可用；主要风险是它自己“mobile UI 客户端插件 + PWA + keepalive + head 注入”叠加的复杂度，以及只支持“宿主单机”，不解决多台 DSH 的切换（正是本插件的价值）。

### 3.6 april-jk/dsh-mobile-suite（17★，补充项：出站 WSS Relay + App 内官方 UI）—— 兼容性：高潜力（未真机验证）

- **机制**：`dsh-plugin`（电脑端 Companion）+ `dsh-relay`（账号/配对/短期票据/中转）+ `dsh-mobile`（Flutter App，WebView）。README.zh-CN.md：“手机不会直接连接电脑。电脑端插件只建立到 Relay 的出站 WSS 连接，DSH 继续监听 `127.0.0.1:3080`”；配对后“选择在线电脑，**手机会打开正常的 DSH Web UI**”。
- **关键设计（决定零改码）**：`dsh-公共文档/DSH-远程MVP-跨端接口.md` 明确：`WebView 入口：Mobile 本地 http://127.0.0.1:<ephemeral>/{path}`；Relay 只提供 `/client-tunnel` 密文 WSS；HTTP/SSE/WebSocket 作为加密 inner envelope 转发；**Companion 把 `Host`/`Origin`/`Referer` 重写为本地 DSH 地址**；响应按 `seq/final` 分片支持 SSE 与长响应；WebSocket 用同一加密 channel 的 `ws_open/ws_frame/ws_close`。=> 对 WebView 而言页面与 API 是**同一个 loopback origin**，本插件 `document.baseURI` 相对路径、`sessionStorage`、`fetch` 劫持、SSE/WS 都天然满足。
- **收益**：E2EE（Relay 只看密文）+ 出站连接（不需公网端口）+ 浏览器访问码（`Settings > Remote Access` 生成，可多浏览器独立密钥），是本组里安全模型最完整的一个。
- **风险/未验证**：① 子模块未在本仓库展开（`.gitmodules` 指向 4 个独立仓库，depth-1 克隆拿不到 `dsh-plugin` 源码），因此“Companion 是否把任意 path（含 `/remote-session/api/*`）都转发”未从代码确认，只从协议文档推断；② WebView 本地网关是 `127.0.0.1:<ephemeral>`，**端口每次会话变化 → origin 变化 → localStorage 不跨启动**（官方主题/草稿会丢，“机器选择”在 sessionStorage 里也只在单次会话内有效）；③ E2EE 分片对长 SSE/大响应有缓冲上限，手机端首屏/长会话可能受影响；④ Flutter WebView 对 `crypto.randomUUID` 无问题（loopback 属安全上下文），但 `AbortSignal.timeout` 取决于 WebView 内核版本。
- **结论**：**高潜力**（架构上比 3.3-3.5 更彻底），但必须真机验证三点：任意 path 转发、WebView origin 稳定性、E2EE 分片下的长会话/SSE。

### 3.7 liguobao/ds-harness-remote（882★，P2P + 原生客户端）—— 与本插件不适用

- **机制**：Host 插件 + 云端 Server（默认 `https://dsh.r2049.cn`）+ E2EE/WebRTC/Relay；Host 只出站连接（AGENTS.md 实现规则 #2）。会话/工作区数据面走**官方 Typert Remote allowlist**（`docs/compatibility.zh.md:5-7`：基线 dsh-v0.2.1-rc.1，ApiProxy 已退役），客户端是 Android 原生 UI + VS Code 扩展 + 独立 Remote Web（在另一个仓库）。
- **为什么不是“Web 网关”**：它不把宿主 `dsh web` 页面透传给手机；手机/客户端是“重新实现的官方 UI + 固定 allowlist RPC”（AGENTS.md “Current Status” 表：Android 原生、Desktop 复用 Harness UI、Remote Web 独立仓库）。因此本插件的 `/remote-session/api/*` 自定义路由与 client bundle 不会出现在对端；`DSH 端插件完整透传` 不成立。它的价值是“多机管理 + 端到端加密”，与本插件在“多机”上功能重叠但形态互斥。
- **结论**：**不适用/低**。若未来它的 Remote Web 变成“官方 `dsh web` 透明透传”，才有零改码可能；当前应作为竞品而不是组合件。

### 3.8 零改码组合结论

**结论：宿主装本插件 + 手机浏览器/WebView 走“同源整页反代”方案，本插件前端零改码可用。** 对照组 `dsh-vps-remote` 已在真机验证过同构路径（官方 UI + `__DSH_TRANSPORT__` pin + Host/Origin 重写 + 私有 cookie），本插件在该形态下需要的四件事全部被满足：

1. HTML 由宿主 `dsh web` 生成 → `__DSH_BOOT__` 图包含本插件 client 条目，`__ModuleLoader__` 能加载；
2. 路径不变 → `/remote-session/api/{state,send,native,...}` 原样到达宿主 `webServer.register` 的前缀路由；
3. 同源 + Host/Origin 重写 → `requestRejected` 不会 403；cookie 由反代补齐；
4. 整页 reload 可重复 → `switchMachine()`（`native-transport.js:32-47`）在手机上工作。

**组合排序（零改码，按风险从低到高）**：
1. `dsh-vps-remote`（本机对照，已验证，但需自备 VPS/SSH）；
2. `dsh-pocket`（一键扫码、有 polyfill，但 ownsHost shim 会覆盖本插件的 `ownsHost:false`，影响官方设置页语义）；
3. `dsh-bridge`（透传与注入齐全，附带 PWA/IM，但自有 mobile UI 与 keepalive 叠加，复杂度高）；
4. `summer1238/dsh-remote-web-gateway`（安全模型最好、路径不变，但无 polyfill/无移动适配、内核漂移风险）；
5. `dsh-mobile-suite`（架构最干净 + E2EE，但缺真机证据、WebView origin 稳定性未知）。

## 4. 移动端 UI 与运行时风险清单（本插件侧）

| # | 风险 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| 1 | 机器切换入口在侧栏 footer | `lib/client.js:543-547`（`sidebar.footer.action`）+ `:549`（`sidebar.panellist`） | 手机需先拉开官方抽屉；窄屏抽屉里 footer 可能被折叠/隐藏 | 文档写明“手机上从侧栏底部切机器”；或后续增加 `conversation.session.header.utilities` 入口 |
| 2 | 机器菜单 288px 固定宽 | `lib/client.js:220` `.dsh-remote-machine-menu { width:288px; max-width:calc(100vw - 24px) }` | 320px 屏几乎占满，触控目标偏小 | 已加 `max-width`，但仍建议窄屏改底部 sheet |
| 3 | `sessionStorage` 存机器选择 | `lib/native-transport.js:10,45` | 新标签页/新 WebView 回到“本地”；隐私模式可能不可用（read 有 try/catch） | 可接受；文档说明“每次新开页面默认本机” |
| 4 | 切机器整页 reload | `lib/native-transport.js:45-46` | 手机 reload 会重置滚动/输入焦点，弱网下首屏慢 | 文档说明；弱网建议配合有 keepalive/重连的网关 |
| 5 | `localStorage` 被 Proxy 重定义 | `lib/native-transport.js:106-135` | WebView 禁存储/隐私模式下 `defineProperty` 失败会 **throw 终止 boot**（`:131-135`） | 移动 WebView 必须允许 localStorage；否则需给插件加“降级不隔离”开关 |
| 6 | `crypto.randomUUID` | `lib/native-transport.js:6,143,169`；pocket `lib/proxy.mjs:30`、bridge `lib/index.js:217` | 非安全上下文（http://局域网IP）老浏览器直接崩 | 选带 polyfill 的网关（pocket/bridge），或强制 HTTPS 隧道（summer/vps） |
| 7 | `AbortSignal.timeout` | `lib/native-transport.js:62` | 老 Android WebView(<103) 远端 probe 抛错 → 回退本机并提示 boot failure | 优先 HTTPS/现代 WebView；必要时插件加 polyfill 检测 |
| 8 | pocket 的 `ownsHost` shim | `lib/proxy.mjs:75`（setter 里强写 `ownsHost=true`） | 远端页面里官方设置页被当“本机可写”，可能写错机器 | 在 pocket 组合文档里标注；或后续本插件在 reload 后用微延迟再覆盖 transport |
| 9 | DSH launch-token cookie | pocket `lib/proxy.mjs:560-610`；summer `plugin/src/runtime.ts:68-74` | 反代不处理则手机 `/api` 401 | 选已处理该握手的网关 |
| 10 | SSE/WS 空闲回收 | bridge `lib/sse-keepalive.js:3-17`；pocket `:1095-1196` | 长任务/审批流断流 | 选带 WS keepalive 的网关 |
| 11 | 服务端 CSP/框架头 | summer `src/gateway.ts:98-105`（`frame-ancestors 'none'`） | 只影响被 iframe 嵌入；官方 UI 不在 iframe，无害 | 无需处理 |
| 12 | relay token 暴露面 | 本插件 relay token 只在 Host 端（`cordis.patch.yml:10-13`），手机侧不落盘 | 网关本身不接触 relay token；但如果网关把整个 `dsh web` 暴露，等于把“能执行代码的 Host”暴露 | 网关必须强鉴权 + HTTPS + 设备撤销（pocket/summer/bridge 均有） |

## 5. 落地建议

1. **桌面端**：优先在 dataelement/dsh-desktop 与 dsh-tauri 上做“安装 + 切换 + 远端会话”三步 smoke；anywhere-labs 固定 compatibility 模式；ningbainb 先验证自定义协议是否转发 `/remote-session/api/*`。
2. **手机端**：把 dsh-pocket 作为“开箱即用”组合（有 polyfill、有 launch-token 握手、有 LAN/CF 两条路），把 dsh-vps-remote 作为“已有 VPS/nginx”组合；文档里明确 pocket 的 `ownsHost` 覆盖与移动 UI 限制。
3. **验证清单（每次升级网关/壳/DSH 都跑）**：
   - `GET /` 返回的 HTML 里含 `__DSH_BOOT__` 且 `entries` 含 `dsh-remote-session`；
   - 桌面/手机页 `fetch('/remote-session/api/state')` 返回 `{ok:true,snapshot...}`；
   - 选远端机器 → 页面 reload 后 `getSnapshot()` 显示远端 peer、会话列表来自远端；
   - 发送一条 prompt 并看到流式输出（验证 `openStream` 透传链）；
   - 切回本机 → 会话/草稿/主题不串（验证 localStorage 命名空间）；
   - 弱网/锁屏回来 → 仍能操作（验证网关 SSE/WS 保活）。
4. **不建议**：在“自绘 UI 桌面壳”（RongleCat）、“内核 <0.2.1-rc.2 的壳”（whitelonng/vibeinging/chokwinlee）、“原生客户端架构的远程方案”（ds-harness-remote）上投入组合适配。

## 6. 证据索引（关键文件:行号）

**本插件契约**：`package.json:33-45`；`lib/index.js:33,255-257,1290-1538,1545-1549`；`lib/native-transport.js:6,10,32-47,51-52,56-101,64-92,106-135,137-166,225-235`；`lib/client.js:45,116,197,220,543-549`；`cordis.patch.yml:16-25`。

**桌面 App**：
- dataelement：`package.json`（`@deepseek-ai/dsh:0.2.1-rc.2`）；`docs/architecture.md:3,24-33,56-68,78-101`；`src/main/index.ts:559,1491,3316`；`src/main/runtime/harness-runtime.ts:242-259,393-399`；`src/main/runtime/profile-plugin-command.ts:105`；`src/main/mobile/*`。
- anywhere-labs：`dsh-plugin-desktop/package.json:168-338`；`dsh-plugin-desktop/README.zh.md:11,57,125-138,279`；`dsh-plugin-desktop/docs/plugin-services.zh.md:100,111,200-207`；根 `package.json:18`（AA bridge）。
- dsh-tauri：`README.md:45-55,71,123-132,142-147`；`src-tauri/src/config/dependencies.rs:299,366`；`src-tauri/src/config/constants.rs:53`；`src-tauri/src/service/workflow/launch.rs:129`；`src-tauri/src/desktop/frontend_preload.rs:11-15,38-46,104-115`；`src-tauri/src/service/workflow/utils.rs:52-58`；`src-tauri/src/bridge/plugin.rs:53-60`；`src-tauri/src/bridge/lifecycle.rs:104`。
- ningbainb：`README.md:47,87,92,290,304`；`apps/dsh-desktop/src/runtime-electron-transport.mjs:17-31,33-40,42-88`；`apps/dsh-desktop/src/runtime-renderer-bootstrap.mjs:158-175`；`apps/dsh-desktop/src/runtime-launcher.mjs:106-108`；`apps/dsh-desktop/src/extensions/plugins.mjs`；`apps/dsh-desktop/src/profile.mjs:89,92`；`pnpm-lock.yaml:3115`。
- whitelonng：`package.json`（`@deepseek-ai/dsh-root@0.1.2-alpha.4`）；`packages/api/gateway/package.json:4`；`apps/desktop/package.json`（Electron shell）。
- vibeinging：`README.md:16,24,56-57,106-113`；`electron/main.js:584,778,1387,1458,1506,1614`；`server/package-lock.json:1964-1966`。
- chokwinlee：`README.md:28,40-43,71-72,113,151-159`；`src/harness-supervisor.ts:23-31,73-75`。
- RongleCat：`README.md:41,73,87`；`src/main/index.ts:157`；`src/main/dsh-host.ts:59`；`package.json`（DSH 0.1.0-rc.6）。

**Web/网关**：
- dsh-pocket：`lib/proxy.mjs:1-12,19,30-31,75,124-193,364-377,536-551,560-610,671-700,779,1016-1055,1095-1196,1024`；`lib/service.mjs:4,280-283`；`lib/index.js:27,260,275-301`；`README.md:42-59,78,113-129`。
- summer1238：`src/gateway.ts:98-105,107-115,146-154,177-224,229-262,264-277`；`src/headers.ts:29-44`；`src/request-policy.ts:34-64`；`plugin/src/index.ts:42,63`；`plugin/src/runtime.ts:68-74`；`plugin/package.json`（dsh.client）。
- dsh-bridge：`lib/index.js:208-225,241-262,597,760-785,790,818,843-859,874-920`；`lib/connection-compat.js:1-35`；`lib/sse-keepalive.js:3-17`；`lib/tunnel-client.mjs`；`README.md` 功能节。
- dsh-mobile-suite：`README.zh-CN.md`（组成/配对/安全边界/“手机打开正常 DSH Web UI”）；`dsh-公共文档/DSH-远程MVP-跨端接口.md`（WebView 本地网关、Host 重写、HTTP/SSE/WS、seq/final）；`dsh-公共文档/Tunnel-Protocol-v1.md`（出站 WSS、加密 envelope）。
- ds-harness-remote：`docs/compatibility.zh.md:5-7,17`；`AGENTS.md`（Repository Boundary / Current Status / 实现规则 2、8）；`package.json`（dsh.client inject 列表）；`packages/plugin/dist/index.js:88724-88741`（`handler.fetch(127.0.0.1)` + `connection.authenticatedUrl`）。
- 对照组 dsh-vps-remote（本机，非 GitHub）：`README.md:8-15,26-31,95-108`；`lib/gate.js:42,599-671,681-706,729-733`。

## 附录：仓库与方法

```text
research/apps/repos-desktop/
  anywhere-labs__dsh-desktop          dataelement__dsh-desktop
  dsh-tauri__deepseek-harness-desktop whitelonng__dshcode
  ningbainb__deepseek-harness-desktop vibeinging__dsh-desktop
  RongleCat__deepseek-app             chokwinlee__deepseek-harness-desktop
research/apps/repos-web/
  shaobeichen__dsh-pocket              summer1238__dsh-remote-web-gateway
  wenbin-wb__dsh-bridge               liguobao__ds-harness-remote
  april-jk__dsh-mobile-suite
```

复现：`gh api repos/<owner>/<repo>`（元数据）、`git clone --depth 1 --filter=blob:none https://github.com/<owner>/<repo>.git <dest>`；`chokwinlee` 仓库因安卓截图引用路径超长，需 `git config core.longpaths true` 后 checkout（源码目录 `src/`、`src-tauri/` 正常）。所有分析均为只读，未执行安装/构建。
