# 控制台账号与会话

网页使用账号密码登录，并开放普通账号自主注册，不再提供网页访问令牌登录或管理员激活入口。原有唯一管理员账号保持不变，管理平台默认配置和普通账号；注册不会产生新管理员。账号支持3至32位字母、数字、点、下划线和短横线，大小写统一为小写；密码为10至128个字符。系统不生成或明文存储初始密码。尚无管理员的全新安装须先经可信服务器初始化；内部`bootstrap`方法保留供这个流程和隔离测试使用。

激活后使用账号密码登录，浏览器通过 HttpOnly、SameSite=Strict 的会话 cookie 保持30天；刷新不需要重复输入令牌。退出立即撤销当前会话；修改自己的密码须验证原密码，并撤销该账号的所有会话，随后重新登录。管理员重命名、修改权限、禁用或重置普通账号密码，也会撤销该账号所有会话。

管理员为唯一管理账号，不能通过账号管理接口禁用、改名或降级它。公开注册固定创建`role:'user'`、`disabled:false`和空`conversationKeys/botScopes`，成功后自动登录。注册仅接受账号名和密码；附加`role`、`disabled`、owner、scope、机器人归属或稳定ID字段一律拒绝，不是忽略后继续接受。管理员也可创建普通账号并显式分配 `group:群号`、`private:QQ号`。管理员私聊也属于对应的 `private:QQ号`，不会另发一份管理员权限。

新注册账号默认没有其他人的会话、机器人、Key或平台配置权限。本人QQ须经真实机器人事件验证绑定，自有机器人须经接入核验与所有权登记；会话委托限指定机器人和指定对象。普通账号只能在自己、所有或受委托的资源范围内操作，不因保存Key或拥有机器人而提升平台角色。原控制台的全局管理 GET/POST、平台凭据和跨会话数据对普通账号仍返回403。用户标识 `id` 稳定，修改账号名不会改变归属。公开注册不等于允许普通账号调用管理员的账号创建、修改或权限扩张接口。详见[用户空间说明](TENANT_SPACES.md)。

## 后端接口

| 方法与路径 | 输入/返回 | 权限 |
| --- | --- | --- |
| GET `/api/auth/status` | `{ok,configured,registrationEnabled,authenticated,user}` | 公开；仅 cookie 会话算已登录；仅机器令牌时 `user:null` |
| POST `/api/auth/login` | `{username,password}`，返回 `{ok,user}` 并设置 cookie | 公开且限速 |
| POST `/api/auth/register` | 严格`{username,password}`，返回`{ok,user}`并设置cookie | 已有唯一管理员且注册开关开启，固定普通账号，公开限速 |
| POST `/api/auth/logout` | `{}`，撤销当前会话并清 cookie | 当前浏览器 |
| POST `/api/auth/password` | `{currentPassword,newPassword}`，返回 `{ok,reauthenticate:true}` | 当前账号，撤销全部会话 |
| GET `/api/auth/users` | `{ok,users}`，无密码/会话数据 | 管理员 |
| POST `/api/auth/users` | `{username,password,conversationKeys:[]}`，返回 `{ok,user}` | 管理员创建普通账号 |
| POST `/api/auth/users/update` | `{id,username?,password?,conversationKeys?,disabled?}` | 管理员修改普通账号 |

公开用户对象仅包含 `id,username,role,disabled,conversationKeys,botScopes,createdAt,updatedAt`；tenant层可再附加可信的自有机器人授权，不返回密码派生或session哈希。所有认证写操作必须为 JSON，同源 Origin；跨站 Fetch 被拒绝。账号 API 不接受任何智能体调用标记，即使同时携带合法管理令牌。

`GET /login` 是登录/注册页；未认证访问浏览器管理页面跳转登录页；普通账号登录后进入`/workspace`，管理员进入平台控制台。浏览器不再把URL或本地缓存的控制台令牌当登录凭据；旧令牌初始化链接也不授予浏览器管理身份。已有`x-console-token`机器通道保留供受限内部MCP/CLI；cookie与agent头混用会被拒绝，不能借传统MCP通道升级身份。浏览器不能调用`bootstrap`；服务端内部首次初始化保留该接口。

## 存储与部署

正式运行的账号、密码派生结果与会话通过`state/console-auth.json`文档适配器保存在SQLite，原JSON迁移后是冻结备份；独立旧JSON模式仍供兼容测试使用。密码使用Node内建异步scrypt（随机16字节盐，N=32768、r=8、p=1、64字节派生结果），验证用`timingSafeEqual`；注册自动登录与每次登录均生成32字节随机token，仅保存SHA-256哈希。登录有效期同时在服务端校验，cookie自行修改不会延长登录。

文件使用独占临时文件、0600权限、fsync、同目录原子替换写入。格式/字段/未来版本/唯一管理员/会话引用均严格校验；损坏或不认识的格式返回503，禁止覆盖或回退到无账号状态。异步密码计算期间若文件被外部替换，本次写入停止。不存在文件表示尚未激活；正常查询不会创建文件。

SQLite模式将文档、账号、范围、会话投影在同一事务内CAS提交；异步scrypt在事务外计算，提交前比较原文。一个auth实例内的请求排队，多个实例并发重名注册只会有一个成功，另一方409，不产生第二管理员或孤立session。不同账号同时基于旧快照写入时，过时方503停止，不能覆盖先成功的账号。注册创建的cookie可跨服务/连接重启继续有效；禁用账号和改密仍立即撤销。

`createConsoleAuth({allowRegistration:true})`默认允许普通注册，参数必须为布尔值。`registrationEnabled()`仅在开关开启且已有有效唯一管理员时为true；关闭注册不撤销已有登录，也不禁止正常账号密码登录。公开注册方法不能用于空库初始化或损坏/未来格式恢复。

HTTPS反代部署必须显式设置 `consoleAuth.secureCookie: true`，使 cookie 带 Secure。仅实际 TLS socket 或这个严格布尔配置能启用 Secure，不信任客户端可伪造的 `X-Forwarded-Proto`。保留既有回环监听、Host与Origin校验；反代须延续原有安全转发约定。此变更不修改代理服务。

限速按连接实际socket地址、账号及全局统计，不信任`X-Forwarded-For`。注册与登录/初始化/改密共用限速器：15分钟内单账号最多12次、单来源30次、全局120次尝试，在昂贵密码计算前检查；进程重启重置限速计数。反代后多个浏览器可能共享来源限额。账号总数上限200，会话最多每账号10个、全局1000个，旧会话被淘汰后需要重新登录。

运行 `node scripts/test-console-auth.mjs` 验证25个核心与真实路由用例：初始化与兼容、scrypt/随机盐、持久登录、过期/注销/改密/禁用撤销、稳定用户ID、scope、唯一管理员、损坏和未来格式保护、异步外部覆盖保护、限速（含伪造代理IP）、CSRF、代理头、Cookie标志以及agent与浏览器通道隔离。浏览器集成另运行 `node scripts/test-account-ui.mjs`。所有测试只使用隔离临时文件、模拟QQ/模型端，不访问生产凭据，不发送真实消息或付费调用。

`node scripts/test-public-registration.mjs`有14项隔离验证：13项真实SQLite测试覆盖固定普通角色与空scope、字段注入、唯一管理员、密码下限、同名队列/跨实例并发、不同名CAS冲突、cookie跨重启、禁用不可复活、注册开关、共享限速、损坏/未来文档与scrypt期间外部替换保护；另有真实Bridge HTTP集成验证注册cookie、网页query/机器头不能登录、cookie加机器头不提权、agent隔离、跨站来源拒绝及可信内部机器通道保留。浏览器实际界面由UI集成另行验证。
