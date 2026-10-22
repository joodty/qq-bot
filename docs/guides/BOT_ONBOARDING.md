# 自有 QQ 机器人的开通申请

普通账号自主注册后只管理自己的资料。申请自有机器人不需要填写服务器连接信息，也不会获得平台管理员权限。

1. 在“我的空间”通过真实 QQ 私聊一次码验证本人账号。
2. 保存本人模型配置，填写机器人 QQ、名称并选择自己的有效费用配置，提交开通申请。
3. 平台启用网页接入服务后，提交申请会自动准备独立运行环境并弹出扫码窗口；本人用准备作为机器人的 QQ 扫码并在手机确认。关闭后可从进度继续，过期可刷新。
4. 后台独立核验实际 QQ、聊天服务、申请人及其费用配置后启用。已接入实例可查看连接或重新扫码。平台未启用自助服务时，继续沿用管理员准备与核验流程。

注册网页账号或填写一个 QQ 号不会登录这个 QQ，也不会认领已经接入的实例。平台先安装所需 SnowLuma/DSH/容器及登录服务后，已安装的组件可按申请自动生成独立环境；本人扫码仍是必要步骤。完整用户流程、运行前提、隔离和测试见 [网页 QQ 登录](WEB_QQ_LOGIN.md)。第二个真实 QQ 是否已成功登录必须由实际扫码与在线核验确认。

## 平台处理

管理员在现有机器人管理页通过内部连接配置登记独立 worker，并保持未启用。用户空间中的管理员申请面板只提供 QQ 匹配、未归属且未启用的实例供选择，不显示连接凭据。

管理员必须明确选择申请人与实例；后台从申请原记录读取申请人 ID，并用现有账号目录重新校验账号、绑定和自费配置。核验成功后才建立所有权、选定申请人费用配置并启用。核验失败保留待处理进度；本次建立的所有权和费用绑定会补偿撤回，已有其他用户的实例不会被停用或转移。

## 状态与接口

| 接口 | 权限与用途 |
| --- | --- |
| `GET /api/tenant/bot-requests` | 普通账号仅看本人申请；平台管理员查看全部申请及安全的候选实例信息 |
| `POST /api/tenant/bot-requests` | 已验证本人 QQ 的账号提交 `{botQQ,name,profileId}` |
| `POST /api/tenant/bot-requests/prepare` | 平台管理员提交 `{id,botId,version}`，关联准备好的实例 |
| `POST /api/tenant/bot-requests/activate` | 平台管理员提交 `{id,version}`，核验实际 QQ 后启用 |
| `POST /api/tenant/bot-requests/reject` | 平台管理员提交 `{id,version,reason}` |
| `POST /api/tenant/bot-requests/login/start` | 本申请人提交 `{id,version}`，准备或恢复专属扫码环境 |
| `POST /api/tenant/bot-requests/login/check` | 本申请人查看登录状态，独立核验通过后自动启用 |
| `POST /api/tenant/bot-requests/login/refresh` | 本申请人刷新该实例二维码 |
| `POST /api/tenant/bot-requests/login/cancel` | 本申请人取消尚未启用且未完成登录的接入 |

申请数据保存在现有 SQLite `state_documents` 中的版本化 `bot-onboarding.json` 文档，不增加数据库表。格式损坏、未来版本和并发版本冲突都拒绝覆盖。申请字段不接受 `ownerUserId`、`role`、端口或机器凭据。

`scripts/test-bot-onboarding.mjs` 使用临时 SQLite、真实账号/租户服务和隔离 HTTP 路由，检查申请权限、费用归属、扫码失败、异步身份变化、已有实例保护和失败补偿。测试不登录真实 QQ，不产生模型费用。
