# 换电脑或换 AI 后继续开发

公开仓库只有代码、脱敏模板和可重复测试。开发测试不需要生产服务器、QQ 登录、API Key 或 Codex 专有会话；WorkBuddy、其他 AI 和人工开发者使用同一套文件。

## Windows：拉取并一键准备

先安装 Git，在希望保存项目的目录打开 PowerShell，再复制这一整段。若任一步失败就停止，不会接着运行后续命令。

```powershell
git clone https://github.com/joodty/qq-bot.git
if ($LASTEXITCODE -ne 0) { throw 'Clone failed' }
Set-Location qq-bot
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\local\Setup-Dev.ps1
if ($LASTEXITCODE -ne 0) { throw 'Development setup failed' }
```

脚本把固定版本的 Node 24、npm、依赖和缓存放到项目的被忽略目录，核对 Node 官方 SHA256，按 lockfile 安装依赖并运行核心隔离测试。它不修改全局 PATH 或系统 Node，不创建生产配置，不登录 QQ，也不启动真实 Bridge。首次运行需要访问 Node/npm 官方下载站。

后续终端可临时使用项目 Node：

```powershell
$env:PATH = (Join-Path (Get-Location) '.tools\node') + ';' + $env:PATH
node --version
npm run test:core
```

## macOS / Linux，或已有合适 Node 的电脑

使用 Node 24 LTS；源码兼容底线是 `>=22.13.0`，当前开发与 SQLite 验证以 Node 24 为基准。

```bash
git clone https://github.com/joodty/qq-bot.git
cd qq-bot
npm ci --ignore-scripts --no-audit --no-fund
node scripts/patch-snowluma-sdk.mjs
npm run test:core
npm run check:public
```

## 每次接手先做什么

```bash
git status --short
git remote -v
git branch --show-current
git pull --ff-only
```

已有本地修改时先确认归属，不能覆盖或自动丢弃。先读 `AGENTS.md`、`docs/HANDOFF.md`、`docs/DESIGN_DECISIONS.md`、`docs/WORK_LOG.md`，再根据任务查看对应源码。GitHub 上的提交与日志记录是跨工具交接依据，上一位 AI 的私人聊天、记忆或 `.local/` 文件不是必需依赖。

## 安全预览与验证

| 命令 | 用途 |
| --- | --- |
| `npm run preview:console` | 假数据控制台，终端打印本机预览地址；不连接 QQ/DSH/模型 |
| `npm run test:core` | 干净克隆可执行的核心回归：存储、账号、权限、申请、会话、预算与接入隔离 |
| `npm run test:audit` | 完整历史审计，保留已知语音文档/DSH 安装环境依赖，不隐瞒失败 |
| `npm run build:data-model` | 建表源码变化后重新生成公共结构字典，不访问运行数据库 |
| `npm run check:public` | 检查待公开文件、源码凭据和机器痕迹；本机可加额外禁止标识 |
| `node scripts/check-publication.mjs --ref HEAD` | 检查当前分支全部可达历史，不扫描未推送的本机私有其他分支 |

浏览器测试需要 Playwright 与 Chrome/Chromium。可单独装在 `.local/qa`，不改变正式依赖锁文件：

```powershell
npm install --prefix .local/qa --no-save --package-lock=false --ignore-scripts playwright@1.51.1
$env:PLAYWRIGHT_MODULE = (Join-Path (Get-Location) '.local/qa/node_modules/playwright')
node scripts/test-registration-ui.mjs
node scripts/test-data-model-ui.mjs
```

部分旧 UI 脚本使用 Windows Chrome 默认安装路径；其他系统需调整测试启动参数。浏览器夹具与生产公网验证是两种证据，不能混为一谈。

## 完成任务后提交与推送

更新工作记录与相关设计说明，运行相关测试，审阅 `git diff` 与暂存内容，只暂存本次文件。所有者已要求每次完成任务后提交并推送；按当前公开分支执行，不需要反复确认这项既有授权。

```bash
npm run check:public
git diff --check
git add <本次改动的文件>
git diff --cached
git commit -m "说明最终改动"
node scripts/check-publication.mjs --ref HEAD
git push
git rev-parse HEAD
git ls-remote origin HEAD
```

首次新分支需要 `git push -u origin <分支名>`。主线通常是 `main`；主线校验时比较 `git ls-remote origin refs/heads/main`。推送需要你自己的 GitHub 登录/写权限，公开克隆和本地测试不需要。不要把 GitHub Token 放进 clone URL 或文档。

提交、远端推送、部署、生产验证分别报告。仅 `git commit` 成功不能宣称已经推送；远端有代码也不能宣称生产已更新。不要用 `--force`、`--all`、`--mirror` 或批量旧标签把私有历史带进仓库。

## 如需运行真实机器人

由实例所有者另外提供配置和凭据，参考 `config.example.json`、[DSH 接入说明](guides/DSH_SETUP.md)、[多机器人设置](guides/MULTI_BOT_SETUP.md) 与 [用户开通申请](guides/BOT_ONBOARDING.md)。首次管理员初始化属于服务器内部步骤，不是公开网页注册入口。

这些步骤与本地开发解耦。不要为了“把测试跑起来”执行真实启动、重置数据库、重新扫码、改代理服务或发送付费测试消息。已有部署授权时，先检查目标当前状态、备份和数据兼容，再按限定范围更新与验证。
