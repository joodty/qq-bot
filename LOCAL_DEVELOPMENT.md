# 本地开发入口

跨电脑和跨 AI 的完整步骤见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)，项目现状见 [docs/HANDOFF.md](docs/HANDOFF.md)，设计变化原因见 [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md)。

Windows 在克隆目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\local\Setup-Dev.ps1
```

工具与依赖保存在本项目目录，不依赖某个固定盘符、用户名、Codex 会话或服务器资料。它只准备本地开发环境和隔离测试，不启动真实 QQ 或模型服务。

公开主线为 `main`。初次公开前的源码快照与开发分支是本机私有历史，不上传；未来开发从 GitHub 的公开主线或其工作分支继续。
