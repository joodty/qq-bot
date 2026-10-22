# 文档入口

新设备、新开发者和 AI 接手时先读前四项。公开交接文档与当前代码一起维护，不需要原始聊天或私有开发笔记。

| 文档 | 用途 |
| --- | --- |
| [HANDOFF.md](HANDOFF.md) | 项目背景、已实现业务、代码地图、明确边界与待办 |
| [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) | 旧假设如何被修正、为什么选择当前方案、代价与后续方向 |
| [DEVELOPMENT.md](DEVELOPMENT.md) | 一键克隆准备、隔离验证、跨工具接手、提交与推送 |
| [WORK_LOG.md](WORK_LOG.md) | 已完成工作、实际验证、发布状态和已知问题 |
| [../AGENTS.md](../AGENTS.md) | 工具通用的工作约定与每次任务结束后的同步要求 |

## 当前业务说明

| 文档 | 主题 |
| --- | --- |
| [CONSOLE_ACCOUNTS](guides/CONSOLE_ACCOUNTS.md) | 注册、密码登录、Cookie、唯一平台管理员与普通账号 |
| [TENANT_SPACES](guides/TENANT_SPACES.md)、[USER_WORKSPACE](guides/USER_WORKSPACE.md) | 本人 QQ、自带 Key、费用来源、归属和会话委托 |
| [BOT_ONBOARDING](guides/BOT_ONBOARDING.md) | 无需用户提供机器凭据的开通申请与实际核验 |
| [MEMBER_PERSONAS](guides/MEMBER_PERSONAS.md) | 授权范围内编辑和切换人设 |
| [SQLITE_STORAGE](guides/SQLITE_STORAGE.md) | 管理数据迁移、文档投影与外部存储边界 |
| [MULTI_BOT_DESIGN](guides/MULTI_BOT_DESIGN.md)、[MULTI_BOT_SETUP](guides/MULTI_BOT_SETUP.md) | 统一管理与独立实例的架构、准备步骤 |
| [CONVERSATION_BUDGETS](guides/CONVERSATION_BUDGETS.md)、[CONVERSATION_BUDGET](guides/CONVERSATION_BUDGET.md) | 群和私聊限额、预留及输出收敛 |
| [DATA_MODEL_PAGE](guides/DATA_MODEL_PAGE.md) | 匿名 ER 说明、字段字典、生成方式与目标模型区别 |

## 原有专项资料

[RULES](../RULES.md)、[SECURITY_BASELINE](guides/SECURITY_BASELINE.md)、[DSH_SETUP](guides/DSH_SETUP.md)、[DSH_020_ADAPTATION](guides/DSH_020_ADAPTATION.md)、[CONSOLE-UI-TESTING](guides/CONSOLE-UI-TESTING.md)、[TOKEN_USAGE_CONSOLE](guides/TOKEN_USAGE_CONSOLE.md) 和 [PRIVACY](guides/PRIVACY.md) 保留专项背景。涉及旧令牌网页、单一人设或旧目录的描述，以本页的当前交接、源码和最新测试为准。

部分上游目录说明曾引用未公开的研究/审计/个人资料，当前索引不再把这些文件标成公开开发的必需依赖。缺少的旧语音文档与 DSH 环境导致的完整审计限制已在工作记录中列明。
