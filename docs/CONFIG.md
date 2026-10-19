# 客户端配置：一个本地网关，四种协议

桌面版在 `127.0.0.1:8787` 上按 **OpenCode Go 的原生协议** 原样转发，并自动注入当前账号的 Key 和 `x-opencode-session`。客户端只要选对 Base URL，就能用整个号池。

> 前提：桌面版正在运行（托盘可见），池里至少一个可用账号。网关只监听回环地址。

## 四个 Base URL

| 协议 | Base URL | 典型客户端 |
|---|---|---|
| OpenAI Chat Completions | `http://127.0.0.1:8787/openai/v1` | DSH、ZCode、Cherry Studio、OpenAI SDK |
| OpenAI Responses | `http://127.0.0.1:8787/openai/v1` | Codex CLI（`wire_api="responses"`） |
| Anthropic Messages | `http://127.0.0.1:8787/anthropic` | Claude Code、ZCode、Anthropic SDK |
| Google Generative AI | `http://127.0.0.1:8787/google` | ZCode、Google GenAI SDK |

API Key 一律填占位符 `sk-pool`（代理会替换成当前账号的真实 Key）。`/v1` 仍然可用，但只等价于 OpenAI Chat 组。

桌面版的「模型与协议」卡片启动时会自动调用官方 `/models`，每 6 小时刷新一次，也可以点「同步」；新模型按名称推断协议并标「推断」。下面的 29 个是 pi-ai 目录里有明确协议的；接口当前返回 37 个，多出来的就是推断项。

## 客户端速查

| 客户端 | 用哪个 Base URL | 协议 | 能用的模型 |
|---|---|---|---|
| DSH | `/openai/v1` + `/anthropic`（+ `/google`） | OpenAI Chat / Anthropic / Google | Chat 18 + Anthropic 5（+ Gemini 1） |
| Codex CLI（ChatGPT） | `/openai/v1` | OpenAI Responses | Responses 5 |
| Claude Code | `/anthropic` | Anthropic Messages | Anthropic 5 |
| ZCode | 三种协议各加一个 provider | OpenAI Chat / Responses / Anthropic / Google | 对应协议的那一组 |
| 其他 OpenAI 兼容客户端 | `/openai/v1` | OpenAI Chat | Chat 18 |

## 模型清单（按协议）

> 以 pi-ai 1.3.0 的 OpenCode Go 目录为准，共 29 个。官方 `/inference/go/v1/models` 目前会返回 37 个（多出的是尚未进目录的新模型/免费模型）。配错协议会得到上游 400。

### OpenAI Chat Completions（18）

```text
deepseek-v4-pro        deepseek-v4.1-flash   glm-5.3        glm-5.3-flash   glm-5.2
kimi-k3                kimi-k2.7-code        longcat-2.0    longcat-2.5-preview-free
mimo-v2.5              mimo-v2.5-pro         mimo-v2.6-flash  mimo-v2.6-pro
hy3                    hy4-preview           step-5-preview-free
cat-jam-free           space-bunny
```

### OpenAI Responses（5）

```text
gpt-6-luna   gpt-5.6-luna   grok-4.7   muse-spark-1.3-contributor   muse-spark-1.2-contributor
```

### Anthropic Messages（5）

```text
claude-haiku-5-5   qwen3.8-max   qwen3.8-flash   qwen3.7-plus   minimax-m3
```

### Google Generative AI（1）

```text
gemini-4-argon-contributor
```

**实测结果（逐个模型，max_tokens=4/8）**

| 模型 | 协议 | 结果 |
|---|---|---|
| `deepseek-v4-pro` / `deepseek-v4.1-flash` | OpenAI Chat | ✅ 200 |
| `glm-5.3` / `glm-5.3-flash` / `glm-5.2` | OpenAI Chat | ✅ 200 |
| `kimi-k3` / `kimi-k2.7-code` | OpenAI Chat | ✅ 200 |
| `longcat-2.0` / `mimo-v2.6-flash` / `hy3` | OpenAI Chat | ✅ 200 |
| `step-5-preview-free` | OpenAI Chat | ❌ 400 `Model is unavailable.`（模型已下架；账号未受影响） |
| `claude-haiku-5-5` | Anthropic | ✅ 200 |
| `qwen3.8-max` / `qwen3.8-flash` / `qwen3.7-plus` | Anthropic | ✅ 200 |
| `minimax-m3` | Anthropic | ✅ 200 |
| `grok-4.7` | OpenAI Responses | ✅ 200 |
| `gpt-6-luna` / `gpt-5.6-luna` | OpenAI Responses | ⚠️ 403 地区限制 |
| `muse-spark-1.3-contributor` | OpenAI Responses | ⚠️ 403 `RegionError`（地区限制） |
| `gemini-4-argon-contributor` | Google | ⚠️ 400：需在 OpenCode 工作区允许「训练数据的付费端点」 |

- 地区限制的 403 会原样透传，**不会**把账号标失效（这一点专门测过：连续请求后两个账号仍是 healthy）。
- 没测到的模型（`mimo-v2.5`、`mimo-v2.5-pro`、`mimo-v2.6-pro`、`longcat-2.5-preview-free`、`hy4-preview`、`cat-jam-free`、`space-bunny`、`muse-spark-1.2`）不代表不可用，只是没有逐个发请求。

---

## 1. DeepSeek Harness（DSH）

DSH 的自定义供应商是**按协议**添加的，一个供应商只能覆盖一种协议。要全模型就加多个：

**OpenAI Chat 组**

```text
设置 → 模型 → 添加供应商 → 自定义 / OpenAI 兼容
Base URL: http://127.0.0.1:8787/openai/v1
API Key:  sk-pool
模型:     deepseek-v4-pro、glm-5.3、kimi-k3、mimo-v2.6-pro …
```

**Anthropic 组**（Claude / Qwen / MiniMax）

```text
添加供应商 → Anthropic
Base URL: http://127.0.0.1:8787/anthropic
API Key:  sk-pool
模型:     claude-haiku-5-5、qwen3.8-max、qwen3.8-flash、qwen3.7-plus、minimax-m3
```

**Google 组**

```text
添加供应商 → Google / Gemini
Base URL: http://127.0.0.1:8787/google
API Key:  sk-pool
模型:     gemini-4-argon-contributor
```

**Responses 组（GPT / Grok / Muse）**：只有 DSH 的 OpenAI 供应商支持 `/responses` 时才能用，Base URL 仍是 `/openai/v1`。不支持就在 DSH 里用不了——这不是配置问题。

> DSH 里如果一个供应商看到全部 29 个模型，需要 pi-ai 插件（按模型自动选协议）；自定义供应商做不到。

## 2. ChatGPT / Codex CLI

> ChatGPT 网页版/桌面版**不能**填自定义 Base URL；这里指 OpenAI 的 **Codex CLI**（`codex`）。

编辑 `~/.codex/config.toml`：

```toml
model = "gpt-6-luna"
model_provider = "opencode-pool"

[model_providers.opencode-pool]
name = "OpenCode Go Pool"
base_url = "http://127.0.0.1:8787/openai/v1"
env_key = "OPENCODE_POOL_KEY"
wire_api = "responses"
```

PowerShell 设置占位 Key：

```powershell
setx OPENCODE_POOL_KEY "sk-pool"
```

可用模型（Responses 组）：

```text
gpt-6-luna   gpt-5.6-luna   grok-4.7   muse-spark-1.3-contributor   muse-spark-1.2-contributor
```

GPT/Grok 在部分地区 403；如果只想要能用的模型，把 Codex 切到 `wire_api = "chat"` 用 Chat 组（codex 是否支持 chat 取决于版本）。

## 3. Claude Code

Claude Code 走 Anthropic Messages，网关的 `/anthropic` 正好对应：

**PowerShell**

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8787/anthropic"
$env:ANTHROPIC_AUTH_TOKEN = "sk-pool"
$env:ANTHROPIC_MODEL = "claude-haiku-5-5"
claude
```

**bash**

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787/anthropic"
export ANTHROPIC_AUTH_TOKEN="sk-pool"
export ANTHROPIC_MODEL="claude-haiku-5-5"
claude
```

可选：把不同档位映射到不同模型：

```powershell
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = "claude-haiku-5-5"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = "qwen3.8-max"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = "minimax-m3"
```

可用模型（Anthropic 组）：

```text
claude-haiku-5-5   qwen3.8-max   qwen3.8-flash   qwen3.7-plus   minimax-m3
```

`claude-haiku-5-5`、`qwen3.8-flash` 已实测 200。Claude Code 的模型名只是请求参数，换成 Qwen/MiniMax 也能跑（能力/工具调用行为按模型实际能力）。

## 4. ZCode

ZCode 的「Add Provider」支持三种协议，一个 provider 一种。UI 路径：

```text
设置 → 模型设置（Model Settings）→ Add Provider
```

**OpenAI Chat**

```text
Name:     OpenCode Go Pool (OpenAI)
Protocol: OpenAI Chat Completions
Base URL: http://127.0.0.1:8787/openai/v1
API Key:  sk-pool
Add Model: deepseek-v4-pro、glm-5.3、kimi-k3、mimo-v2.6-pro …
```

**Anthropic**

```text
Name:     OpenCode Go Pool (Anthropic)
Protocol: Anthropic Messages
Base URL: http://127.0.0.1:8787/anthropic
API Key:  sk-pool
Add Model: claude-haiku-5-5、qwen3.8-max、qwen3.8-flash、qwen3.7-plus、minimax-m3
```

**Google**

```text
Name:     OpenCode Go Pool (Gemini)
Protocol: Google Generative AI
Base URL: http://127.0.0.1:8787/google
API Key:  sk-pool
Add Model: gemini-4-argon-contributor
```

**OpenAI Responses**（GPT/Grok/Muse）在 ZCode 里选 `openai-responses`，Base URL 仍填 `/openai/v1`，模型填 Responses 组。地区受限时 ZCode 会直接显示上游 403。

高级：`~/.zcode/v2/provider_config.json`（CLI 与桌面端共用）。最小结构：

```json
{
  "schemaVersion": 1,
  "config": {
    "providerConfigRules": {
      "providerRules": [
        {
          "providerId": "opencode-go-openai",
          "providerName": "OpenCode Go Pool (OpenAI)",
          "enabled": true,
          "config": {
            "access": { "type": "api-key", "apiKey": "sk-pool" },
            "api": { "type": "openai-chat-completions", "baseUrl": "http://127.0.0.1:8787/openai/v1" },
            "personalModelIds": ["deepseek-v4-pro", "glm-5.3", "kimi-k3"],
            "visibility": "visible"
          }
        }
      ]
    },
    "modelConfigRules": {
      "providerModelRules": [],
      "manualProviderModelRules": []
    }
  }
}
```

改完在 ZCode 里 `/model` 刷新目录。

## 其他客户端

任何 OpenAI 兼容客户端（Cherry Studio、ChatBox、OpenAI SDK、LangChain…）：

```text
Base URL: http://127.0.0.1:8787/openai/v1
API Key:  sk-pool
Model:    Chat 组模型 ID
```

OpenAI SDK：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/openai/v1", api_key="sk-pool")
client.chat.completions.create(model="deepseek-v4-pro", messages=[{"role": "user", "content": "hi"}])
```

Anthropic SDK：

```python
import anthropic
client = anthropic.Anthropic(base_url="http://127.0.0.1:8787/anthropic", api_key="sk-pool")
client.messages.create(model="claude-haiku-5-5", max_tokens=64, messages=[{"role": "user", "content": "hi"}])
```

## 排错

| 现象 | 原因 |
|---|---|
| `400 MissingSessionID` | 绕过了网关直连 OpenCode；网关会自动补 `x-opencode-session` |
| `400` + 上游 JSON | 模型与 Base URL 协议不匹配 |
| `403 unsupported_country_region_territory` | 该模型在当前地区不可用（GPT/Grok/Muse 常见）；换 Chat/Anthropic 组模型 |
| `400 ... trains on request data` | Gemini：去 OpenCode 工作区隐私设置允许训练数据的付费端点 |
| `503 NO_USABLE_KEY` | 池里没有可用账号，或代理没启动 |
| `401` | 账号 Key 失效；面板会标 invalid，换号 |
| 模型列表为空 | 客户端不拉 `/models`，手动填模型 ID |
| 只有部分模型 | 客户端只支持一种协议，按协议配多个供应商 |

## 安全

- 只监听 `127.0.0.1`；
- 跨域只允许 `localhost` / `127.0.0.1` 的网页；
- 明文 Key 只在桌面版主进程（Windows DPAPI），客户端只看到 `sk-pool`。
