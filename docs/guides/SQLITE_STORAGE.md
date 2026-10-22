# SQLite 持久层与本次迁移边界

本版使用 Node 内建 `node:sqlite`，无需额外数据库服务。本机验证运行时为 Node 24.22.0，SQLite 3.53.4；代码使用该运行时实际提供的 `DatabaseSync`。API依据 [Node.js 官方 SQLite 文档](https://nodejs.org/api/sqlite.html)。部署必须使用支持这些API的运行时，不能继续依赖不含SQLite模块的旧Node版本。

每个运行目录的管理数据库为 `state/manager.sqlite`。数据库应用标识 `0x51514254`，本版 `PRAGMA user_version=1`；这与原JSON中的 `version:1` 是两个独立层次的版本。数据库在写入敏感数据之前以0600模式创建，连接启用外键、5000毫秒busy timeout及FULL同步。Windows的POSIX模式不等于完整ACL，仍沿用已有state目录的访问权限保护。

## 已迁移的内容

| 数据 | SQLite关系表/文档 |
| --- | --- |
| 账号、密码派生结果、登录会话 | `accounts`、`auth_sessions` |
| 账号获授的机器人与会话范围 | `account_scopes` |
| 角色卡正文和worker文件镜像状态 | `role_cards`、`role_materializations` |
| 成员自建人设、名称、正文、归属与版本历史 | `member_cards`、`member_revisions` |
| 人设稳定身份、会话存档、当前管理选择 | `persona_identities`、`archive_records`、`selected_sessions` |
| 每个会话的人设绑定 | `conversation_roles` |
| 多机器人连接注册信息 | `bots` |
| 全局人设及active/silent状态 | `state_documents`中的严格校验`current-role.json`文档 |
| 每个群与私聊的每日预算、覆盖设置、在途预留与当日观察高水位 | `budget_settings`、`budget_overrides`、`budget_reservations`、`budget_days` |
| 用户自费配置密文、QQ验证、机器人归属、委托、费用来源及试用设置 | `tenant_settings`、`tenant_profiles`、`tenant_qq_bindings`、`tenant_binding_challenges`、`tenant_owned_bots`、`tenant_delegations`、`tenant_funding`、`tenant_trial_overrides` |

`state_documents`同时保存各文档的原始文本、类型、所属机器人和修订号，以兼容既有严格版本校验和CAS。账号、范围、人设、存档等有对应的真实查询表，修改时与原文在同一SQLite事务内更新；不再只是把全部内容塞进一个无法查询的JSON字段。主账号ID、密码盐与哈希、会话token哈希和原到期时间都保留，因此有效浏览器cookie可以跨迁移继续使用。明文cookie或明文密码不会因迁移写入数据库。

旧`conversationKeys`只授予`primary`机器人。新`botScopes:[{botId,key}]`可分别授予不同机器人的群或私聊；同一个QQ会话号在不同机器人下互不授权。人设身份、存档、选择和会话绑定使用机器人复合键，同名角色或相同模型sessionId可分属不同实例。

## 仍保留在原处的内容

- DSH保存的模型聊天历史和上下文仍由各实例自己的DSH目录管理，未复制进SQLite。
- `sessions.json`中的活动模型映射等桥接运行状态仍沿用原JSON；SQLite存档表保存管理索引和历史选择，不冒充DSH完整历史。
- `token-usage.jsonl`费用账本继续兼容JSONL，未在本次强行迁移；费用口径仍为保留usage按配置价目表估算。
- social状态、消息/附件缓存、图片/语音、其他日志和未明确接入的运行文件继续使用现有存放方式。

## 导入与故障保护

新建数据库前，先核验已有账号、人设绑定、存档、成员卡、机器人注册表、全局人设以及`roles/*.md`（排除README）。非法UTF-8、损坏JSON、不认识的版本/字段或无效引用会拒绝导入。全部已知旧文档先验证，再用一个SQLite事务写入原文与关系表；任何失败都不覆盖旧文件。缺少旧存档时，现有会话的兼容索引由原store的legacy回调一次性生成并落库。

会话预算文档`state/conversation-budget.json`也遵循相同的严格导入与数据库权威规则，兼容旧名称`group-budget.json`，同一机器人不允许同时使用两份非空预算文档。预算从既有费用账本读取已观察估算，并将每日高水位及在途预留另存SQLite；这不等于迁移或改写费用账本。参见[会话预算的行为和估算边界](CONVERSATION_BUDGET.md)。

`state/tenants.json`同样在初次导入时严格验证，之后由数据库权威保存。自费API密钥只保存AES-256-GCM密文，SQLite原文和查询表里均不保存明文Key。独立的`state/tenant-key`是32字节主密钥，不进入SQLite；有密文却丢失主密钥时返回503并禁止自动生成新密钥。恢复用户自费配置需要匹配时点的数据库和主密钥，不能只恢复其中一个。详见[用户空间与自费边界](TENANT_SPACES.md)。

JSON原文件保留为迁移时的冻结备份。某文档一旦导入，之后只读数据库，不会把后来修改、损坏或放回的旧JSON重新覆盖到数据库。删除文档保留数据库墓碑，避免同名旧文件使已删除内容复活。其他明确接入的运行目录内文档可按文档首次校验导入；既有数据库文档不会反灌。

Markdown角色文件是一个例外：初次导入时相同内容原样保留，之后作为worker兼容镜像，由数据库更新，所以不能把活动`roles/*.md`当作永久冻结备份。正文先与相关管理状态一起提交SQLite，再原子物化文件。提交后若文件镜像失败，数据库保留新真值和可重试outbox，错误带`committed:true`；不能把它误当成数据库事务已回滚。下次启动会重建数据库权威镜像，正文未同步则停止启动，防止worker读取错误人设。

数据库重开会验证应用标识、版本、受管schema、完整性和外键；未来版本、未知数据库或受管schema变更会失败关闭。连接存活期间也会拒绝版本/受管schema发生变化后的继续读写。写入必须携带先前读到的完整`expectedText`；并发修改导致比较失败时停止改写，不能用空对象覆盖新数据。异步密码运算在事务外进行，提交时再次CAS。

## 接口与事务

```js
const storage = createSqliteState({ file, root, botId: 'primary' });
const botStorage = storage.forBot('beta');
const old = botStorage.readText(documentPath); // 不存在时ENOENT
botStorage.writeText(documentPath, nextText, old);
storage.transaction(() => {
  // 同步操作；嵌套使用SAVEPOINT，禁止跨await持锁。
});
```

`expectedText:null`表示期望文档不存在，`undefined`不是无条件覆盖许可。还提供`deleteText`、`renameText`、`listDocuments(prefix)`、`materializeText`、`flushMaterializations`及受信内部模块使用的`db`句柄。所有文档路径必须位于指定root内部；`forBot`不会改变root边界。三个既有store的`storage`为可选参数，隔离的旧JSON兼容测试仍可使用原逻辑。

## 回滚与验证范围

手动回滚必须配套选择代码/数据库schema版本、同一时点的数据库、运行状态与DSH目录。**不能只把旧JSON复制回来，也不能删除新数据库让程序重新导入过时JSON**：迁移后的账号撤销、scope、人设版本和新存档可能只存在数据库中。未来数据库版本不会被旧代码自动降级。本次不增加运维定时任务或自动备份服务。

`node scripts/test-sqlite-state.mjs`目前覆盖18项隔离验证：迁移字节与cookie/ID/哈希保留、旧文件不反灌、损坏/未来格式拒绝、schema校验、事务/SAVEPOINT/CAS、外键和权限、账号依赖不因重写而丢失、多bot隔离、worker身份、MD创建/重命名/删除/墓碑、成员版本和机器人投影、SQL约束失败回滚、物化失败恢复及并发账号写入。已有账号23项、会话17项、切换竞态6项兼容回归也已通过。这里的测试均为临时目录和模拟账号/机器人，不代表真实QQ或供应商在线验收。
