# GitHub DSH（DeepSeek Harness）App 生态全景调查

> 快照时间：2026-10-27 10:20–10:50（Asia/Shanghai）。数据源：已登录 `gh` CLI（account `gaolin89898`）调用 `search/repositories` 与 `repos/{owner}/{repo}`；stars/license/pushed_at 均为该时刻 API 快照，非实时。
> 目的：为 `dsh-remote-session` 插件（自建 relay + 官方 Gateway 协议跨机透传 + 多机会话切换 + 插件同步）寻找可适配的 App/客户端，并判定生态空白点。
> 范围：只收与 DeepSeek Harness（dsh）相关的 App/客户端/远程访问/打包分发类项目；纯插件（桌宠、皮肤、侧边栏等）不计入表格。

## 0. 结论速览（先看这里）

**① 有没有 App 已经像本插件一样支持"多台 DSH 机器切换"？**
没有同形态（在同一套官方 UI 内、用官方 Gateway 协议把会话切到另一台机器、两端只需插件+relay）的公开项目。最接近的是三类"多主机客户端"：
- [april-jk/dsh-mobile-suite](https://github.com/april-jk/dsh-mobile-suite)（17★）：Flutter App + DSH 插件 + 可自建 Relay，App 内有"已配对电脑"列表，选一台后打开它的官方 Web UI；出站 WSS、E2EE、Relay 只见密文。架构与本插件最像，但切换发生在 App 层（重连另一台电脑、打开另一套 UI），且协议是自有协议而非官方 Gateway 透传。
- [saya-ch/dsh-mobile](https://github.com/saya-ch/dsh-mobile)（639★）：Android App 设备列表集中显示所有已配对电脑并支持切换/重新配对（官方 README 明写"适合经常在多台设备之间切换"），同样是自有插件 HTTPS 网关。
- [flymysql/dsh-remote](https://github.com/flymysql/dsh-remote)（187★，桌面插件）、[Blank-not-black/dsh-Remote](https://github.com/Blank-not-black/dsh-Remote)（65★，"多服务器自动选优"）、[ccch1mneyyy/dsh-go](https://github.com/ccch1mneyyy/dsh-go)（72★，"切换主机"）支持多机列表，但均为 SSH/自有 gateway/App 层切换。
→ 结论：**"单前端 + 官方协议 + 多机原地切换"仍是空白**，这是本插件最硬的差异点（详见 §7）。

**② 有没有官方 App 协议或移动端 SDK？**
没有。官方 org `deepseek-ai` 共 45 个公开仓库，其中与 DSH 相关的只有 `deepseek-ai/deepseek-harness` + 两个内部组件（`dsh-libreoffice-kit`、`dsh-node-addon-require-builtin`）；**没有官方移动端 App、没有 mobile SDK、没有面向第三方客户端的协议规范**。官方现状：
- App 形态 = 官方 Desktop（`apps/desktop`、`apps/desktop-host`）、Web（`apps/web`）、CLI（`apps/cli`）；`packages/sdk` 是嵌入/自动化 SDK（Python/TS），不是移动端 SDK。
- 唯一的"协议"是工程文档 [docs/api-gateway.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/api-gateway.md)：Typert API Gateway，`@Remote`/`@RemoteScope` 方法经 Connection RPC 与 `/api/remote.mux` WebSocket 传输；另有内部笔记 [peer-principal-and-remote-access](https://github.com/deepseek-ai/deepseek-harness/blob/main/.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.md) 描述 peer/principal 与 liveshare 经 Relay 的远程访问模型（实现内部，不是公开发布级协议）。
- 官方推荐的分发方式是插件 topic（`dsh-plugin`，GitHub 约 1.9 万仓库），因此生态里所有"App 协议"都是社区自定义的。

**③ 哪些明显只是"手机本地跑 DSH"，不是远程客户端？**
判据：内嵌 Node/PRoot/Termux/打包 dsh 运行时、Host 只监听 `127.0.0.1:3080`、无需电脑配对。符合的有（详见 §2）：DSH-APP/DSHA、kelai141/dsh-mobile-apk、woaiys3/…android-app、Soodok/…Local-Android、WSK-build/DSHBox、Tongyu3/Tdsh…、dphmoblie/…android、pht88888888/DSHAPP、thness/dsh-mobile、Thanksgiver233/dsh-mobile、YOYOFeelings/…Android、everettjf/dsh-ios、Vengisk/…termux、hnmrxz/…HarmonyOS、QinpanWan/dsh-harmonyos-pc。这些项目可作为本插件的"relay 节点候选"（能装插件的那部分），但不是远程客户端。

**④ 适配判断（lead 指定四分类，详见 §6）**
- 零改码可配的"远程 Web UI 壳"：手机侧看到的就是电脑上的官方 DSH Web UI，本插件的"远程会话"入口会随官方 UI 一起出现，切换机器后由 relay 透传官方 Gateway；候选：dataelement/dsh-desktop、dsh-tauri/…、chokwinlee/…、lencx/Minke、ChisaAlter/WhaleIsle、summer1238/…、shaobeichen/dsh-pocket、wenbin-wb/dsh-bridge、anywhere-labs/dsh-desktop。
- 原生协议重写、需改客户端：Clarklevis1995/dsh-mobile（+dsh-plugin-mobile-gateway）、saya-ch/dsh-mobile、april-jk/dsh-mobile-suite、201222-L/dsh-mobile-remote、sorsama/…、Hakunm/…、SCSpotato/dsh-remote、hongshuxifan321/dsh-mobile-app、zexadev/dsh-tether、Blank-not-black/dsh-Remote。
- 能装第三方 DSH 插件（本插件可装进去，自身即为 relay 节点）：所有"官方 UI + 插件机制"的桌面壳/本地运行 App（官方 Desktop、anywhere-labs、dataelement、dsh-tauri、ningbainb、myYangyunfan、WhaleIsle、oh-dsh、lencx/Minke、DSH-APP/DSHA、kelai141、WSK-build/DSHBox、Soodok 等）；注意它们内置的 dsh 版本普遍为 0.1.x/0.2.x，低于本插件要求的 DSH `>=0.2.1-rc.2`（本插件自身版本为 1.0.0），需先升级运行时。
- 只能当外层壳、不能装插件：纯 WebView/网页/PWA 镜像类（summer1238、dsh-pocket、dsh-bridge、WhaleIsle 的 Android 端等）——但插件装在"电脑端 DSH"即可，手机端无需插件。

## 1. 方法与口径（可复现）

- 工具：`gh search repos` / `gh api search/repositories`（认证限额 5000/h core、30/min search）+ `gh api repos/...` 元数据 + `gh api repos/.../readme -H "Accept: application/vnd.github.raw"` 读 README；未使用未认证网页抓取。
- 搜索口径（`q` → total_count，均为 2026-10-27 快照）：
  | 查询 | total | 查询 | total |
  | --- | --- | --- | --- |
  | `deepseek harness` | 26196 | `deepseek harness client` | 816 |
  | `deepseek-harness` | 33364 | `dsh mobile app` | 67 |
  | `dsh mobile` | 578 | `deepseek harness remote` | 458 |
  | `dsh android` | 517 | `dsh web remote` | 138 |
  | `dsh ios` | 115 | `dsh gateway` | 350 |
  | `dsh remote` | 770 | `dsh p2p` | 23 |
  | `dsh desktop` | 2887 | `deepseek harness android` | 372 |
  | `deepseek harness mobile` | 380 | `deepseek harness ios` | 80 |
  | `topic:deepseek-harness` | 18784 | `dsh phone` | 290 |
  | `dsh app` | 1222 | `dsh in:name app` | 405 |
  | `deepseek harness tunnel` | 78 | `dsh sync mobile` | 3 |
- 汇总去重：22 组查询共 644 个唯一仓库 → 关键词筛出 538 个 → 人工核对 74 个候选（含用户给定名单 + lead 补充）→ 73 份 README 全文；表格收录 60 个 App/远程/打包/官方相关仓库（另有若干纯插件、皮肤、IM 网关在正文提及但不入表）。
- DSH 同名歧义过滤：排除 Distributed Shell / Debian `dsh` / DShop / robotics harness / 通用 "harness" 等。示例已排除：`devmentors/DNC-DShop.Api`（.NET DShop）、`SerpentAI/D3DShot`（截图库）、`lockekk/dshare-hid`（键鼠共享）、`devmentors`、`AMAP-ML/LongHorizon-Harness`（通用 computer-use harness）、`YaoApp/yao`（通用 agent 平台）、`ZSeven-W/dsh-ios` 与 `ZSeven-W/dsh-android`（DSH 内嵌 iOS 模拟器/安卓模拟器插件，不是 DSH 客户端）。
- 名单核对异常：用户名单中 `SOSPotato/dsh-remote` 已 404，实际存在的是 [SCSpotato/dsh-remote](https://github.com/SCSpotato/dsh-remote)（94★，Android 原生远程控制）；`ChisaAlter/Deepseek-Harness-Desktop` 已重定向到 `ChisaAlter/WhaleIsle`；`fufankeji/deepseek-harness-studio` 首次 API 404、复查询正常（695★），推测为索引/缓存瞬断，按正常收录标注。

### 1.1 已知候选名单核对（用户给定 + lead 补充）

用户给定 29 个候选（`gh api repos/{owner}/{repo}` 逐一核对；✓=存在且已收录，⚠=存在但非 App/已排除，✗=404）：

| # | 候选 | 结果 | # | 候选 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 1 | saya-ch/dsh-mobile | ✓ §① | 16 | anywhere-labs/dsh-desktop | ✓ §③ |
| 2 | Clarklevis1995/dsh-mobile | ✓ §① | 17 | dataelement/dsh-desktop | ✓ §③ |
| 3 | hongshuxifan321/dsh-mobile-app | ✓ §① | 18 | dsh-tauri/deepseek-harness-desktop | ✓ §③ |
| 4 | 201222-L/dsh-mobile-remote | ✓ §① | 19 | whitelonng/dshcode | ✓ §③ |
| 5 | zexadev/dsh-tether | ✓ §①⑤ | 20 | ningbainb/deepseek-harness-desktop | ✓ §③ |
| 6 | sorsama/deepseek-harness-mobile | ✓ §① | 21 | vibeinging/dsh-desktop | ✓ §③⑤ |
| 7 | yukiykchen/deepseek-harness-mobile | ✓ §① | 22 | RongleCat/deepseek-app | ✓ 桌面壳（未入表） |
| 8 | thness/dsh-mobile | ✓ §② | 23 | Astro-Han/pawwork | ✓ 桌面壳（未入表） |
| 9 | kelai141/dsh-mobile-apk | ✓ §② | 24 | ZSeven-W/rish-app | ✓ §② |
| 10 | DSH-APP/DSHA | ✓ §② | 25 | WSL043/dsh-codex-subscription | ⚠ 模型订阅接入插件，非 App，排除 |
| 11 | WSK-build/DSHBox | ✓ §② | 26 | everettjf/dsh-ios | ✓ §② |
| 12 | shaobeichen/dsh-pocket | ✓ §④ | 27 | SimonMedy/DSH-Mobile | ✓ §① |
| 13 | liguobao/ds-harness-remote | ✓ §⑤ | 28 | Hakunm/dsh-android-app | ✓ §① |
| 14 | wenbin-wb/dsh-bridge | ✓ §④ | 29 | SOSPotato/dsh-remote | ✗ 404；实际为 SCSpotato/dsh-remote §① |
| 15 | summer1238/dsh-remote-web-gateway | ✓ §④ | | | |

lead 补充线索核对（全部已核实并收录）：

| 线索 | 结果 | 说明 |
| --- | --- | --- |
| april-jk/dsh-mobile-suite | ✓ §① Top1 | 另有子仓 april-jk/dsh-mobile(1★, Dart)、dsh-mobile-plugin(1★, TS)、dsh-relay(2★, TS)，架构三段式已核实 |
| kuraneko1/dsh-mobile-maxxing | ✓ §⑦ | PWA/通知/移动 UX/CJK 集成插件，47★ |
| Z-6354/dsh-mobile-hanui | ✓ §⑦ | ≤1023px 触屏布局修正，18★ |
| ChisaAlter/WhaleIsle（旧名 Deepseek-Harness-Desktop） | ✓ §③ | 旧仓名已重定向；Android 正式签名 APK，扫码连桌面 |
| QinpanWan/dsh-harmonyos-pc | ✓ §⑧ | 32★，鸿蒙适配 + 桌面/平板客户端 |
| xiaogouyo/dsh-harmonyos | ✓ §⑧ | 2★，Electron 壳 + HAP 打包 |
| hnmrxz/deepseek-harness-desktop-HarmonyOS | ✓ §⑧ | 7★，HAP 内置 Node+dsh，本地跑 |
| dsh-tauri CI 构建 Android/unsigned iOS | ✓ 已核实 | commit 292a855（2026-10-13）"follow desktop releases with Android and unsigned iOS builds"，新增 build-android.yml/build-ios.yml 等 7 个 workflow |
| Thanksgiver233/dsh-mobile | ✓ §② | 29★，内置 Node+dsh CLI，本地模式 |
| YOYOFeelings/DeepSeek-Harness-Android | ✓ §② | 29★，kelai141 二改，MIT 双署名 |
| lehhair/dsh-mobile | ✓ §⑦ | 25★，PiUI 翻页器结构移动适配 |

## 2. 分类总览

| 类别 | 数量（本表收录） | 代表项目 | 与本插件的关系 |
| --- | --- | --- | --- |
| ① 手机远程控制客户端 | 12 | saya-ch/dsh-mobile、april-jk/dsh-mobile-suite、Clarklevis1995/dsh-mobile | 竞品/可对接客户端 |
| ② 手机本地运行 DSH | 14 | DSH-APP/DSHA、kelai141/dsh-mobile-apk、WSK-build/DSHBox | 潜在 relay 节点 |
| ③ 桌面端 App/外壳 | 15 | anywhere-labs/dsh-desktop、dataelement/dsh-desktop、dsh-tauri | 本插件宿主 |
| ④ Web/手机网页远程访问 | 7 | dsh-pocket、dsh-bridge、dsh-remote-web-gateway | 零改码壳 |
| ⑤ P2P/自建 Relay 方案 | 5 | liguobao/ds-harness-remote、dsh-sev、flymysql/dsh-remote | 架构参照/竞品 |
| ⑥ 官方仓库与官方 App 相关 | 6（含 2 份官方文档） | deepseek-ai/deepseek-harness | 协议来源 |
| ⑦ 补充：Web UI 移动优化/PWA | 4 | kuraneko1/dsh-mobile-maxxing、mexiaosqwq/dsh-web-mobile | 可在手机上放大本插件入口 |
| ⑧ 补充：鸿蒙/多端/非 Windows 桌面 | 5 | QinpanWan/dsh-harmonyos-pc、Zhou-Yujing114514/deepseek-harness-linux | 分发面扩展 |

### 2.1 生态结构观察

- **体量**：官方 `deepseek-ai/deepseek-harness` 26.3 万★ 一骑绝尘；桌面壳头部是 anywhere-labs/dsh-desktop(3.3 万★) 与 dataelement/dsh-desktop(1.7 万★)；手机端最高是 DSH-APP/DSHA(2428★) 与 kelai141/dsh-mobile-apk(900★)；远程访问类最高是 dsh-pocket(2436★)、Clarklevis1995/dsh-mobile(660★)、saya-ch(639★)、liguobao(882★)。App 类整体仍处早期（多数 <1k★）。
- **语言分布**：Kotlin/Java 主导"手机本地跑"（14 个），TypeScript/JavaScript 主导"插件/远程/桌面"（约 35 个），Rust/C++ 只出现在侧车与原生打包（dsh-tether sidecar、web-casa、dsh-launcher）。
- **时间窗口**：收录项目 `pushed_at` 集中在 2026-08-14 ~ 2026-10-27（仅少量 9 月初），说明 DSH App 生态整体只有约 2–3 个月，仍属"抢先占位"阶段，标准与协议尚未收敛——对本插件是利好窗口。
- **平台覆盖**：Android 最活跃；iOS 社区受签名限制（zexadev 未签名 IPA、everettjf 本地跑、Clarklevis KMP）；HarmonyOS 出现 3 个项目（QinpanWan、xiaogouyo、hnmrxz）；Linux 打包与便携版各有 1 个。
- **协议碎片化**：至少 6 套互不兼容的第三方协议（Clarklevis1995 mobile-gateway、saya-ch 插件网关、april-jk Companion+Relay、dsh-plugin-tether iroh、dsh-pocket/bridge HTTP 反代、liguobao APIProxy/P2P）；无一套以官方 Gateway 透传为核心。
- **分发形态**：npm 插件（`dsh plugin --profile web add`）、APK/EXE/DMG、PWA、Docker（runzhliu/deepseek-harness-docker 128★，未入表）并行；`dsh-plugin` topic 约 1.9 万仓库，插件市场类（dsh-market 9101★、awesome 列表 2 万★）已成流量入口。

## 3. 分类清单

字段：仓库（链接）｜★｜语言｜许可证｜pushed_at｜连接机制｜核心能力｜与本插件相关度。相关度=与本仓库 remote-session 插件（自建 relay + 官方 Gateway 协议透传 + 多机切换）的适配价值。

### ① 手机远程控制客户端（原生/跨平台 App，连接电脑上的 DSH）

| 仓库 | ★ | 语言 | 许可证 | pushed | 连接机制 | 核心能力 | 相关度 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [april-jk/dsh-mobile-suite](https://github.com/april-jk/dsh-mobile-suite) | 17 | -（Flutter/Dart） | MIT | 2026-08-18 | 插件出站 WSS→自建/公有 Relay（E2EE，Relay 只见密文）；App 内打开官方 Web UI；QR 配对 | 多电脑列表、账号/票据、可私有部署 relay（8787/SQLite）；含 dsh-mobile、dsh-mobile-plugin、dsh-relay 子仓 | 高：架构最接近本插件，但协议自有、切换在 App 层 |
| [saya-ch/dsh-mobile](https://github.com/saya-ch/dsh-mobile) | 639 | TypeScript | Apache-2.0 | 2026-10-26 | 电脑端插件（HTTPS/WS 网关）+ Android App（WebView 官方 UI）；LAN + Tailscale/FRP/cpolar/cloudflared/Caddy | 配对多设备列表、切换/重配对/撤销、远程通道多种、诊断放行 | 高：唯一明写"多台设备间切换"的手机 App；自有协议 |
| [Clarklevis1995/dsh-mobile](https://github.com/Clarklevis1995/dsh-mobile) | 660 | Kotlin | MIT | 2026-10-26 | KMP 原生 iOS/Android，经 `dsh-plugin-mobile-gateway` 的 WebSocket 连 Harness | 会话/时间线/文件/审批/通知的原生移动端（Whaleness） | 高：原生协议重写方，需适配 gateway 才可用本插件 |
| [Clarklevis1995/dsh-plugin-mobile-gateway](https://github.com/Clarklevis1995/dsh-plugin-mobile-gateway) | 120 | JavaScript | MIT | 2026-10-26 | WS 设备鉴权移动网关（配套上条，非 App） | 会话/实时事件/消息同步/审批/Goal/命令菜单的双向同步 | 高：事实上的"第三方 App 协议"，可对照设计适配层 |
| [sorsama/deepseek-harness-mobile](https://github.com/sorsama/deepseek-harness-mobile) | 213 | Kotlin | MIT | 2026-10-22 | 原生 Android 连电脑 `dsh web`（LAN/adb reverse/Termux 本地） | chat、goals、审批、通知 | 中：自有 UI 直连 HTTP，兼容本插件需改造 |
| [201222-L/dsh-mobile-remote](https://github.com/201222-L/dsh-mobile-remote) | 89 | Dart | MIT | 2026-10-07 | Flutter App + DSH 插件；LAN/Tailscale/蒲公英/FRP 自配 | 发消息派活、进度、通知、审批；PC/手机配置通道互通 | 中：外网靠用户自配隧道 |
| [hongshuxifan321/dsh-mobile-app](https://github.com/hongshuxifan321/dsh-mobile-app) | 103 | JavaScript | MIT | 2026-08-18 | Android 客户端 + WS/隧道/WebView | DSH Remote 早期实现 | 中低 |
| [zexadev/dsh-tether](https://github.com/zexadev/dsh-tether) | 79 | JavaScript | MIT | 2026-10-26 | 插件携带 Rust sidecar，iroh QUIC 打洞 P2P；失败回落只载密文的 relay；同 App 支持手机本地跑（仅 arm64） | 6 位配对码、Hosts 列表、多机管理、iOS beta（未签名 IPA） | 高：P2P+relay 回退与本地模式并存，架构参考价值大 |
| [Hakunm/dsh-android-app](https://github.com/Hakunm/dsh-android-app) | 28 | Kotlin | AGPL-3.0 | 2026-10-27 | 原生 Android 客户端，建议前置 Caddy/Nginx HTTPS 或 Tailscale/WireGuard | chat、审批、工作区、文件、模型管理 | 中低：偏单机直连 |
| [SCSpotato/dsh-remote](https://github.com/SCSpotato/dsh-remote) | 94 | Kotlin | 未见 LICENSE | 2026-08-28 | 原生 Android 客户端直连 DSH | 手机远程控制 DSH | 中低：单主机 |
| [SimonMedy/DSH-Mobile](https://github.com/SimonMedy/DSH-Mobile) | 17 | TypeScript | MIT | 2026-09-01 | WebView 加载官方 Web UI，Tailscale 组网 | 非官方社区移动客户端 | 低：纯壳 |
| [yukiykchen/deepseek-harness-mobile](https://github.com/yukiykchen/deepseek-harness-mobile) | 53 | Kotlin | 未见 LICENSE | 2026-10-12 | 仅连电脑：扫码/SSH 端口转发；已移除内置 Node（独立仓库 DSH Local 承接本地跑） | 连接方式选择、聊天 | 中：WebView 远程壳 |

### ② 手机上本地运行 DSH（内嵌 Node / PRoot / Termux，非远程客户端）

| 仓库 | ★ | 语言 | 许可证 | pushed | 连接机制 | 核心能力 | 相关度 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [DSH-APP/DSHA](https://github.com/DSH-APP/DSHA) | 2428 | Java | MIT | 2026-10-26 | 内置 Ubuntu 环境 + proot/proroot；官方 Web UI；ADB 直连 | 免 ROOT 免 Termux、内置 DSH 0.2.1-rc.2 + 移动 UI、AI 输出实时上屏 | 中：能跑插件即可作 relay 节点，但 dsh 版本低 |
| [kelai141/dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk) | 900 | Kotlin | MIT | 2026-10-27 | WebView UI + 内嵌 Termux 运行时快照（解压即跑） | 真实 bash、插件/模型设置、ABI 分包 | 中：同上 |
| [woaiys3/deepseek-harness-android-app](https://github.com/woaiys3/deepseek-harness-android-app) | 644 | Java | MIT | 2026-10-18 | APK 内本地服务（127.0.0.1+令牌）、Shizuku/无障碍自动化 | 手机本地跑 + AI 操作手机 + 文件编辑 | 中 |
| [Soodok/Deepseek-Harness-Local-Android](https://github.com/Soodok/Deepseek-Harness-Local-Android) | 351 | Kotlin | MIT | 2026-10-27 | 官方 dsh 引擎跑在 Android 沙箱（非容器）、WebView | 完整移植、扩展中心、无 root/Termux | 中 |
| [WSK-build/DSHBox](https://github.com/WSK-build/DSHBox) | 301 | Kotlin | GPL-3.0 | 2026-10-18 | PRoot Debian + Node + WebView 集成 | 手机本机跑 DSH、终端/文件/AI 浏览器助手 | 中 |
| [Tongyu3/Tdsh-DSH-Mobile-Android-NO-ROOT](https://github.com/Tongyu3/Tdsh-DSH-Mobile-Android-NO-ROOT) | 101 | Java | NOASSERTION | 2026-10-21 | 一键 APK，内嵌运行时 | 文件读取/编辑、无障碍扩展 | 中 |
| [dphmoblie/deepseek-harness-android](https://github.com/dphmoblie/deepseek-harness-android) | 79 | Kotlin | MIT | 2026-10-26 | PRoot Ubuntu 24.04 + Node 24.19 + dsh 0.2.1-rc.1，内置 WebView | 手机本机跑 + 插件/文件管理 | 中 |
| [pht88888888/DSHAPP](https://github.com/pht88888888/DSHAPP) | 58 | Kotlin | MIT | 2026-10-24 | 内置 Termux bootstrap + Node 26 + WebView 官方 GUI | 不自绘聊天界面，复用官方前端 | 中 |
| [thness/dsh-mobile](https://github.com/thness/dsh-mobile) | 32 | Kotlin | MIT | 2026-08-15 | 内嵌 Node.js + 官方 Web UI，WebView → 127.0.0.1:3080 | 安装即用 | 中 |
| [Thanksgiver233/dsh-mobile](https://github.com/Thanksgiver233/dsh-mobile) | 29 | Kotlin | MIT | 2026-08-17 | 内置 Node + dsh CLI，Kotlin/Compose 原生 UI + 本地模式 | 覆盖 Web 端核心功能、离线/重连 | 中 |
| [YOYOFeelings/DeepSeek-Harness-Android](https://github.com/YOYOFeelings/DeepSeek-Harness-Android) | 29 | Kotlin | MIT | 2026-08-29 | kelai141 二次开发：Termux 快照 + SAF + 看门狗 | 多模块重构、运行时在线更新 | 中低 |
| [everettjf/dsh-ios](https://github.com/everettjf/dsh-ios) | 22 | C | GPL-3.0 | 2026-09-02 | iOS 内打包 Alpine + Node 22 + WKWebView，全本地 | iPad/iPhone 本地跑完整 agent | 低：iOS 禁子进程类方案受限 |
| [Vengisk/deepseek-harness-termux](https://github.com/Vengisk/deepseek-harness-termux) | 74 | Shell | MIT | 2026-08-26 | Termux 安装脚本（非 App） | 在 Termux 跑 dsh | 低 |
| [ZSeven-W/rish-app](https://github.com/ZSeven-W/rish-app) | 160 | Objective-C++ | MIT | 2026-09-29 | iOS/Android 本地多引擎（DSH/Claude Code/Codex/GLM），本地执行 | 口袋 agent、工作区/工具执行 | 低：多引擎本地壳 |

### ③ 桌面端 App / 外壳（Electron/Tauri/原生）

| 仓库 | ★ | 语言 | 许可证 | pushed | 连接机制 | 核心能力 | 相关度 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) | 33404 | TypeScript | MIT | 2026-10-27 | 插件化桌面（自身即插件宿主）+ 内置"手机远程控制"（iOS/Android 连 Desktop，2.0.9+） | 最大社区桌面发行版，万物皆插件 | 高：本插件可作其插件运行；其手机端可作零改码壳 |
| [dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop) | 17043 | JavaScript | MIT | 2026-10-27 | 打包 Node+DSH；配对的手机经 LAN 或临时 Cloudflare 隧道继续会话，6 位配对码 | 桌面 + 手机桥接（bridge 独立于官方 Web 端口） | 高：远程 Web UI 壳，主机可装本插件 |
| [dsh-tauri/deepseek-harness-desktop](https://github.com/dsh-tauri/deepseek-harness-desktop) | 3296 | TypeScript | MIT | 2026-10-27 | Tauri 2 + 内嵌 Harness 界面；Android/iOS 移动端扫码连电脑（LAN/Cloudflare）；CI 已构建 Android 与 unsigned iOS（commit 292a855） | 8MB 安装包、预置插件 | 高："桌面壳+移动构建"，可直接作为本插件宿主 |
| [ningbainb/deepseek-harness-desktop](https://github.com/ningbainb/deepseek-harness-desktop) | 870 | JavaScript | BSD-3-Clause | 2026-10-26 | 内置 Node.js + DSH（Windows 含 Git），官方 Web UI | Windows 桌面客户端/免配置安装 | 中高：宿主（可装本插件） |
| [yyh-001/DSH-X](https://github.com/yyh-001/DSH-X) | 757 | JavaScript | MIT | 2026-10-26 | 轻量桌面启动器，管理启动项/多实例 | 版本、插件、整合包、MCP、技能管理 | 中：多实例场景与本插件多机互补 |
| [myYangyunfan/dsh_desktop](https://github.com/myYangyunfan/dsh_desktop) | 730 | JavaScript | MIT | 2026-10-22 | Tauri 2 + 内置 Node，内置 34 个伴随插件 | Windows 桌面客户端 | 中高：宿主 |
| [whitelonng/dshcode](https://github.com/whitelonng/dshcode) | 703 | TypeScript | MIT | 2026-09-13 | Electron（macOS/Windows） | 一键社区桌面伴侣 | 中：宿主 |
| [lencx/Minke](https://github.com/lencx/Minke) | 693 | TypeScript | Apache-2.0 | 2026-10-18 | Electron；Tailscale Serve over HTTPS / Tailscale Direct IP 做手机投屏与触控 | DeepSeek Harness Desktop，视频流/触控投射手机 | 高：Tailscale 远程壳，零改码 |
| [fufankeji/deepseek-harness-studio](https://github.com/fufankeji/deepseek-harness-studio) | 695 | TypeScript | MIT | 2026-09-01 | Electron 桌面端，一键启动 | 零代码桌面端、插件发现/推送/管理 | 中：宿主 |
| [vibeinging/dsh-desktop](https://github.com/vibeinging/dsh-desktop) | 485 | JavaScript | MIT | 2026-10-26 | 内置手机远程：Host 只出站，Remote 依次 LAN→P2P→TURN→Relay，Noise IK 加密；账号/信令/中继由第三方服务提供 | 桌面工作区 + 默认内置手机远程 | 高：与本插件 relay 思路同向，但绑定第三方服务 |
| [chokwinlee/deepseek-harness-desktop](https://github.com/chokwinlee/deepseek-harness-desktop) | 284 | Kotlin | MIT | 2026-10-01 | Tauri 桌面宿主 + 原生 SwiftUI iPhone 客户端（可信 Wi-Fi / 自有 Tailscale） | 紧凑 macOS 包、移动 Remote | 高：自带 iPhone 端的桌面宿主 |
| [ChisaAlter/WhaleIsle](https://github.com/ChisaAlter/WhaleIsle) | 192 | JavaScript | MIT | 2026-10-26 | 桌面（Electron 系）+ 正式签名 Android APK，扫桌面"远程"二维码连接 | 社区增强桌面：对话/终端/Git/插件市场/手机远程 | 高：多端壳，主机可装本插件 |
| [hust-open-atom-club/oh-dsh](https://github.com/hust-open-atom-club/oh-dsh) | 323 | TypeScript | MIT | 2026-09-12 | 一套 runtime 三种形态：Desktop/Web/TUI | 打包 Node/插件/PTY/浏览器 | 中：宿主 |
| [zhukunpenglinyutong/desktop-cc-gui](https://github.com/zhukunpenglinyutong/desktop-cc-gui) | 4537 | TypeScript | NONE | 2026-10-26 | Tauri 多引擎桌面客户端（Claude Code/Codex/Gemini/OpenCode/DSH） | 多引擎聚合 | 低中：DSH 只是其一 |
| [cocode-agency/cocode](https://github.com/cocode-agency/cocode) | 166 | TypeScript | MIT | 2026-09-03 | 发行版：DSH 桌面 GUI + TUI；SSH 到机器继续 | 开箱即用分发 | 低中 |

> 低相关桌面外壳（不入表）：`qufei1993/dsh-desktop`(56)、`bruc3van/dsh-desktop`(93)、`sryimnoob123/dsh-starter`(84)、`RongleCat/deepseek-app`(34)、`dsh-plugins/dsh-launcher`(73)、`FlashingChen/dsh-desktop-hub`(62)、`2439816947/DSH-Desktop`(73)、`xingj404-lab/dsh-desktop`(57)、`agent-earth/deepseek-harness-desktop`(256)、`Astro-Han/pawwork`(204)、`MichengAI/dsh-codex-desktop`(123)、`web-casa/DeepSeek-Harness-Desktop`(123)。

### ④ Web/手机网页远程访问方案（扫码/隧道/反代/PWA）

| 仓库 | ★ | 语言 | 许可证 | pushed | 连接机制 | 核心能力 | 相关度 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [shaobeichen/dsh-pocket](https://github.com/shaobeichen/dsh-pocket) | 2436 | JavaScript | GPL-2.0 | 2026-10-17 | 插件：LAN 开关 + cloudflared 快速/命名隧道 + 二维码 + 访问密码；WebSocket 全透传 | 实时同屏、双向操作、隧道自动恢复 | 高：纯反向代理官方 Web UI，主机装本插件即可见多机入口 |
| [wenbin-wb/dsh-bridge](https://github.com/wenbin-wb/dsh-bridge) | 221 | JavaScript | MIT | 2026-10-26 | 插件：LAN 扫码直连 + Cloudflare 临时/固定域名 + 自建隧道 + 微信/QQ/飞书/Telegram 机器人 | 多通道远程访问、安全守护、隧道可观测性 | 高：Web UI 镜像 + IM 通道并存 |
| [summer1238/dsh-remote-web-gateway](https://github.com/summer1238/dsh-remote-web-gateway) | 165 | TypeScript | MIT | 2026-08-28 | 插件：一键 Cloudflare Quick Tunnel + 扫码；一次性配对、GitHub 身份验证、每设备独立授权/撤销 | 无需远程桌面/SSH/公网 IP；手机继续用电脑上的 DSH | 高：零改码手机 Web 壳 |
| [Blank-not-black/dsh-Remote](https://github.com/Blank-not-black/dsh-Remote) | 65 | JavaScript | MIT | 2026-10-26 | 插件 + 单文件 gateway + 客户端；LAN/Tailscale 直连，WS+长轮询、离线历史 | 会话/审批/提问/文件传输、多服务器自动选优 | 高：多机选优最接近"多机"诉求，但自有协议 |
| [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im) | 2625 | JavaScript | MIT | 2026-10-25 | 插件：扫码/机器人凭据接入 IM（飞书/微信/钉钉/企微/QQ/Slack/Telegram/Discord/WhatsApp） | 在 IM 里与 DSH agent 对话 | 中：旁路通道，不是 App |
| [THEWOLFWALKER/dsh-notifier](https://github.com/THEWOLFWALKER/dsh-notifier) | 59 | JavaScript | MIT | 2026-10-17 | 28 个出站通道 + 6 个入站控制的远程控制平面 | 通知与远程控制 | 中低 |
| [GDWhisper/dsh-web-startup-auth](https://github.com/GDWhisper/dsh-web-startup-auth) | 63 | TypeScript | MIT | 2026-10-23 | 远程 Web 启动插件 + 用户名/密码认证 | 反代前置鉴权 | 低中：可作本插件 relay 前的鉴权层 |

### ⑤ P2P / 自建 Relay / SSH 隧道类远程方案

| 仓库 | ★ | 语言 | 许可证 | pushed | 连接机制 | 核心能力 | 相关度 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote) | 882 | TypeScript | 未见 LICENSE | 2026-10-27 | DSH 插件 + 自有服务：LAN→WebRTC P2P→TURN→加密 WS Relay 四级协商；客户端 Android/iOS/Web | 多端访问本机 DSH、E2EE、设备与 peer 身份双授权 | 高：P2P/relay 产品化程度最高，直接竞品 |
| [april-jk/dsh-relay](https://github.com/april-jk/dsh-relay) | 2 | TypeScript | MIT | 2026-08-19 | 云 Relay：账号/配对/短期票据/流量中转（可为 dsh-mobile-suite 私有部署） | 出站 WSS、E2EE 帧中转、SQLite | 高：与本插件 relay/server.cjs 最可比的公开实现 |
| [Buzzso/dsh-sev](https://github.com/Buzzso/dsh-sev) | 137 | JavaScript | MIT | 2026-08-27 | 本地 GUI 混排远程会话 + SSH 隧道（watchdog 自动重连）+ 远程 session API | 把服务器变 DSH"分身"，关掉本地也不中断 | 中高：SSH 出站方案，多机管理 |
| [flymysql/dsh-remote](https://github.com/flymysql/dsh-remote) | 187 | JavaScript | MIT | 2026-10-27 | 插件主动 SSH 连出多台机器；远端起仅监听 127.0.0.1 的 `dsh web`，端口经隧道搬回本机 loopback；一次性登录令 | 多机列表、远程工作区、远端 DSH 界面挂到本机、体检/部署 | 高：多机列表 + 远端官方 UI，思路与本插件最近（但走 SSH） |
| [vibeinging/dsh-desktop](https://github.com/vibeinging/dsh-desktop) | 485 | JavaScript | MIT | 2026-10-26 | 内置手机远程：LAN/P2P/TURN/Relay + Noise IK（另见 §3） | 桌面 + 远程一体 | 高：relay 协议栈参照 |

### ⑥ 官方仓库与官方 App 相关

| 仓库/文档 | ★ | 语言 | 许可证 | pushed/日期 | 形态 | 与本插件关系 | 相关度 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 262694 | TypeScript | MIT | 2026-10-23 | monorepo：apps/desktop、apps/desktop-host、apps/web、apps/cli、packages/sdk、docs/api-gateway.md；官方 Web UI 默认 127.0.0.1:3080 | 本插件的官方基础与协议来源；永久性：无移动 App | 高（基础） |
| [docs/api-gateway.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/api-gateway.md) | - | Markdown | MIT | 2026-10 | Typert API Gateway：`@Remote`/`@RemoteScope` 经 Connection RPC + `/api/remote.mux` WS 传输 | 第三方客户端唯一可依赖的"官方协议"（工程文档级） | 高 |
| [peer-principal-and-remote-access 笔记](https://github.com/deepseek-ai/deepseek-harness/blob/main/.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.md) | - | Markdown | MIT | 2026-10-12 | peer/principal 模型；liveshare viewer 请求经 Relay 到 owner 的 Host 插件 | 证明官方内部已有 Relay/远程访问模型，但非公开 App 协议 | 中高 |
| [deepseek-ai/dsh-libreoffice-kit](https://github.com/deepseek-ai/dsh-libreoffice-kit) | 199 | JavaScript | MIT | 2026-09-30 | 官方内部组件（Office 渲染），非 App | 无直接关系 | 低 |
| [deepseek-ai/dsh-node-addon-require-builtin](https://github.com/deepseek-ai/dsh-node-addon-require-builtin) | 18 | C++ | MIT | 2026-10-12 | 官方内部组件（Node addon），非 App | 无直接关系 | 低 |
| [deepseek-ai/awesome-deepseek-agent](https://github.com/deepseek-ai/awesome-deepseek-agent) | 6307 | - | - | 2026-09-17 | 官方 Agent 集成列表，无 DSH App 条目 | 证明官方未运营 App 生态 | 低 |

### ⑦ 补充：Web UI 移动优化 / PWA 插件（手机端体验）

| 仓库 | ★ | 语言 | 许可证 | pushed | 连接机制 | 核心能力 | 相关度 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [mexiaosqwq/dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile) | 174 | TypeScript | MIT | 2026-10-26 | 纯前端插件（窄屏适配） | 窄屏好用、宽屏适用 | 中：配合远程壳让本插件多机入口在手机上可用 |
| [kuraneko1/dsh-mobile-maxxing](https://github.com/kuraneko1/dsh-mobile-maxxing) | 47 | JavaScript | MIT | 2026-10-26 | 插件：PWA + 通知 + 移动 UX + CJK 显示 | 可安装 PWA、离线启动、通知 | 中：与远程方案叠加 |
| [lehhair/dsh-mobile](https://github.com/lehhair/dsh-mobile) | 25 | TypeScript | BSD-3-Clause | 2026-09-06 | 插件：PiUI 翻页器结构（scroll-snap 两页） | 移动端手势/键盘适配 | 中 |
| [Z-6354/dsh-mobile-hanui](https://github.com/Z-6354/dsh-mobile-hanui) | 18 | JavaScript | MIT | 2026-10-05 | 插件：≤1023px 触屏布局修正 | 侧栏/弹窗/输入框移动适配 | 中 |

### ⑧ 补充：鸿蒙 / 多端 / 非 Windows 桌面

| 仓库 | ★ | 语言 | 许可证 | pushed | 连接机制 | 核心能力 | 相关度 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [QinpanWan/dsh-harmonyos-pc](https://github.com/QinpanWan/dsh-harmonyos-pc) | 32 | TypeScript | MIT | 2026-10-09 | 鸿蒙适配（原生 ELF/.node、node-pty 补丁）+ 桌面/平板客户端 | 让 dsh 在 HarmonyOS 跑起来、缓存预设 | 中：新平台分发 |
| [hnmrxz/deepseek-harness-desktop-HarmonyOS](https://github.com/hnmrxz/deepseek-harness-desktop-HarmonyOS) | 7 | JavaScript | MIT | 2026-09-21 | HAP 内自带 Node + dsh 核心树（0.1.6-alpha.2），本机 127.0.0.1 起停；桌面态直载官方 Web UI | 鸿蒙手机/平板/2in1 本地跑、多核心版本切换 | 中：本地运行类 |
| [xiaogouyo/dsh-harmonyos](https://github.com/xiaogouyo/dsh-harmonyos) | 2 | JavaScript | NONE | 2026-08-15 | Electron 壳 + ohos_electron_hap 打包，自动拉起 dsh web | 鸿蒙 PC/2in1 客户端 | 低中 |
| [Zhou-Yujing114514/deepseek-harness-linux](https://github.com/Zhou-Yujing114514/deepseek-harness-linux) | 153 | TypeScript | MIT | 2026-10-26 | Linux 打包（AppImage/.deb/.tar.gz） | 一等公民 Linux 桌面分发 | 低中 |
| [WSL043/DSH-Portable](https://github.com/WSL043/DSH-Portable) | 80 | JavaScript | Apache-2.0 | 2026-10-26 | 便携化：一个文件夹带走会话/设置/插件/工作区 | 稳定版 Win/macOS/Linux | 低中 |

## 4. Top 9 连接机制详解（与本插件直接对标）

1. **april-jk/dsh-mobile-suite（App + 可自建 Relay，最接近本插件架构）**：电脑端 `dsh-mobile-plugin` 只建立**出站 WSS** 连 Relay，DSH 仍绑定 `127.0.0.1:3080`；手机扫电脑上的加密配对二维码，**Relay 负责账号、配对、短期票据，只转发不透明加密帧**（HTTP/SSE/WebSocket 内容在 App 与 Companion 间 E2EE，Relay 拿不到内容密钥）；App 设备列表显示所有"已配对电脑"，选中一台即打开**该电脑的正常 DSH Web UI**；Relay 可私有部署（8787 + SQLite），默认公有 relay 为 `relay.dshmobile.online`。差异：切换=App 换连另一台电脑，不是同一 UI 内切换会话；其设备鉴权/票据模型与本插件共享令牌模型不同，但**"出站 WSS + E2EE 中转 + 官方 UI"三段式几乎相同**。
2. **saya-ch/dsh-mobile（App 设备列表，多机切换体验最完整）**：电脑装 DSH Mobile 插件，插件在本机起独立 HTTPS/WS 网关（含设备配对、私有 CA、可选自托管 Caddy 证书）；手机 App 是 WebView 包官方 UI，另有 LAN 与 Tailscale/Funnel、cpolar、cloudflared、自建 FRP、自有反代多通道；README 明写 App"将已配对电脑集中显示在设备列表中，支持切换、重新配对或删除"，并可设"启动行为→显示设备列表"。差异：多机列表在 App 层，多通道杂，不涉及官方 Gateway 跨机透传。
3. **liguobao/ds-harness-remote（P2P/TURN/Relay 四级协商）**：DSH 插件 + 自有服务，连接顺序 `LAN → P2P(WebRTC) → TURN → 加密 WebSocket Relay`，E2EE、Host 端本地固定 peer 身份 + 服务端成员双授权；官方 README 列出 Android/iOS/Web 客户端与 Desktop/agon/ACP gateway 适配。差异：它是"把本机 DSH 暴露给多端"，本插件是"多台 DSH 在一个前端里互通"；但 relay 回退与授权模型可直接对照。
4. **zexadev/dsh-tether（iroh P2P + relay 回退 + 手机本地模式）**：插件携带 Rust sidecar，两端通过 iroh QUIC 打洞直连，失败才回落只载密文的 relay；6 位配对码 + 出站代理；同一 App 在无电脑时用 arm64 APK 内打包的 Node 24 + dsh 0.2.1-rc.2 本地跑，Hosts 列表管理多机。差异：客户端与传输均自研，宿主侧需装 `dsh-plugin-tether`。
5. **summer1238/dsh-remote-web-gateway（纯 Web 反代 + 一次性配对）**：插件一键起 Cloudflare Quick Tunnel，出公网二维码；一次性配对 + GitHub 授权登录 + 每设备独立授权/撤销，无需 SSH/公网 IP/端口转发。差异：反向代理官方 Web UI，**主机装本插件时，手机壳天然能看到"远程会话"入口**——是本插件最可能的零改码落地方式之一。
6. **shaobeichen/dsh-pocket（LAN/公网扫码 + WS 全透传）**：插件一键 LAN 开关 + cloudflared 快速/命名隧道，二维码分发；WebSocket 全透传实现"电脑输出、手机同步滚动"、双向操作、心跳重连、隧道自恢复。与本插件组合方式同 5。
7. **Clarklevis1995/dsh-mobile + dsh-plugin-mobile-gateway（原生协议重写代表）**：桌面/手机装 gateway 插件，插件以 WebSocket + 设备鉴权对外提供会话、实时事件、消息同步、审批、Goal、命令菜单等一套**自有 App 协议**；KMP 客户端（Whaleness）在 iOS/Android 原生渲染。适配本插件需在 gateway 里加"多机/relay"端点或改客户端。
8. **flymysql/dsh-remote（多机列表 + 远端官方 UI 挂载）**：桌面插件主动 SSH 连多台机器，选"远程工作区"或把远端 `dsh web`（仅 127.0.0.1）经隧道搬到本机 loopback，用一次性登录令打开远端 DSH 界面；设置里"多机列表/体检/部署/端口转发/审计"。差异：出站 SSH 而非 relay，但"一个前端看多台 DSH"的产品形态与本插件最接近。
9. **Blank-not-black/dsh-Remote（多服务器自动选优的控制台）**：插件 + 单文件 gateway + 客户端，LAN/Tailscale 直连，WS + 长轮询、离线历史；手机端会话/审批/提问/文件传输，宣称"多服务器自动选优"。差异：自有 console 不是官方 UI，切换语义偏"连哪台服务器"。

## 5. 关键问题逐条回答

**Q1：有无 App 已支持"多台 DSH 机器/会话切换"？**
- 有"多主机客户端"级实现：april-jk/dsh-mobile-suite（已配对电脑列表）、saya-ch/dsh-mobile（设备列表+切换）、zexadev/dsh-tether（Hosts 多机管理）、flymysql/dsh-remote（多机 SSH 列表+远端 DSH UI）、Blank-not-black/dsh-Remote（多服务器自动选优）、ccch1mneyyy/dsh-go（切换主机）。
- 没有"单前端原地切换会话/工作区所属机器"的实现：上述全部在 App/插件层"换一台电脑连"或"挂远端 UI"，不存在本插件这种"当前官方 UI 不动，只把 Gateway 连接经 relay 指向另一台机器，会话在目标机运行、原机无感"的模式；也无人做跨机插件同步（本插件 plugin-sync 独有）。
- 结论：本插件定位仍空白；最接近的 april-jk/saya-ch 是"App 内多机"，不是"UI 内多机"。

**Q2：有无官方 App 协议或移动端 SDK？**
- 无官方 App/SDK。官方 org 45 仓库无移动端项目；官方 App 形态仅 Desktop/Web/CLI；`packages/sdk` 是宿主内嵌 SDK。
- 可用的"官方协议"只有工程层 Typert API Gateway（`@Remote` 方法 → `/api/remote.mux` WS）与 peer/principal+Relay 的内部模型；官方文档站与 docs/ 目录无 mobile/app/第三方客户端章节，也未发布协议版本化规范。
- 因此生态协议高度碎片：至少 6 套自有方案（Clarklevis1995 mobile-gateway、saya-ch 插件网关、april-jk Companion+Relay、dsh-plugin-tether iroh、dsh-pocket/bridge HTTP 反代、liguobao APIProxy/P2P）。对本插件含义：**不要指望对接标准 App 协议；要么做"官方 Web UI 壳"零改码，要么提供适配层**。

**Q3：哪些明显只是"手机本地跑 DSH"而非远程客户端？**
- 见 §2 全部 13 个 + 鸿蒙 2 个（hnmrxz、QinpanWan 偏本地）；判定证据：README 自述"内置 Node/PRoot/Termux""127.0.0.1:3080 本地""无需电脑/无需配对""不是 PC 上 dsh 的遥控器"。其中 DSH-APP/DSHA、kelai141、WSK-build/DSHBox、Soodok、Tongyu3、dphmoblie、pht88888888、Thanksgiver233、YOYOFeelings 支持插件管理 → 理论上可装本插件当 relay 节点，但内置 dsh 多为 0.2.x（部分低于本插件要求的 `>=0.2.1-rc.2`）；everettjf/dsh-ios 与 Vengisk/termux 生态受限；ZSeven-W/rish-app 是多引擎本地壳，不以 DSH 远程为主。

### 5.1 关键证据摘录（原文，便于复核）

- saya-ch/dsh-mobile：「App 在一个列表中显示局域网和远程配对的电脑，定期检测可达状态，并支持切换、重新配对或删除本地记录」；「启动行为 → 显示设备列表：每次启动先选择电脑，适合经常在多台设备之间切换」。
- april-jk/dsh-mobile-suite：「The phone never connects directly to the computer. The plugin opens only an outbound WSS connection to the Relay, while DSH remains bound to `127.0.0.1:3080`」；「DSH HTTP, SSE, and WebSocket content is encrypted end to end … The Relay routes opaque frames and does not receive the content key」；设备列表截图为 `docs/images/mobile-devices.png`（Paired DSH computers）。
- liguobao/ds-harness-remote：「Remote negotiates paths in the order `LAN -> P2P -> TURN -> Relay`」「When WebRTC is unavailable … falls back to the encrypted WebSocket Relay」「Server membership and the Host's locally pinned peer identity must both authorize a connection」。
- zexadev/dsh-tether：「Direct first (iroh hole-punching), relay only as fallback and it sees ciphertext only; no account, no server to run」；「Open the app → Hosts in the top bar → Run on this phone」（Hosts 列表 = 多机管理）。
- flymysql/dsh-remote：「维护多台 SSH 机器……把远端机器的 DSH 界面挂到本机……远端只监听 127.0.0.1」；设置页含「多机列表、连接体检、远程 DSH 界面、端口转发、审计日志」。
- 官方 API：`docs/api-gateway.md`「`@Remote` … the Gateway delivers each yielded item … over its multiplexed `/api/remote.mux` WebSocket」；内部笔记「Viewer requests reach the owner's liveshare Host plugin through the Relay」。
- 官方仓库结构（tree 21889 条，未截断）：`apps/desktop`、`apps/desktop-host`、`apps/web`、`apps/cli`、`packages/sdk`、`docs/api-gateway.md`；无 `mobile`/`app-*` 目录。

## 6. 与本插件适配的工程判断

| 适配路径 | 含义 | 代表项目 | 工作量/风险 |
| --- | --- | --- | --- |
| A. 零改码远程 Web UI 壳 | 手机打开的是电脑上的官方 UI，本插件注入的"远程会话"入口随之出现；切换后由 relay 透传官方 Gateway | dsh-pocket、dsh-bridge、summer1238、dataelement、dsh-tauri、lencx/Minke、chokwinlee、WhaleIsle、anywhere-labs | 低；只需两端装插件+同一 relay。风险：壳若做了 UI 裁剪/自定义（Minke 投屏、WhaleIsle 移动 UI）可能丢入口 |
| B. 官方 UI + 插件宿主（可装本插件） | 桌面/本地运行 App 本身就是官方 DSH 进程，插件生态可用 | 官方 Desktop、anywhere-labs、ningbainb、myYangyunfan、whitelonng、oh-dsh、fufankeji、DSH-APP/DSHA、kelai141、WSK-build/DSHBox、Soodok | 中；需 DSH ≥0.2.1-rc.2（插件自身 1.0.0）与插件 profile 支持；移动端 App 的 dsh 版本普遍偏旧，需升级或 fork |
| C. 原生协议重写（需改客户端） | App 只认自有 gateway 协议，看不到本插件 UI，也不能直接切机 | Clarklevis1995、saya-ch、april-jk、201222-L、sorsama、Hakunm、SCSpotato、hongshuxifan321、zexadev、Blank-not-black | 高；要么在对方 gateway 加 relay/多机端点，要么给本插件加 App 适配协议 |
| D. 纯隧道/反代（插件装主机侧） | 手机经隧道访问主机官方 Web UI，本插件在主机生效 | 手机浏览器 + dsh-pocket/dsh-bridge/summer1238/GDWhisper；配合 kuraneko1/mexiaosqwq/Z-6354/lehhair 移动适配 | 低；最现实的首发适配路径，PWA 可再加分 |

## 7. 生态空白点（对本插件的战略含义）

1. **"单 UI 内多机会话切换"无竞品**：现存多机产品全是"客户端层面选一台机器"，没有把官方 Gateway 协议经 relay 指到另一台机器的实现；本插件的"同一前端、会话在目标机跑、原机无感"是独有卖点，建议在 README/宣传中直接对标 april-jk/saya-ch 作差异说明。
2. **没有官方 App 协议 = 适配层机会**：生态里 6+ 套自有协议，互不兼容；本插件若提供"relay 多机 + 官方协议"能力，可成为"App 的通用后端"，或反向提供"App 适配器"（把多机列表暴露给 April-jk/Saya 类客户端）。
3. **跨机插件同步无人做**：生态里只有单机插件市场/启动器（dsh-market 9101★、yyh-001/DSH-X、fufankeji），没有跨机器同步插件与启用状态的产品；本插件 plugin-sync 是第二个硬差异点，值得单独宣传。
4. **多机 relay 的信任模型可借鉴**：april-jk（账号+设备+短期票据+E2EE）、liguobao（服务端成员+Host 本地 peer 双授权）、zexadev（配对码+公钥）都比本插件"共享令牌"更细粒度；若本插件面向多用户/多设备，建议补设备级票据与撤销。
5. **版本碎片是最大落地阻力**：大量 App 内置 dsh 0.1.x/0.2.x，本插件要求 DSH ≥0.2.1-rc.2（插件自身 1.0.0）；官方 developer preview 明确会破坏兼容。建议插件在启动时做版本探测并给出可读降级提示，同时优先适配"官方 Desktop + 官方 Web UI 壳"这条路（A/B 类），把移动端原生协议适配放到第二阶段。

### 7.1 建议的下一步验证（按性价比排序）

1. **A 类路径实测**：在 dsh-tauri/deepseek-harness-desktop 或 dataelement/dsh-desktop 上装本插件与 relay，用其手机端（扫码/配对）打开官方 UI，验证"远程会话"入口与跨机切换在移动壳内是否完整可用；这是最快能对外演示的组合。
2. **april-jk 深度对比**：部署其 dsh-relay 与 dsh-mobile-plugin，实测多电脑切换体验与 E2EE/票据模型，作为本插件 README 差异化对标的基准；重点比较"换 App 里的电脑"与"换 UI 里的机器"两种语义。
3. **协议适配评估**：读 Clarklevis1995/dsh-plugin-mobile-gateway 的 WS 消息面，评估能否在其上增加 `relay/machines` 端点，让 Whaleness 类原生 App 复用本插件的多机能力；或反向给本插件加一个轻量 App REST/WS 适配层。
4. **版本兼容测试**：抽样 DSH-APP/DSHA（内置 0.2.1-rc.2）、kelai141、WSK-build/DSHBox，验证本插件在 DSH 低于 0.2.1-rc.2 时的行为与报错，决定是否加版本探测/降级提示。
5. **可发现性**：向 awesome-dsh-plugin（2 万★）与 dsh-market（9101★）提交本插件条目，并在 README 中标注 "remote relay + multi-machine switch + plugin sync" 三个关键词，便于与上述竞品区分。

## 附录

- 逐仓元数据快照（stars/language/license/pushed_at）来自 `gh api repos/{owner}/{repo}`，2026-10-27 10:26–10:50 之间；`-` 表示 API 未返回（缺失语言或未声明 license 的以"未见 LICENSE/NOASSERTION"标注）。
- 搜索命令示例：`gh api -X GET search/repositories -f q="dsh mobile" -f per_page=50`；README：`gh api repos/{owner}/{repo}/readme -H "Accept: application/vnd.github.raw"`。
- 生态发现类仓库（未入表，供后续人工浏览）：`awesome-dsh-plugin/awesome-dsh-plugin`(20924★)、`dsh-market/dsh-market`(9101★)、`AdamPlatin123/dsh-plugin-radar`(1484★)、`0xsline/awesome-deepseek-harness`(1260★)、`Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins`(560★)、官方 topic `dsh-plugin`（约 1.9 万仓库）。
- 本报告只读调研，未修改仓库源码、未提交 commit；数据只写入本文件。
