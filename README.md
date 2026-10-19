# aipool

**N 个上游 LLM Key → 一个局域网端点 + 一个 token。**

跑在 Mac mini（或任何常开的机器）上，把 OpenCode Go、Ark、DeepSeek、OpenRouter、Ollama……这些上游的 Key 聚成一个池子，对局域网暴露一个 OpenAI 兼容（同时兼容 Anthropic Messages）的地址。任何客户端只需要：

```bash
export OPENAI_BASE_URL=http://192.168.8.10:8787/v1
export OPENAI_API_KEY=sk-aipool-xxxxxxxx
```

额度耗尽、凭据失效、上游 5xx 都会**在这一次请求里**换到下一个账号/下一个供应商重试，客户端只看到一次成功的回复。

```
                 ┌──────────────── aipool (Mac mini, :8787) ───────────────┐
 MacBook  ──────►│  token 鉴权 → 模型解析 → Key 池 ──┬─► opencode-go/k1   │
 iPhone   ──────►│       ↑                            ├─► opencode-go/k2   │
 iPad     ──────►│   dashboard (/)                    ├─► ark-plan/k1      │
 另一台服务器 ───►│   最近请求 / 配额 / 冷却            └─► ollama/local    │
                 └──────────────────────────────────────────────────────────┘
```

---

## 为什么不用插件而是独立服务

`dsh-opencode-go` 是一个 DSH 插件：它只在 **DSH 进程里**接管 `opencode-go` 这一条路由，换句话说，只有 DSH 能用，只有 OpenCode Go 能用。

`aipool` 把同样的思路抽成独立服务：

| | dsh-opencode-go 插件 | aipool |
|---|---|---|
| 谁能用 | 只有 DSH | 任何 OpenAI/Anthropic 客户端（DSH、opencode、Claude Code、Cursor、脚本、手机） |
| 哪些上游 | 只有 OpenCode Go | 任意 OpenAI 兼容 + Anthropic 兼容，可混用 |
| 切换粒度 | Key | Key × 供应商 |
| 凭据 | DSH credentials seam | 本地 `~/.aipool/config.json`（0600）+ 环境变量引用 |
| 部署 | 跟着 DSH 生命周期 | LaunchAgent 常驻，开机自启 |

---

## 30 秒零 Key 试跑

仓库自带一个假上游，故意让第 2、3 个 Key 分别返回 429 和 401，用来演示自动切换：

```bash
cd aipool
node examples/demo-upstream.mjs --port 18081        # 终端 A
```

```bash
export AIPOOL_HOME=/tmp/aipool-demo                 # 终端 B，避免污染正式配置
node bin/aipool.mjs init --port 8787 --name demo
node bin/aipool.mjs provider add --id demo \
  --base-url http://127.0.0.1:18081/v1 --model demo-model \
  --usage-url http://127.0.0.1:18081/v1/usage
node bin/aipool.mjs key add --provider demo --label 好号   --key sk-good
node bin/aipool.mjs key add --provider demo --label 耗尽号 --key sk-exhausted
node bin/aipool.mjs key add --provider demo --label 坏号   --key sk-invalid
node bin/aipool.mjs serve
```

另开终端，用 `init` 打印的那个 `sk-aipool-…`：

```bash
TOKEN=sk-aipool-...
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"model":"demo-model","messages":[{"role":"user","content":"hi"}]}' -D -
```

响应头里的 `x-aipool-route: demo/k3` 和 `x-aipool-attempts: 3` 就是证据：前两个号 429/401，第三个号成功，客户端无感。

打开 `http://127.0.0.1:8787/?token=<admin token>` 看面板。

---

## 接入真实上游

`aipool init` 会生成一份带三个 provider 骨架的配置（OpenCode Go、Ark Agent Plan、Ollama）。加 Key 只要一条命令：

```bash
# OpenCode Go（多账号）
aipool provider add --id opencode-go --type openai \
  --base-url https://opencode.ai/zen/go/v1 \
  --usage-url https://opencode.ai/zen/go/v1/usage \
  --models-url https://opencode.ai/zen/go/v1/models
aipool key add --provider opencode-go --label 账号A     # 交互式粘贴，不回显
aipool key add --provider opencode-go --label 账号B

# 火山方舟 Agent Plan（Anthropic 协议 + Bearer 鉴权）
aipool provider add --id ark --type anthropic \
  --base-url https://ark.cn-beijing.volces.com/api/plan \
  --path /v1/messages --auth-header bearer \
  --model deepseek-v4-pro,doubao-seed-2.1-pro,glm-5.3
aipool key add --provider ark --label 方舟

# DeepSeek 官方
aipool provider add --id deepseek --type openai \
  --base-url https://api.deepseek.com/v1 --model deepseek-chat,deepseek-reasoner
aipool key add --provider deepseek --label 主号

# OpenRouter（一个 Key 打很多模型）
aipool provider add --id openrouter --type openai \
  --base-url https://openrouter.ai/api/v1 \
  --models-url https://openrouter.ai/api/v1/models
aipool key add --provider openrouter --label OR

# 本机 Ollama（不需要真 Key，随便填一个）
aipool provider add --id ollama --type openai \
  --base-url http://127.0.0.1:11434/v1 --priority 900 --model qwen3-coder
```

改完如果 daemon 在跑，CLI 会发 `SIGHUP` 让它热加载，不用重启。

> Key 支持环境变量引用，配置文件里可以只写 `"key": "${DEEPSEEK_KEY}"` 或 `"key": "env:DEEPSEEK_KEY"`。

---

## 客户端怎么用

### curl / 任何 OpenAI SDK

```bash
curl http://192.168.8.10:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-aipool-..." -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4-pro","messages":[{"role":"user","content":"hi"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://192.168.8.10:8787/v1", api_key="sk-aipool-...")
print(client.chat.completions.create(model="deepseek-v4-pro",
      messages=[{"role":"user","content":"hi"}]).choices[0].message.content)
```

### DSH

设置 → 模型 → 新增一个 OpenAI 兼容供应商：

- Base URL：`http://192.168.8.10:8787/v1`
- API Key：`sk-aipool-...`
- 模型：`/v1/models` 里挑，或写 `provider/model`

### Claude Code / 任何 Anthropic 客户端

```bash
export ANTHROPIC_BASE_URL=http://192.168.8.10:8787
export ANTHROPIC_AUTH_TOKEN=sk-aipool-...
claude
```

`/v1/messages` 是原生支持的：入站 Anthropic、上游 OpenAI 时，工具调用、图片、流式都会双向翻译。

### 别的机器

同一个 token 可以直接发给 MacBook / iPhone / 另一台服务器。每台设备建议 `aipool token new --name macbook` 单独发一个，泄漏了只撤那一个。

需要限制某台设备只能用某些模型：`aipool token new --name ipad --models deepseek-v4-pro,glm-5.3`。限制只作用于客户端**显式写了**的 model；不写 model 时走 `routing.defaultModel`，不会被拦。

---

## 自动切换规则

一次请求最多尝试 `routing.maxAttempts` 次（默认 4），每次按「供应商优先级 → 该供应商内最久未用的 Key」挑一个：

| 上游返回 | 判定 | 动作 | 冷却 |
|---|---|---|---|
| 401 / 403 | 凭据失效 | 标记 `invalid`，换 Key | 15 分钟（面板可一键重置） |
| 402、调用额度用完（429 + `quota` 文案） | 额度耗尽 | 标记 `exhausted`，换 Key | 10 分钟 + 用量接口报告恢复即复活 |
| 普通 429（每分钟限流） | 被限流 | 换 Key | 20 秒（有 `Retry-After` 就按它，上限 10 分钟） |
| 5xx、连接重置、超时 | 上游有病 | 换 Key | 15 秒 / 8 秒（同样尊重 `Retry-After`） |
| 404 + `model not found` | 这个供应商没这个模型 | **换供应商**，不惩罚 Key | 5 分钟内跳过该组合 |
| 400 / 413 / 422 | 请求本身有问题 | **不重试**，原样返回给客户端 | — |

- **流式也安全**：先拿到上游第一个 SSE 事件再给客户端发响应头；首个事件就是错误的，仍然换号重试，客户端看不到半截流。
- **中途断流**：已经吐过 token 的流无法静默重放，会发一条 SSE error 事件收尾，并把该 Key 打入冷却。
- **配额感知**：配了 `usageUrl` 的供应商按各自的 `usageRefreshMs`（默认 60 秒）探测 5h/周/月用量，`preemptAtPercent` 达到阈值就提前避让（默认 100 = 只在失败后切），窗口重置后自动复活，不靠计时器猜。
- **网关自己不会把 Key 判死**：冷却都是绝对时间戳落盘，重启后照旧生效；过期即自动恢复。
- **跨供应商兜底**：模型写成裸 id（`deepseek-v4-pro`）时，所有声明了这个模型的供应商都算候选，按 `priority` 依次尝试；写成 `provider/model` 就只打那一个。

---

## 面板

`http://<mac-mini-ip>:8787/?token=<admin token>`（`aipool dashboard --open` 直接打开）

- 每个 Key 的 5h / 周 / 月配额条、重置倒计时、冷却倒计时、请求数、错误数、平均延迟、最近错误
- 重置冷却 / 停用 / 启用 / 探活（真发一次最小请求）
- 客户端 token 列表：最近使用、请求数、停用
- 最近 50 条请求：模型、实际路由、尝试次数、耗时、错误码
- 断线时保留上次数据并挂横幅，不会白屏

---

## CLI

```
aipool init [--port 8787] [--name 设备名]      初始化配置，打印 admin token 和第一个客户端 token
aipool serve                                    前台运行（SIGHUP 热加载，Ctrl-C 退出）
aipool status [--json]                          池状态 / 配额 / 令牌（从运行中的 daemon 读）
aipool dashboard [--open]                       打印（并打开）带 token 的面板地址

aipool key add --provider ID --label 名称 [--key K]
aipool key ls | rm --provider ID <id|label> | test [--provider ID]

aipool token new --name macbook [--rpm 60] [--models a,b]
aipool token ls | revoke <id|name> | disable|enable <id|name>

aipool provider add --id ID --type openai|anthropic --base-url URL [--model ...] [--path ...]
aipool provider ls | rm <id>

aipool install | uninstall                       macOS LaunchAgent（开机自启 / 崩溃重启）
aipool logs [-f] [--n 100]
aipool doctor                                   体检：配置、Node、端口、监听地址、LaunchAgent
```

环境变量：`AIPOOL_HOME`（默认 `~/.aipool`）、`AIPOOL_CONFIG`、`AIPOOL_LOG_LEVEL=debug`。

---

## 配置参考

`~/.aipool/config.json`（0600）。`aipool config --json` 可以打印生效值（Key 已脱敏）。

```jsonc
{
  "version": 1,
  "server": {
    "host": "0.0.0.0",              // 局域网可达；只给本机用就改 127.0.0.1
    "port": 8787,
    "allowFrom": ["127.0.0.1/32", "::1/128", "192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12"],
    "trustProxy": false,             // 放在反代后面时读 X-Forwarded-For
    "maxBodyBytes": 67108864,        // 图片/长上下文的请求体上限
    "dashboard": true
  },
  "auth": {
    "adminToken": "adm_…",           // 面板用；绝不能发给客户端
    "tokens": [{ "id": "tk_…", "name": "macbook", "hash": "sha256…", "disabled": false, "rpm": null, "models": null }]
  },
  "routing": {
    "defaultModel": "auto",          // 客户端不写 model 时用它
    "maxAttempts": 4,                // 一次请求最多试几个 (供应商, Key) 组合
    "retryDelaysMs": [150, 500, 1200, 2000],
    "streamIdleTimeoutMs": 300000,
    "requestTimeoutMs": 600000,
    "exposeModels": "all"            // all=裸 id 也列出来；aliases=只列 provider/model
  },
  "cooldown": { "rateLimitMs": 20000, "serverMs": 15000, "transportMs": 8000, "authMs": 900000, "quotaMs": 600000 },
  "providers": [{
    "id": "opencode-go",
    "name": "OpenCode Go",
    "type": "openai",                // openai | anthropic
    "baseUrl": "https://opencode.ai/zen/go/v1",
    "chatPath": "/chat/completions", // anthropic 默认 /v1/messages
    "modelsPath": "/models",
    "authHeader": "bearer",          // bearer | x-api-key | both（方舟 plan 用 bearer）
    "priority": 10,                  // 越小越优先
    "timeoutMs": 300000,
    "models": [{ "id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro" }],
    "modelsUrl": "https://opencode.ai/zen/go/v1/models",
    "usageUrl": "https://opencode.ai/zen/go/v1/usage",
    "preemptAtPercent": 100,
    "streamUsage": true,             // 流式时向上游要 usage；少数兼容服务不认 stream_options 就设 false
    "headers": {},
    "keys": [{ "id": "k1", "label": "账号A", "key": "sk-…", "enabled": true, "weight": 1 }]
  }],
  "aliases": {
    "gpt-4o": ["opencode-go/glm-5.3", "ark/doubao-seed-2.1-pro"]
  }
}
```

- `aliases` 是**跨供应商兜底**的显式写法：别名 → 有序的 `provider/model` 列表，前一个死光自动下一个。
- `auto` 是保留虚拟模型：优先用 `aliases.auto`，没写就按 provider 优先级取各自目录里的第一个模型。

---

## 部署到 Mac mini

```bash
git clone <this-repo> ~/aipool && cd ~/aipool
node bin/aipool.mjs init
# … 加 provider / key …
node bin/aipool.mjs install      # LaunchAgent：开机自启 + 崩溃重启
node bin/aipool.mjs doctor
node bin/aipool.mjs status
node bin/aipool.mjs logs -f
```

- 服务文件：`~/Library/LaunchAgents/com.aipool.gateway.plist`，日志 `~/.aipool/aipool.log`
- macOS 防火墙放行 `node`（或直接把端口限制在局域网）
- 只在局域网用：`allowFrom` 保留私网段即可；要从外网用，走 Tailscale/WireGuard，别直接把 8787 暴露到公网
- 详见 [docs/mac-mini.md](docs/mac-mini.md)

---

## 安全

- 客户端 token 只存 sha256，`token ls` 永远看不到明文；泄漏就 `token revoke`
- admin token 与客户端 token 分离：面板接口不认客户端 token
- 上游 Key 只存在 `~/.aipool/config.json`（0600），接口和日志里只出现 `sk-abcd…wxyz`
- `allowFrom` 按 CIDR 拦来源 IP；`trustProxy` 默认关，防止伪造 `X-Forwarded-For`
- **token 只能放在请求头里**（`Authorization` 或 `x-api-key`），查询串 `?token=` 只在面板地址里由浏览器自己解析，服务端 API 不接受——避免 token 落进访问日志
- 面板 HTML 由服务端产出，所有数据走 `textContent` 注入，无 `innerHTML` 拼接

---

## 设计取舍

- **每次请求现选 Key**，不做「当前活动 Key」这种全局粘性状态：并发请求互不干扰，一个号挂了不会让整条流卡在它身上。代价是同一对话的相邻请求可能落到不同账号上（对无状态 API 无影响）。
- **冷却用绝对时间戳**落盘，重启后继续生效；用量数据带抓取时间，超过 15 分钟就丢弃，避免「上次关机前 99%」把 Key 永久判死（这正是插件版的一个坑）。
- **超时覆盖整个响应体读取**，不只是响应头：上游发完头就吊住 body 时，请求会在 `timeoutMs` 后断开并换号。
- **失败分类决定重试范围**：客户端自己的 400 绝不重试（否则四次 4xx 白烧时间）；模型不存在只换供应商不罚 Key。
- **不做跨对话记忆/计费聚合**，只做「一个入口 + 一个池 + 看得见的状态」。

---

## 测试

```bash
node --test test/*.test.mjs
```

35 项：池状态机（轮换/冷却/复活/配额预判/限流与额度分流/Retry-After）、协议双向翻译（含 SSE、stream_options 开关）、端到端网关（鉴权、429 换号、跨供应商兜底、400 不重试、流式、流空闲超时、413、Anthropic 双向、token 模型白名单）、重启后状态恢复与过期数据丢弃。全部用本地假上游，不需要任何真 Key。

---

## 与 dsh-opencode-go 的关系

思路同源，实现独立。`aipool` 可以同时服务 DSH 和其他客户端；如果你想继续用 DSH 插件形态，插件仍然可用，但它只覆盖 OpenCode Go 一家、且只服务 DSH。插件版的缺陷清单与修法见 [docs/audit-dsh-opencode-go.md](docs/audit-dsh-opencode-go.md)。

MIT.
