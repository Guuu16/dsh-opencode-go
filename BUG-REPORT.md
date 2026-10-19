# dsh-opencode-go 代码审查与修复报告

- 审查对象：`Guuu16/dsh-opencode-go`（main 分支）
- 审查方式：通读全部源码 + 在原生 Node 下运行测试 + 为每个问题补回归测试
- 基线测试：16/16 通过
- 修复后：**22/22 通过**（新增 6 项，其中 4 项在修复前是失败的复现用例）

## 结论

共确认 9 个问题并已修复，另有 4 条风险/改进建议未改代码。
改动文件：`index.js`、`pool.js`、`client.js`、`test/plugin-load.test.mjs`、新增 `test/pool-usage.test.mjs`。

---

## 已修复

### 1. [高] 自定义模型列表为空，反而暴露「全部模型」

**位置**：`index.js:516` `modelSelection()`

**原因**：`modelMode === 'custom'` 且 `models` 为空时，函数返回 `null`，而 `null` 在本插件里的语义是「不过滤 = 全部模型」。这与卡片文案「未选择任何模型：该供应商暂时不可用」以及 `putConfig` 的空列表校验完全相反。手改 yml、旧版本设置文档、或并发写入都可能留下 `custom + []`，结果所有模型静默恢复可用。

**修复**：custom 模式一律返回 `Set`（空 Set 表示一个都不暴露）；`listModels` 过滤为空，`resolveModel`/`stream` 对任何模型报 `UNKNOWN_MODEL`。

**验证**：`test/plugin-load.test.mjs` → “a custom model selection with no ids exposes no models”。

### 2. [高] 月度额度没有参与「主动避让」和「自动复活」

**位置**：`pool.js:195`（`isUsable`）、`pool.js:368`（`recovered`）

**原因**：OpenCode Go 的 5 小时滚动、每周、每月是**三个独立窗口**。原实现只检查 rolling + weekly：

- 月度额度已耗尽、但 5h 窗口刚重置的账号仍被视为可用 → 每个请求先打一次 429，才切走；
- 耗尽的账号只要 rolling 恢复就「复活」，哪怕 monthly 仍是 100% → 复活后马上再失败。

**修复**：

- 避让检查 `rolling / weekly / monthly` 三个窗口；
- 复活要求所有已上报窗口 `status` 不是 `quota`/`error`，且 `percent < 98`。

**验证**：`test/pool-usage.test.mjs` 三项（月度避让、月度未恢复不复活、全部恢复才复活）。

### 3. [高] 新增 Key 的 id 可能重复

**位置**：`client.js:453`

**原因**：`id: 'key-' + Date.now().toString(36)`。快速连点两次「添加 Key」，同毫秒会生成相同 id：React key 冲突，保存时 `assertKeyList` 报 `duplicate key id`，用户看到的是没头没脑的保存失败。

**修复**：时间戳 + 4 位随机后缀（仍满足 `^[a-z0-9][a-z0-9-]{0,31}$`）。

### 4. [中高] 配置里一个坏 Key 会让整个插件静默不挂载

**位置**：`index.js:442`

**原因**：构造函数调用 `applyConfig()` → `pool.syncKeys(cfg.keys)`，后者用 `assertKeyList` 校验并抛错。DSH 对插件构造异常只写日志，不弹任何 UI，结果就是「插件装了但设置页没有、路由也没接管」，而且 bundle/兼容性检查都看不出来。

**修复**：`syncKeys` 包 `try/catch`，打印 warn 并保留旧 Key 列表，其余注册流程继续；下一次合法配置提交会自愈。

**验证**：`test/plugin-load.test.mjs` → “a malformed key entry is reported but never aborts construction”。

### 5. [中] 导航图标可能被自己的 CSS 一起隐藏

**位置**：`client.js:983`

**原因**：注入的规则是 `button:has(.dsh-ogp-nav-mark) > svg { display: none }`，本意是隐藏 shell 默认的齿轮。如果侧边栏把 `label` 直接渲染在 `button` 里，插件自己的 sparkle `<svg>` 也是 `> svg`，会被一起隐藏，导航只剩文字。

**修复**：`> svg:not(.dsh-ogp-nav-mark)`。

> 说明：本地没有可挂载该插件的 DSH 侧边栏环境，无法做真实 DOM 验证，属防御性修复。

### 6. [中] 顶部横幅显示内部 id，而不是账号名

**位置**：`client.js:848`

**原因**：`当前使用: key-mv0qbswj`、`上次切换: key-a → key-b`。用户填的 `label` 完全没用上；换号后无法一眼确认切到了哪个账号。

**修复**：新增 `labelOf()` 映射，横幅和「最近切换」都显示显示名，找不到 id 时回退。

### 7. [中] 每次额度轮询，每个 Key 都重写一次状态文件

**位置**：`pool.js:355` `onUsage()`

**原因**：`onUsage` 无条件 `persist()`。卡片每 30 秒轮询，`status()` 会对每个 Key 调用一次 → 10 个账号就是每 30 秒 10 次 JSON 序列化 + 临时文件 + rename。对 SSD 和杀软都是无意义的 churn。

**修复**：usage-only 更新只留在内存；只有状态真正变化（复活）才落盘。选择逻辑实时读内存，重启后的首个轮询会补齐用量。

**验证**：`test/pool-usage.test.mjs` → “usage-only polls do not rewrite the state file”。

### 8. [低] 重置时间已过显示「未知」

**位置**：`client.js:330`

**修复**：新增 `resetDone`（中「已重置」/ 英 `reset`）文案。

### 9. [低] 路由被占用后不再重试接管

**位置**：`index.js:421`

**原因**：`llm/adapters-updated` 只在 `servingRoute === null` 时重试。若 `replace()` 失败但 `servingRoute` 仍停在旧路由（例如 `opencode-go-alt` 模式下切回默认路由、默认路由被别的插件占着），之后任何拓扑变化都不会再尝试。

**修复**：只要 `servingRoute !== current().route` 就重试 `tryRegister()`。

---

## 合并的既有修复

仓库里已有一条 `fix/pool-state-and-timeouts` 分支（提交 `e8bad1e`），修的是另一组更严重的 P0。本次发布把它的 3 项一并合入 `main`，避免新版本仍带着这些问题：

1. **额度/模型请求的超时只覆盖响应头**：`usage.js` / `models.js` 在拿到 headers 后就 `clearTimeout`，body 卡死会永久挂住 `status()` 和整张卡片。现在 body 读取也在计时器窗口内，非 2xx 时取消 body 释放连接。
2. **空 Key 列表会把持久化状态整体抹掉**：面板删空 Key 后 `syncKeys([])` 落盘 `states: {}`，再把 Key 加回来时 exhausted/invalid 全部复活。现在空列表不落盘，缺席 Key 的状态保留。
3. **内层流没有终止 chunk 时零输出返回**：调用方收到「若干 delta + 0 个 finish + 无异常」。现在优先补发最后一次可分类错误，否则补一个 dry-pool finish。

桌面版也同步修了第 1 类问题（`electron/core/usage.js` 的 body 超时，含回归测试）。

## 未修复 / 建议

1. **新增 Key 的凭据写入存在竞态（未证实）**
   `onSaveKeys` 先 `putKeys`，紧接着对每个新 Key `putKeySecret`。`putKeySecret` 通过 `pool.entries()` 查找 id，而 pool 的 Key 列表要等 `loader/volatile-update` 应用配置后才更新。如果 DSH 的事件派发是异步的，新 Key 会报 `unknown key "..."`。本次没有 DSH 运行环境可验证时序；稳妥做法是：`putKeys` 后等待一次配置应用，或让 `putKeySecret` 直接以 `this.current().keys` 查找。桌面版不存在这条链路。

2. **`usageBaseUrl` 可指向任意主机（安全）**
   主进程会用 `Authorization: Bearer <key>` 请求该地址。虽然只有能改设置的人才能改它，但一旦被改，就会把全部 Key 明文发给目标服务器。建议限制 `https://` + 主机白名单（如只允许 `opencode.ai`），或至少在 UI 上警示。

3. **`status()` 对全部 Key 无上限并发**
   `Promise.all(entries.map(...))`：20 个账号 = 每轮 20 个并发请求。建议并发 3–4，和桌面版一致。

4. **重试预算没有上限**
   `harnessRetryBudget = keys × threshold`。20 个账号 × 阈值 20 = 400 次重试，按 2s 退避上限也要几分钟才把错误交给对话。建议 clamp 到 40 左右，或在文档里明确最坏等待时间。

---

## 验证记录

```text
$ node --test test/*.test.mjs
✔ the host module evaluates against the DSH runtime surface
✔ constructing the plugin registers the route and persists state
✔ the constructor tolerates a config with no keys
✔ the model catalog resolves the active pool key
✔ a pool with no usable key reports MISSING_CREDENTIAL, not a load failure
✔ module-scope declarations are not swallowed by comments
✔ a custom model selection with no ids exposes no models          ← 新增
✔ a malformed key entry is reported but never aborts construction ← 新增
✔ a monthly window over the threshold preempts the key            ← 新增
✔ an exhausted key does not revive while its monthly window …     ← 新增
✔ an exhausted key revives once all three windows recovered       ← 新增
✔ usage-only polls do not rewrite the state file                  ← 新增
✔ （retry-budget 原有 10 项）
ℹ tests 22
ℹ pass 22
ℹ fail 0
```

修复前的失败输出（节选）：

```text
✖ a monthly window over the threshold preempts the key
  actual: true, expected: false
✖ an exhausted key does not revive while its monthly window is exhausted
  actual: 'healthy', expected: 'exhausted'
✖ usage-only polls do not rewrite the state file
  actual: 10, expected: 0
```

---

## 桌面版

独立的 Windows 桌面应用见 `../opencode-go-pool/README.md`：同样的号池规则（并修复了上面第 2/7 类问题），新增额度看板、托盘/快捷键换号、DPAPI 加密和本地 OpenAI 兼容代理。
