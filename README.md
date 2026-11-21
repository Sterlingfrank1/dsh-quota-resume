# 额度恢复自动续跑

当模型请求因为**额度或限流**失败时，让任务自己继续跑，不需要人工再敲一句“继续”。

插件不区分厂商，只读 LLM 层已经归一化的失败码（`QUOTA`、`ACCOUNT_QUOTA`、`RATE_LIMIT`），
因此对官方 DeepSeek、OpenCode Go、以及任何把这些限制归类到上述码的 OpenAI 兼容路由都成立。

## 两条恢复通道

| 通道 | 什么时候用 | 你会看到什么 |
|---|---|---|
| **同轮重试** | 等待很短：`Retry-After` 不超过 `inlineMaxMs`，或 `QUOTA` / `RATE_LIMIT` 先做几次秒级退避 | 没有中断。同一个 turn 重新发出刚才那一步请求，从断点继续。 |
| **暂停 + 定时唤醒** | 属于窗口型额度（5 小时 / 每周 / 每月），或需要的等待超过 `inlineMaxMs` | 当前 turn 带着厂商错误正常收尾；到预计重置时间，同一会话收到一条 `[quota-resume]` 继续指令，自动开始下一轮。 |

唤醒时间到了但额度还没恢复时，插件会按 `probeInitialMs` 翻倍（上限 `probeMaxMs`）再安排一次，
所以它不需要预先知道真实重置时刻也能逐步逼近。会话一旦成功产出一条助手消息，
遗留的唤醒任务会被自动删除，不会在之后多触发一轮。

唤醒本身是 Host 计划任务里的一次性任务，投递到同一个 Session，因此**跨重启有效**；
Host 关闭期间错过的那次，会在下次启动时补投。

## 安装

要求 DeepSeek Harness 已装好并至少运行过一次（存在 profile）。

1. 打开 **插件（Plugins）**；
2. **添加插件（Add plugin）**；
3. 选择本仓库目录（或克隆后的目录）。

命令行等价做法：让 `plugin_manager` 的 `install_bundle` 指向本目录。安装后
`package.json` 会把本包链接进 profile，并在 `cordis.patch.yml` 中插入 `quota-resume` 一行。

## 配置

所有字段都可省略，在 profile 的 `cordis.patch.yml` 里覆盖该行 `config` 即可：

```yaml
- id: quota-resume
  name: dsh-quota-resume
  config:
    probeInitialMs: 300000
    providers:
      - dsh-opencode-go
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关。 |
| `handleQuota` | `true` | 是否处理 `QUOTA`。 |
| `handleRateLimit` | `true` | 是否处理 `RATE_LIMIT`。 |
| `handleBalance` | `false` | 是否把 `ACCOUNT_QUOTA`（账户余额）也当作窗口来处理。默认关闭，因为等待并不能把余额等回来。 |
| `providers` | `[]` | 只处理这些 provider；为空表示全部。 |
| `exemptProviders` | `[]` | 忽略这些 provider。 |
| `quotaRetries` | `2` | `QUOTA` 在暂停前先做几次同轮重试。 |
| `quotaBaseMs` | `20000` | `QUOTA` 的首次同轮退避，之后逐次翻倍。 |
| `rateLimitRetries` | `3` | `RATE_LIMIT` 在暂停前先做几次同轮重试。 |
| `rateLimitBaseMs` | `5000` | `RATE_LIMIT` 的首次同轮退避。 |
| `inlineMaxMs` | `300000` | 单个 turn 里最多肯等多久；厂商给的 `Retry-After` 超过它就直接暂停。 |
| `probeInitialMs` | `600000` | 首次探测的等待时间。 |
| `probeMaxMs` | `3600000` | 探测等待翻倍的上限。 |
| `maxProbes` | `0` | 最多探测几次；`0` 表示不限。 |
| `probeJitterRatio` | `0.1` | 探测等待的对称抖动比例。 |
| `fallbackDelayMs` | `300000` | 无法建立定时唤醒时（例如委派子会话）退回到同轮重试的等待时间。 |
| `resumeTitle` | `额度恢复后自动继续` | 自动化任务页里显示的任务名。 |
| `resumePrompt` | 见 `index.js` | 到点投递的继续指令正文。 |

## 实现要点

- 监听 `agent/request-error` 这个 waterfall：接管时返回 `{ kind: 'retry' }`，让 agent loop
  在同一个 turn 内重跑失败的那一步；不接管时调用 `next()`，行为与没装插件一致。
- 暂停时通过 `ctx.schedule.create()` 建一次性 `at` 任务，目标为 `{ kind: 'session', sessionId }`，
  到点由计划任务向该会话投递继续指令。
- 监听 `session/event` 中的 `assistant/message`，成功即清理本轮计数与遗留的唤醒任务。
- 零运行时依赖：不 import 任何 `@deepseek-ai/*` 包，通过 `ctx.reflect.get('schedule')` 取可选服务，
  因此本地链接安装不会引入第二份 cordis/schemastery；未提供 `schedule` 服务时自动退回同轮重试。

## 已知边界

- **Host 必须运行**。桌面程序关着的时候不会自动醒来；错过的那次唤醒在下一次启动时补投。
- `ACCOUNT_QUOTA` 是余额，不是窗口，等待解决不了；默认只记日志、不重试。
- 委派子会话不能接收计划消息，此时退化为同轮重试，父会话会一直等着。
- 同轮计数与“已暂停”登记在进程内存里，重启后归零（持久任务本身仍在，只是探测间隔重新从
  `probeInitialMs` 开始）。
- 每次重试都是一次真实的模型请求。被额度拒绝的请求通常不计费，但最终成功的那次会照常计费。
- 若失败发生在已经吐出部分 token 之后，重试可能重复这截内容；额度拒绝一般发生在出词前。

## 开发

```sh
node --test test/decide.test.mjs test/runtime.test.mjs
```

- `test/decide.test.mjs`：纯决策函数——分流、退避、探测升级、配置校验。
- `test/runtime.test.mjs`：用假的 `ctx` 与假的 `schedule` 服务验证监听器接线——同轮重试、
  取消即放弃、暂停建任务、去重、余额不重试、成功后清理。

## 许可

暂未添加 LICENSE。需要的话请明确用哪一个（例如 MIT）。
