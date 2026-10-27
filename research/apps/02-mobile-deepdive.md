# 移动端远程控制客户端深度剖析：能否适配 dsh-remote-session 的 relay

> 调研日期：2026-10-27 · 对象：本仓库插件 v1.0.0（`package.json:36` 声明 `dsh >=0.2.1-rc.2`，本机基线 DSH 0.2.1-rc.3）
> 范围：GitHub 上 11 个 DSH 手机/远程访问项目（深挖 7 个 + 表格级 4 个），判断"通过本插件自建 relay 连接"或"直接复用其 DSH 侧网关"的可行性。
> 路径约定：仓库代码路径相对 `research/apps/repos-mobile/<owner>__<repo>/`；`_aux/` 是辅助克隆（上游网关/relay 组件）。
> 证据格式为 `文件:行`，行号以 2026-10-27 浅克隆 HEAD 为准；本插件行号以当前工作区源码为准。

---

## 0. 结论速览

1. **没有任何现成 App 能直接连本插件的 relay。** 本 relay 是 JSON 消息总线（`POST /v1/*` + SSE），不是 HTTP/WS 反向代理；
   11 个候选里没有一个客户端说这个协议，包括配置"任意服务器地址"的那几个——它们要的是 HTTP(S) 或 WSS 网关，不是本 relay。

2. **最快落地路线不是改 App，而是"零改码壳 + 装本插件"。**
   选一个把**官方 DSH Web UI 整页透传**到手机的原生壳（WebView/浏览器），在它连接的 Host 上安装本插件：
   本插件的机器切换/远程会话 UI 是注入官方 UI 的普通 web 客户端补丁，会随页面出现；切机后页面 `/api/**`
   由本插件经我们自己的 relay 改发到目标机器。手机 App 一行不改。

   - 结构成立且已适配 DSH 0.2.x 的壳：**saya-ch/dsh-mobile**（Android App + 浏览器，验证到 0.2.1-rc.2）、
     **zexadev/dsh-tether**（Android/iOS，徽章支持到 0.2.1）。
   - 结构最贴近但 DSH 版本停在 0.1.x：**april-jk/dsh-mobile-suite**（WebView + 官方 HTTP/SSE/WS 透传 + 多机 + E2EE，
     Companion 测试基线 DSH 0.1.0-rc.6），需先给它的 Companion 做 0.2.x 移植，才能与本插件同机共存。

3. **若目标是"手机 App 原生协议直连 relay"，首选 sorsama/deepseek-harness-mobile。**
   它说的就是官方 DSH 协议（`POST /api/<ns>/<method>` + 双向 `/api/remote.mux` 流），与本插件 `native` 载体
   （官方 Gateway 透传）一一对应：**DSH 侧零改动**，手机侧新增 relay transport 约 900–1400 行 Kotlin（中，1–2 人周）。
   次选 **Clarklevis1995/dsh-mobile**（产品最完整、Android+iOS，但私有 `dsh-mobile-v1` 协议需要在 DSH 侧加桥，中偏大）。

4. **纯 Web 代理/PWA 家族**（summer1238、wenbin-wb、hongshuxifan321、kuraneko1）只能走第 2 条路。
   其中 hongshuxifan321 的 WS 白名单仍写死旧 DSH 路径，需一行级补丁；kuraneko1 可作为 PWA/推送增强与本插件叠加。

5. **审批/推送缺口**：走 `native`（官方 Gateway）时审批、提问、终端、文件全部保留；只用 relay 高层 RPC
   （`prompt`/`events`/`list`）则**没有审批面**。壳路线的审批在官方 UI 内可用，锁屏推送取决于壳：
   april-jk MVP 明确把 push notifications 列为 deferred，zexadev 只有"待审批"通知，saya-ch 有系统通知，
   kuraneko1 提供 Web Push。

---

## 1. 调研方法与基线

### 1.1 方法

- 元数据：`gh api repos/<owner>/<repo>` 取 stars/license/pushed_at/language/size；README 用
  `gh api repos/<owner>/<repo>/readme -H "Accept: application/vnd.github.raw"`。
- 代码：`git clone --depth 1` 到 `research/apps/repos-mobile/<owner>__<repo>/`；suite 型项目按组件分别克隆到 `_aux/`
  （Clarklevis 的 DSH 侧网关、sorsama 的 dsh-relay、april-jk 的三个组件、yukiykchen 的 fork 插件）。
- 逐项目回答 8 个问题：① 客户端技术栈/平台；② DSH 侧插件与协议（传输层、端点、帧、鉴权/配对）；
  ③ 能力矩阵；④ 传输层是否可插拔（文件:行）；⑤ 改造成本；⑥ 多机支持；⑦ license/活跃/DSH 版本；⑧ 适配结论。
- **零改码壳判定**：App 是否把"官方 DSH Web UI"整页透传（HTML + 静态资源 + 插件 client bundle + `/api/**` +
  官方 WS/SSE），且其 DSH 侧组件能运行在 `0.2.1-rc.2+`。是 → 装本插件即得多机切换；否 → 必须改客户端网络层。
- 只读调研：不改克隆源码、不构建、不安装依赖；未修改本仓库源码、未提交。

### 1.2 本插件 relay 协议（对照基线一）

鉴权=`/etc/dsh-relay/token` 共享令牌（`relay/server.cjs:24-27,:161`）；内存态、不落盘；`GET /health` 免鉴权（`:153`）。
端口 127.0.0.1:3098，由 nginx 以 `/dsh-relay/` 前缀对外暴露；离线实例 15 分钟后清除（`:19,:172-181`）。

| 端点 | 请求 | 响应/事件 | 证据 |
| --- | --- | --- | --- |
| `GET /v1/stream?id&token` | 每实例一条 SSE | 建立即发 `event: ready`（peers 快照），20s `: ping` 心跳 | `server.cjs:116-146` |
| `POST /v1/register` | `{id,name,sessions?,meta?,previousId?,token}` | `{ok,peers}`；新实例向他人广播 `peer online` | `server.cjs:65-88` |
| `POST /v1/index` | `{id,sessions,token}` | `{ok}`，广播 `peer.index` | `server.cjs:90-97` |
| `POST /v1/publish` | `{from,to,type,payload?,id?,token}` | 定向/广播 SSE `message`；`409 target_offline`（无离线队列） | `server.cjs:99-114` |
| `POST /v1/peers` | `{id,token}` | 权威 peers 快照（online/sessions/meta） | `server.cjs:148-170` |

SSE 事件：`ready`、`peer`（online/offline）、`peer.index`、`message`（envelope `{from,type,payload,id?,ts}`，`server.cjs:34-40,:104`）。
限制：body ≤64MB（`:15`）、单实例 SSE 只保留 1 条、新连接顶掉旧连接（`:116-122`）。
**协议层不限制"实例必须是 DSH"**——任何持有共享令牌、能维持 SSE 的进程都能注册成 peer，这是 App 改造的理论基础。

### 1.3 本插件 relay RPC（对照基线二）

信封：请求 `{from,to,type:'rpc',id,payload:{method,params}}`；
应答 `{from,to,type:'rpc.result',id,payload:{ok:true,result} | {ok:false,error}}`（`lib/index.js:867-884`）。
调用方=任意已注册实例；26 个方法（`lib/index.js:1085-1110`）：

| 类别 | 方法 | 作用 |
| --- | --- | --- |
| 核心透传 | `native` | 官方 Gateway 载体（fetch + 流），见 §1.4 |
| 元信息 | `version`、`list`、`workspaces`、`models`、`commands`、`permissionCatalog` | 版本/会话索引/工作区/模型/斜杠命令/权限预设目录 |
| 会话内容 | `transcript`、`events`、`fork`、`attachment`、`fileReferences`、`files` | 转录/增量事件/分叉/附件/文件引用/工作区文件 |
| 写操作 | `prompt`、`cancel`、`create`、`executeCommand`、`selectModel`、`permissionSet`、`goalAction`、`openPath` | 发消息/取消/新建会话/执行命令/选模型/改权限/目标操作/打开路径 |
| 反馈 | `feedback`、`feedbackPut`、`feedbackDelete` | 消息反馈 |
| 同步 | `pluginSync` | 远端插件清单/安装/同步 |

**注意：RPC 面没有独立的 approval/审批方法**（`lib/index.js:1085-1110` 无对应项）。本插件桌面端能处理审批，
是因为它跑的是完整官方客户端协议，审批经 `native` 的官方事件流往返（`lib/native-gateway.js:111-175`）。
任何只用高层 RPC 的 App 都会缺审批——这是后面所有改造评估的关键约束。

### 1.4 `native` 载体＝官方 Gateway 协议隧道（对照基线三）

实现见 `lib/native-gateway.js:93-176`：

| operation | 字段 | 作用 | 证据 |
| --- | --- | --- | --- |
| `probe` | `{}` | 返回 `{protocol:1,clientEntries:[...]}`，用于版本/客户端组合探测 | `:99-103` |
| `fetch` | `requestId,route,method,contentType,bodyBase64` | 走官方 `connection.createSharedFetchHandler('/api')`，等价页面同源 fetch | `:110,:178-201` |
| `open` | `streamId,endpoint,payload,uplink?` | 打开官方 `typertGateway.wireStream.open` 逻辑流 | `:111-144` |
| `pull` | `streamId,sequence` | 拉取批次 `{sequence,values[],done,failure}` | `:162-175` |
| `uplink` | `streamId,sequence,value?,done?` | 客户端→Host 上行（支持双工） | `:154-161` |
| `close`/`cancel`/`release` | `streamId`/`requestId`/`{}` | 关闭流/取消请求/释放客户端 | `:105-109,:150-153` |

限制：每客户端 64 请求、128 流（`:82,:114`）；流快照 ≤16MB（`:132`）；HTTP 响应 ≤8MB、route 只允许 `/api/` 前缀
（`:183,:198`）；客户端 60s 空闲回收（`:4-5`）；前置条件=DSH 必须提供 `ctx.typertGateway.wireStream` 与
`ctx.connection.createSharedFetchHandler`（`:96-98`，注入声明见 `lib/index.js:33`）。
浏览器侧由 `lib/native-transport.js` 劫持 `window.fetch` / `__DSH_TRANSPORT__.fetch/openStream`（`:137-227`），
切机写 `sessionStorage` 后整页 reload（`:29-51`），且要求页面有官方 `__DSH_BOOT__` 客户端组合图（`:60-102`）。

### 1.5 三种外部接入面

1. **透明 Web UI 壳（零改码）**：App 把 Host 的官方 DSH 页面整页透传给 WebView/浏览器。页面自带本插件注入的
   机器切换补丁；切机后 `/api/**` 由本插件改走 relay。App 代码不动，但入口 Host 必须在线。
2. **relay RPC 客户端（中）**：App 自己实现 §1.2 + §1.3（共享令牌、SSE 长连、RPC 信封），注册成 peer 读写远端会话。
   不需要官方 Gateway，但**没有审批**，除非扩展 relay 协议。
3. **`native` 载体（重但全）**：App 内实现官方 Gateway 客户端协议（fetch/mux），复用 §1.4。审批/提问/终端/文件全保留；
   要求 App 与 DSH 协议版本同步演进。

---

## 2. 零改码壳路线（最快落地）

### 2.1 判定为"透明官方 UI 壳"的项目

- **saya-ch/dsh-mobile**：HTTPS 网关反代官方 UI（`src/gateway.ts`），Android WebView App + 浏览器。
- **april-jk/dsh-mobile-suite**：Companion 把官方 HTTP/SSE/WS 全透传（`dsh-公共文档/Tunnel-Protocol-v1.md`），
  Flutter WebView（`_aux/april-jk__dsh-mobile/pubspec.yaml:40`）。
- **zexadev/dsh-tether**：Tauri WebView + 本机 HTTP 代理把官方 UI 经 iroh 拿过来（`app/src-tauri/src/lib.rs:192-198`）。
- **hongshuxifan321/dsh-mobile-app**：认证反代官方 UI + 移动 CSS（`server/plugin/lib/proxy.js`），Android WebView + PWA。
- **summer1238/dsh-remote-web-gateway**：透明反代 + Cloudflare Tunnel（`src/gateway.ts:5,:146`），浏览器/PWA。
- **wenbin-wb/dsh-bridge**：反代 + HTML 注入 + 隧道（`lib/index.js:579`），浏览器/PWA。
- **kuraneko1/dsh-mobile-maxxing**：纯 DSH 插件直接增强官方 UI（PWA/Web Push/移动 UX），本身不是壳，是佐证与增强。

### 2.2 走通前提（缺一不可）

1. 壳的 DSH 侧组件能运行在 **DSH 0.2.1-rc.2+**（本插件与官方 Gateway 透传所需；`package.json:36`）。
2. 壳透传**整页**：`/`、静态资源、插件 client bundle、`/api/**`、官方 WS（0.2.x 为 `/api/remote.mux`）、SSE 不缓冲。
3. WebView 允许 `localStorage/sessionStorage`（切机状态与草稿隔离依赖，`native-transport.js:104-135`）。
4. 切机 reload 后仍经壳加载页面（URL 不变，满足）；目标机 B 也装本插件且与本机同 relay。
5. **入口机 A 必须在线**（壳只连 A；B 的页面资源仍来自 A——这是本插件"本地骨架 + 远端 Host"设计）。
   这也是零改码路线的产品限制：不是"任意在线机器直接打开"，而是"从 A 的页面出发控制 B"。

### 2.3 逐壳判定

| 壳 | DSH 0.2.1-rc.2+ 就绪 | 整页透传 | 零改码结论 |
| --- | --- | --- | --- |
| saya-ch | ✅ 验证到 0.2.1-rc.2（rc.3 已装入候选；README 兼容表） | ✅ HTTPS 网关反代官方 UI | **首选，可直接实测** |
| zexadev | ✅ 徽章 0.1.0-rc.7…0.2.1，内置 0.2.1-rc.2 | ✅ 本机 HTTP 代理转发官方 UI | **次选，可直接实测**（Android+iOS） |
| april-jk | ❌ Companion 测试基线 0.1.0-rc.6 | ✅ 官方 HTTP/SSE/WS 全透传 | 结构最佳，需移植 Companion |
| hongshuxifan321 | ⚠️ 未验证；WS 白名单写死旧路径 | ✅ 官方 UI + 认证反代 | 需一行级补丁 + 实测 |
| summer1238 | ❌ 验证基线 0.1.0-rc.7 | ✅ 透明反代（http-proxy-3） | 浏览器/PWA；需升 DSH 适配 |
| wenbin-wb | ⚠️ 兼容到 0.2.0-rc.2 | ✅ 反代 + HTML 注入 | 浏览器/PWA；需实测 |
| kuraneko1 | ⚠️ 活跃（10-26）但未声明 DSH 版本范围，需实测 | 本身是官方 UI 插件 | 与本插件叠加做 PWA/通知增强（版本需实测） |

### 2.4 实测清单（拿到壳之后先验这四件事）

1. WebView 移动布局下本插件注入点（`sidebar.panel`/`footer`/`settings.section`，见 `lib/client.js:542-560`）是否可见可点。
2. 切机后 reload 是否保留 `sessionStorage['dsh.remote-session.machine.v1']`；WebView 是否禁用了 storage。
3. 目标机 B 的 `/api/remote.mux` 事件流经壳的 WS 转发/SSE 代理是否不缓冲（首字延迟、持续输出）。
4. 壳的认证/反代是否剥离本插件静态资源或改写 `__DSH_BOOT__` 客户端组合图。

---

## 3. 逐项目深挖

### 3.1 saya-ch/dsh-mobile（639★ · Apache-2.0 · 2026-10-26 · TypeScript）

- **技术栈**：DSH 插件（Node/TS，npm `dsh-mobile`）自带独立 HTTPS 网关（默认 3443，`README.md:133`）；
  Android App（Kotlin WebView 壳）+ 手机浏览器。局域网固定私有 CA，公开远程入口用受信任证书（`README.md:47,60`）。
- **DSH 侧/协议**：不是 API 网关，而是**反向代理 + 移动布局注入**：
  `src/gateway.ts:9-18` 建 http/https 服务器，`:46` 移动兼容引导，`:123-130` 移动 boot/layout 注入；`access.ts` 设备配对
  （43 位配对码，`README.md:148`）；远程通道可选 Tailscale Funnel / cpolar / cloudflared / 自建 FRP / 自有反代 / 托管 Caddy
  （`README.md:150-168`）。第三方插件仍由 DSH 加载（`README.md:288`），但**第三方 WS 默认拦截、可按路径放行**
  （`README.md:294-298`）——本插件只用同源 `/api`，不需要放行。
- **客户端**：纯 WebView 壳。`apps/mobile/android/.../SecureWebViewClient.kt:68`（WebViewClient），
  `NativeBridge.kt:44`（禁用 addJavascriptInterface，改用 WebMessageListener），`PairedDeviceStore.kt`/`PairingTrust.kt`
  管多设备与凭据。
- **能力矩阵**：会话/聊天/实时回复/审批/工作区/文件/模型=官方 UI 全量；Android 系统通知（`README.md:59`）；
  多台已配对电脑列表（`README.md:57`）。
- **传输可插拔性**：App 层没有传输抽象（WebView 只认 URL）；可插拔点在插件侧通道工厂，与 relay 无关。
- **改造 relay**：若坚持 App 直连 relay 需重写 App+网关 → **大/不划算**；走零改码壳 → **0**；
  可选增强（把 relay URL/token 预置进配对二维码/设置页）→ 小。
- **多机**：有（多设备列表+自动恢复，`README.md:57`）；每台电脑各自一个网关地址，跨机统一入口靠本插件。
- **DSH 版本**：兼容表验证 `0.1.7-alpha.2`…`0.2.1-alpha.3`/`0.2.1-rc.2`（`README.md:398` 起的历史表），覆盖本插件基线。
- **结论**：**零改码首选壳**。把本插件装到它连接的 Host，手机 WebView 内的官方 UI 会出现本插件注入的机器切换；
  切机后 `/api` 经我们 relay 到 B。唯一待实测的是移动布局下注入点可见性与存储权限。

### 3.2 april-jk/dsh-mobile-suite（17★ · MIT · 2026-08-18；四组件）

**结构**：`dsh-mobile/`（Flutter Android/iOS）、`dsh-mobile-plugin`（Companion，Node）、`dsh-relay`（可自部署 relay）、网站。
- App=**Flutter WebView 容器**，不是原生重写：`pubspec.yaml:40` 依赖 `flutter_inappwebview`；
  `lib/features/session/session_webview_page.dart:339-347` 直接 `InAppWebView(initialUrlRequest: 官方 UI 的 relay URL)`；
  登录/配对/电脑列表在 `lib/data/relay_service.dart`、`lib/features/session/secure_tunnel.dart`。

**传输协议**（自有、非本 relay）：
- Companion 只出站一条 **WSS `/device`**（`dsh-公共文档/Tunnel-Protocol-v1.md:3`），信封 `{v:1,type,channel,id,ts,payload}`
  （`:7-21`）；内层用 `http_req/http_res` 流式转发 HTTP（含 SSE，`:50-73`）与 `ws_open/ws_frame/ws_close` 转发 WebSocket
  （`:77-84`）；外层再包 E2EE sealed 帧（`Tunnel-E2EE-v1.md`；App 侧 `SecureTunnelTransport` 接口见
  `_aux/april-jk__dsh-mobile/lib/features/session/secure_tunnel.dart:8`，实现 `:23-52` 用 `WebSocket.connect`+`WebTicket`）。
- 资源边界 4MiB WS 帧 / 2MiB 请求 / 32MiB 响应，32 HTTP + 16 WS 通道（`Tunnel-Protocol-v1.md:86-90`；
  实现 `_aux/april-jk__dsh-mobile-plugin/src/relay-client.ts:34-37`）。
- 鉴权/配对：relay 账号（邮箱+密码）+ 电脑二维码配对（一次性 code + E2EE key 放 URL fragment，`README.md:59-61,66`）
  + 短票据 WebTicket；手机永远拿不到电脑设备凭据（`README.md:97`）；支持"网页访问码"多浏览器同时连（`README.md:65-67`）。
- **DSH 侧（Companion）**：把官方 HTTP/SSE/WS 透明转发到 `127.0.0.1:3080` 并重写 Host/Origin，DSH 不开公网端口
  （plugin `README.md:70-72`）——正是零改码所需性质。兼容基线 **DSH 0.1.0-rc.6**（plugin `README.md:15,20`），
  落后本插件要求的 0.2.1-rc.2 一代。
- 能力：官方 UI 全量（会话/聊天/实时/审批/文件）；多电脑列表（`README.md:62`）；无原生推送
  （AGENTS.md 的 MVP deferred 明确列了 "push notifications, native approvals"）；有 E2EE。

**Lead 四问逐条回答**：

1. **它的 Relay 是否可替换/是否私有协议**：私有协议，**不可即插即用替换**——WSS + 通道化 HTTP/WS 转发 + E2EE，
   我们的 relay 没有 WS 服务端/通道概念；替换需重写 Companion 与 App 传输层（大）。但它可私有部署
   （docker compose + SQLite，`README.md:71-92`），可与我们的 relay 并存、各管一段。
2. **App 是原生重写还是 WebView**：**WebView 加载官方 UI**（`pubspec.yaml:40`、`session_webview_page.dart:339-347`），
   只有登录/配对/设备列表是原生 Flutter。
3. **把本插件装到它连接的 Host，App 能否零改码显示机器切换**：**结构上成立，当前版本大概率不行**。
   成立的原因是 WebView 透传整页 → 本插件注入的 UI 会出现在页面里，切机后 `/api` 改走我们的 relay；
   不行的原因是 Companion 只测过 DSH 0.1.0-rc.6，而本插件要求 0.2.1-rc.2+——两者无法同机。把 Companion 移植到
   0.2.x 属于**小-中工作量**（其隧道与 DSH 版本解耦，改动集中在其 settings/Remote Access 面板与 Host/Origin 重写），
   值得给上游提 PR。
4. **DSH 侧插件是否也把官方 HTTP/SSE/WS 透传（类 dsh-vps-remote）**：**是**。
   `http_req/http_res` 逐帧流式（含 SSE 不缓冲）、`ws_open/ws_frame/ws_close` 双向帧，Companion 只连本地 3080
   （`Tunnel-Protocol-v1.md:50-84`；plugin `README.md:70-72`）。

**结论**：结构最理想的零改码候选，但受 DSH 版本代沟阻塞；若愿意做一次上游移植，它同时给"Android+iOS+多机+E2EE+
可自部署 relay"。**不建议把我们的 relay 硬套它的隧道。**

### 3.3 zexadev/dsh-tether（79★ · MIT · 2026-10-26 · Tauri + Rust）

- **技术栈**：Tauri 2 手机 App（Android；iOS beta 自签名）+ Rust sidecar（iroh QUIC）+ Node DSH 插件
  （`dsh-plugin-tether`）；另有 Android 本地模式（手机内跑 DSH，与本主题无关）。
- **协议**：iroh P2P 打洞直连，失败回退到只看密文的 relay；App 起**本机 127.0.0.1 HTTP 代理**，
  把每条入站 TCP 映射成一条 iroh 代理流，WebView 由此拿到主机完整官方 DSH UI（`app/src-tauri/src/lib.rs:192-198`）；
  `tether-core/src/lib.rs:11` 使用 iroh 流，`:256-350` 重写 HTTP 请求头（ProxyAuth/trusted host）。
  配对=6 位 CSPRNG 码 + iroh 公钥（`README.md:126`）；支持 DSH 0.1.0-rc.7…0.2.1（`README.md:20`）。
- **能力矩阵**：官方 UI 全量；多机器列表（`README.md:114-115`）；审批通知（`README.md:119`，只推"待审批"，审批在官方 UI 内）；
  无原生聊天 UI。
- **传输可插拔性**：**没有抽象**——iroh 端点/流与 HTTP 代理写死在 Rust（`app/src-tauri/src/lib.rs:127-198`、
  `host/src/main.rs:146-159`），换成我们的 relay 等于重写"消息化 HTTP/WS 隧道"（大）。
- **零改码**：**可行（待实测）**：官方 UI 整页透传 + 本机代理；A 装本插件后 WebView 内出现机器切换；
  切机 reload 仍走本机代理到 A，`/api` 走我们 relay 到 B。注意双隧道叠加延迟，以及 Tauri 移动端 WebView 的 storage 支持。
- **多机/许可**：有；MIT、极活跃（2026-10-26）。
- **结论**：**零改码次选**，尤其需要 iOS 时。

### 3.4 hongshuxifan321/dsh-mobile-app（103★ · MIT · 2026-08-18 · JS）

- **技术栈**：Android 全屏 WebView App + 通用 PWA + Node 认证代理插件（`server/plugin`，v0.1.0）。
- **DSH 侧/协议**：认证反代 `0.0.0.0:8082 → 127.0.0.1:3080`，Basic Auth（timingSafeEqual+限流）、把 Host/Origin
  统一重写成固定 trusted host `dsh.remote`、注入移动 CSS/viewport/WS 认证 cookie 脚本（`server/plugin/lib/proxy.js:1-60`）；
  `/mobile` 302 到 `/`，即"官方 UI + 适配 CSS"（`server/plugin/README.md`）；云端默认 cloudflared 隧道。
  **WS 升级白名单只放行 `/api/events.{mux,host}`**（`proxy.js:9,:235`）——0.1.x 时代的官方路径，DSH 0.2.x 已改成
  `/api/remote.mux`。
- **客户端**：WebView 自动携带 Basic Auth、密码经 Android Keystore（`README.md:24-37`）；可填固定域名或完整 https 地址。
- **能力矩阵**：官方 UI 全量（审批在 UI 内）；无系统通知；单机（一个反代上游），无多机。
- **零改码判定**：结构上可以（官方 UI + 插件 bundle 透传），但当前实现在 DSH 0.2.x 上实时通道会被自己的 WS 白名单拦掉，
  且未验证 0.2.x 的 trusted-host/loopback 行为 → 需一行级放行补丁（`/^\/api\/(events\.(mux|host)|remote\.mux)/`）+ 实测。
- **结论**：可作零改码备选（补丁成本小），但维护活跃度一般、无多机、无通知。

### 3.5 Clarklevis1995/dsh-mobile（660★ · MIT · 2026-10-26 · Kotlin/KMP）

- **技术栈**：Kotlin Multiplatform 共享业务层 + Android Jetpack Compose + iOS SwiftUI；原生 UI，非 WebView
  （`README.md:32-38`）。
- **DSH 侧**：独立仓库 `Clarklevis1995/dsh-plugin-mobile-gateway`（0.10.3+/0.11.x，需 DSH 0.2.1-rc.2 的 Connection Peer）
  维护私有协议 `dsh-mobile-v1`：WS `/ws/mobile`（本机 3080、局域网独立 3081、公网必须 WSS 反代，
  `_aux/.../PROTOCOL.md:7-11`），全部 JSON 文本帧，请求 `{type}`/响应 `{kind}`；
  配对=Base64URL v2 `{version,publicUrl,pairingCode,expiresAt}` + 子协议 `dsh-mobile-v1, dsh-pair.<code>` +
  `X-DSH-Device-ID`，成功后发长期设备 token（`PROTOCOL.md:58-93`）；`hello` protocol 3 能力列表（`PROTOCOL.md:84-86`）；
  提问/审批有 replay 与"任一端先完成"语义（`PROTOCOL.md:180-197`）；多网关 phase 1 只做到"一个 App 配多台网关"，
  **明确不提供网络中转**（gateway `README.md:63-67`）。
- **传输可插拔性（证据最充分）**：
  - 共享层 `interface GatewayTransport { open/send/close + events Flow }`
    （`shared/src/commonMain/.../platform/GatewayPlatformContracts.kt:58-66`）、
    `GatewaySplitTransport`（`:69-72`，控制/会话双连接）。
  - Android 实现 `OkHttpGatewayTransport.kt:21-24`（`:68` newWebSocket），iOS 实现 `GatewayClient.swift:8`
    （URLSessionWebSocketTask `:136,:331-336`）。
  - 依赖注入可替换：`AndroidAppGraph.kt:29`（`transportOverride`）、`:57-59`（`SplitGatewayTransport(OkHttpGatewayTransport(...))`）；
    多网关状态机 `AndroidMultiGatewayStore.kt:58,:430`，iOS `MultiGatewayStore.swift`。
    → **换底层传输只需再写一个 `GatewayTransport` 实现，业务/协议层不动。**
- **能力矩阵**：工作区/会话/实时对话/Agent 轨迹/提问与审批/文件浏览下载预览/插件管理/定时任务/模型/权限预设/多主机/
  iOS 实时活动与通知（`README.md:69-92`）。是候选里功能最全的。
- **改造 relay 工作量**：两条路——
  (a) 给 `dsh-plugin-mobile-gateway` 增加出站 relay 客户端（`/v1/register`+SSE+`/v1/publish`，把手机来的帧投给本地
  adapter；relay 是哑总线，它可自行处理自定义 envelope），手机端新增 `RelayGatewayTransport`
  （实现 open/send/close/events，估计 250–350 行 KMP）；
  (b) 写一个本地 WS 桥插件连 gateway。都要动两个代码库，且其网关协议仍在快速演进（0.11.x 未发布变更多）
  → **中/中偏大，2–4 人周**。
- **多机/许可**：有（多网关保存/切换，`README.md:79`）；DSH 与本插件同代（0.2.1-rc.2）；MIT、最活跃。
- **结论**：**改网络层路线里功能上限最高，但成本约为 sorsama 的 2–3 倍**；需要 iOS 或要"最像成品"时选它。

### 3.6 201222-L/dsh-mobile-remote（89★ · MIT · 2026-10-07 · Dart + JS）

- **技术栈**：DSH 插件（Node，`lib/index.js` 约 309KB）+ Flutter Android App（`dsh-mobile-app/`）。
- **DSH 侧/协议**：自有 HTTP + SSE API，挂载路径可配（默认 `/m`，`lib/index.js:36`），SSE 在 `lib/index.js:2170`；
  访问口令 `authToken`（`README.md:119`）；审批走 DSH 的 `approval/request` 瀑布 + `$events` 双端通道
  （`docs/09-compatibility.md:13-22`）；桌面端另有 LAN 桥（`README.md:91-101`）。
- **App**：Flutter 原生 UI，`dsh-mobile-app/lib/api.dart` 统一封装 API：`baseUrl=/path=/token=`（`:82-86`）、
  多候选地址轮换（`:96-102`）、SSE 帧流（`:1097-1175`）、幂等 requestId（`:29-38`）。
- **能力矩阵**：聊天/流式/审批提问/系统推送（Server酱/ntfy/Bark）/会话/工作区/模型/目标/任务/子代理/悬浮球
  （`README.md:23-37`）。
- **多机/版本**：无（一台 PC、多地址轮换）；DSH 基线 0.1.2-rc.1（`docs/09-compatibility.md:13`）；活跃度一般（10-07）。
- **改造 relay 工作量**：手机端加 relay 客户端把 `api.dart` 的 HTTP/SSE 换成 relay RPC；DSH 侧需为 `/m` 路由加隧道能力
  （我们 `native` 只允许 `/api/`，`native-gateway.js:183`）→ **中偏大**；其 `/m` API 是私有面，无官方协议可复用。
- **结论**：零改码不可行（原生 UI + 私有 API）；改网络层优先级低于 sorsama/Clarklevis。

### 3.7 sorsama/deepseek-harness-mobile（213★ · MIT · 2026-10-22 · Kotlin/Compose）

- **技术栈**：Android 原生（Kotlin + Compose，非 KMP），直接实现**官方 DSH 协议**；另有 Termux 本机模式。
- **协议（与本插件 `native` 载体同源）**：
  - 一元调用 `POST /api/<namespace>/<method>`，信封 `{type:'client-request',rpcId,method,payload}`
    （`core/src/main/kotlin/.../wire/RpcTransport.kt:61-98` 定义 carrier 接口，`:118-126` OkHttp 实现；
    下载/上传各有专用方法 `:76-97`）。
  - 实时=**双向 WS `/api/remote.mux`**（`wire/dto/StreamProtocol.kt:40`），客户端消息 `open/cancel/item/end`
    （`:69-101`）、内置 `$events` 流（`:49`）。
  - 这正是本插件 `native` 的 `fetch` 与 `open/pull/uplink` 所承载的同一套官方 Gateway 协议。
  - relay 模式目前用他们家 `dsh-relay`（HTTPS 反向代理+密码/配对/短票据，`_aux/sorsama__deepseek-harness-relay/src/proxy/{http,ws}.ts`；
    App 侧 `RelayPairing.kt:34,37`，`HostConfig.kt:44-64` 存 relay 指纹/设备 ID）。
- **传输可插拔性（证据充分）**：
  - `interface RpcTransport`（`RpcTransport.kt:61`）+ `OkHttpRpcTransport`（`:118`）；
  - 流载体 `RemoteStreamMux` 类（`RemoteStreamMux.kt:85`）与 `openStream(endpoint,args)`（`:249`）；
  - 连接装配 `ConnectionManager.kt:214` 的 `muxFactory(host)`、`:168` connect；
  - 主机模型支持 LAN/relay/loopback 三种模式（`HostConfig.kt:194-196`）、最多记 8 台
    （`HostsStore.kt:31,:284`、`AUTO_RELAY` 自动重连）。
  → **把 HTTP carrier 与 mux carrier 各换一次即可接上 relay。**
- **能力矩阵**：聊天/流式/工具卡/轨迹/审批/提问/目标/待办/队列/子代理/终端/工作区文件/模型/预设/插件/定时任务/
  归档会话/通知（`README.md:51-67`）——即官方 UI 的完整能力，且在原生 UI 里。
- **改造 relay（最优）**：
  - DSH 侧 **零改动**：`native` RPC 已把官方 `/api` fetch 与 `/api/remote.mux` 流透传给任意 relay peer
    （`native-gateway.js:110,111-175`）。
  - 手机侧新增：① `RelayClient`（register/SSE/publish+rpcId 关联+重连，约 300–450 行）；
    ② `RelayRpcTransport : RpcTransport`（post/download/upload → `native.fetch`，约 150–250 行）；
    ③ mux 的 relay carrier（open/item/end/cancel → `native.open/uplink/pull/close`，约 200–300 行，
    建议先在 `RemoteStreamMux` 抽 carrier 接口）；④ relay 主机配置/配对 UI（约 150–250 行）。
    合计 **900–1400 行 Kotlin，1–2 人周（中）**。
  - 限制/风险：`native.fetch` 响应 ≤8MB（`native-gateway.js:198`）、流快照 ≤16MB、relay body ≤64MB → 大附件下载/导出
    可能触顶，需要调大常量或分块；流是"拉取式长轮询"（`pull` 等待 ≤10s，`native-gateway.js:26-27`），延迟比 WS 高，
    需在 UI 侧做缓冲；App 锁定 DSH 0.2.1-rc.2（`docs/PROTOCOL.md` 头部），与本插件基线一致，但双方都需随官方协议升级。
- **协议对照（sorsama 载体 → 本插件 native RPC）**：

  | sorsama 载体 | 本插件 `native` | 证据 |
  | --- | --- | --- |
  | `POST /api/<ns>/<method>` | `fetch {route:'/api/<ns>/<method>', method:'POST', bodyBase64}` | `native-gateway.js:110,:178-201` |
  | 二进制下载/导出 | `fetch`（GET） | `native-gateway.js:183-199` |
  | `/api/remote.mux` 的 `open {streamId,endpoint,payload}` | `open {streamId,endpoint,payload}` | `native-gateway.js:111-144` |
  | mux `item {streamId,value}` | `uplink {streamId,sequence,value}` | `:154-161` |
  | mux `end {streamId}` | `uplink {streamId,sequence,done:true}` | `:154-161` |
  | mux `cancel {streamId}` | `close {streamId}` | `:150-153` |
  | Host→Client 的 item/error/end | `pull {sequence}` → `{values[],done,failure}` | `:162-175` |
  | `$events` 流 | `open {endpoint:'$events',...}` | `StreamProtocol.kt:49` |

- **多机**：有（Recent 主机列表），接 relay 后"多机"= relay peers 切换，天然契合本插件产品模型。
- **结论**：**"App 直连 relay"路线的最佳选择**：协议同源、DSH 侧零改、传输层两处干净接缝、MIT、活跃。
  只买一个改造，买它。

---

## 4. 对比总表

### 4.1 候选总表

| 仓库 | ★/许可/最近push | 平台/技术栈 | DSH 侧形态 | 客户端协议 | 多机 | 零改码壳 | 改网络层 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| saya-ch/dsh-mobile | 639/Apache-2.0/10-26 | Android WebView+浏览器；TS 插件 | HTTPS 反代+移动 UI 注入 | 官方 HTTP/WS 透传 | ✅ | ✅（0.2.1 已验证） | 大 | **零改码首选** |
| Clarklevis1995/dsh-mobile | 660/MIT/10-26 | Android+iOS；KMP 原生 | dsh-plugin-mobile-gateway | 私有 `dsh-mobile-v1` WS | ✅ | ❌ | 中偏大 | 改网络层次选（要 iOS 才值） |
| 201222-L/dsh-mobile-remote | 89/MIT/10-07 | Android Flutter 原生 | 自有 `/m` HTTP+SSE 插件 | 私有 HTTP/SSE | ❌ | ❌ | 中偏大 | 优先级低 |
| april-jk/dsh-mobile-suite | 17/MIT/08-18 | Android(+iOS) Flutter WebView | Companion 透传 HTTP/SSE/WS + 自有 relay | 私有 WSS 隧道+E2EE | ✅ | ✅结构/❌当前 DSH | 大（不建议换 relay） | 移植 Companion 后值得 |
| zexadev/dsh-tether | 79/MIT/10-26 | Android+iOS；Tauri+Rust iroh | 出站 iroh sidecar+HTTP 代理 | iroh QUIC/TLS（HTTP/WS 隧道） | ✅ | ✅（支持 0.2.1） | 大 | **零改码次选** |
| hongshuxifan321/dsh-mobile-app | 103/MIT/08-18 | Android WebView+PWA | 认证反代+官方 UI CSS | 官方 HTTP/WS 透传 | ❌ | ⚠️需补丁 | 大 | 备选（WS 白名单待修） |
| sorsama/deepseek-harness-mobile | 213/MIT/10-22 | Android 原生 Kotlin | 无（直连官方 API） | **官方 HTTP+`/api/remote.mux`** | ✅ | ❌ | **中（最优）** | **改网络层首选** |
| summer1238/dsh-remote-web-gateway | 165/MIT/08-28 | 浏览器/PWA；TS 插件 | 透明反代+Cloudflare Tunnel+JWT | 官方 HTTP/WS 透传 | ❌ | ⚠️DSH 0.1.x | 大 | 浏览器路线备选 |
| wenbin-wb/dsh-bridge | 221/MIT/10-26 | 浏览器/PWA+IM 机器人 | 反代+HTML 注入+隧道 | 官方 HTTP/WS 透传 | ❌ | ⚠️≤0.2.0-rc.2 | 大 | 浏览器路线；IM 是另一条路 |
| yukiykchen/deepseek-harness-mobile | 53/**无 LICENSE**/10-12 | Android/iOS/鸿蒙 Kuikly | fork april-jk 插件(0.1.8) | 私有 WSS 隧道(E2EE) | ❌ | ❌ | 中偏大 | 只作架构参考 |
| kuraneko1/dsh-mobile-maxxing | 47/MIT/10-26 | 浏览器/PWA（纯 DSH 插件） | 装进官方 UI：PWA/Web Push/移动 UX/CJK | 官方 UI | — | ✅（佐证） | — | **与本插件叠加增强** |

### 4.2 能力矩阵（会话/聊天/实时/审批/工作区/文件/模型/通知/多机）

| 项目 | 会话 | 聊天 | 实时 | 审批 | 工作区 | 文件 | 模型 | 通知 | 多机 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| saya-ch | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Android | ✅ 多设备 |
| Clarklevis1995 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ iOS 实时活动 | ✅ |
| 201222-L | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 推送通道 | ❌ |
| april-jk | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ deferred | ✅ |
| zexadev | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ 待审批 | ✅ |
| hongshuxifan321 | ✅ | ✅ | ⚠️旧 DSH 路径 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| sorsama | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| summer1238 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| wenbin-wb | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ 浏览器 | ❌（IM 多工作区） |
| yukiykchen | ✅ | ✅ | ⚠️0.1.x | ⚠️ | ✅ | ✅ | ✅ | ❌ | ❌ |
| kuraneko1 | 官方 UI | 官方 UI | 官方 UI | 官方 UI | 官方 UI | 官方 UI | 官方 UI | ✅ Web Push | 需本插件 |

> 说明：标"官方 UI"表示由 DSH 官方页面提供，本项目只做增强；✅/⚠️/❌ 依据各项目 README 与源码（见 §3 证据）。

### 4.3 对零改码路线的佐证：kuraneko1/dsh-mobile-maxxing

纯 DSH 插件，`dsh plugin --profile web add https://github.com/kuraneko1/dsh-mobile-maxxing` 即装，零外部依赖
（README "素の DSH にそのまま入ります"）；做可安装 PWA、Web Push 通知、移动端布局（侧栏抽屉/设置单点/代码换行）、
终端深色、轨迹隐藏等，**全部只增强官方 Web UI**，不改 DSH 源码（README 功能表）。
这证明：官方 Web UI 在手机上可用且可通过 DSH 侧插件增强——**本插件的机器切换补丁能与它叠加**：
用户在手机浏览器/PWA 里既能收到推送，又能切多台装了我们插件的机器。这也是零改码路线最省力的通知补齐方式（尤其 iOS）。

---

## 5. 推荐方案

### 5.1 路线 A（建议先做）：零改码壳 + 装本插件

- **组合**：每台 DSH 装本插件 + 配置同一 relay → 手机装 **saya-ch/dsh-mobile**（Android 首选，Apache-2.0，
  已验证 DSH 0.2.1-rc.2，最活跃）或 **zexadev/dsh-tether**（要 iOS/不想配隧道时选，iroh 直连/回退，支持 0.2.1）；
  可选叠加 **kuraneko1/dsh-mobile-maxxing**（PWA+Web Push）。
- **用户路径**：手机打开电脑 A 的 DSH UI（经壳自己的通道）→ 侧栏/设置出现本插件"远程会话/机器切换"→ 切到 B →
  页面 reload（仍经壳回到 A 的页面骨架）→ 之后 `/api/**` 由本插件经 relay 在 B 执行。**App 零改码。**
- **产品限制（必须写进文档）**：入口机 A 必须在线；这不是"任意在线机器都能直接打开"，而是"从 A 的页面出发控制 B"。
  要消除该限制只能走路线 B（手机自己做 relay 实例）。
- **次优补强**：若愿意给上游提 PR，**april-jk/dsh-mobile-suite** 是最值得移植的壳：WebView+官方 HTTP/SSE/WS 全透传+
  多机+E2EE+可自部署 relay，只需把 Companion 从 DSH 0.1.0-rc.6 迁到 0.2.x（隧道与 DSH 版本解耦，改动集中在其 plugin
  的 settings/Remote Access 面板与 Host/Origin 重写），之后同样能零改码承载本插件。

### 5.2 路线 B（要"任意在线机器可直接打开"时）：手机做 relay 实例

- **首选 sorsama/deepseek-harness-mobile**：按 §3.7 的 4 处改造（RelayClient / `RpcTransport` / mux carrier / 主机 UI），
  DSH 侧零改动；保留审批、提问、终端、文件（走 `native` 全量官方流）。工作量 **中（900–1400 行 Kotlin，1–2 人周）**。
- **次选 Clarklevis1995/dsh-mobile**：功能/平台覆盖最好，`GatewayTransport` 接缝干净，但私有 `dsh-mobile-v1` 需在 DSH 侧
  加桥（其网关插件挂 relay 客户端，或本地 WS 桥插件），**中偏大（2–4 人周）**；需要 iOS 时唯一值得投入的选择。
- 201222-L 除非用户特别偏好 Flutter/其功能集，否则不建议。

### 5.3 工作量汇总

| 方案 | 改 App | 改 DSH 侧 | 工作量 | 保留审批 | 任意机器入口 |
| --- | --- | --- | --- | --- | --- |
| A1 saya-ch + 本插件 | 0 | 0（只装插件） | 极小 | ✅ | ❌ 依赖 A 在线 |
| A2 zexadev + 本插件 | 0 | 0（只装插件） | 极小 | ✅ | ❌ 依赖 A 在线 |
| A3 april-jk + 移植 Companion | 0 | 中（DSH 0.2.x 适配） | 中 | ✅（须先补 UI 审批） | ❌ 依赖 A 在线 |
| B1 sorsama relay transport | 中（900–1400 行 Kotlin） | 0 | 中，1–2 人周 | ✅（走 native） | ✅ |
| B2 Clarklevis relay 桥 | 中偏大（250–350 行 + 注册/配对） | 中偏大（DSH 网关加 relay 客户端） | 中偏大，2–4 人周 | ✅（协议自带） | ✅ |
| C 把 relay 改成 HTTP/WS 反代 | — | 大（重写 relay） | 大 | 取决于壳 | ✅ | 不建议 |

### 5.4 不建议

- 把本 relay 改成 HTTP/WS 反向代理去兼容"Web 壳/PWA 家族"：relay 两端都在 NAT 后、只做出站轮询，改造成长连接隧道
  等于重写产品，且与现有 `/v1/*` 语义冲突。
- 用 yukiykchen 的 fork：无 LICENSE、实验性、单向单机；其价值只是"april-jk 架构的又一实现样本"。

---

## 6. 关键风险

1. **DSH 版本窗口很窄**：本插件要求 `0.2.1-rc.2+`（`package.json:36`），并依赖 `typertGateway.wireStream` /
   `createSharedFetchHandler`（`native-gateway.js:96-98`）。零改码候选里只有 saya-ch、zexadev 明确覆盖 0.2.x
   （kuraneko1 活跃但未声明版本范围，需实测）；
   april-jk（0.1.0-rc.6）、summer1238（0.1.0-rc.7）、hongshuxifan321（旧 WS 路径）、wenbin-wb（≤0.2.0-rc.2）都有代沟。
   官方处于 developer preview，任何适配都应锚定具体版本并做 `probe`/`version` 探测。
2. **"零改码"不等于"客户端直连 relay"**：壳路线强依赖入口机 A 在线，且 A 必须是装本插件的那台 DSH；
   用户若期望"手机连 relay 后任意机器随便开"，必须走路线 B。
3. **审批缺口**：relay RPC 面没有 approval 方法；只实现 `prompt`/`events` 的 App 会丢失审批。
   必须走 `native` 官方载体（`native-gateway.js:111-175`），或在 relay 协议上新增审批 RPC。
4. **推送缺口**：本插件本身无推送；壳路线的锁屏通知取决于壳（april-jk MVP deferred，zexadev 只有待审批通知，
   saya-ch 有系统通知），或叠加 kuraneko1 的 Web Push（浏览器/PWA）。
5. **尺寸/吞吐限制**：`native.fetch` 响应 ≤8MB、流快照 ≤16MB（`native-gateway.js:198,:132`）、relay body ≤64MB
   （`server.cjs:15`）、每客户端 64 请求/128 流；大附件、会话导出、终端高频输出可能触顶。
   流是拉取式长轮询（`pull` 最多等 10s），移动网络下延迟/电量高于 WS。
6. **鉴权模型偏弱**：手机若作为 relay 实例需保存**共享令牌**，等于获得 relay 下所有机器控制权；无设备级撤销/审计；
   SSE 的 token 在 query（`server.cjs:116-119`，nginx 必须关 access log）；relay 明文可见（对比 april-jk 的 E2EE）。
   手机丢失场景需要能一键轮换 relay 令牌。
7. **手机实例的副作用**：`/v1/register` 会向 DSH 广播 `peer online`，桌面 UI 会 probe `version`/`list`；
   手机需应答或优雅失败（本插件对失败容忍，但会显示为 legacy peer）。relay 无离线队列（`409 target_offline`），
   手机需自己补拉。
8. **协议/实现演进风险**：Clarklevis 的 gateway 0.11.x 有多项未发布协议变更；april-jk 的 tunnel 协议 v1 有明确版本化约定；
   sorsama 锁 DSH 0.2.1-rc.2。跟随成本必须计入。
9. **许可证**：除 yukiykchen（无 LICENSE）外均为 MIT/Apache-2.0；若参考/复制 april-jk 或 yukiykchen 代码，
   注意 yukiykchen 是 april-jk 的 fork（`_aux/yukiykchen__dsh-scan-remote/ATTRIBUTION.md`），应当用上游。
10. **WebView 壳的固有不确定**：不同厂商 WebView 版本对 ES 模块/`__DSH_BOOT__`/storage/WS 分片行为不同；
   移动布局可能隐藏本插件注入的侧栏入口。上线前必须真机矩阵验证（Android 10+/iOS 17+、深浅色、横竖屏）。

---

## 7. 附录

### 7.1 仓库元数据（gh api，2026-10-27）

| 仓库 | stars | license | pushed_at | language | size(KB) | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| saya-ch/dsh-mobile | 639 | Apache-2.0 | 2026-10-26 | TypeScript | 48547 | DSH 插件 + Android App |
| Clarklevis1995/dsh-mobile | 660 | MIT | 2026-10-26 | Kotlin | 94475 | KMP；配套 dsh-plugin-mobile-gateway |
| hongshuxifan321/dsh-mobile-app | 103 | MIT | 2026-08-18 | JavaScript | 225 | WebView + 认证反代 |
| 201222-L/dsh-mobile-remote | 89 | MIT | 2026-10-07 | Dart | 5077 | 插件 + Flutter App |
| zexadev/dsh-tether | 79 | MIT | 2026-10-26 | JavaScript | 11059 | Tauri + Rust iroh |
| sorsama/deepseek-harness-mobile | 213 | MIT | 2026-10-22 | Kotlin | 7449 | 官方协议原生客户端 |
| yukiykchen/deepseek-harness-mobile | 53 | 无 | 2026-10-12 | Kotlin | 932 | april-jk 的 fork/实验品 |
| summer1238/dsh-remote-web-gateway | 165 | MIT | 2026-08-28 | TypeScript | 27265 | 透明 Web 网关 |
| wenbin-wb/dsh-bridge | 221 | MIT | 2026-10-26 | JavaScript | 14339 | 反代 + PWA + IM 机器人 |
| april-jk/dsh-mobile-suite | 17 | MIT | 2026-08-18 | — | 372 | 四组件；含可自部署 relay |
| kuraneko1/dsh-mobile-maxxing | 47 | MIT | 2026-10-26 | JavaScript | 4860 | 纯 DSH Web UI 增强插件 |

### 7.2 克隆物与辅助仓库

- 主克隆：`research/apps/repos-mobile/<owner>__<repo>/`（9 个候选 + april-jk suite + kuraneko1 README）。
- `_aux/`：`Clarklevis1995__dsh-plugin-mobile-gateway`、`sorsama__deepseek-harness-relay`、
  `yukiykchen__dsh-scan-remote`、`april-jk__dsh-mobile`、`april-jk__dsh-mobile-plugin`、`april-jk__dsh-relay`
  （suite 的 git submodule 未递归，单独浅克隆）。
- 仅读不构建、不改任何克隆源码；未修改本仓库源码、未提交。

### 7.3 关键证据文件索引

- 本插件：`relay/server.cjs`、`lib/index.js:867-884/1043-1129`、`lib/native-gateway.js:93-201`、
  `lib/native-transport.js:19-51/137-227`、`package.json:36`。
- saya-ch：`src/gateway.ts`、`apps/mobile/android/.../SecureWebViewClient.kt`、
  `README.md:45-60,133-168,284-298,398+`。
- april-jk：`dsh-公共文档/Tunnel-Protocol-v1.md`、`Tunnel-E2EE-v1.md`、
  `_aux/april-jk__dsh-mobile/pubspec.yaml:40` 与 `lib/features/session/{session_webview_page.dart,secure_tunnel.dart}`、
  `_aux/april-jk__dsh-mobile-plugin/src/relay-client.ts:14-37`、plugin `README.md:15,70-72`。
- zexadev：`app/src-tauri/src/lib.rs:127-198`、`tether-core/src/lib.rs:11,256-350`、`host/src/main.rs:146-159`、
  `README.md:20,114-131`。
- hongshuxifan321：`server/plugin/lib/proxy.js:1-60,201-236`、`server/plugin/README.md`、`README.md:21-37`。
- Clarklevis：`_aux/Clarklevis1995__dsh-plugin-mobile-gateway/PROTOCOL.md`、
  `shared/src/commonMain/.../platform/GatewayPlatformContracts.kt:58-72`、
  `androidApp/.../platform/OkHttpGatewayTransport.kt:21-79`、`androidApp/.../AndroidAppGraph.kt:29,57-59`、
  `AndroidMultiGatewayStore.kt:58,430`、`DeepSeekHarnessMobile/Core/GatewayClient.swift:8,331-336`。
- sorsama：`core/src/main/kotlin/.../wire/RpcTransport.kt:61-126`、`wire/RemoteStreamMux.kt:85,249`、
  `wire/dto/StreamProtocol.kt:30-101`、`app/.../connection/{HostConfig.kt,HostsStore.kt,ConnectionManager.kt,RelayPairing.kt}`、
  `README.md:51-67,98-104`、`docs/PROTOCOL.md`。
- 201222-L：`lib/index.js:36,2170`、`dsh-mobile-app/lib/api.dart:29-38,82-102,1097-1175`、
  `docs/09-compatibility.md:13-22`。
- 其他：`summer1238/src/gateway.ts:5,146` + `docs/COMPATIBILITY.md:10-12`；`wenbin-wb/lib/index.js:8,221,579` +
  `lib/tunnel-client.mjs`；`kuraneko1` README；`yukiykchen` `androidApp/.../relay/DshRelayManager.kt` +
  `docs/app-host-protocol.md`。
