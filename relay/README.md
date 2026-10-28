# 部署 relay 中转服务

relay 负责连接 DSH 设备并转发消息。它只在内存中保存在线状态和会话列表，不保存会话内容。你需要一台 Ubuntu 22.04/24.04 服务器、一个指向该服务器的域名，以及 HTTPS 证书。

## 让 AI 帮你部署

把下面的提示词交给能使用终端和 SSH 的 AI，把服务器别名和域名换成自己的。不要把 SSH 密码或 relay 令牌写进提示词：

```text
请直接帮我部署这个项目里的 DSH relay 中转服务，不要只给我操作建议。

服务器：<SSH 配置中的别名，或 user@服务器地址>
域名：<已解析到这台服务器的域名>
项目：https://github.com/gaolin89898/remote-session-plugin

请使用我本机已有的 SSH 密钥或 SSH 配置登录；不要索取、打印或保存密码。先检查服务器系统、Node.js、Nginx、现有 relay 服务、域名解析和防火墙规则。若已有 relay 或令牌，先备份配置并保留现有令牌，不要覆盖其他网站的 Nginx 配置。

在 Ubuntu 22.04/24.04 上部署仓库的 relay/server.cjs，使用专用 dsh-relay 系统账号和 relay/dsh-relay.service；令牌放在 /etc/dsh-relay/token，权限只允许 root 和服务账号读取。使用 Nginx 将 HTTPS 的 /dsh-relay/ 转发到 127.0.0.1:3098，保留 SSE 长连接配置并关闭该路径的 access log；为域名配置有效证书。不要把 3098 端口开放到公网。

部署后运行配置检查，确认 dsh-relay 已启用、Nginx 配置有效，并且 https://<域名>/dsh-relay/health 返回 {"ok":true}。不要在输出、日志或最终回复中显示令牌。最后告诉我 Relay 地址、服务状态、查看日志的方法，并提醒我在每台 DSH 的“设置 → 远程会话”中手动填写相同的地址和令牌、为每台机器填写不同的实例 ID。如果发现已有配置与此步骤冲突，先说明情况并暂停修改。
```

AI 必须能从当前电脑通过 SSH 访问服务器；否则它只能整理命令，不能代你执行。

## 安装服务

先在服务器安装 Node.js 22 LTS、Nginx 和 Certbot：

```bash
sudo apt update
sudo apt install -y nginx curl openssl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs certbot python3-certbot-nginx
node --version
```

版本应为 `v22` 或更新版本。然后创建专用服务账号、安装 relay 程序并生成随机令牌：

以下命令用于首次部署。若服务器已有 relay 或令牌，请先备份并保留现有令牌，不要重新生成。

```bash
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin dsh-relay
sudo install -d -o root -g root -m 755 /opt/dsh-relay
sudo install -d -o root -g dsh-relay -m 750 /etc/dsh-relay
sudo curl -fsSL https://raw.githubusercontent.com/gaolin89898/remote-session-plugin/main/relay/server.cjs \
  -o /opt/dsh-relay/server.cjs
sudo chmod 644 /opt/dsh-relay/server.cjs
if [ ! -s /etc/dsh-relay/token ]; then
  sudo sh -c 'umask 077; openssl rand -hex 32 > /etc/dsh-relay/token'
fi
sudo chown root:dsh-relay /etc/dsh-relay/token
sudo chmod 640 /etc/dsh-relay/token
```

安装并启动 systemd 服务：

```bash
sudo curl -fsSL https://raw.githubusercontent.com/gaolin89898/remote-session-plugin/main/relay/dsh-relay.service \
  -o /etc/systemd/system/dsh-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-relay
sudo systemctl status dsh-relay --no-pager
```

服务只监听 `127.0.0.1:3098`，不要把 3098 端口开放到公网。

## 配置 HTTPS

先将 `relay.yourdomain.com` 换成你自己的域名，并把域名解析到服务器 IP。云防火墙和系统防火墙需要允许外部访问 80、443 端口。

```bash
sudo curl -fsSL https://raw.githubusercontent.com/gaolin89898/remote-session-plugin/main/relay/nginx.conf.example \
  -o /etc/nginx/conf.d/dsh-relay.conf
sudo sed -i 's/relay.example.com/relay.yourdomain.com/g' /etc/nginx/conf.d/dsh-relay.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx --redirect -d relay.yourdomain.com
```

如果启用了 UFW 防火墙，也要开放 HTTP 和 HTTPS：

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

检查地址：

```bash
curl -fsS https://relay.yourdomain.com/dsh-relay/health
```

返回 `{"ok":true}` 表示 relay 可访问。插件配置中的 Relay 地址要填完整路径，例如 `https://relay.yourdomain.com/dsh-relay`。

新插件使用 `Authorization: Bearer <token>` 建立 SSE 连接，令牌不进入 URL。relay 为兼容旧客户端仍接受 query 中的令牌，迁移期间保持 Nginx 模板中的 `access_log off`。当请求携带 `Authorization` 时，以请求头为准，不会退回 query 鉴权。

升级顺序：先备份并更新 relay 程序、重启服务，再更新各设备插件。保留现有令牌，不需要重新配对。旧部署可能在 `/health` 泄露实例信息，升级后应确认匿名请求只返回 `{"ok":true}`，包括已有设备在线时。

## 配置 DSH

在每台 DSH 的 **设置 → 远程会话** 中填写：

1. Relay 地址：`https://relay.yourdomain.com/dsh-relay`
2. 访问令牌：运行 `sudo cat /etc/dsh-relay/token`，把输出内容填入每台机器。
3. 实例 ID：每台机器各不相同，例如 `home`、`office`。
4. 实例名称：填写对方容易认出的设备名称。

保存后应看到“relay 已连接”。两端插件都需为 1.0.0 或更新版本。

## 查看状态

```bash
sudo systemctl status dsh-relay --no-pager
sudo journalctl -u dsh-relay -n 100 --no-pager
```

修改 relay 程序后执行 `sudo systemctl restart dsh-relay`。服务重启后在线设备会自动重新连接。

本机验证 relay 启动、令牌鉴权和 SSE 注册：在仓库目录运行 `node --test test/relay-server.mjs`。
