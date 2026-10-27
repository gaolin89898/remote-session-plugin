# DSH Remote Session

在多台 DSH 之间切换工作区和会话，继续使用 DSH 自带的页面、编辑器和模型选择器。对话由当前选中的那台机器运行。

> **需要自备服务器。** 插件不会替你托管或部署中转服务。本机和远端 DSH 都必须能访问你自己的 relay 服务器。按[部署指南](relay/README.md)操作即可。

如果你希望 AI 代为部署，可把[部署指南中的提示词](relay/README.md)交给能通过 SSH 访问服务器的 AI。

## 安装

在每台 DSH 上安装插件并重启。两端都需要 **1.0.0 或更新版本**。

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

## 插件同步

在 **设置 → 远程会话 → 插件同步** 中选择目标机器，可安装缺少的插件、更新已发布插件和同步启用状态。插件配置、令牌和本地路径不会复制。

## 安全与常见问题

只把自己的可信设备接入同一个 relay。共享令牌允许访问该 relay 下的所有设备，不要把令牌提交到 Git 或写进公开配置文件。

- relay 未连接：检查地址是否包含 `/dsh-relay`，并确认两台机器的令牌相同。
- 看不到另一台机器：确认它已启动 DSH、安装 1.0.0 以上版本插件，并使用相同的地址和令牌。
- relay 服务未运行：在服务器查看 `sudo journalctl -u dsh-relay -n 100 --no-pager`。
