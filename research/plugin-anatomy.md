# DSH 第三方插件解剖：打包 / 安装 / 调试（Host + Client）

> 调研对象：DSH 0.2.1-rc.2（本机 npx CLI）/ 0.2.1-rc.3（Desktop 运行时）。
> 只读参考了 desktop profile 已装的 `dsh-better-sidebar@0.28.0`、`@linxin666/dsh-ssh@0.4.8`、`dshmarket@1.66.37`，
> 以及服务器 `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 下官方包源码。
> 未修改 desktop profile / app.asar / 服务器配置。

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 最小结构 | `package.json` + `cordis.patch.yml` + `lib/index.js`(Host ESM) + `lib/client.js`(浏览器 CJS-factory 包裹) |
| 客户端格式 | **不是普通 ESM**：必须 `window.__ModuleLoader__.load({id, factory(require){...return module.exports}})`，id = 包名 |
| 构建工具 | 官方/第三方均 `tsc` + `tsdown`(rolldown) 产出该包裹；**可手写 plain JS**（本骨架即手写） |
| 安装 | `dsh plugin --profile <p> add <pkg|file:绝对路径>` → 转发 pnpm，装进 `~/.dsh/profiles/<p>/node_modules`，并把包名追加进 `dsh.profile.bundles` |
| 安全验证 | 新建临时 profile（本机已建 `hello-test`）+ `--dump-config`；桌面 profile 被 CLI 显式禁止管理 |
| 验证结果 | ✅ 组合/挂载成功，Host 自定义路由 `GET /hello/api/ping` 实跑返回 JSON；⚠️ client.js 未做端到端浏览器验证 |

## 1. 最小包结构（Host 端 + Client 端）

```
hello-plugin/
├─ package.json          # dsh.bundle.patch / dsh.client / exports["./client"]
├─ cordis.patch.yml      # 一个 insert 行，把插件挂进 loader 树
└─ lib/
   ├─ index.js           # Host：ESM cordis 插件（export name/inject/apply[/Config]）
   └─ client.js          # Client：__ModuleLoader__ 包裹的 CJS-factory 模块
```

### 1.1 package.json 中与 DSH 相关的字段

参考真实包：

- `dsh-better-sidebar/package.json:13-54`
  - `:13 "main": "lib/index.js"`；`:15-35 "exports"`：`.`→`./lib/index.js`，**`"./client"`→`./lib/client.js`**
  - `:39-54`：`"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "inject": [...], "platform": "web" }, "manifestVersion": 1 }`
  - `:36-38 "engines": { "node": ">=20" }`
- `@linxin666/dsh-ssh/package.json:24-40`：多了 `"dsh": { "engines": { "dsh": ">=0.2.1-rc.2" } }`（DSH 版本门槛）
- `dshmarket/package.json:47-59`：`dsh.bundle.patch` + `dsh.client`，**没有 manifestVersion**（可选）

字段语义（源码依据 `dsh-client-modules/lib/index.js`）：

| 字段 | 作用 |
|---|---|
| `type: "module"` + `main` | Host 半以 ESM 被 Loader `import()` |
| `exports["."]` | Host 入口 |
| `exports["./client"]` | **必须**：无此导出而声明 `dsh.client` → boot 抛 `declares dsh.client but exports no "./client" bundle`（`index.js:738`） |
| `dsh.bundle.patch` | 声明本包的 patch 层；`dsh plugin add` 据此自动把包名加入 profile 的 `bundles` |
| `dsh.client.platform` | 必填字符串；`!== "web"` 的条目被静默跳过（`index.js:733-735`） |
| `dsh.client.inject` | 客户端依赖的**整包**（client bundle 需先于本行加载），进 boot graph 的 `inject` 字段（`index.js:407`） |
| `dsh.client.external` | 仅声明**非基线**模块请求；基线 `PLATFORM_MODULES` 表（react、`@deepseek-ai/dsh-client-*` 等）无需声明。自引用/环/缺失供应商会在组合期报错（`index.js:435`，README:50） |
| `dsh.client.immediately` | `true` = 启动即物化该行（否则按需 lazy 加载）（`index.js:69`） |
| `dsh.manifestVersion` | 清单版本，第三方常见 `1`；dshmarket 未写也可用 |
| `dsh.engines.dsh` | 安装时的 DSH 版本门槛（`dsh plugin add` 拦截用） |

### 1.2 cordis.patch.yml 写法

bundle 层 = 顶层 YAML 数组，`insert` 追加 loader 行：

```yaml
- insert:
    - id: hello-plugin            # loader entry id，全树唯一
      name: 'dsh-hello-plugin'    # 模块 specifier，从 profile node_modules 解析
      # config:                   # 可选，schema 来自 Host 的 export const Config
      #   greeting: hello
```

真实样例：`@linxin666/dsh-ssh/cordis.patch.yml:10-12`（就 3 行）；
`dsh-better-sidebar/cordis.patch.yml:39-42` 带 `!!js` 表达式做 aggregate 双挂载守卫；
`desktop/cordis.patch.yml:4-7` 展示 profile 用户层如何按 `id` + `name` 覆盖 `config`，`:46-48` 展示 `disabled: true`，
`:64-76` 展示数组/对象型 config。用户层 patch 在 bundle 层之后合并。

## 2. Client 端如何被打包和加载

**发现链**（`dsh-client-modules/lib/index.js`）：

1. Node 半扫描 Loader 里 enabled 的 entries（`:507-514` `ClientModuleRegistry`，`static inject = ["loader"]`）。
2. 定位该 entry 的 `package.json`，解析 `dsh.client` 声明 + `exports["./client"]` → 绝对 `clientPath`（`:732-743`）。
3. 组合 boot graph（`WebBootEntry`），按 `inject`/`external` 拓扑排序（`:417-444`，环会抛错）。
4. 通过 `ctx.inject(["webServer"])` 的 web carrier 注册 `/plugins` 前缀路由（`:570-571`，`:937`），
   并在 `webserver/index-inject` 钩子里往 HTML `<head>` 注入：`window.__ModuleLoader__` 队列脚本、组合脚本
   preload、bootstrap 脚本、`window.__DSH_BOOT__` 图（`:463-505`）。
5. 浏览器半把每个 bundle 的 factory 注册进模块系统；**执行 bundle 只登记 factory，模块体副作用（含 CSS 注入）在首次物化时才跑**（README:70-72）。

**入口格式**（硬约束）：产物不是 ES module，而是自执行包裹：

```js
window.__ModuleLoader__.load({
  id: 'dsh-hello-plugin',            // 必须是包名（combo 路由 /plugins/<id>/client.js）
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    // require('react') / require('@deepseek-ai/dsh-client-ui-slots') 同步取基线模块
    // require.async('./client.chunk.js') 取 tsdown 切出的懒加载 chunk
    exports.name = '...'; exports.inject = ['slots','locale']; exports.apply = (ctx) => {...};
    return module.exports;           // 必须 return
  }
});
```

证据：`dsh-better-sidebar/lib/client.js:1-30`、`dshmarket/client/client.js:1-2` 均为此包裹；
`@linxin666/dsh-ssh/lib/client.js:16610-16614` 结尾 `exports.apply/inject` + `return module.exports`，
`:16550-16555` 是 client 侧 cordis `inject`（服务名，如 `slots`/`locale`/`layout`）。
CSS：在 factory 内插 `<style>`/`import './x.css'` 由 tsdown 内联（模块体副作用），不要在文件顶层执行。

**构建工具**：`tsc` + `tsdown`。`dsh-better-sidebar/package.json:214` = `tsc -p tsconfig.build.json && tsdown`；
`dshmarket/package.json:25-26` = `tsc -p tsconfig.json && npm run build:client`（`tsdown` + `scripts/normalize-client-banner.mjs` 统一包头注释）。
**可以直接手写 plain JS**，只要自己产出上面的包裹 + 在 `exports` 暴露 `./client`；本骨架 `lib/client.js` 即手写、
无需任何构建依赖（代价是没有 TS 类型与 chunk 切分）。

## 3. 安装与调试路径

CLI 入口（本机实测可用）：

```bash
# 桌面 App 自身的 asar 不直接可跑；实际 CLI 在 npx 缓存里（restart-dsh.cmd:13 同款）
DSH_CLI="C:/Users/32891/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh/lib/bin.js"
node "$DSH_CLI" --version          # 0.2.1-rc.2
node "$DSH_CLI" --help
```

`lib/bin.js` 的关键行为（服务器同版本源码）：

- `:22-23` `dsh <name>` ≡ `dsh --profile <name>`；`plugin` 子命令把剩余参数**原样转发 pnpm**。
- `:35-37` **profile `desktop` 被 CLI 拒绝**："managed exclusively by the Electron application"。
- `:105` launcher 自有 flag：`--profile/--patch/--dump-config/--dump-config-schema/--dump-default-config`；
  其余参数**原样传给被启动的 app**。
- `:115-123` `dsh plugin --profile <p> <pnpm args...>`，profile 首次使用时自动初始化（模板 = `@deepseek-ai/dsh-base`）。

安装（本机实测，装进临时 profile）：

```bash
node "$DSH_CLI" plugin --profile hello-test add "file:C:/Users/32891/Desktop/dsh/remote-session-plugin/hello-plugin"
# dsh: initialized profile hello-test at C:\Users\32891\.dsh\profiles\hello-test
# dependencies: + dsh-hello-plugin file:C:/Users/32891/Desktop/dsh/remote-session-plugin/hello-plugin
# Packages: +1  / Done in 598ms
```

结果结构 `~/.dsh/profiles/hello-test/`：`package.json`（dependencies 出现 `file:` 依赖，`dsh.profile.bundles` 自动追加
`dsh-hello-plugin`）、`cordis.patch.yml`、`node_modules/`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、
`.plugin-manager/logs/operation-*/pnpm.log`。**`file:` 本地目录可直接安装**，也可用 better-sidebar 注释里的 `link:`。

验证组合（不启动服务）：

```bash
node "$DSH_CLI" --profile hello-test --dump-config | grep -B2 -A2 hello
# 363 行输出，尾部：
# == dsh-hello-plugin
# - id: hello-plugin
#   name: dsh-hello-plugin
```

启动 + 自定义路由实测：

```bash
node "$DSH_CLI" --profile hello-test --port 3099 --no-open
# dsh web: http://127.0.0.1:3099/?token=...
curl -s http://127.0.0.1:3099/hello/api/ping
# {"ok":true,"plugin":"dsh-hello-plugin","pid":38380,"dshHome":"C:\\Users\\32891\\.dsh","at":"2026-10-26T01:45:00.528Z"}
```

坑：
- **不要** `dsh --profile X web`：`web` 会被当 app 参数 → `error: too many arguments ... got 1: web`。
  正确：`dsh --profile X` + app flag（`--port 3099 --host 127.0.0.1 --no-open`）。
- 端口别用 3080（用户常驻 `dsh web` 占用）；用 `--port 3099`。
- 缺 web carrier 时 Host 行不会静默失败：boot 打印
  `hello-plugin (dsh-hello-plugin): pending (waiting for service: webServer)`，因为 `inject = ['webServer']`。
- 装官方包会触发版本闸门：`dsh: installation rejected ... incompatible with dsh 0.2.1-rc.2 ... dsh plugin allow-version <pkg@ver> --dsh-version <v> --accept-risk`。
- pnpm 可能以 `ERR_PNPM_IGNORED_BUILDS`（如 koffi）让 `plugin add` 整体标失败：文件已落盘但 **bundles 未追加**，
  需 `pnpm approve-builds` 或手工把包装进 `dsh.profile.bundles` 再 boot。
- 同一前缀路由挂两次 → boot 抛 `duplicate prefix route`（better-sidebar 用 `!!js` disabled 守卫，见其 cordis.patch.yml:26-42）。

HMR / 重载：`dsh-client-hmr/lib/index.js:5` 暴露 SSE `/plugins/events`（`:169`），
`:115` 监听已物化 bundle 的 `client.js` 等产物（按 `mtimeMs/ctimeMs/size` 算 revision），
改动客户端产物即可热替换单行；`require.async` 的 chunk 粒度同理。**Host 半（lib/index.js）改动不会热更**，
需重启 profile（用户侧即 `C:\Users\32891\restart-dsh.cmd:13,26` 那种杀端口重拉）；
profile 目录里 `node_modules/@deepseek-ai/dsh` 与 `app.asar` 内的运行时版本要对齐（runtime.json:7 node 24.21.0）。

清理：`rm -rf ~/.dsh/profiles/hello-test` 即可，不影响 desktop/web。

## 4. Host 半如何注册 HTTP 路由给 Client

`dsh-better-sidebar/lib/index.js:8976-9004`（同款写法直接抄）：

```js
export const inject = [...];                    // :9386 export { Config, apply, inject, name }
ctx.effect(() => ctx.webServer.register({       // 返回 disposer，交给 ctx.effect 以便卸载/重载
  kind: 'prefix',                               // 'prefix' 前缀匹配；也支持 'exact'（better-sidebar:3480）
  path: '/sidebar/api',
  handler: async (req, res) => {
    // 1) 浏览器信任围栏：fence(req)（校验 Cookie/来源），403 拒绝
    // 2) 自己解析 new URL(req.url,'http://dsh.internal').pathname 分发子方法
    // 3) writeJson(res, 200, {...})，永远自己 end()
  },
}));
```

WebSocket 用 `ctx.webServer.registerUpgrade({...})`（`:9230-9260`）。客户端侧就是普通 `fetch('/hello/api/ping')`
（本骨架 client 即如此）。`dsh.client.inject` 里的 `@deepseek-ai/dsh-client-*` 是**浏览器侧** UI 服务包，
与 Host 的 cordis `inject`（服务名数组）是两套东西，别混。

## 5. Hello-World 骨架（已落地，可直接复用）

`C:\Users\32891\Desktop\dsh\remote-session-plugin\hello-plugin\`

| 文件 | 内容要点 |
|---|---|
| `package.json` | `main`/`exports "."`/`exports "./client"`/`dsh.bundle.patch`/`dsh.client{platform:web,immediately:true}`/`manifestVersion:1`/`engines.node` |
| `cordis.patch.yml` | `- insert: [{id: hello-plugin, name: 'dsh-hello-plugin'}]` |
| `lib/index.js` | `export const name/inject=['webServer']`；`apply(ctx)` 内 `ctx.effect(() => ctx.webServer.register({kind:'prefix',path:'/hello/api'}))`，`GET /hello/api/ping` 返回 `{ok:true,...}` |
| `lib/client.js` | 手写 `window.__ModuleLoader__.load({id:'dsh-hello-plugin', factory})`，`apply(ctx)` 里 `ctx.effect` 挂右下角角标并 `fetch('/hello/api/ping')` 打印响应 |

复现步骤：`dsh plugin --profile hello-test add file:<hello-plugin 绝对路径>` → `--dump-config` 应见
`- id: hello-plugin / name: dsh-hello-plugin` → `--profile hello-test --port 3099` 后
`curl /hello/api/ping` 得 JSON。

未完成项（后续可补）：`GET /plugins/dsh-hello-plugin/client.js` 目前 curl 直取 404 ——
该路由受浏览器信任围栏（`?token=` 换 Cookie / Origin 校验）保护，需用真实浏览器打开带 token 的 URL，
看 boot graph 的 `/plugins/??...` combo 是否包含本包；同时确认 `hello-test` 仅 base+web-app 两 bundle 时
client-modules 注入是否完整（建议比对 `web` profile 的 bundles 列表）。
