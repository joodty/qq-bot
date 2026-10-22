#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getRuntimePaths, validateRuntimeIdentity } from '../src/runtime-paths.js';

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = { bridge: 'src/bridge.js', setup: 'scripts/setup-dsh.mjs', snowluma: 'src/mcp-snowluma-safe.js', 'snowluma-host': 'src/mcp-host-server.js', 'web-search-safe': 'src/mcp-web-search-safe.js' };
try {
  const runtimeRoot = process.argv[2], target = process.argv[3] || 'bridge';
  if (!runtimeRoot || !path.isAbsolute(runtimeRoot) || !Object.hasOwn(targets, target)) throw new Error('用法: node scripts/run-bot-instance.mjs <绝对运行目录> [bridge|setup|snowluma|snowluma-host|web-search-safe]');
  const config = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (!config.managerWorker || config.botId === 'primary' || !path.isAbsolute(config.dsh?.homeDir || '') || !path.isAbsolute(config.snowluma?.homeDir || '')) throw new Error('只允许有独立home与身份的worker配置');
  Object.assign(process.env, { QQ_BRIDGE_RUNTIME_ROOT: path.resolve(runtimeRoot), QQ_BRIDGE_BOT_ID: config.botId, QQ_BRIDGE_EXPECTED_QQ: String(config.expectedQQ), DSH_HOME: config.dsh.homeDir, SNOWLUMA_HOME: config.snowluma.homeDir, QQ_MODE_DIAG: path.join(runtimeRoot, 'state', 'qq-mode-plugin.log') });
  validateRuntimeIdentity(config, getRuntimePaths({ codeRoot }));
  const entry = path.join(codeRoot, targets[target]); process.argv = [process.execPath, entry, ...(target === 'setup' ? ['web'] : [])];
  await import(pathToFileURL(entry).href);
} catch (error) { console.error('实例入口拒绝运行：' + error.message); process.exitCode = 1; }
