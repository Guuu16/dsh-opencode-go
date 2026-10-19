# 在 Mac mini 上常驻

目标：Mac mini 开机就跑 `aipool`，局域网里任何设备随时能用；崩溃自动拉起；日志可查；升级不丢配置。

## 1. 准备

```bash
# Node >= 20（Homebrew 或官方安装包都行）
node -v

git clone <repo> ~/aipool
cd ~/aipool
node bin/aipool.mjs init --port 8787
```

`init` 会生成 `~/.aipool/config.json`（0600）、一个 admin token、一个客户端 token（只显示一次）和一个监听结构，先把这两串东西存进密码管理器。

## 2. 加 Key 并先手工跑一次

```bash
node bin/aipool.mjs provider add --id opencode-go --type openai \
  --base-url https://opencode.ai/zen/go/v1 \
  --usage-url https://opencode.ai/zen/go/v1/usage \
  --models-url https://opencode.ai/zen/go/v1/models
node bin/aipool.mjs key add --provider opencode-go --label 账号A
node bin/aipool.mjs key add --provider opencode-go --label 账号B

node bin/aipool.mjs serve          # 前台跑，Ctrl-C 退出
```

另开一个终端自查：

```bash
TOKEN=sk-aipool-...
curl -s http://127.0.0.1:8787/v1/models -H "Authorization: Bearer $TOKEN" | head -c 300
node bin/aipool.mjs status
node bin/aipool.mjs key test       # 每个 Key 真发一次最小请求
```

确认无误再交给 launchd。

## 3. 装成 LaunchAgent

```bash
node bin/aipool.mjs install
node bin/aipool.mjs doctor
```

- plist：`~/Library/LaunchAgents/com.aipool.gateway.plist`
- `RunAtLoad` + `KeepAlive`：登录即启动、退出即拉起
- 日志：`~/.aipool/aipool.log`（stdout/stderr 都进这里）
- 卸载：`node bin/aipool.mjs uninstall`

常用运维：

```bash
launchctl print gui/$(id -u)/com.aipool.gateway | head -20
launchctl kickstart -k gui/$(id -u)/com.aipool.gateway   # 手动重启
node bin/aipool.mjs logs -f
```

改了配置（`key add`、`token new` 等）CLI 会自动 `SIGHUP` 热加载；手改 `config.json` 也可以：

```bash
kill -HUP $(cat ~/.aipool/aipool.pid)
```

## 4. 局域网访问

```bash
ipconfig getifaddr en0        # 例如 192.168.8.10
```

客户端填 `http://192.168.8.10:8787/v1`。

- **建议给 Mac mini 固定 IP**（路由器里 DHCP 绑定），否则 IP 变了所有客户端都要改。
- macOS 防火墙：系统设置 → 网络 → 防火墙 → 选项，允许 `node` 接收入站连接。
- `server.allowFrom` 默认只放行回环 + 三个私网段，够局域网用。

## 5. 从外网用（可选）

不要直接把 8787 端口映射到公网。两条安全路线：

**Tailscale（推荐）**

```bash
brew install --cask tailscale
# 登录后拿 Mac mini 的 100.x.y.z 地址
```

客户端把 base URL 换成 `http://100.x.y.z:8787/v1`，流量走 WireGuard，不暴露端口。

**反向代理 + 只许 VPN**

Caddy/Nginx 反代到 `127.0.0.1:8787`，`server.trustProxy` 改 `true`；再把 `allowFrom` 收紧到 VPN 网段，或者干脆保持 `host: 127.0.0.1` 只让反代访问。

## 6. 升级

```bash
cd ~/aipool && git pull
node --test test/*.test.mjs        # 先验一遍
launchctl kickstart -k gui/$(id -u)/com.aipool.gateway
```

配置在 `~/.aipool/config.json`，与代码目录分离，`git pull` 不会动它。

## 7. 备份与排障

```bash
cp ~/.aipool/config.json ~/Documents/aipool-config.backup.json   # 里面有明文 Key，注意存放位置
```

| 现象 | 先看什么 |
|---|---|
| 客户端 401 | `aipool token ls`；token 是不是被 `disable` 了 |
| 面板打不开 | `aipool doctor` 的端口检查；`curl 127.0.0.1:8787/healthz` |
| 请求很慢 | `aipool status` 看某 Key 的平均延迟；`logs -f` 看是否在反复重试 |
| 全部 429 | 面板配额条；`aipool key test` 逐个验号 |
| 某个号永久失效 | 面板「重置冷却」或 `clearInvalid` 等价操作；确认 Key 在供应商后台还有效 |
| 改了配置没生效 | `kill -HUP $(cat ~/.aipool/aipool.pid)`；或 `launchctl kickstart -k` |
