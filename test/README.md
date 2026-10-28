# 测试

`npm test` 运行离线测试与本机 HTTP 集成测试，不读取真实会话、连接线上 relay 或调用模型。

`npm run test:native` 使用已安装的 Windows 版 DeepSeek Harness，在临时目录生成两个隔离的 DSH_HOME，连接本机测试 relay，并通过 Playwright 验证：

- 本机与远端之间切换，保留原生工作区和会话界面。
- 使用目标机器的完整客户端组件及对应脚本版本，本地组合在切回后恢复。
- 远端独有插件显示设置页，同名插件加载远端版本；设置读取和修改只作用于目标机器，切回后恢复本机配置。
- 工作区、会话和二进制附件请求在目标机器执行。
- 插件比较、同步与同步后的远端组件刷新。
- 桌面与窄屏下的布局、环境标识和设置错误恢复。
- 机器菜单中的重启按钮、确认与取消、旧版本和离线状态，以及真实 Web 实例重启后的自动重连。

`test/restart.mjs` 另行验证 Windows、macOS、Linux 的启动策略、服务归属判断和重复请求，并用隔离进程验证 Web 与桌面主进程/Host 的退出和重新启动。系统策略测试不代表已在 macOS 或 Linux 桌面应用上实测。

运行前执行 `npm ci`、`npm run build`。默认使用 `%LOCALAPPDATA%/Programs/DeepSeek Harness` 和 Playwright Chromium 1228；可设置 `DSH_DESKTOP`、`DSH_CHROMIUM`。测试生成自己的令牌与会话，不使用真实用户凭据或调用模型；结束后关闭测试进程。截图写入被 Git 忽略的 `research/browser/out/`。

只检查真实 DSH 实例重启时，可设置 `DSH_NATIVE_RESTART_ONLY=1` 后运行 `npm run test:native`。

每次升级 DSH 都应运行双实例验证，并记录实际版本。离线能力检查只验证 API 与组件是否存在，不能保证不同版本的内部协议始终兼容。

2026-10-28 验证：插件 `1.2.0`，DSH `0.2.1-rc.3`，41 项自动测试与真实双实例浏览器验证通过，包含远端独有插件、同名插件的不同客户端版本、设置的目标端保存与本机隔离，以及 Windows 上真实 DSH Web 实例的远程重启、进程更换和自动重连。验证待部署的 relay 文件时，可将 `DSH_RELAY_TEST_SERVER` 设置为其绝对路径后运行 `node test/relay-server.mjs`；该测试使用临时令牌与本机端口。

`setup.ps1`、`run-a.cmd`、`run-b.cmd` 和 `verify.mjs` 是保留的手工双实例调试工具。`setup.ps1` 默认复制少量真实会话；需要隔离测试时使用 `-SkipSessions`，或优先使用 `test:native`。
