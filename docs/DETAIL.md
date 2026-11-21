# 额度恢复自动续跑 · 详细说明

当模型请求因为**额度或限流**失败时，本插件让被迫中断的工作自己继续跑。
它不绑定厂商：只读 LLM 层已经归一化的失败码（`QUOTA`、`ACCOUNT_QUOTA`、`RATE_LIMIT`），
所以官方 DeepSeek 路由、OpenCode Go 路由，以及任何把这些限制归类到上述码的
OpenAI 兼容路由都能被覆盖。

## 两条恢复通道

| 通道 | 触发条件 | 表现 |
|---|---|---|
| 同轮重试 | 等待很短：`Retry-After` 不超过 `inlineMaxMs`，或 `QUOTA` / `RATE_LIMIT` 先做几次秒级退避 | 无中断。同一个 turn 重新发出失败的那一步，从断点继续。 |
| 暂停 + 定时唤醒 | 窗口型额度（5 小时 / 每周 / 每月），或需要的等待超过 `inlineMaxMs` | 当前 turn 带着厂商错误收尾；到预计重置时间，同一会话收到一条 `[quota-resume]` 继续指令，自动开始下一轮。 |

被暂停的会话如果在唤醒时仍然受限，会按更长的探测间隔再暂停一次
（`probeInitialMs` 起，逐次翻倍，上限 `probeMaxMs`），因此插件不需要预先知道
真实的重置时刻，也能逐步逼近它。会话成功产出一条助手消息后，遗留的唤醒任务会被删除，
这样用户手动继续过之后不会再多触发一轮。

唤醒是 Host 计划任务中的一次性任务，投递到同一个 Session，所以**跨重启有效**；
Host 关闭期间错过的那次会在下次启动时补投。

## 配置

所有字段都可省略，在 profile 的 `cordis.patch.yml` 里覆盖该行 `config`：

```yaml
- id: quota-resume
  name: dsh-quota-resume
  config:
    probeInitialMs: 300000
    inlineMaxMs: 600000
    providers:
      - dsh-opencode-go
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关。 |
| `handleQuota` | `true` | 是否处理 `QUOTA`。 |
| `handleRateLimit` | `true` | 是否处理 `RATE_LIMIT`。 |
| `handleBalance` | `false` | 是否把 `ACCOUNT_QUOTA`（账户余额）也当作窗口处理。默认关闭：等待无法补充余额。 |
| `providers` | `[]` | 只处理这些 provider；为空表示全部。 |
| `exemptProviders` | `[]` | 忽略这些 provider。 |
| `quotaRetries` | `2` | `QUOTA` 暂停前的同轮重试次数。 |
| `quotaBaseMs` | `20000` | `QUOTA` 首次同轮退避，逐次翻倍。 |
| `rateLimitRetries` | `3` | `RATE_LIMIT` 暂停前的同轮重试次数。 |
| `rateLimitBaseMs` | `5000` | `RATE_LIMIT` 首次同轮退避。 |
| `inlineMaxMs` | `300000` | 单轮内最多肯等多久；厂商 `Retry-After` 超过它就直接暂停。 |
| `probeInitialMs` | `600000` | 首次探测等待。 |
| `probeMaxMs` | `3600000` | 探测等待翻倍的上限。 |
| `maxProbes` | `0` | 最多探测次数；`0` 表示不限。 |
| `probeJitterRatio` | `0.1` | 探测等待的对称抖动比例。 |
| `fallbackDelayMs` | `300000` | 无法建立定时唤醒时（例如委派子会话）退回同轮重试的等待。 |
| `resumeTitle` | `额度恢复后自动继续` | 自动化任务页显示的任务名。 |
| `resumePrompt` | 见 `index.js` | 到点投递的继续指令正文。 |

## 判定规则

1. 失败码不在 `QUOTA` / `ACCOUNT_QUOTA` / `RATE_LIMIT` 之内，或 provider 被过滤 → 不接管，
   调用 `next()`，行为与未安装一致。
2. `ACCOUNT_QUOTA` 且 `handleBalance: false` → 记一条警告日志，不重试、不排任务。
3. 同轮重试还有预算 → 计算等待（优先 `providerRetryAfterMs`，否则本地指数退避），
   等待不超过 `inlineMaxMs` 就返回 `{ kind: 'retry' }`。
4. 否则进入暂停：探测等待取 `max(指数探测, providerRetryAfterMs)`，加抖动；
   `maxProbes` 用尽则放弃并记日志。
5. 整个等待过程都可被取消（用户点停止 / 插件卸载），取消后交回终态，绝不继续重试。

## 实现要点

- 监听 `agent/request-error` waterfall：接管时返回 `{ kind: 'retry' }`，让 agent loop 在同一个
  turn 内重跑失败的那一步；同轮重试的等待本身也监听该 turn 的 `signal`。
- 暂停时通过 `ctx.schedule.create()` 创建一次性 `at` 任务，目标为 `{ kind: 'session', sessionId }`；
  已有同一会话的 `[quota-resume]` 任务时改为 `edit` 更新，不叠加。
- 监听 `session/event` 中的 `assistant/message`，成功即清空本轮计数并删除遗留的唤醒任务。
- 零运行时依赖：不 import 任何 `@deepseek-ai/*` 包，可选服务通过 `ctx.reflect.get('schedule')`
  取得，因此本地链接安装不会引入第二份 cordis / schemastery；没有 `schedule` 服务时自动退回同轮重试。

## 已知边界

- **Host 必须运行**。桌面程序关着时不会自动醒来；错过的那次唤醒在下一次启动时补投，
  但不会“睡着也干活”。要做到那种程度需要进程外看门狗（计划任务 + CLI）。
- `ACCOUNT_QUOTA` 是余额，不是窗口，等待解决不了；默认只记日志。
- 委派子会话不能接收计划消息，此时退化为同轮重试，父会话会一直等着。
- 同轮计数与“已暂停”登记在进程内存里，重启后归零；持久任务本身仍在，只是探测间隔
  重新从 `probeInitialMs` 开始。
- 每次重试都是一次真实的模型请求。被额度拒绝的请求通常不计费，最终成功的那次照常计费；
  探测间隔因此需要限流（默认 10 分钟起，逐步放宽）。
- 若失败发生在已经吐出部分 token 之后，重试可能重复这截内容；额度拒绝一般发生在出词前。
