# 群与私聊每日预算

本版按机器人、会话和北京时间自然日计算预算。每个群、每个私聊默认每天1元，包括管理员的私聊；`group:123`与`private:123`互不占用额度，不同机器人也独立。预算是付费调用的准入控制，依据已观察的模型usage人民币估算以及尚在执行的预留，**不是供应商账单的绝对硬上限**。DSH现有prompt接口没有可用的绝对输出费用上限，模型一次调用或工具内部调用可能超过起始估值。

管理员可设置全局启用、默认每日额度、默认调用预留，以及每个会话的启用/额度覆盖。额度允许0到1,000,000元，精度最多六位小数；额度0会阻止新的付费调用。清除某个覆盖后沿用全局设置。普通账号的设置权限由HTTP端鉴权决定，模块不会因为QQ号是管理员而绕过预算。

## 阈值与在途费用

- 今日已观察花费与在途剩余预留之和达到80%时，返回`degrade`供桥接缩短/降级调用。
- 已占用达到100%时，拒绝新的付费调用。当前剩余额度不足以预留本次估值时，也会提前拒绝。
- 默认每次起始预留0.1元，管理员可配置。成功预留恰好填满额度的最后一次调用仍可执行并降级；之后的新调用被拒绝。

预留在真正发起付费请求之前，用SQLite事务写入，不能仅在内存里计算。请求被DSH接受不表示费用已结束，因此不能立即释放。预留保留`operationId`、`sessionId`与`turnId`，便于重启后查询在途调用。

若能明确归属某次调用已经写入账本的累计花费，`renew(id,{observedCostCny})`会把该预留的剩余占用降为`max(0,预留-已归属花费)`，避免同时算在支出与预留里；归属花费只会增加。无法可靠归属时，保守保留全额预留。多个排队请求合并到同一turn时，同一份usage不能在多份预留上重复扣减。

只有确认turn结束、错误已经终止或取消成功后，才调用`settle`或`release`。RPC超时本身不能证明模型停止执行。`settle`可记人民币估算作审计，但不会再向费用账本或每日支出追加一次，避免双计；费用账本仍由原有usage采集负责。

## 跨日、租约与账本重置

默认租约30分钟，可设置1分钟至24小时。桥接必须定期确认DSH仍在执行后续租，不能仅凭一个存在的session映射续租。`active({includeExpired:true})`可找回未关闭和已过期记录。确认过期调用仍在途时可重新续租；已结算/释放的调用禁止复活。过期且未续租的预留不再占用额度，防止崩溃造成永久占用，因此桥接的恢复核查与续租是预算完整性的必要部分。

北京时间午夜切换后，昨日已观察支出不占今日额度；尚未结束的调用，其剩余预留继续保守占用今日额度，直到结束或租约失效。费用读取器收到明确的北京时间`YYYY-MM-DD`，不使用主机本地时区推算。

每个会话每天观察到的支出高水位持久化到`budget_days`，读数下降不会让已观察的当日额度立即退回；新一天单独计算。**预算依赖的费用账本禁止通过控制台reset清空**：只有高水位不足以把reset前和reset后的新消费相加，不能把它宣传成任意账本删改后仍完整计费。手动改写、删除账本不属于可安全重置预算的接口。已结束/过期的预留审计在七天后可清理，每日高水位保留至少最近90天。费用账本原文不因预算重算或清理而修改。

费用读取器必须同步返回`{amount,currency:'CNY',complete:true}`。这里的`complete`是当前日期可用usage估算的健康性，不要求遗失的全部历史都能补齐；仍可换算人民币的估价fallback不必因此判失败。非人民币、无可用价格、当前账本不完整或读失败时，启用预算的会话返回`unsupported`并暂停新的付费调用。取消/结算旧调用仍可执行。

## 内部接口

文件`src/group-budget.js`同时导出`createConversationBudget`与兼容名称`createGroupBudget`。需要SQLite式同步`transaction/readText/writeText`存储适配器，不悄悄回退成缺少跨进程事务的JSON写入。

```js
const budget = createConversationBudget({storage, file, botId, getSpent});
const admission = budget.reserve('private:123', {
  operationId: requestId, sessionId, estimatedMaxCost: 0.1,
});
if (!admission.allowed) return;
// 根据 admission.action 的 normal/degrade 选择调用策略。
// accepted之后保留预留；异步turn/start可通过renew绑定turnId。
budget.renew(admission.id, {turnId, observedCostCny: 0.04});
// 确认turn结束且usage已采集之后：
budget.settle(admission.id, {amount: 0.04, currency: 'CNY'});
```

关闭预算时`reserve`返回`allowed:true,id:null`，调用方仅在有id时续租/关闭。`operationId`在保留期内幂等，不能用于另一个会话或重绑身份。已完成操作重试不会重新建立预留。

`config()`返回`configVersion`和设置。`update({configVersion,overrides:{key:override|null},...})`比较配置版本，冲突409；`null`删除单个覆盖，未提及的会话保持。兼容`groups`参数和返回别名，但它同样包含私聊，不能与`overrides`同时提交。`overview(keys)`返回`conversations`及兼容`groups`别名。`status(key)`返回当日支出高水位、当前账本读数、剩余预留、剩余额度、状态、估算边界与机器人标识。

状态、租约、配置和每日高水位与原文文档在同一事务内投影到`budget_settings/overrides/reservations/days`，带CAS及外键。损坏文档、未来版本和未知结构拒绝覆盖；启动后旧预算JSON不再反灌数据库。

`scripts/test-group-budget.mjs`当前有22项隔离验证，包括四个真实Node进程并发抢同一额度、私聊/群/机器人隔离、管理员私聊无例外、80%/100%、费用重置高水位、部分归属、租约/重启/跨日、CAS、SQL投影、事务回滚及严格迁移。它不替代真实DSH异步turn与所有工具入口的桥接集成验证。
