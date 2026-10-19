# dsh-opencode-go 代码审计

审计对象：`git@github.com:Guuu16/dsh-opencode-go.git`（v0.2.2，13 文件，纯 ESM）
方法：通读 7 个源文件 + 自写探针复现 + `node --test test/*.test.mjs`（16 项全绿）。
标记：**【实证】** = 有可复现脚本；**【推断】** = 读代码得出、需真实运行时确认。

结论：**功能可用，但有 2 个 P0 会让「重启恢复」「额度避让」这两个核心承诺失效**，另有若干 P1 在真实故障场景下会误判 Key 状态。

---

## P0-1 usage 超时只覆盖到响应头，body 卡住会让整张卡片永久转圈 【实证】

`usage.js:46-79`（`models.js:61-102` 同构）

```js
res = await impl(baseUrl, { headers, signal: controller.signal })
// finally { clearTimeout(timer) }  ← 拿完 headers 就解除超时
body = await res.json()            // ← 这一行没有超时保护
```

探针：`fetchUsage({ timeoutMs: 50, fetchImpl: 返回 json() 永不 resolve })` → 600ms 后仍未 settle。

为什么是 P0：`status()` 用 `Promise.all` 聚合所有 Key（`index.js:673`），**任意一个 Key 的 body 卡住 → 整个 status RPC 永不返回**；卡片 `refreshing` 永久为 true、刷新按钮永久禁用；30 秒轮询还会每轮再压一个 pending RPC（client 侧没有 in-flight 保护）。

修法：把读 body 放进 timer 存活期内，非 2xx 时 `res.body?.cancel()` 释放连接。

```js
try {
  res = await impl(url, { headers, signal: controller.signal })
  if (res.status === 401) throw new UsageError('unauthorized', ...)
  if (!res.ok) {
    await res.body?.cancel?.().catch(() => {})
    throw new UsageError(`http-${res.status}`, ...)
  }
  body = await res.json()          // 仍在 timer 内
} finally { clearTimeout(timer) }
```

---

## P0-2 空 Key 列表会把持久化状态整体抹掉 【实证】

`pool.js:154-169`（`syncKeys` 无条件 `persist()`）+ `index.js:429-433`

```js
syncKeys(entries) {
  const before = new Map(this.states)
  this.states = new Map()          // 按本次列表重建
  ...
  this.persist()                   // 列表为空 → 落盘 {"states": {}}
}
```

探针：状态文件里 `a=exhausted, b=invalid` → 构造插件（`keys: []`）→ 文件变成 `"states": {}` → 再把 Key 加回来，两个死号全部复活成 `healthy`。

触发路径：面板里把 Key 行全删了保存（`putKeys([])`）→ `applyConfig` → `syncKeys([])`；或启动时先拿到空列表、设置覆盖层后到。

修法：空列表不落盘也不清空已加载状态；未出现在本次列表的 id 放旁路 map，等它回来时恢复：

```js
if (this.keys.length > 0) this.persist()
```

---

## P1-1 `stream()` 在「没有 finish」的结束路径上会零输出返回 【实证】

`index.js:341-367`

内层适配器如果没给终止 chunk 就结束（`finish === null`），代码走 `// Degenerate inner adapter` 后直接 `return` —— 调用方收到「若干 text-delta + 0 个 finish + 无异常」。静默重试两跳之后也可能命中这条路径。

修法（保留最后一次可分类的错误）：

```js
if (finish !== null) { yield finish; return }
if (lastErrorFinish !== null) { yield lastErrorFinish; return }
yield dryPoolFinish('dsh-opencode-go: provider stream ended without a finish chunk')
```

---

## P1-2 持久化的用量没有新鲜度，重启后可能永久避让 【实证】

`pool.js:387-404` + `pool.js:187-201`

`load()` 原样恢复 `usage`，`isUsable()` 只看 `percent`，不看 `resetsAt`、也没有 `usageAt`。探针：状态文件写 `rolling.percent=99`（实际 5h 窗口早已重置）→ `preemptAtPercent=90` 时该 Key 永久不参与选择；用量接口再 401 → 永远没人覆盖它 → 池子「全干」。

修法：`onUsage` 记 `usageAt`；`isUsable` 要求「用量新鲜（<10 分钟）且 `resetsAt` 未过期」才做预判。

> aipool 里对应实现：`state.json` 存绝对 `cooldownUntil`，`quotaFetchedAt` 超过 15 分钟直接丢弃。

---

## P1-3 「启用」把 exhausted/invalid 洗成 healthy 【实证】

`pool.js:255-262`：`setDisabled(id, false)` 直接 `st.state = HEALTHY`，`lastFailure` 还留着。结果是面板显示「健康 + 上次失败 QUOTA」，下一轮请求又撞墙。

修法：停用时记住来源状态（`disabledFrom`），启用时还原；只有「清除失效」才允许清标记。

---

## P1-4 putKeys / putConfig 并发写会被 revision 栅栏打回 【推断】

`index.js:739-801` / `849-855`：两次写各自现读 `row.revision`，并发时一次成功一次 `SETTINGS_REVISION_CONFLICT`，后一次改动悄悄丢掉。

修法：写串行化（promise 链）+ 冲突时重读 `revision` 重试一次。

---

## P2 清单

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 1 | `index.js:681` → `pool.js:348` | `status()` 每个 Key 调一次 `onUsage` → 每次同步全量落盘（10 Key = 每 30s 10 次写） | 值未变就不写；或 dirty + `setImmediate` 合并 |
| 2 | `typert.host.js` 严格 codec | `preemptAtPercent`/`usageRefreshMs` 缺省时是 `undefined`，JSON 丢键 → 整张卡片「加载失败」；状态文件里的 `lastSwitch` 形状坏了同样整卡失效 | status 出口 `Number(x ?? 默认值)`；`load()` 丢弃非法 `lastSwitch`/`lastFailure` |
| 3 | `index.js:228-232` | `MISSING_CREDENTIAL` 不在换号码里 → 活动 Key 没配密钥时不会切到有密钥的号 | 加入轮换码集合 |
| 4 | `pool.js:292-321` | 上游错误文案原样落盘并回传面板，文案里带 Key 就泄漏 | 落盘/回传前 `sk-…` 脱敏 |
| 5 | `pool.js:352-360` | 复活只看 `rolling`，周额度 100% 的号每 30s 复活一次、再撞一次 429 | 三个窗口都低于阈值才复活 |
| 6 | `pool.js:283-313` | `failureStreak` 是全局共享、没有 per-request 隔离；单 Key 时阈值到了会先清零再判断，永远到不了阈值 | 计数按请求隔离；无可用 Key 时不清零 |
| 7 | `index.js:429` | 构造期 `assertKeyList` 抛错 → 插件静默不挂载（YAML 手写重复 Key 就能触发） | `applyConfig` 内 try/catch，坏配置降级并曝光 |
| 8 | `client.js:880` / `720-750` | 池子全干时显示「尚未配置 Key」；轮询无 in-flight 保护 | 区分文案；`inflight` 去重 + requestId 丢弃过期响应 |
| 9 | `models.js:116-179` | 动态模型一律 `baseUrl` 硬编码 + `reasoning:true` + 纯文本；缓存只增不减 | 从配置派生 baseUrl；能力默认不声称；按差集清理 |
| 10 | `index.js:488-493` | 重试预算按 `keyCount`（含 disabled/exhausted）算，10 个号只剩 1 个可用时仍申请 40 次重试 | 用 `usableCount()` |

## 审过但没问题的部分

- 双终止 finish：不可复现（遇到 finish 即 break，最多 yield 一次）
- `aborted` finish：原样透传、不记 success，正确
- `UsageCache` 不缓存失败、并发去重正确
- 明文 Key 不进 `status()` / state / 日志（唯一通道是 P2-4 的错误文案）
- 浏览器半无 `dangerouslySetInnerHTML`，无 XSS 面
- 三个 interval 都有 cleanup
- `load()` 先于 `syncKeys()` 本身安全（同 id 状态会保留），问题只在空列表覆盖

## README 与实现的两处偏差

1. 文档说「14 项测试」，实际 16 项。
2. 请求上限公式 `2 × (Key 数 × 阈值 + 1)` 在单 Key 时低估：`harnessRetryBudget` 有 `max(2, …)` 下限，K=1 时最坏 6 次请求，公式只给 4。

---

## 附：可直接应用的补丁

`docs/dsh-opencode-go-fixes.patch`（134 行）修掉了上面 4 个最要命的问题，`git apply` 即可：

```bash
cd /tmp && git clone git@github.com:Guuu16/dsh-opencode-go.git
cd dsh-opencode-go
git apply /path/to/docs/dsh-opencode-go-fixes.patch
node --test test/*.test.mjs        # 16 项仍全绿
```

包含：

1. `usage.js` / `models.js`：超时覆盖 body 读取；非 2xx 时 `res.body.cancel()` 释放连接
2. `pool.js`：空 key 列表不再覆盖状态文件，缺席 key 的状态进 `orphans` 保留
3. `index.js`：内层流没有终止 chunk 时补一个（优先用最后一次可分类的错误）

验证（真实 undici，上游发完头不发 body）：修前 1.5s 仍未返回，修后 310ms 内以错误返回，`status()` 不再挂死。
