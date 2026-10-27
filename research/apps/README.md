# DSH App 调研（GitHub）— 资料索引

调研日期 2026-10-27。目标：回答"GitHub 上有没有 DSH 的 App、能否与本仓库 `dsh-remote-session` 插件适配"。

## 建议阅读顺序

1. **[00-REPORT.md](00-REPORT.md)** — 主报告：结论、适配方案（零改码 / 原生 App / 桌面宿主 / App 网关）、推荐路线与风险。
2. **[00-plugin-protocol-brief.md](00-plugin-protocol-brief.md)** — 本插件对外协议与三种接入面速览（适配基线）。
3. **[01-ecosystem-survey.md](01-ecosystem-survey.md)** — GitHub 生态全景：60 个仓库 / 8 分类 / Top9 连接机制 / 空白点。
4. **[02-mobile-deepdive.md](02-mobile-deepdive.md)** — 11 个手机端项目源码级深挖：谁可零改码、谁要改客户端、协议风险。
5. **[03-desktop-gateway-integration.md](03-desktop-gateway-integration.md)** — 8 个桌面壳 + 5 个 Web/手机网关的集成可行性。

## 一句话结论

- **有 App，但没有官方手机 App**；生态高度碎片化（≥6 套私有协议）。
- **没有竞品实现本插件的"单 UI 内多机切换"**；最接近的是 april-jk（App 内多电脑列表）与 saya-ch（设备列表切换）。
- **最快落地是零改码**：手机浏览器/PWA 或"官方 UI 壳 App"（saya-ch / zexadev）+ 在 Host 装本插件；本机 `dsh-vps-remote` 公网通道今天即可验证。
- **要原生 App 直连 relay**：首选改造 `sorsama/deepseek-harness-mobile`（DSH 侧零改，约 1–2 人周）。
- **桌面 App**：`dataelement/dsh-desktop`、`dsh-tauri`、`anywhere-labs/dsh-desktop`（compatibility）可装本插件。

## 目录说明

```
research/apps/
├── 00-REPORT.md                     # 主报告（交付物）
├── 00-plugin-protocol-brief.md      # 插件协议速览
├── 01-ecosystem-survey.md           # 生态清单
├── 02-mobile-deepdive.md            # 手机端深挖
├── 03-desktop-gateway-integration.md# 桌面/网关集成
├── repos-mobile/                    # 手机端候选浅克隆（约 245MB，未提交）
├── repos-desktop/                   # 桌面 App 浅克隆（约 600MB，未提交）
└── repos-web/                       # Web/网关浅克隆（约 50MB，未提交）
```

克隆物仅用于证据复核，已被本目录 `.gitignore` 排除；不需要时可整体删除 `repos-*/` 回收约 900MB 磁盘。

## 复核提示

- GitHub 数据（stars/license/pushed_at）为 2026-10-27 快照，会变化。
- 报告中的协议结论均附 `文件:行号`；克隆仓库的 HEAD 与报告记录的时间一致。
- 未做真机/端到端验证的条目在正文标注"待验证"。
