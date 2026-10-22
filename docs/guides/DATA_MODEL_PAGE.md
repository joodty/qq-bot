# 公共数据模型说明页

`/data-model` 不需要登录。登录页、用户空间、控制台和权限说明中均提供入口。

页面包含当前 SQLite 的 26 张表、四个主题的 ER 图、字段及外键字典、结构 SQL 下载，以及尚未迁移的目标业务模型讨论。实线表示实际数据库外键，虚线表示程序维护的业务关系。当前存储还包括 `state_documents` 内的版本化文档、用量 JSONL 和 DSH 自己的消息存储；页面明确区分这些边界。

数据来自 `src/sqlite-state.js` 的建表定义，不连接运行中的数据库，不读取记录、账号、QQ、会话内容、密码或密钥。静态 JSON 通过 `/data-model/schema.json` 公开，工作实例仍保持仅内部 API 的边界。

修改建表定义后运行 `npm run build:data-model`，提交 `public/data-model-schema.json`。新增表还需补充生成器中的中文说明。`npm run test:data-model` 会验证字典与真实建表结果一致、匿名可读、管理 API 仍需鉴权，`npm run test:data-model:ui` 检查实际浏览器交互和手机布局。

页面里的“目标业务模型”和建议导航层级仅用于讨论。本次没有迁移表结构，也没有重组控制台全部功能。
