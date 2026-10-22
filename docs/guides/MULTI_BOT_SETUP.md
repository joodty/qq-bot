# 新增独立 QQ 机器人实例

主机器人仍使用原网址、原管理端口和 `primary` 标识；新增实例通过统一机器人管理页接入。以下是代码已经提供的接入流程，**不代表第二个真实 QQ 已经登录或上线**。QQ 扫码、独立 SnowLuma 与 DSH 的准备由用户完成，项目不自动部署这些登录组件。

## 1. 先准备独立端点

第二个 QQ 必须有自己的 SnowLuma home、HTTP/WS 端点，以及自己的 DSH home 与 HTTP 端点。不要复用主实例登录目录、默认 DSH home 或管理端口；也不要只复制主 config/state 启动第二进程。

下面是示意分配，端口均需先确认未占用，不是当前服务器的实际配置：

| 用途 | 示例 |
| --- | --- |
| worker Bridge 管理端口 | 3310 |
| 独立 SnowLuma HTTP / WS | 3300 / 3301 |
| 独立 DSH HTTP | 3380 |
| worker 数据目录 | `/absolute/path/bot-demo`（创建前不存在） |
| SnowLuma home | `/absolute/path/snowluma-demo` |
| DSH home | `/absolute/path/dsh-demo` |

创建工具只接受显式的回环端点，不接受远程 URL；拒绝使用主实例默认的 3100/3080/3000/3001。它不会探测或停止占用端口的其他服务。准备两套服务后，应先确认实际 QQ、端口和 home 的对应关系；不假定 SnowLuma 单进程支持两个 QQ。

## 2. 从受控模板新建运行目录

在项目源码根目录运行。把 `YOUR_BOT_QQ` 换成新 QQ 的数字，路径换成准备好的绝对路径；示例可写成一条命令：

```text
node scripts/create-bot-instance.mjs --botId=bot-demo --runtimeRoot=/absolute/path/bot-demo --expectedQQ=YOUR_BOT_QQ --consolePort=3310 --snowlumaHttpUrl=http://127.0.0.1:3300 --snowlumaWsUrl=ws://127.0.0.1:3301 --snowlumaHome=/absolute/path/snowluma-demo --dshBaseUrl=http://127.0.0.1:3380 --dshHome=/absolute/path/dsh-demo
```

Windows 同样使用该脚本，把路径替换为本机绝对路径；含空格的整个 `--参数=值` 应作为一个带引号的参数传入。

工具生成新的 `config.json`、空 roles/audio、独立 state 和可写 preset/bundle。它只读取仓库的 `config.example.json` 和受控 preset，不复制主配置、私人角色、账号数据库、QQ 登录资料、DSH 凭据或模型会话。机器令牌随机生成并只写入该实例配置，命令结果不打印令牌。目标目录已经存在时拒绝覆盖；失败后先检查保留的目录，不直接重跑覆盖。

新实例默认没有 ownerQQ，群和私聊允许列表为空，`allowAllWhenEmpty=false`。它不会因为配置为空就开放所有聊天。

## 3. 配置新实例自己的凭据

仅编辑新目录下的 `config.json`：

- `snowluma.accessToken` 填该实例 HTTP token，`snowluma.wsAccessToken` 填对应 WS token；两者可能不同，不能盲目复制同一个值。
- `snowluma.homeDir`、`httpUrl`、`wsUrl` 对应同一独立 SnowLuma 和同一个预期 QQ。保持 `followDiscoveredEndpoint=false`，worker 不自动扫描并跟随另一份安装。
- `dsh.homeDir`、`dsh.baseUrl` 对应该实例真实 DSH。`dsh.authToken` 默认留空，客户端按这个独立 home 的凭据核验；不要复制主 DSH 的签名密钥或登录资料。
- 保留生成的 `botId`、`expectedQQ`、`managerWorker=true`。运行目录、环境与配置的身份不一致时会拒绝启动。
- 模型、工具预设与少量测试对象按实际服务配置。先只允许一个测试群和指定私聊，完成双 QQ 验收后再扩展。

凭据仅在服务器受控配置和管理员接入表单中使用，不放进群聊、公开仓库或截图。普通账号不会接触机器凭据；每个 worker 也不需要新建网站登录账号。

## 4. 安装该实例 MCP 配置，再运行 Bridge

先为新实例已准备好的独立 DSH 安装项目 preset/MCP 配置：

```text
node scripts/run-bot-instance.mjs /absolute/path/bot-demo setup
```

wrapper 从实例配置设置 `QQ_BRIDGE_RUNTIME_ROOT`、`QQ_BRIDGE_BOT_ID`、`QQ_BRIDGE_EXPECTED_QQ`、`DSH_HOME` 和 `SNOWLUMA_HOME`。安装产物写入该实例的 home/preset，MCP 通过相同 wrapper 绑定该实例。默认主实例启动方式不变。

然后运行 worker Bridge：

```text
node scripts/run-bot-instance.mjs /absolute/path/bot-demo bridge
```

这条命令运行前台 Bridge，不自动安装/启动 SnowLuma 或 DSH，不替代用户扫码，也不配置后台进程守护。`setup` 如果报告需要重新载入 DSH 的 profile，应只处理新实例对应的 DSH，不能重启或修改主实例及代理服务。

## 5. 在原管理入口新增连接、核验并启用

用统一管理员账号打开“机器人管理”，填写与配置完全一致的 botId、名称、预期 QQ、worker 管理端口和该实例 `consoleToken`。机器 token 为16–128位字母、数字、下划线或短横线；留空更新表示保留旧 token，页面不会把已保存 token 回显。

1. 新增后保持未启用。主实例固定为 primary，不能作为远端重复登记；同 QQ 或同管理端口拒绝重复连接。
2. 点击核验。系统读取独立实例的 botId、WS/HTTP 实际 QQ 与在线状态、DSH 就绪状态。未知、错号、不可达或重定向都明确拒绝。
3. 系统还会同步已知机器人 QQ 集合及核验元数据，这属于控制配置写入；不会发送 QQ 消息、创建模型对话或请求付费模型。任一启用 worker 不能确认防互聊集合时，不启用新连接。
4. 核验成功后启用管理连接，再在对应 bot 的范围内管理角色、会话、测试对象与授权。成员用原账号登录，只有管理员授权的 bot + 群/私聊范围可用。

worker 在首次收到有效的防互聊集合前禁止聊天/发送。集合持久化，重启后仍然生效。默认过滤已知 bot 发言和拍一拍，不提供无预算护栏的自动 AI 互聊开关。

“停用接入”只禁止 Manager 代理该连接，不表示退出 QQ 或停止进程；本次没有进程运维功能。如需停止实际聊天，应使用该 bot 的聊天暂停/准入设置，不要通过误删配置或破坏端口实现。

## 6. 验证和保留数据

先在指定测试群人工触发两个 QQ，确认回复身份、不同人设、模型对话 ID 和费用分别归属，再测私聊、重连、过滤、普通账号范围。现有 primary 的原 DSH ID不改；新建存档仍在下一次正常唤醒才创建模型对话。

同时观察双实例内存、CPU、响应耗时、图片语音峰值、供应商并发与账本增长。测试夹具、连接核验或看到两个在线状态，不能替代两套真实 QQ 的端到端验收。

角色与会话等数据使用各运行目录下的 SQLite；迁移后的原 JSON 保留为备份，不应手工回写 JSON 试图覆盖数据库。备份与恢复应保留一致检查点；损坏/未来格式拒绝改写，不自动初始化空库。当前账号仍只维护一套，原有普通账号范围不会自动扩展到新 bot。

接入只涉及机器人组件，不改动原管理网址、主 bot 的 QQ 登录、代理端口或代理配置。边界与验证范围见[多机器人实现说明](MULTI_BOT_DESIGN.md)。
