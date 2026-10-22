# 用户空间、自费配置与机器人归属

平台权限继续只有`admin`和`user`。拥有机器人或保存API Key不会提升平台角色。普通账号有自己的空间，机器人按所有者归属；所有者可把具体群/私聊委托给其他账号，委托只增加指定机器人下指定会话的业务权限。平台主机器人`primary`始终属于平台，不能通过用户接入流程认领。

账号原有ID、密码派生结果、cookie会话和显式会话授权继续保留。旧账号里的QQ相关信息不构成已验证绑定，也不会自动授权对应私聊。

## 本人QQ验证与试用

登录用户空间后填写本人QQ，取得十分钟有效的一次码，再由该QQ通过真实OneBot私聊发给平台机器人。网页不能直接消费验证码。桥接需先核实机器人实例和事件身份，用真实`event.user_id`调用`consumeBinding`，不能信浏览器提交的QQ号、转发内容或工作实例任意上报的用户身份。

验证码只保存SHA-256哈希；每次新申请使该账号旧码失效，申请有冷却和次数限制，同一QQ的五次错误尝试会使待验证码失效。错误计数在事务提交后才报错，刷新/重启不能清零。绑定是一对一关系，不能抢占已有QQ或把已绑定账号换到别人的QQ。QQ绑定本身只产生本人私聊范围；即使绑定的是平台管理员账号，QQ事件解析结果也不会变成平台管理员权限。

已绑定用户在平台机器人上的私聊默认使用平台试用，每人每日0.1元、平台共享每日1元；管理员可调整默认值、单用户试用覆盖和平台总额，普通用户不能抬高平台额度。实际用量准入和在途预留由预算层执行，tenant服务只提供经过权限校验的费用来源及额度元数据。

未绑定的普通私聊默认阻止付费调用。桥接可显式保留可信旧配置`ownerQQ/allow.private`的既有平台通道，它来自已有运维配置，而不是从账号资料推断的授权。原主机器人群聊继续使用原平台来源。所有这些调用仍需预算准入。

## 自费密钥

初版仅接受固定DeepSeek官方HTTPS地址`https://api.deepseek.com`，模型白名单为`deepseek-flash`与`deepseek-v4-pro`，不接收用户baseURL或端点，避免把凭据发给任意主机。模型依据[DeepSeek官方文档](https://api-docs.deepseek.com/)及[模型接口](https://api-docs.deepseek.com/api/list-models/)核实。保存阶段校验Key形状和长度，不进行付费模型测试；保存成功不等于供应商余额/权限已验证。

API Key用AES-256-GCM加密，随机12字节IV、16字节认证Tag，并把所有者与profile稳定ID放入AAD，防止密文被复制到另一用户/配置后使用。密码学接口依据[Node 24 Crypto文档](https://nodejs.org/download/release/v24.21.0/docs/api/crypto.html)。主密钥是独立`state/tenant-key`中的32字节随机数据，创建时0600并fsync；只有首次需要加密且没有既有密文时才生成。数据库记录主密钥指纹，有密文却丢失、替换或损坏主密钥时拒绝覆盖，返回503。

普通用户与平台管理员的profile列表只显示本人元数据，不返回API Key、密文或主密钥。别人的profile不能通过猜ID改写或删除。修改时不填Key保留原密文；替换时重新生成IV。profile和费用选择各有独立版本，过时保存返回409。

删除配置使用失效标记，原有费用选择仍指向失效项并停止调用，**不自动改用平台Key**。被明确标为供应商拒绝的配置也停止使用。只有用户明确把本人平台私聊费用来源改为`null`时，才切回管理员设定的试用。平台管理员不能替机器人所有者选择其他人的Key。

## 托管机器人与委托

普通账号验证绑定本人 QQ 后，只提交`{botQQ,name,profileId}`开通申请，不填写或取得实例连接凭据。管理员在平台内部准备独立 worker，再明确关联申请与未归属实例；本人扫码后，后台按`verify → claim(申请原ownerID) → setFunding(申请人本人profile) → enable`核验启用。填写 QQ 号不会登录、认领已有实例。失败会停用本次实例并撤销本次新建的所有权/费用绑定；已经转交他人的实例不被补偿逻辑停用。申请存于现有`state_documents`版本化文档，不增加表。详见[BOT_ONBOARDING.md](BOT_ONBOARDING.md)。

机器人所有者拥有自己实例的费用、准入、人设、会话等业务权限，不能访问平台账号目录、其他机器人、平台机器凭据或本地closed-agent工具。委托采用精确账号名解析成稳定账号ID，并只保存指定`botId`下的会话keys；撤销使用空keys并保留版本。管理员转交机器人所有者时清除旧委托及旧所有者费用来源，防止新所有者继续借用原Key。

工作实例内部费用接口固定为`POST /api/internal/tenant`，请求`{action:'funding',botId,key}`，用该工作实例自己的机器令牌认证；拒绝cookie、agent、Origin、浏览器site/destination和query通道。Node原生fetch可能带`Sec-Fetch-Mode:cors`，该字段单独存在不代替身份判断。

**工作实例只能取得它的所有者明确选择的bot profile。** 即使某个访客把个人Key存入平台空间，工作实例也不能通过声称自己收到了该QQ的私聊而取得访客Key。个人私聊BYOK只在可信平台主实例使用。内部接口不提供QQ验证码消费、账号目录或平台Key。

## SQLite与恢复边界

tenant服务通过事务/CAS保存`tenants.json`原文，并同步投影到`tenant_settings/profiles/qq_bindings/binding_challenges/owned_bots/delegations/funding/trial_overrides`关系表。所有owner、绑定和委托用户引用实际账号；auth写入采用稳定ID的UPSERT，不删除重建仍存在的账号。损坏、未来版本、未知字段及不合法引用拒绝覆盖，迁移后的旧JSON只是冻结备份。

数据库与独立主密钥必须配套恢复；旧JSON不能覆盖数据库新状态。主密钥不是密码登录资料，也不能通过重新设置登录密码重建。Windows的0600模式不等于完整ACL，仍依赖state目录已有的访问保护。本次不创建额外运维任务。

DSH历史、费用JSONL、活动映射及SQLite管理索引的边界见[SQLite持久层说明](SQLITE_STORAGE.md)。BYOK文本聊天档案与待核对费用由聊天/runtime模块自己的严格文档存入SQLite，用户空间overview只返回经过范围筛选的统计，不返回这些底层档案、凭据或跨用户聊天。

验证脚本为`scripts/test-tenant-service.mjs`与`scripts/test-tenant-router.mjs`。测试使用临时SQLite、虚构账号、虚构机器人身份与本地HTTP，不调用真实QQ或供应商；完整上线验收还需桥接paid入口、最终发送guard、真实实例健康与浏览器权限证据。
