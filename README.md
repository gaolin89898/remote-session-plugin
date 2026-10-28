# DSH Remote Session

在多台 DSH 之间切换完整界面，包括目标机器的设置、账号、模型、插件、工作区和会话。界面组件及插件版本来自当前选中的机器，配置读取、修改和对话执行也在该机器完成。

[更新记录](CHANGELOG.md)

> **需要自备服务器。** 插件不会替你托管或部署中转服务。本机和远端 DSH 都必须能访问你自己的 relay 服务器。按[部署指南](relay/README.md)操作即可。

如果你希望 AI 代为部署，可把[部署指南中的提示词](relay/README.md)交给能通过 SSH 访问服务器的 AI。

## 安装

在每台 DSH 上安装插件并重启。完整界面切换需要两端都安装 **1.2.2 或更新版本**；旧版目标会提示升级。

```bat
git clone https://github.com/gaolin89898/remote-session-plugin.git
cd remote-session-plugin
"%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "file:%CD%"
```

## 配置

在 DSH 的 **设置 → 远程会话** 中设置：

| 项目 | 填写内容 |
| --- | --- |
| Relay 地址 | 你的 HTTPS 地址，例如 `https://relay.example.com/dsh-relay` |
| 访问令牌 | 服务器 `/etc/dsh-relay/token` 文件的内容 |
| 实例 ID | 每台机器唯一，例如 `home`、`office` |
| 实例名称 | 对方看到的名字，例如“家里电脑” |

所有机器使用同一个 Relay 地址和令牌。保存后状态显示“relay 已连接”，点击侧栏的 **远程会话** 即可切换机器。

切换后，远端独有插件也会显示；设置保存在远端，不覆盖本机配置。切回本机后恢复本机的界面与插件。机器菜单和“远程会话”的 relay 连接管理始终由入口机器提供。

插件市场等插件在 DSH 中注册的同源 HTTP 接口也随机器切换，包括已安装列表、插件操作和设置保存。目标端使用自身 DSH 的鉴权访问这些接口，启动令牌和认证 Cookie 不传给浏览器或 relay；只转发已注册接口，不跟随重定向。

浏览器草稿和界面缓存按机器隔离，不会复制目标浏览器的 Cookie 或缓存。远端插件使用 DSH 原生 API、已注册 HTTP 接口和客户端模块加载机制；依赖操作系统桌面桥接、独立 WebSocket、独立 HTTP 服务或直接页面导航的第三方功能仍取决于其实现，不会自动转发到远端。

## 插件同步

在 **设置 → 远程会话 → 插件同步** 中选择目标机器，可安装缺少的插件、更新已发布插件和同步启用状态。插件配置、令牌和本地路径不会复制。

## 重启 DSH

机器菜单中远程机器右侧的重启图标用于重启该机器上的 DSH，点击后确认，正在运行的任务会中断。重启当前连接的实例后，界面等待它重新上线并自动刷新。

插件根据目标实例的系统和启动方式选择操作：Windows、macOS、Linux 桌面端重启应用与 Host；Web 端优先使用所属的 systemd、PM2 或 launchd 服务，否则保留原程序、参数、目录和环境重新启动。只有确认 DSH 是对应服务的主进程才会操作服务；容器、未识别的服务包装器及旧版目标会禁用按钮并显示原因。各端首次安装此功能后需手动重启一次。

## 安全与常见问题

只把自己的可信设备接入同一个 relay。共享令牌允许访问该 relay 下的所有设备，不要把令牌提交到 Git 或写进公开配置文件。

HTTPS 保护传输，relay 服务器仍可读取转发内容；当前不提供端到端加密。新插件通过 `Authorization` 请求头建立 SSE 连接。升级时先更新 relay，再更新各设备插件；relay 仍兼容旧版客户端，无需更换现有令牌。

- relay 未连接：检查地址是否包含 `/dsh-relay`，并确认两台机器的令牌相同。
- 看不到另一台机器：确认它已启动 DSH、安装 1.2.2 或更新版本插件，并使用相同的地址和令牌。
- relay 服务未运行：在服务器查看 `sudo journalctl -u dsh-relay -n 100 --no-pager`。

## 开发验证

```powershell
npm ci
npm run build
npm test
npm run test:native
```

`test:native` 在临时目录启动两个真实 DSH 实例，通过浏览器验证完整界面切换、远端独有插件、不同插件版本、原生 API 和插件 HTTP 接口的远端读写与本机隔离、原生工作区、附件上传、插件同步与远端重启。需要已安装 Windows 版 DeepSeek Harness 和 Chromium；可通过 `DSH_DESKTOP`、`DSH_CHROMIUM` 指定路径。详情见 [测试说明](test/README.md)。

旧 Vendor 方案已[归档](research/legacy-vendor/README.md)，不参与当前构建或测试。
