# DSH AI 工具箱

独立 Vue 页面与 DSH 插件入口，当前版本 **0.1.8**。Go 后端仍由本机单独运行；插件不启动、停止或打包 Go 程序，不读取 `config.json`、`auths/` 或 `data/`。

## 构建与打包

在本目录运行：

```powershell
npm --prefix ../web ci
npm run build
npm test
npm pack
```

构建生成 `web/dist/` 和插件的 `public/`，打包生成 `dsh-workbuddy-accounts-0.1.8.tgz`。包内只包含页面、DSH 入口和本机接口转发代码，不包含账号数据、密钥或 Go 二进制。

原有 `web` 目录的 `npm run build` 继续生成 Go 内嵌页面；独立版本使用 `npm run build:standalone`，不依赖 Go 编译。两个版本共用页面源码。更新插件时先用 `npm version patch --no-git-tag-version` 递增版本，并同步文档中的包名，再构建、检查和打包，避免缓存复用同版本旧资源。

## 运行方式

1. 在项目根目录启动本机账号服务；已有独立后台服务运行时直接使用：

   ```powershell
   $env:WB2A_LISTEN='127.0.0.1:7863'
   .\wb2api.exe -config config.json
   ```

2. 在 DSH 插件管理器安装本地 `.tgz`，或使用 CLI。桌面版使用 `desktop` profile：

   ```powershell
   dsh plugin --profile desktop add "file:C:/绝对路径/dsh-workbuddy-accounts-0.1.8.tgz"
   ```

   独立 Web 版将 `--profile desktop` 改为 `--profile web`。更新已安装插件时使用同一命令，包名以 `npm pack` 输出为准。

3. 在侧栏打开「AI 工具箱」，首次使用时输入本机服务的管理密钥（后端 `config.json` 的 `api_key` 字段）。插件页面与原页面属于不同来源，首次需要重新输入。更新后刷新页面加载新资源，入口未出现时重新加载 DSH。

默认连接 `127.0.0.1:7863`。可通过插件配置的 `backendPort` 改端口，目标地址固定为本机。DSH 和后端必须运行在同一台电脑，本插件不提供远程转发。

已验证 DSH `0.2.1-rc.5` 的本机 Web 模式，以及桌面版 `desktop` profile 使用本机 HTTP 页面时的菜单、主题和接口连接。自定义协议来源及其他布局模式尚未验证；当前接口桥接仅接受本机 HTTP/HTTPS 来源。

关闭页面或卸载插件不会关闭 Go 后端，后台签到继续由 Go 服务执行。账号和签到设置仍保存在原来的 `auths/`、`data/` 和 `config.json`；签到选项保存在 `data/account-settings.json`（跟随 `state_file` 目录），后端重启后保留。

## 独立页面预览

在本目录运行 `npm run preview`，访问 <http://127.0.0.1:5174/workbuddy-accounts/>。`FRONTEND_PORT` 可改页面端口，`WORKBUDDY_BACKEND_PORT` 可改本机 API 端口。预览仍需先启动后端。

该预览服务与 DSH 使用同一接口桥接。前端资源使用相对路径，API 请求发往页面目录的 `api/`，再转给本机 `/panel/api/`。因此插件前端更新无需重新编译或重启 Go；Go 内嵌页面更新仍需重新编译并重启后端。

接口桥接只接受本机、同源请求，保留 Go 管理密钥验证，不转发 DSH Cookie，不开放跨域访问。页面资源不包含凭证；iframe 只允许同源嵌入，不修改 Go 原有的嵌入保护。DSH 的插件来源应保持可信。

嵌入 DSH 时，页面和 Arco 滚动条自动跟随 DSH 的深浅色与皮肤配色；独立打开时保留页面自己的主题设置。签到设置的三个开关开启为蓝底“开”、圆点在右，关闭为灰底“关”、圆点在左，两种主题均使用白色圆点和文字；点击「保存设置」后才生效，「取消」恢复已保存选项。

点击 DSH 侧栏的「AI 工具箱」展开账号、任务中心、活动奖励、签到设置和运行日志菜单。嵌入页面不再显示第二列侧栏、签到概览和最近活动；管理密钥入口在「签到设置」页。积分明细页面及入口已移除，账号页仍保留余额和刷新积分。

显示名称为「AI 工具箱」，包名仍为 `dsh-workbuddy-accounts`，页面路径仍为 `/workbuddy-accounts/`。
