# dsh-budget-handoff

> 给 DeepSeek Harness 会话装一个「预算刹车」：按官方价目表实时算钱，钱花完时拦住任务，
> 并留下一份能让人接着干活的交接快照。

## 解决什么问题

让 Agent 长时间干活，最后往往是两种结局：

1. **预算失控** —— 你不知道这个会话已经烧了多少钱，等发现时额度已经用完。
2. **钱花光了，活没干完** —— 任务被硬中断，上下文里没留下任何「干到哪了」的记录，
   接手的人（或下一次会话）只能从头再来，于是又烧一遍钱。

本插件在每次模型调用后按真实 token 用量计费，累计到预算上限时**在下一步执行前**
拦住任务（`{ kind: 'reject' }`），并在两个位置写下交接快照。

## 安装

```sh
dsh plugin --profile <your-profile> add github:ZiOstudio/dsh-budget-handoff
```

## 配置

在 profile 的 `cordis.patch.yml` 里给这个插件加 `config:`：

```yaml
- insert:
    - id: dsh-budget-handoff
      name: dsh-budget-handoff
      config:
        budgetCNY: 5.0
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `budgetCNY` | number | `1.0` | 每会话预算，单位人民币元；下限 `0.0001`（展示精度 `toFixed(4)` 能表达的最小非零值） |
| `priceTablePath` | string | `''` | 预留字段：自定义价格表路径。**当前版本只声明、未实现读取逻辑**，运行时始终用内置的 `./pricing.json` |

删掉整个 `config:` 段也可以，schema 会回填默认值。

## 工作方式

```
session/event (usage)          agent/pre-step
        │                            │
        ▼                            ▼
  calculateCost()            spent >= budgetCNY ?
        │                            │
        ▼                     ┌──────┴──────┐
  sessionCosts 累加           否            是
  + 打印本call/累计                     │
                               next()  写快照 ×2
                                         ├─ cwd/BUDGET-STOPPED-handoff-snapshot.md
                                         └─ $DSH_HOME/storages/dsh-budget-handoff/last-stop.md
                                        + stderr 六行提示
                                        + return { kind: 'reject' }
```

1. **算钱**：监听 `session/event`，取每次调用的 `usage`，按当前时段（高峰/空闲）算人民币，
   累加进内存里的 `sessionCosts`，并打印 `thisCall` 与累计值。
2. **拦截**：监听 `agent/pre-step`，每步开始前比较累计消费与 `budgetCNY`；
   超了就构造快照、写盘、向 stderr 打印提示，然后 `reject` 这一步（不抛异常）。
3. **写快照**：快照是给**人**看的，不会回灌进模型上下文（MVP 决策）。

## 价格表

`src/pricing.json`，结构 `provider → model → { cacheRead, cacheMiss, output }`，
每个桶含 `offPeak` / `peak` 两档。**单位：人民币元 / 百万 token。**

覆盖范围（只覆盖 DeepSeek 官方）：

| provider | model | 备注 |
|---|---|---|
| `deepseek-official` | `deepseek-flash` | 在售主力 |
| `deepseek-official` | `deepseek-v4-pro` | 在售 |
| `deepseek-official` | `deepseek-v4-flash` | 旧名别名，按 Flash 价计费 |
| `deepseek-official` | `deepseek-v4-flash-vision-exp` | 旧名别名，按 Flash 价计费 |

高峰时段＝北京时间（UTC+8）周一至周五 `09:00–12:00`、`14:00–18:00`（半开区间，
12:00 与 18:00 整点算空闲）；其余时间（含周末）为空闲。**中国法定节假日未建模**。
表里查不到的 provider/model 不会静默按 0 计费，而是返回哨兵值 `-1`，
调用方打印 `cost unknown … skipped` 并跳过这笔账。

## 快照位置

触发拦截时同时写两份（内容逐字节相同）：

1. 工作目录：`./BUDGET-STOPPED-handoff-snapshot.md`
2. 固定位置：`$DSH_HOME/storages/dsh-budget-handoff/last-stop.md`
   （`$DSH_HOME` 未设置时回退到 `~/.dsh`；目录不存在会自动创建）

同时向 **stderr** 打印六行提示（消费额、预算额、两个快照路径），因此
`stdout` 的解析不会被污染。

快照内容包含：

- 触发位置（turn/step）
- 累计消费和预算
- 最近 10 条会话事件（工具调用、步骤边界、模型回复摘要）
- 下一步建议
- 生成时间（北京时间 UTC+8）

## 已知限制

1. **单步会话不会触发**：闸门在 `agent/pre-step`，如果会话只有一步，那一步执行完
   就没有「下一步」可拦了。
2. **拦截后 CLI 退出码为 1**：任务被拒绝，CLI 以非零码结束。
3. **只支持 `deepseek-official`**：其他 provider 一律走「价格未知 → 跳过计费」。
4. **跨进程不累计**：`sessionCosts` 是内存 Map，进程重启即归零，也不跨会话共享。
5. **法定节假日未建模**：节假日仍按工作日窗口判高峰。

## 开发

```sh
pnpm install
pnpm run build            # tsc → dist/
node dist/ledger.test.js  # 账本自测
node dist/pricing.test.js # 价格/时段自测
node dist/snapshot.test.js# 快照自测
```

## License

MIT © 2026 ZiOstudio
