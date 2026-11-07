# AI 工具箱

DSH 插件的一半：`dsh-remote-session` 现在同时提供「远程会话」「Agent 工作台」和「AI 工具箱」。侧栏「AI 工具箱」是 WorkBuddy / Trae / Qoder 的账号、签到、任务与奖励页面；账号数据仍由本机单独运行的 Go 账号服务（`toolbox/`）保存。

## 与远程会话的关系

AI 工具箱跟随「远程会话」选中的电脑：页面资源、账号、统计、签到设置、任务、奖励和客户端操作都通过 DSH 通道访问当前电脑上的 Go 服务。两端都要安装**同一版本**的合并后插件，并各自运行账号服务；目标端版本过旧时页面会提示更新插件。

切换电脑会重新加载页面，管理密钥、备注与页面偏好按电脑隔离；首次连接每台电脑需输入对应 Go 服务的管理密钥。远端离线、未安装插件或未启动后端时显示连接错误，不回退读取本机数据。远程导入文件上限为 16 MB。

## Go 账号服务

`toolbox/` 是原来的 WorkBuddy2API Panel 仓库（Go + Vue）。插件不启动、停止或打包 Go 程序，也不读取 `config.json`、`auths/` 或 `data/`；只做页面与同源接口转发，管理密钥仍由 Go 服务校验。

```sh
# 账号模式，默认监听 127.0.0.1:7863
cd toolbox
go run ./cmd/server -config config.json
```

端口通过插件配置 `backendPort`（默认 7863）指定；只允许本机回环访问，不开放远程 URL 配置。

## 构建与验证

页面源码在 `toolbox/web/`，Go 内嵌页与插件独立页共用这一份源码：

```sh
npm --prefix toolbox/web ci
npm --prefix toolbox/web run build:standalone
node tools/build-toolbox.mjs        # 生成 public/{index.html,accounts.js,index.css}
node tools/build-machine-client.mjs # 生成含工具箱入口的 lib/client.js
npm test                            # 含 toolbox-server / toolbox-remote 测试
```

`npm run preview:toolbox` 可在 5174 端口独立预览页面，仍需要先启动 Go 账号服务。

## 迁移

旧版独立插件 `dsh-workbuddy-accounts` 已并入本插件：升级时应先卸载旧插件，再安装/更新 `dsh-remote-session`；远程机器上的旧插件与账号服务同样处理。旧插件的 `backendPort` 配置改到本插件配置里。
