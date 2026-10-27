# GitHub DSH App 调研与 dsh-remote-session 插件适配评估报告

> 日期：2026-10-27（Asia/Shanghai） · 调研对象：本仓库 `dsh-remote-session` v1.0.0（DSH 要求 `>=0.2.1-rc.2`，本机基线 DSH `0.2.1-rc.3`）
> 结论可复现：GitHub 数据用已登录 `gh` CLI 取 2026-10-27 快照；代码结论均附文件:行号。未改本仓库源码、未提交。
> 配套子报告（均在 `research/apps/`）：
> - [`01-ecosystem-survey.md`](01-ecosystem-survey.md)：生态全景（60 仓库 / 8 分类 / 22 组搜索口径 / Top9 机制）
> - [`02-mobile-deepdive.md`](02-mobile-deepdive.md)：11 个手机端项目深挖（7 个源码级 + 4 个表格级）
> - [`03-desktop-gateway-integration.md`](03-desktop-gateway-integration.md)：8 个桌面壳 + 5 个 Web/手机网关 + 本机对照实现
> - [`00-plugin-protocol-brief.md`](00-plugin-protocol-brief.md)：本插件协议与接入面速览

---

## 0. 结论先行（TL;DR）

1. **GitHub 上确实有大量 DSH 的 App，但没有官方手机 App。** 官方仓库只有 `apps/desktop`、`apps/desktop-host`、`apps/web`、`apps/cli` 四种形态；Web UI 本身已是可安装 PWA 且做了移动端适配；官方 `packages/sdk` 与 ACP 是 stdio 自动化协议，不是移动端 SDK。社区 App 生态约 2–3 个月大、头部项目几百到两千星，协议高度碎片化（至少 6 套互不兼容的自有协议）。

2. **没有任何公开 App 已经实现"本插件同形态的多机切换"**（同一前端不动、官方 Gateway 协议经 relay 指向另一台机器、会话在目标机运行、原机无感）。最接近的是 `april-jk/dsh-mobile-suite`（App 内多电脑列表 + 可自部署 Relay + E2EE）和 `saya-ch/dsh-mobile`（App 内设备列表切换），但它们的"多机"都发生在 App 层：选另一台电脑、打开另一套 UI，而不是同一 UI 内切机器。跨机插件同步（本插件 `plugin-sync`）同样没有竞品。

3. **适配是可行的，但要按目标分层：**
   - **只想到手机上用（含多机切换）→ 零改码。** 本机已有 `dsh-vps-remote` 公网通道（nginx → SSH 反向隧道 → gate → 本机 DSH Web），它把官方 Web UI 的 HTTP/SSE/WS 整页透传，本插件的前端补丁会随页面一起出现。用手机浏览器/PWA 打开即可获得"远程会话"机器切换，**今天就能验证，0 行代码**。
   - **想要一个 App 壳（仍零改码）→ 选已是 DSH 0.2.1 就绪的"官方 UI 壳"**：`saya-ch/dsh-mobile`（Android，Apache-2.0，已验证 DSH 0.2.1-rc.2）或 `zexadev/dsh-tether`（Android+iOS，Tauri/iroh，支持 0.2.1）。把本插件装在它连接的 Host 上即可，App 一行不改。
   - **想要原生 App 直连 relay、任意在线机器直接开 → 需要改 App**：首选 `sorsama/deepseek-harness-mobile`（它实现的正是官方 HTTP + `/api/remote.mux` 协议，与本插件 `native` 载体一一对应；DSH 侧零改动，手机侧约 900–1400 行 Kotlin，1–2 人周）；需要 iOS 时选 `Clarklevis1995/dsh-mobile`（KMP，传输层接口干净，但私有协议需 DSH 侧搭桥，2–4 人周）。
   - **桌面 App 直接装本插件**：`dataelement/dsh-desktop`、`dsh-tauri/deepseek-harness-desktop`、`anywhere-labs/dsh-desktop`（compatibility 模式）兼容性最高（内核恰为 0.2.1-rc.2/rc.3 + 官方 UI + 官方插件机制）。
   - **不建议**：把本插件 relay 改成 HTTP/WS 反代去兼容"Web 壳家族"；给 april-jk 的私有 E2EE 隧道换 relay；在自绘 UI 桌面壳（如 RongleCat/deepseek-app）上适配。

4. **最大的三个功能缺口**：① 高层 relay RPC 没有审批（approval）方法——只用 `list/prompt/events` 的原生 App 会丢审批，必须走 `native` 官方事件流；② 没有推送；③ relay 是共享令牌模型，无 E2EE、无设备级撤销/审计（对比 april-jk 的账号+设备+E2EE）。

5. **现网事实（本机）**：relay 已配置且在线 3 台（home / company / server，会话索引 33 / 60 / 1），说明多机 relay 已实际部署；但线上 relay 的 `GET /health` **未鉴权就返回实例清单**（仓库版 `relay/server.cjs:153-155` 只返回 `{ok:true}`），说明线上部署与仓库版本不一致，建议核对并收紧。详见 §8。

---

## 1. 调研问题、范围与方法

**问题**：① GitHub 上有没有 DSH 的 App？② 能否与当前 `dsh-remote-session` 插件适配、怎么适配、代价多大？

**范围**：与 DeepSeek Harness（dsh）相关的 App/客户端/远程访问/打包分发项目；纯插件（皮肤、桌宠、侧边栏增强等）只在必要时作为增强提及。

**方法**：
- 元数据与 README：已登录 `gh` CLI（`gh search repos`、`gh api repos/...`、README raw），22 组搜索口径，去重 644 个仓库 → 关键词筛 538 → 人工核对 74 → 73 份 README；最终表格收录 60 个仓库。
- 源码级分析：`git clone --depth 1` 17 个候选/组件仓库（桌面 8、手机 9+辅助、Web 网关 4），只读分析，不安装、不构建。
- 本机事实：读取本机 DSH 安装版本、profile 插件清单、relay 设置（只读，不打印令牌）、`dsh-vps-remote` 源码、`/remote-session/api/state`（被 DSH 鉴权栅栏 403，属预期）。
- 只读纪律：未修改本仓库源码、未提交 commit；克隆物仅在 `research/apps/repos-*/`。

**可信度说明**：star/更新时间为 2026-10-27 快照；协议结论均有文件:行号；标注"待验证"的条目未做真机/端到端验证。

---

## 2. 事实基线

### 2.1 本插件如何工作（一页版）

```
浏览器（宿主官方 Web UI + 本插件 client 补丁）
  │ 同源 HTTP：/api/**（官方 Gateway）、/remote-session/api/*（本插件）
  ▼
DSH 实例 A（插件 Host 端 lib/index.js）
  │ POST /v1/{register,index,publish,peers}   GET /v1/stream (SSE)
  ▼
自建 relay（relay/server.cjs，共享令牌，内存态、不落盘）
  ▲
  │ 同上（消息总线）
DSH 实例 B（同一插件）── 插件把官方 Gateway 协议经 relay 透传给 A 的页面
```

- **机器切换**：页面把选中 peerId 写入 `sessionStorage['dsh.remote-session.machine.v1']`，然后整页 reload（`lib/native-transport.js:29-51`）；reload 后本插件劫持同源 `fetch` 与 `__DSH_TRANSPORT__.fetch/openStream`，把 `/api/**` 改为 relay RPC `native` 转发到 B 执行（`lib/native-transport.js:137-227`）。
- **relay 协议**：`GET /health`、`GET /v1/stream?id&token`（SSE，20s 心跳）、`POST /v1/register`、`/v1/index`、`/v1/publish`、`/v1/peers`；SSE 事件 `ready/peer/peer.index/message`；共享令牌鉴权（`relay/server.cjs`）。
- **relay RPC**（`lib/index.js:1085-1110`）：`version/list/transcript/events/fork/attachment/fileReferences/workspaces/commands/openPath/files/create/feedback*/goalAction/permissionCatalog/permissionSet/executeCommand/prompt/cancel/models/selectModel/pluginSync` 以及核心透传 `native`。**没有 approval 方法**。
- **`native` 载体**（`lib/native-gateway.js:93-201`）：`probe/fetch/open/pull/uplink/close/cancel/release`，把官方 `connection.createSharedFetchHandler('/api')` 与 `typertGateway.wireStream` 完整搬到 relay 对端；限制：单请求 ≤64、单客户端 ≤128 流、流快照 ≤16MB、HTTP 响应 ≤8MB、客户端 60s 空闲回收。
- **客户端硬依赖**（`lib/native-transport.js:56-135`）：页面必须有官方 `__DSH_BOOT__` 客户端组合图（过滤后仍须含 `dsh-remote-session`、`@deepseek-ai/dsh-client-ui-workspace`、`@deepseek-ai/dsh-api-session-controller`）；`sessionStorage` 存机器选择；`localStorage` 被 Proxy 按机器命名空间隔离（`defineProperty` 失败会抛错终止 boot）；启动即用 `crypto.randomUUID`，probe 用 `AbortSignal.timeout`。
- **UI 注入点**（`lib/client.js:542-560`）：`sidebar.footer.action`（环境状态）、`sidebar.panellist`（机器/会话菜单，菜单宽 288px `client.js:220`）、`settings.section`（Relay 配置 + 插件同步）。
- **版本门槛**：`package.json:36` `dsh >= 0.2.1-rc.2`；本机 DSH `0.2.1-rc.3`，满足。插件自身版本 1.0.0（部分调研材料误写为"要求 DSH 1.0.0"，以此处为准）。

**三个外部接入面**（适配的出发点）：
1. **透明 Web UI 壳**：App 把宿主官方 DSH 页面整页透传给 WebView/浏览器。页面自带本插件补丁 → 机器切换 UI 随页面出现；切机后 `/api` 走 relay。**App 零改码，但入口机 A 必须在线**（页面骨架来自 A）。
2. **relay RPC 客户端**：App 自己实现 relay 协议（共享令牌 + SSE + RPC 信封），注册成一个 peer，直接读写远端会话；不需要官方 Gateway，**但没有审批**（除非扩展协议）。
3. **`native` 载体客户端**：App 实现官方 Gateway 客户端协议（fetch + mux 流），等价于把官方前端协议搬进 App；审批/提问/终端/文件全保留，但工程量大且必须跟随 DSH 协议演进。

### 2.2 本机环境事实（为什么"适配"有现实基础）

- **多机 relay 已在跑**：`$DSH_HOME/remote-session-settings.json`（只读核对，不打印令牌）显示本机实例 `home`（"家里"），relay 地址为自建 HTTPS；线上 relay `/health` 显示 `home`、`company`、`server` 三台在线（会话索引 33 / 60 / 1）。即：**公司机器、服务器都已接入**，本插件的核心能力已实际使用。
- **手机远程通道已在跑**：本机另有 `dsh-vps-remote` 插件（不在 GitHub）：`https://dsh.gaolin.xin` → nginx（TLS）→ `ssh -R` 隧道 → 本机 gate `127.0.0.1:17864` → DSH Web。本机 17864/17865 正在监听、ssh 隧道进程存在；gate 对未登录请求返回 401（预期）。其 `lib/gate.js:599-671` 代理 HTTP/SSE，`:681-724` 代理 WebSocket 升级，`:42` 注入 `__DSH_TRANSPORT__={ownsHost:true}`，`:610-618` 重写 Host/Origin/Referer 并注入私有 DSH cookie。
- **官方 Web UI 移动端就绪**：官方 `apps/web/index.html` 带 PWA manifest、`mobile-web-app-capable`；官方有 `isMobileDevice()` 与移动端设置横条；`apps/web/public/manifest.webmanifest` 为 `display:standalone`。
- **推论**：手机浏览器打开现有公网入口时，页面会加载宿主官方 UI（含本插件客户端）→ **"远程会话"与机器切换入口今天就应该可用**；本文 §7 的 P0 就是验证这一点。若成立，则"在手机上用 DSH（含多机切换）"已经不需要任何 App。

### 2.3 官方 DSH 的"App 形态"与协议

- **官方 App 形态**：`apps/desktop`（Electron 桌面）、`apps/desktop-host`、`apps/web`（浏览器 GUI，可 PWA）、`apps/cli`。官方仓库 45 个公开仓库中没有移动端项目。
- **官方文档化的远程访问**：`dsh --profile web` 支持反向代理发布（`--public-url`、`--trusted-host`、TLS），`docs/user/guide/public-deployments.md` 明确代理必须保留 Host、剥离前缀、转发 WebSocket、重写 cookie 作用域。这是社区所有"远程访问插件"的官方基础。
- **官方客户端协议（事实标准）**：Typert API Gateway（`docs/api-gateway.md`）：`@Remote` 方法 → `POST /api/<namespace>/<method>`；流 → 多路复用 `/api/remote.mux` WebSocket；官方 Web 前端即用此协议。**这就是社区原生 App 在逆向/复刻的协议**。
- **官方 SDK / ACP（不是移动端方案）**：`packages/sdk/protocol` 是换行分隔的 JSON-RPC 2.0，跑在调用方自备字节流上（官方服务端插件通过 **stdio** 提供）；方法含 `initialize/session.prompt/session.resume/session.wait/...`，服务端→客户端含 `approval/request`、`user-question/ask`、`session.event` 等；`dsh --profile acp` 同理且刻意不带 UI 语义。结论：**官方有"客户端协议"，但没有"移动端 SDK/App 协议"，也没有网络化网关**——所以社区生态才碎片化。
- **对适配的含义**：不存在"对接官方 App 协议"这条捷径；要么复用官方 **Web 前端**（零改码壳），要么在 App 里复刻官方 Gateway 协议（重），要么走本插件自己的 relay RPC（中，但缺审批）。

---

## 3. GitHub 生态全景（节选自 `01-ecosystem-survey.md`）

### 3.1 分类总览

| 类别 | 收录数 | 代表项目 | 与本插件的关系 |
| --- | --- | --- | --- |
| ① 手机远程控制客户端 | 12 | april-jk/dsh-mobile-suite、saya-ch/dsh-mobile、Clarklevis1995/dsh-mobile | 竞品/潜在客户端 |
| ② 手机本地运行 DSH（内嵌运行时） | 14 | DSH-APP/DSHA(2.4k★)、kelai141/dsh-mobile-apk(900★)、WSK-build/DSHBox | 潜在 relay 节点（能装插件的话） |
| ③ 桌面端 App/外壳 | 15 | anywhere-labs/dsh-desktop(33k★)、dataelement/dsh-desktop(17k★)、dsh-tauri(3.3k★) | 本插件宿主 |
| ④ Web/手机网页远程访问 | 7 | dsh-pocket(2.4k★)、dsh-bridge、dsh-remote-web-gateway | 零改码壳 |
| ⑤ P2P / 自建 Relay | 5 | liguobao/ds-harness-remote(882★)、april-jk/dsh-relay、flymysql/dsh-remote | 架构参照/竞品 |
| ⑥ 官方仓库与官方 App 相关 | 6 | deepseek-ai/deepseek-harness(262k★)、docs/api-gateway.md | 协议来源 |
| ⑦ Web UI 移动优化 / PWA | 4 | kuraneko1/dsh-mobile-maxxing、mexiaosqwq/dsh-web-mobile | 可在手机上增强本插件入口 |
| ⑧ 鸿蒙 / 多端 / 非 Windows 桌面 | 5 | QinpanWan/dsh-harmonyos-pc、hnmrxz/...-HarmonyOS | 分发面扩展 |

### 3.2 与本插件相关度最高的项目（详见子报告）

| 项目 | ★ | 许可 | 形态/机制 | 相关度 |
| --- | --- | --- | --- | --- |
| april-jk/dsh-mobile-suite | 17 | MIT | Flutter WebView App + DSH Companion + 可自建 Relay（出站 WSS、E2EE、多电脑列表、App 内打开官方 UI） | 高：架构最像本插件，但协议私有、DSH 基线 0.1.0-rc.6 |
| saya-ch/dsh-mobile | 639 | Apache-2.0 | Android WebView App + HTTPS 反代插件；多设备列表切换；多通道（LAN/Tailscale/FRP/cloudflared） | 高：零改码壳首选 |
| Clarklevis1995/dsh-mobile | 660 | MIT | KMP 原生 iOS/Android + `dsh-plugin-mobile-gateway` 私有 WS 协议 | 高：原生体验最好，需搭桥 |
| sorsama/deepseek-harness-mobile | 213 | MIT | Android 原生 Kotlin，直接实现官方 HTTP + `/api/remote.mux` 协议 | 高：改 relay 客户端首选 |
| zexadev/dsh-tether | 79 | MIT | Tauri App + iroh P2P + 回退 relay；官方 UI 逻辑代理；支持 0.2.1 | 高：零改码次选（含 iOS） |
| liguobao/ds-harness-remote | 882 | 无 LICENSE | P2P/TURN/Relay 四级 + Android/iOS/Web 客户端 | 高：竞品/架构参照，不适用零改码 |
| shaobeichen/dsh-pocket | 2436 | GPL-2.0 | 插件 + 本机反代 + cloudflared；整页透传官方 UI | 高：零改码组合候选 |
| summer1238/dsh-remote-web-gateway | 165 | MIT | 插件 + 透明反代 + CF Tunnel + 设备授权 | 中高：路径不变、安全模型好；内核旧 |
| wenbin-wb/dsh-bridge | 221 | MIT | 插件 + 反代 + 隧道 + PWA + IM Bot | 中高：透传齐全、复杂度高 |
| dataelement/dsh-desktop | 17k | MIT | Electron 桌面壳，固定 DSH 0.2.1-rc.2 + 官方 Web UI + 插件机制 | 高：桌面宿主首选 |
| dsh-tauri/deepseek-harness-desktop | 3.3k | MIT | Tauri 桌面壳，官方 UI，支持换内核；CI 出 Android/unsigned iOS 构建 | 高：桌面宿主首选/多端 |
| anywhere-labs/dsh-desktop | 33k | MIT | Electron + 桌面本身是 DSH 插件；compatibility 模式复用官方 UI | 高（仅 compatibility） |
| kuraneko1/dsh-mobile-maxxing | 47 | MIT | 纯 DSH 插件：PWA、Web Push、移动 UX | 中：与本插件叠加补推送 |
| DSH-APP/DSHA | 2428 | MIT | 手机内嵌 Ubuntu/PRoot 跑 DSH（本地运行，非远程客户端） | 中：潜在 relay 节点 |

### 3.3 生态层面的四个判断

1. **"单 UI 内多机原地切换"无竞品**：现存多机产品全是"App/插件层换一台电脑连"或"挂远端 UI"。本插件"同一前端、官方 Gateway 经 relay 指向目标机、会话在目标机跑"仍是空白，建议在 README/宣传中直接对标 april-jk/saya-ch 说明差异。
2. **没有官方 App 协议 = 适配层机会**：至少 6 套互不兼容的自有协议；本插件若提供"relay 多机 + 官方协议"能力，可作为多类 App 的通用后端，或反向做 App 适配器。
3. **跨机插件同步无人做**：生态只有单机插件市场/启动器，`plugin-sync` 是第二个硬差异点。
4. **版本碎片是最大阻力**：大量 App/壳内置 DSH 0.1.x/0.2.x，且官方 developer preview 明确会破坏兼容；适配必须以 `version`/`probe` 探测锚定具体版本。

---

## 4. 手机端 App 深挖与适配矩阵（节选自 `02-mobile-deepdive.md`）

### 4.1 判定规则

**零改码壳**必须同时满足：① App 把宿主官方 DSH Web UI **整页**透传（HTML + 静态资源 + 插件 client bundle + `/api/**` + 官方 WS/SSE，路径不加前缀）；② 其 DSH 侧组件能运行在 **DSH 0.2.1-rc.2+**；③ WebView 允许 `localStorage/sessionStorage`；④ 切机 reload 后仍经同一壳加载页面。否则必须改客户端网络层。

### 4.2 候选对比（11 个）

| 仓库 | ★/许可/最近 push | 平台/栈 | 客户端协议 | 多机 | 零改码壳 | 改网络层 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| saya-ch/dsh-mobile | 639/Apache-2.0/10-26 | Android WebView+浏览器；TS 插件 | 官方 HTTP/WS 透传 | ✅ 设备列表 | ✅（0.2.1-rc.2 已验证） | 大 | **零改码首选** |
| zexadev/dsh-tether | 79/MIT/10-26 | Android+iOS；Tauri+Rust iroh | iroh QUIC/TLS 隧道 HTTP/WS | ✅ Hosts | ✅（支持 0.2.1） | 大 | **零改码次选（含 iOS）** |
| april-jk/dsh-mobile-suite | 17/MIT/08-18 | Android(+iOS) Flutter WebView | 私有 WSS 隧道 + E2EE | ✅ | ✅结构/❌ DSH 基线 0.1.0-rc.6 | 大（不建议换 relay） | 移植 Companion 后值得 |
| hongshuxifan321/dsh-mobile-app | 103/MIT/08-18 | Android WebView+PWA | 官方 HTTP/WS 透传（WS 白名单旧路径） | ❌ | ⚠️ 需 1 行补丁 | 大 | 备选 |
| summer1238/dsh-remote-web-gateway | 165/MIT/08-28 | 浏览器/PWA；TS 插件 | 透明反代（路径不变） | ❌ | ⚠️ DSH 0.1.0-rc.7 基线 | 大 | 浏览器路线备选 |
| wenbin-wb/dsh-bridge | 221/MIT/10-26 | 浏览器/PWA + IM Bot | 反代 + HTML 注入 | ❌ | ⚠️ ≤0.2.0-rc.2 | 大 | 浏览器路线；IM 互补 |
| sorsama/deepseek-harness-mobile | 213/MIT/10-22 | Android 原生 Kotlin | **官方 HTTP + `/api/remote.mux`** | ✅ | ❌ | **中（最优）** | **改网络层首选** |
| Clarklevis1995/dsh-mobile | 660/MIT/10-26 | Android+iOS；KMP 原生 | 私有 `dsh-mobile-v1` WS | ✅ | ❌ | 中偏大 | 要 iOS 才值 |
| 201222-L/dsh-mobile-remote | 89/MIT/10-07 | Android Flutter 原生 | 私有 `/m` HTTP+SSE | ❌ | ❌ | 中偏大 | 优先级低 |
| yukiykchen/deepseek-harness-mobile | 53/无 LICENSE/10-12 | Android/iOS/鸿蒙 | fork april-jk 插件 | ❌ | ❌ | 中偏大 | 只作参考（无许可） |
| kuraneko1/dsh-mobile-maxxing | 47/MIT/10-26 | 浏览器/PWA（纯 DSH 插件） | 官方 UI 增强（PWA/Web Push/移动 UX） | 需本插件 | ✅（佐证） | — | **与本插件叠加补推送** |

### 4.3 零改码壳的关键结论

- **saya-ch/dsh-mobile（首选）**：插件在本机起独立 HTTPS 网关（默认 3443）反代官方 UI，Android App 是 WebView 壳（`apps/mobile/android/.../SecureWebViewClient.kt:68`），本插件只用同源 `/api`，不会被它"第三方 WS 默认拦截"的策略挡住（`README.md:294-298`）；兼容表覆盖 DSH `0.2.1-rc.2`（`README.md:398-425`），本机 `0.2.1-rc.3` 有 rc.2 基线。把本插件装到它连接的 Host → 手机 App 内官方 UI 会出现本插件机器切换。
- **zexadev/dsh-tether（要 iOS 选它）**：App 起本机 HTTP 代理，把 WebView 的请求经 iroh 转发到宿主官方 UI（`app/src-tauri/src/lib.rs:192-198`）；支持 DSH 0.1.0-rc.7…0.2.1（`README.md:20,140`）。零改码成立，需实测双隧道叠加延迟与 Tauri WebView storage。
- **april-jk/dsh-mobile-suite（结构最佳但被版本卡住）**：App 是 Flutter WebView（`_aux/april-jk__dsh-mobile/pubspec.yaml:40`），Companion 把官方 HTTP/SSE/WS 全透传并重写 Host/Origin（`dsh-公共文档/Tunnel-Protocol-v1.md`），还带 E2EE 与多电脑列表；但 Companion 测试基线是 **DSH 0.1.0-rc.6**，与本插件要求的 0.2.1-rc.2 相差一代 → 当前无法同机。把 Companion 移植到 0.2.x 属小-中工作量（隧道与 DSH 版本解耦），**值得给上游提 PR**，之后它就是最理想的零改码壳。
- **hongshuxifan321** 结构可行但 WS 白名单写死 `/api/events.{mux,host}`，DSH 0.2.x 的 `/api/remote.mux` 会被自己拦掉，需 1 行级补丁；**summer1238 / wenbin-wb** 是浏览器/PWA 且版本偏旧，适合桌面浏览器而非 App。
- **kuraneko1/dsh-mobile-maxxing** 是"官方 UI 可移动化、可增强"的佐证：纯 DSH 插件即可加 PWA、Web Push、移动布局，与本插件不冲突，可作为手机端通知补齐方案（尤其 iOS PWA）。

### 4.4 "改客户端网络层"路线

**首选 sorsama/deepseek-harness-mobile**：
- 它直接实现官方协议：一元 `POST /api/<namespace>/<method>`（`core/.../wire/RpcTransport.kt:61-126`）、实时双向 WS `/api/remote.mux`（`wire/dto/StreamProtocol.kt:40`）；与本插件 `native` 的 `fetch` 与 `open/pull/uplink` 一一对应。
- **DSH 侧零改动**（`native` 已把官方 `/api` 与 mux 流透传给任意 relay peer）；手机侧需 4 处：`RelayClient`（register/SSE/publish + rpcId 关联，约 300–450 行）+ `RelayRpcTransport`（约 150–250 行）+ mux 的 relay carrier（约 200–300 行）+ relay 主机配置/配对 UI（约 150–250 行），合计 **900–1400 行 Kotlin，1–2 人周**。
- 走 `native` 能保留审批、提问、终端、文件等完整官方能力；风险：`native.fetch` ≤8MB、流快照 ≤16MB、`pull` 为长轮询（≤10s 等待），大附件/高频终端输出需调参或分块。
- 锁 DSH 0.2.1-rc.2，与本插件基线一致（双方都需随官方协议升级）。

**次选 Clarklevis1995/dsh-mobile**：
- 产品最完整（Android+iOS，KMP 原生 UI，会话/审批/文件/插件/定时/多网关/通知）。
- 传输层干净：`GatewayTransport` 接口 + OkHttp/Swift 实现 + DI 可替换（`shared/.../GatewayPlatformContracts.kt:58-72`、`AndroidAppGraph.kt:29,57-59`），新增 relay transport 约 250–350 行；但其协议是私有 `dsh-mobile-v1`，**DSH 侧必须加桥**（给 `dsh-plugin-mobile-gateway` 加 relay 客户端，或写本地 WS 桥插件），合计 2–4 人周。需要 iOS 时这是唯一值得投入的选择。
- 201222-L（Flutter 私有 `/m` HTTP+SSE）改造成本中偏大、价值低，除非特别偏好其功能集。

---

## 5. 桌面 App 与 Web 网关（节选自 `03-desktop-gateway-integration.md`）

### 5.1 本插件对宿主的硬性要求

- **Host 半**：DSH ≥0.2.1-rc.2；必须有 `webServer/sessionController/agents/connection/typertGateway/clientModules`（缺一个整插件加载失败，`lib/index.js:33`）；必须支持 `webserver/index-inject` 注入（`lib/index.js:255-257`）与 `/remote-session/api` 前缀路由注册（`lib/index.js:1545-1549`）；必须能通过 profile bundle 安装。
- **Client 半**：页面必须有官方 `__DSH_BOOT__` 且可被过滤改写；`__DSH_TRANSPORT__` 可写（`native-transport.js:225-226`）；同源相对 API；可用的 `localStorage/sessionStorage`；`crypto.randomUUID`；切机整页 reload 可重复。
- **三条否决线**：A 内核 <0.2.1-rc.2 / 无 `typertGateway`；B 自绘 renderer（无官方 `__DSH_BOOT__`）；C 页面 HTML 不经官方 index 注入或路由到不了 Host。

### 5.2 桌面 App 兼容性

| App | 内核 | 官方 UI/`__DSH_BOOT__` | 插件安装 | 装本插件可用性 |
| --- | --- | --- | --- | --- |
| dataelement/dsh-desktop（17k★） | 固定 0.2.1-rc.2 | 是 | 官方 profile + `dsh plugin` | **高** |
| dsh-tauri/deepseek-harness-desktop（3.3k★） | 固定 0.2.1-rc.2（可换内核） | 是（preload 注入官方前端） | 本地/npm/github/社区市场 | **高** |
| anywhere-labs/dsh-desktop（33k★） | 0.2.1-rc.3 | 是（仅 compatibility 模式原样上游） | 官方 profile + dshmarket | **高（compatibility）/中低（extended/advanced）** |
| ningbainb/deepseek-harness-desktop（870★） | 0.2.1-rc.2 | 是，但自定义 `dsh-runtime://app` 协议 + 自管 transport | 插件中心 | 中（需实测 path 转发/transport 覆盖） |
| whitelonng/dshcode（700★） | 0.1.2-alpha.4 | 是 | 有 | 低（无 typertGateway） |
| vibeinging/dsh-desktop（485★） | 0.1.5-rc.1 | 是 | 有 | 低（版本门槛） |
| chokwinlee/deepseek-harness-desktop（284★） | 0.1.5-rc.2 | 是 | 有 | 低（版本门槛） |
| RongleCat/deepseek-app（34★） | 0.1.0-rc.6 | **否**（自绘 renderer） | Host 插件卡片 | 不可行 |

**落地**：首选 dataelement 或 dsh-tauri 做"安装 → 切机 → 远端会话"三步 smoke；anywhere-labs 必须写明"仅 compatibility 模式"（extended/advanced 用自有 root 替换官方 frame，`@deepseek-ai/dsh-client-ui-layout` 不在 boot 图，本插件 UI 无处挂载）。

### 5.3 Web/手机网关兼容性

| 方案 | 机制 | 零改码结论 | 主要卡点 |
| --- | --- | --- | --- |
| **本机 dsh-vps-remote（对照实现）** | nginx → ssh -R → gate → `dsh web`；HTTP/SSE/WS 全代理，Host/Origin 重写，注入私有 cookie 与 transport pin | **已验证同构可行**（`lib/gate.js:42,599-724`） | 需自备 VPS/SSH；无 polyfill（依赖 HTTPS 现代浏览器） |
| shaobeichen/dsh-pocket（2.4k★） | 插件起本机反代 + cloudflared；带 `crypto.randomUUID`/`AbortSignal.any` polyfill、launch-token 握手、SSE 跳过压缩、WS 透传 | **高** | 其 transport shim 会把 `ownsHost` 强写 true，覆盖本插件远端页面的 `ownsHost:false`（影响官方设置页语义，不影响本插件 API）；未 polyfill `AbortSignal.timeout` |
| wenbin-wb/dsh-bridge（221★） | 插件反代 + 隧道 + PWA + IM Bot；loopback cookie、polyfill、SSE keepalive | **中高** | 复杂度高；ownsHost pin 需实测；只解决单机 |
| summer1238/dsh-remote-web-gateway（165★） | 独立 gateway + DSH 插件；`http-proxy-3` 路径不变；配对票据 + JWT 设备撤销；处理 launch-token | **中高** | 无 transport shim/polyfill、无移动适配；依赖 DSH `authenticatedUrl`（peerDeps 仍 ^0.1.0-rc.5，版本漂移风险） |
| april-jk/dsh-mobile-suite（17★） | 出站 WSS Relay + E2EE + 本地 loopback WebView 网关 | **高潜力（未真机）** | Companion 只测到 DSH 0.1.0-rc.6；WebView origin 每次会话变化（`127.0.0.1:<ephemeral>`）导致 storage 不持久 |
| liguobao/ds-harness-remote（882★） | P2P/WebRTC/Relay + 原生客户端（Typert allowlist） | **不适用** | 不是官方 UI 透传，而是重写客户端；与本插件自定义路由/client bundle 不共存 |

**零改码组合结论**：宿主装本插件 + 手机浏览器/WebView 走"同源整页反代"完全成立；四件事全部满足：① HTML 由宿主 `dsh web` 生成 → `__DSH_BOOT__` 含本插件条目；② 路径不变 → `/remote-session/api/*` 原样到 Host；③ 同源 + Host/Origin 重写 → `requestRejection` 不 403；④ 整页 reload 可重复 → `switchMachine()` 在手机上工作。
**组合排序（风险从低到高）**：`dsh-vps-remote`（已验证，需 VPS）→ `dsh-pocket`（一键扫码 + polyfill，但 ownsHost 覆盖）→ `dsh-bridge`（透传全，复杂度高）→ `summer1238`（安全模型最好，无 polyfill/移动适配）→ `april-jk`（架构最干净 + E2EE，待真机与版本移植）。

---

## 6. 适配方案设计（本报告综合判断）

### 6.1 判定框架：App 分四类，路线分五条

| App 类型 | 例子 | 能做的事 | 适配路线 |
| --- | --- | --- | --- |
| A. 远程 Web UI 壳（整页透传官方 UI） | saya-ch、zexadev、april-jk、dsh-pocket、dsh-bridge、summer1238、dsh-vps-remote | 零改码获得本插件机器切换（页面自带补丁） | 路线 A |
| B. 官方 UI + 插件宿主（桌面/本地运行） | dataelement、dsh-tauri、anywhere-labs、DSH-APP/DSHA、kelai141 | 装本插件即成为 relay 节点/宿主 | 路线 D |
| C. 原生协议重写 App | sorsama、Clarklevis、201222-L、hongshuxifan | 需改客户端网络层才能接 relay | 路线 B |
| D. 自绘/非官方 UI | RongleCat/deepseek-app、liguobao 原生客户端 | 本插件前端无加载入口 | 不适用（或路线 C） |

### 6.2 路线 A：零改码壳（推荐先做，0 行代码）

- **A1 手机浏览器/PWA + 现有 `dsh-vps-remote`（本机今天可用）**：手机打开现有公网 HTTPS 地址 → 宿主官方 UI 加载 → 侧栏出现"远程会话"→ 选目标机器 → 整页 reload → `/api/**` 经 relay 在目标机执行。可配合官方 PWA（添加到主屏幕）与 `kuraneko1` 类插件补推送。
- **A2 App 壳 + 本插件**：`saya-ch/dsh-mobile`（Android 首选）或 `zexadev/dsh-tether`（含 iOS）；把本插件装到它连接的 Host 即可。App 一行不改。
- **A3 april-jk 移植（可选，需上游 PR）**：把其 Companion 从 DSH 0.1.0-rc.6 迁到 0.2.x，之后获得"WebView + E2EE + 多电脑列表 + 本插件机器切换"的最完整组合。
- **硬限制（必须写进文档）**：入口机 A 必须在线。这是"从 A 的页面出发控制 B"，不是"任意在线机器直接打开"。

### 6.3 路线 B：原生 App 作为 relay 客户端（要"任意在线机器直接开"时）

- **B1 首选 sorsama**：按 §4.4 的 4 处改造；DSH 侧零改动；1–2 人周；保留审批/提问/终端/文件（走 `native`）。
- **B2 次选 Clarklevis**：功能最全、有 iOS，但需 DSH 侧桥 + 私有协议，2–4 人周。
- **协议映射（sorsama ↔ 本插件 `native`）**：`POST /api/<ns>/<method>` ↔ `fetch`；`/api/remote.mux` 的 `open/item/end/cancel` ↔ `open/uplink/pull/close`；`$events` 流 ↔ `open {endpoint:'$events'}`。
- **能力缺口**：若只用高层 relay RPC（`list/prompt/events`），则无审批、无提问、无终端；必须在 App 内实现 `native` 官方载体（较重但完整），或走路线 C 给插件补审批 RPC。

### 6.4 路线 C：插件侧增加"App 网关"（想同时支持多类 App/自研 App 时）

- 在 relay/插件侧新增面向移动端的能力：
  1. **审批 RPC**：Host 插件注册 `approval/request` waterfall 的远端 answerer，把 pending 请求经 relay 广播给已授权 App，App 回 `approval.answer`；需处理"官方 UI 与 App 同时在线"的应答者冲突（单终端 answerer 原则，`docs/subsystems/approval.md`）。
  2. **推送通道**：事件钩子（审批/完成/报错）→ Web Push / ntfy / Server酱 / Bark 等。
  3. **设备级鉴权**：共享令牌之外增加设备票据、撤销、审计（参照 april-jk/liguobao 模型）。
  4. 可选：给 relay 增加一个轻量 REST/WS 适配面，把 `list/transcript/events/prompt` 暴露为 App 友好的接口（不改变现有 `/v1/*` 语义）。
- **工作量**：约 1–2 周，但收益是"任意 App 都能接"，且补上审批/推送两个关键缺口。适合作为产品化二期。

### 6.5 路线 D：把 App/桌面壳变成 relay 宿主

- 桌面 App（dataelement/dsh-tauri/anywhere-labs）装本插件即可作为一台 relay 节点，与现有 home/company/server 互通。
- 手机"本地运行 DSH"类 App（DSH-APP/DSHA、kelai141、thness 等）若能装第三方插件，可以让**手机本身成为 relay 里的一台机器**（桌面端可远程打开手机上的工作区/会话）；但多数内置 DSH 为 0.2.x、插件安装支持不一，需逐个验证。
- 价值：把"手机控制电脑"扩展为"手机与电脑互为节点"，是生态里没人做的方向。

### 6.6 路线 E（远期）：官方 SDK 协议桥

- 官方 SDK（`packages/sdk`，stdio 换行 JSON-RPC：`initialize/session.prompt/session.resume/...`，含 `approval/request`、`user-question/ask`、`session.event`）语义最完整。
- 若把它经 relay 承载（或把 SDK server 挂在插件内），App 可获得官方级审批/提问语义；但 SDK server 是独立 profile/进程模型，与桌面 profile 的会话所有权（session.lock 单写者）需要设计，工程量大，建议仅作为长期方向。

### 6.7 方案对比

| 方案 | 改 App | 改 DSH 侧 | 工作量 | 保留审批 | 任意机器入口 | 推送 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 现有浏览器/PWA | 0 | 0 | **0（今天可验）** | ✅（官方 UI） | ❌ 依赖入口机在线 | 靠 PWA 增强 |
| A2 saya-ch / zexadev 壳 | 0 | 0 | 极小（装插件） | ✅（官方 UI） | ❌ 依赖入口机在线 | 壳自身（saya-ch 有系统通知） |
| A3 april-jk 移植 | 0 | 中（Companion 0.2.x） | 中 | ✅ | ❌ | 需自加 |
| B1 sorsama + relay transport | 中（900–1400 行 Kotlin） | 0 | 中，1–2 人周 | ✅（走 native） | ✅ | 需自加/走原生通知 |
| B2 Clarklevis + relay 桥 | 中偏大 | 中偏大 | 2–4 人周 | ✅（协议自带） | ✅ | ✅（原生） |
| C 插件侧 App 网关 | 0（对现有 App 仍需适配） | 中（1–2 周） | 中 | ✅（补 RPC） | ✅ | ✅（可补） |
| D App/桌面壳宿主 | 0 | 0 | 极小 | ✅ | — | — |
| E SDK 协议桥 | 中 | 大 | 大 | ✅ | ✅ | — |

---

## 7. 推荐路线与执行计划

### P0（今天可做，0 代码）——验证"手机 + 本插件多机"已经可用
1. 手机浏览器打开现有公网地址（`https://dsh.gaolin.xin`，或局域网直连），登录/配对；
2. 确认页面出现本插件注入的"环境状态/远程会话"入口（可能需要先拉出侧栏抽屉）；
3. 打开宿主 `/remote-session/api/state`（页面内已验证同源），确认返回 `{ok:true, relay:{connected:true}, peers:[home,company,server]}`；
4. 选择 `company`/`server` → 整页 reload → 确认会话列表与工作区来自目标机；发一条只读 prompt 验证流式输出；切回本机确认草稿/主题不串。
5. 若 1–4 全部通过：**"GitHub DSH App 适配"对手机使用场景已无必要**，只需文档化入口与限制（入口机在线、移动 UI 入口位置、新窗口默认本机）。

### P1（1–3 天）——桌面端与 App 壳 smoke
- 在 dataelement/dsh-desktop 或 dsh-tauri 上安装本插件（`dsh plugin --profile web add <本插件路径>` / 其插件中心），跑同样三步：切机 → 远端会话 → 返回本机。
- 若要 App：安装 `saya-ch/dsh-mobile`（Android）或 `zexadev/dsh-tether`（iOS），连接已装本插件的 Host，验证同一套流程。记录 WebView 版本/存储/移动布局问题。

### P2（1–2 周）——原生直连 relay PoC（仅当"任意机器直接开"是硬需求）
- fork `sorsama/deepseek-harness-mobile`，先实现 `RelayClient` + `version/list`（打通认证/SSE/RPC），再实现 `RelayRpcTransport`（`native.fetch`），最后做 mux carrier（`open/pull/uplink/close`）。
- 验收：App 直连 relay 后能列出 3 台机器、打开远端会话、流式回复、审批弹窗、取消运行。
- 同时评估是否给插件加"审批 RPC + 推送 + 设备票据"（路线 C），以免每个 App 重复实现。

### P3（2–4 周）——产品化增强（可选）
- 插件侧：`/health` 收紧、版本探测与降级提示、移动端 UI 入口增强（如 `conversation.session.header.utilities` 槽位）、`AbortSignal.timeout` polyfill 或降级、审批/推送 RPC。
- 生态侧：给 april-jk 提 Companion 0.2.x 移植 PR（双赢）；把本插件提交到 awesome-dsh-plugin / dsh-market，README 突出 "remote relay + multi-machine switch + plugin sync" 三个关键词。

### 验收 checklist（每次升级 DSH/网关/壳都跑）
1. `GET /` HTML 含 `__DSH_BOOT__` 且 entries 含 `dsh-remote-session`；
2. 页面 `fetch('/remote-session/api/state')` 返回 `{ok:true, snapshot...}`；
3. 切远端机器 → reload → 会话/工作区来自远端；
4. 发消息看到流式输出（验证 `openStream` 链路）；
5. 切回本机 → 草稿/主题/会话不串（验证 localStorage 命名空间）；
6. 弱网/锁屏回来仍可操作（验证网关 SSE/WS 保活）。

---

## 8. 风险与安全

### 8.1 技术风险
1. **DSH 版本漂移**：官方 developer preview 明确会破坏兼容；本插件要求 `>=0.2.1-rc.2` 且依赖 `typertGateway.wireStream`/`createSharedFetchHandler`。多数壳停留在 0.1.x；任何适配都要锚定版本并做 `version`/`probe` 探测。
2. **审批缺口**：高层 relay RPC 无 approval 方法；只用 RPC 的原生 App 会丢审批。必须走 `native` 或扩展 RPC。
3. **推送缺口**：本插件无推送；锁屏通知取决于壳（saya-ch 有、zexadev 只有待审批、april-jk MVP 明确 deferred），可用 kuraneko1 的 Web Push 补浏览器/PWA 场景。
4. **尺寸/吞吐限制**：`native.fetch` 响应 ≤8MB、流快照 ≤16MB、relay body ≤64MB、每客户端 64 请求/128 流；`pull` 是长轮询（≤10s 等待），大附件/会话导出/终端高频输出可能触顶，移动网络下延迟/耗电高于 WS。
5. **WebView 兼容矩阵**：非安全上下文缺 `crypto.randomUUID`、老内核缺 `AbortSignal.timeout`/`Promise.withResolvers`；mobile 布局可能隐藏侧栏注入点；隐私模式/禁存储会让 `localStorage` Proxy 抛错终止远程 boot。上线前必须真机矩阵验证。
6. **零改码的固有依赖**：入口机 A 必须在线；A 的页面骨架 + B 的 Host 组合必须兼容（`probe` 的 clientEntries 交集校验）；A 升级 DSH 后可能要求 B 同步升级。

### 8.2 安全风险（建议优先处理）
1. **relay 共享令牌 = 全机控制权**：手机若作为 relay 实例需保存令牌；无设备级撤销/审计；手机丢失场景必须能轮换令牌。
2. **relay 明文可见**：消息在 relay 侧是明文（TLS 只保护传输），SSE token 在 query 字符串里（nginx 必须关 access log，README 已写）。对比 april-jk 的 E2EE 模型，本插件更适合"自有可信 relay"。
3. **线上 relay 部署与仓库不一致**：本机 relay `/health` 当前未鉴权返回实例清单（id/name/online/sessions），而仓库版只返回 `{ok:true}`。建议核对线上版本并收紧（避免泄露机器名/会话数量）；同时核对是否有未发布的额外端点。
4. **网关暴露面**：Web 壳把"能执行代码的 Host"暴露给手机/公网，必须强鉴权（PIN/配对/设备撤销）+ HTTPS + 限速，优先选安全模型成熟的方案（summer1238 的票据/设备撤销、pocket 的 PIN、vps-remote 的设备审批）。
5. **公网入口与 relay 关系**：手机浏览器经 Web 壳访问 A，A 再出站连 relay；relay 不需要对公网暴露除 `/health` 之外的写接口（nginx 已按 `/dsh-relay/` 前缀转发）。

---

## 9. 附录

### 9.1 子报告索引
| 文件 | 内容 | 规模 |
| --- | --- | --- |
| [`00-plugin-protocol-brief.md`](00-plugin-protocol-brief.md) | 本插件协议/接入面速览（adaptation 基线） | ~150 行 |
| [`01-ecosystem-survey.md`](01-ecosystem-survey.md) | 60 仓库 / 8 分类 / 22 组搜索口径 / Top9 连接机制 / 空白点 | ~293 行 |
| [`02-mobile-deepdive.md`](02-mobile-deepdive.md) | 11 个手机端项目（7 源码级）协议/能力/改造成本 | ~523 行 |
| [`03-desktop-gateway-integration.md`](03-desktop-gateway-integration.md) | 8 桌面壳 + 5 Web 网关 + dsh-vps-remote 对照 | ~267 行 |

### 9.2 关键参考链接（GitHub）
- 官方：https://github.com/deepseek-ai/deepseek-harness （`docs/api-gateway.md`、`docs/subsystems/typert.md`、`packages/sdk/protocol/README.md`、`apps/web/index.html`、`apps/desktop/README.md`、`docs/user/guide/public-deployments.md`）
- 零改码壳：https://github.com/saya-ch/dsh-mobile · https://github.com/zexadev/dsh-tether · https://github.com/april-jk/dsh-mobile-suite
- Web 网关：https://github.com/shaobeichen/dsh-pocket · https://github.com/wenbin-wb/dsh-bridge · https://github.com/summer1238/dsh-remote-web-gateway
- 原生 App：https://github.com/sorsama/deepseek-harness-mobile · https://github.com/Clarklevis1995/dsh-mobile
- 桌面宿主：https://github.com/dataelement/dsh-desktop · https://github.com/dsh-tauri/deepseek-harness-desktop · https://github.com/anywhere-labs/dsh-desktop
- 增强：https://github.com/kuraneko1/dsh-mobile-maxxing

### 9.3 本机对照实现（不在 GitHub）
- `C:\Users\32891\Documents\deepseek-harness\default-workspace\dsh-vps-remote`：`README.md`、`lib/gate.js`、`deploy/home-dsh.conf`。它证明"同源整页透传 + transport pin + Host/Origin 重写 + 私有 cookie"能让官方 UI 在手机浏览器完整工作，是本文零改码结论的关键实证。

### 9.4 数据与复现
- GitHub 数据快照：2026-10-27 10:20–11:00（Asia/Shanghai）；`gh` 账号 `gaolin89898`（认证限额）。
- 复现：`gh api repos/<owner>/<repo>`、`gh api repos/<owner>/<repo>/readme -H "Accept: application/vnd.github.raw"`、`git clone --depth 1 --filter=blob:none https://github.com/<owner>/<repo>.git research/apps/repos-*/<owner>__<repo>`。
- 免责声明：star/许可证/更新时间会变化；"待验证"条目未经真机/端到端验证；本报告不构成对任何第三方项目安全性的背书。

---

## 10. 未决问题（建议后续跟进）

1. **P0 真机验证**：手机浏览器访问现有公网入口时，"远程会话"入口是否可见、切机是否成功、官方 UI 的 `__DSH_BOOT__` 与 `/remote-session/api/*` 是否被 `dsh-vps-remote` 完整透传（架构上应成立，需实测）。
2. **pocket 的 `ownsHost` 覆盖**：其 transport shim 会把远端页面的 `ownsHost` 强写 true，是否影响远端机器设置页写入正确目标，需实测并决定是否在插件侧做延迟覆盖。
3. **线上 relay 版本核对**：`/health` 返回实例清单与仓库代码不一致，确认是哪个版本/是否有自定义改动，并收紧权限。
4. **sorsama relay transport PoC**：900–1400 行 Kotlin 的估算需用真实代码验证；`pull` 长轮询在移动网络下的体验需压测。
5. **april-jk Companion 0.2.x 移植**：评估实际改动面（隧道与 DSH 版本解耦）并给上游提 PR，成功后零改码壳就多一个 E2EE 选择。
6. **路线 C 的审批 RPC 设计**：官方 UI 与 App 同时在线时的 answerer 冲突、单终端语义、超时/取消行为需对照 `docs/subsystems/approval.md` 设计。
