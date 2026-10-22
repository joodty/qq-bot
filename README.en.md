# QQ Bot Management

A management extension derived from [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge). It adds conversation-specific personas and resumable persona sessions, daily estimated spending limits, ordinary account registration, isolated bot ownership, user-provided API configurations and SQLite management state.

[中文说明](README.md) · [Handoff](docs/HANDOFF.md) · [Design decisions](docs/DESIGN_DECISIONS.md) · [Development](docs/DEVELOPMENT.md) · [Work log](docs/WORK_LOG.md)

The detailed handoff is maintained in Chinese and is tool-independent: start with `AGENTS.md`, whether using Codex, WorkBuddy, another AI or a regular editor.

With Git and Node 24:

```bash
git clone https://github.com/joodty/qq-bot.git
cd qq-bot
npm ci --ignore-scripts --no-audit --no-fund
node scripts/patch-snowluma-sdk.mjs
npm run test:core
npm run check:public
```

Windows can run `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\local\Setup-Dev.ps1` after cloning. It downloads and verifies a portable Node 24 runtime inside the checkout, installs locked dependencies, enables the local pre-push check and runs isolated core tests. It does not change global Node or start a real bot.

Development fixtures need no production credentials, server access, QQ login or paid model calls. Actual bot deployment is separate. Independent QQ instances still need platform preparation, a real QR login and identity verification; registration alone does not provision or claim a QQ account.

Public history begins at a sanitized snapshot. Pre-publication local branches and tags are private and must not be merged or pushed. Server connection details, real account/group IDs, runtime state, API keys and private keys are excluded. See [LICENSE](LICENSE) for retained upstream attribution and component boundaries.
