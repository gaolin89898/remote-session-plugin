# dsh-remote-session

通过 relay 切换本机和远程 DSH 实例，直接使用 DSH 自带的工作区列表、会话页面、编辑器和图标。

## 使用

**服务器要求：需要自备一台本机与远端 DSH 都能访问的服务器，部署并运行 relay 中继服务。** 本项目不提供托管服务器；两端要配置相同的 relay 地址和访问令牌，并确保网络端口可达。

1. 每台机器安装插件并重启 DSH。
2. 在 DSH 设置中的「远程会话」填写 relay 地址、访问令牌、实例 ID 和实例名称。各机器的实例 ID 必须唯一。
3. 点击侧栏「远程会话」，通过与官方「更多」相同的弹出菜单选择本机或远程机器；离线机器不可选择。
4. 切换会重新加载页面，随后 DSH 原生工作区和会话组件使用选中机器的数据。模型及会话执行环境均来自该机器。

当前机器选择按浏览器标签页保存，工作区选择和会话草稿按机器隔离。切回本机恢复原有本机连接与存储。连接设置始终管理当前客户端所在机器的 relay 配置。

侧栏底部常驻显示当前本机或远程机器名称，以及「客户端」或「Web 端」；连接远程机器时，「远程会话」入口右侧也显示机器名称和运行端，切回本机后隐藏入口右侧提示。切换机器后自动更新，远程离线时显示离线状态；收起侧栏后保留底部紧凑提示，悬停可查看完整信息。

两端都需要安装 1.0.0 或更新版本的插件，并重启 DSH。旧版对端会显示升级提示。

### 同步插件

在「设置 → 远程会话 → 插件同步」选择目标机器，比较本机与目标的插件清单，勾选后同步。双方的远程会话插件均需为 1.0.0 或更新版本。

同步通过 DSH 官方插件管理服务安装缺少的插件、更新已发布版本，并匹配选中插件的启用状态。目标机器上其他插件保持原样，插件配置、访问令牌和机器路径不复制。官方内置插件采用目标 DSH 自带的版本，基础组件和远程连接插件需要单独升级。未发布的本地路径、Git 或压缩包来源插件会显示为不可同步；目标版本较新时，官方更新接口会拒绝降级。

每个插件显示同步结果，失败不会阻止后续插件。任务在目标机器后台执行，关闭设置页或临时断线后可重新查看进度，也可取消当前安装及后续任务。需要重启时会提示目标机器重启 DSH；任务历史在目标 DSH 重启后清除。

## 实现

插件注册侧栏机器选择入口、环境提示和设置项，不注册独立的工作区或会话主面板。

- `tools/machine-client.tsx`：复用宿主提供的官方 `Menu`、图标和状态点。
- `lib/native-transport.js`：通过官方 `webserver/index-inject` 在 Connection 初始化前安装传输；转发原生 HTTP、Gateway 流及附件上传。
- `lib/native-gateway.js`：在远端创建官方 Peer，调用共享 API 与 Gateway，管理流、取消、顺序、背压和连接释放。
- `lib/plugin-sync.js`：比较可迁移的插件信息，调用官方插件管理服务，并管理同步任务及取消。
- `lib/index.js`：relay 连接、实例发现、原生协议转发，以及兼容旧版的 Host RPC。

会话文件始终由所属机器的 DSH 写入，插件不直接修改会话文件。relay 使用共享令牌鉴权；拥有令牌的机器属于同一信任组，应只接入可信设备。原生转发拥有目标 DSH 的 owner 权限。

生产客户端不再加载 `lib/vendor` 中的旧版会话组件。`vendor/.src` 和旧构建脚本保留为源码参考，`research/browser` 中早期面板测试不适用于当前入口。

## 构建与验证

```sh
npm ci
node tools/build-machine-client.mjs
node --test test/native-transport.mjs test/plugin-sync.mjs
node research/browser/native-e2e.mjs
```

原生端到端测试使用两个临时 `DSH_HOME`、本地测试 relay 和真实 DSH Web 客户端，不读取现有会话或令牌，也不调用模型。Windows 默认使用已安装的 DeepSeek Harness 和 Playwright Chromium；可通过 `DSH_DESKTOP`、`DSH_CHROMIUM` 指定安装目录及浏览器可执行文件。截图输出到 `research/browser/out/`。

`node tools/bake-client.mjs` 会重新构建，并同步 Host、Client 和文档到两份 `dist` 分发目录及本机 desktop profile。已有的机器配置和令牌保持原样。Host 更新后必须重启 DSH。

## 安装与配置

使用 DSH 桌面应用自带的 CLI 安装到 desktop profile：

```bat
"C:\Users\<用户>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "file:C:\path\to\remote-session-plugin"
```

也可将 `dist/dsh-remote-session-company` 复制到另一台机器，再使用其桌面 CLI 安装该目录。安装后重启 DSH。

源码的 `cordis.patch.yml` 不包含令牌。设置页保存配置到 `~/.dsh/remote-session-settings.json`，保存后立即重连。初始配置也可通过 `DSH_RELAY_URL`、`DSH_RELAY_TOKEN`、`DSH_RELAY_INSTANCE_ID`、`DSH_RELAY_INSTANCE_NAME` 提供。

## 协议与限制

插件私有 HTTP 路由为 `/remote-session/api/*`，由 DSH 的浏览器认证保护。`state`、`refresh` 提供机器状态，`settings`、`settings-save` 管理本机设置，`native` 承载原生 API 与流操作。

relay 保持 v1 协议：`/v1/register`、`/v1/stream`、`/v1/index`、`/v1/publish`。应用层新增 `native` RPC，无需增加 relay 路由。传输受 HTTP 请求大小和 relay 配置限制，不等同于无限制文件传输。

远端和本机应使用兼容的 DSH 版本；前端模块仍由本机 DSH 提供。连接远端时，启动列表取双方已安装组件的交集，并排除依赖不完整的组件，防止本机独有插件调用远端不存在的接口。远端页面不订阅本机插件热更新；刷新页面会重新检查组件。连接或兼容性检查失败时自动返回本机，并在机器菜单中保留错误原因。切回本机恢复完整启动列表。远端需要自行配置可用模型和工具。原生机器切换目前通过页面重载完成。

官方参考源码许可证保留在 `vendor/LICENSE.deepseek-harness`。
