#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeBotId, normalizeBotQQ } from '../src/runtime-paths.js';
import { normalizeWorkerPort } from '../src/bot-manager.js';

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function localEndpoint(value, protocol) {
  if (typeof value !== 'string' || !new RegExp('^' + protocol + '://127\\.0\\.0\\.1:[0-9]+/?$').test(value)) throw new Error('端点必须显式为 ' + protocol + '://127.0.0.1:独立端口');
  const parsed = new URL(value); normalizeWorkerPort(Number(parsed.port)); return parsed.origin;
}
export function createBotInstance(input) {
  const botId = normalizeBotId(input.botId); if (botId === 'primary') throw new Error('primary 为保留实例');
  const expectedQQ = normalizeBotQQ(input.expectedQQ);
  if (!input.runtimeRoot || !path.isAbsolute(input.runtimeRoot)) throw new Error('runtimeRoot 必须为绝对路径');
  const runtimeRoot = path.resolve(input.runtimeRoot), codeRoot = path.resolve(input.codeRoot || CODE_ROOT);
  if (runtimeRoot === codeRoot || codeRoot.startsWith(runtimeRoot + path.sep) || fs.existsSync(runtimeRoot)) throw new Error('必须使用尚不存在的独立运行目录，不能覆盖代码或已有资料');
  for (const name of ['snowlumaHome', 'dshHome']) if (typeof input[name] !== 'string' || !path.isAbsolute(input[name])) throw new Error(name + ' 必须为独立服务的绝对路径');
  const dshHome = path.resolve(input.dshHome), snowlumaHome = path.resolve(input.snowlumaHome);
  if (dshHome === path.join(os.homedir(), '.dsh') || dshHome === snowlumaHome || dshHome === codeRoot || snowlumaHome === codeRoot) throw new Error('worker 不得复用默认DSH或混用运行目录');
  const consolePort = normalizeWorkerPort(input.consolePort);
  const managerUrl = input.managerUrl ?? 'http://127.0.0.1:3100';
  if (managerUrl !== 'http://127.0.0.1:3100') throw new Error('managerUrl 仅允许 http://127.0.0.1:3100');
  const httpUrl = localEndpoint(input.snowlumaHttpUrl, 'http'), wsUrl = localEndpoint(input.snowlumaWsUrl, 'ws'), baseUrl = localEndpoint(input.dshBaseUrl, 'http');
  const ports = [consolePort, ...[httpUrl, wsUrl, baseUrl].map(url => Number(new URL(url).port))];
  if (new Set(ports).size !== ports.length || ports.includes(3100) || ports.includes(3080) || ports.includes(3000) || ports.includes(3001)) throw new Error('worker 端口须互不重复且不能使用主实例默认端口');
  const config = JSON.parse(fs.readFileSync(path.join(codeRoot, 'config.example.json'), 'utf8').replace(/^\uFEFF/, ''));
  config.botId = botId; config.expectedQQ = expectedQQ; config.managerWorker = true;
  config.managerUrl = managerUrl;
  config.consolePort = consolePort; config.consoleToken = crypto.randomBytes(32).toString('base64url');
  config.ownerQQ = null; config.allow = { groups: [], private: [] }; config.deny = { groups: [], private: [] }; config.allowAllWhenEmpty = false;
  config.dsh = { ...config.dsh, baseUrl, homeDir: dshHome, authToken: '', allowRemote: false };
  config.snowluma = { ...config.snowluma, httpUrl, wsUrl, homeDir: snowlumaHome, launcherPath: '', accessToken: '', followDiscoveredEndpoint: false };
  config.sessionCwd = path.join(runtimeRoot, 'state', 'agents'); config.workspaceTitle = 'QQ · ' + botId;
  // Never copy the primary config, credentials, role cards, account DB or QQ login data.
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  for (const dir of ['state', 'roles', 'audio']) fs.mkdirSync(path.join(runtimeRoot, dir), { mode: 0o700 });
  fs.writeFileSync(path.join(runtimeRoot, 'config.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.cpSync(path.join(codeRoot, 'dsh', 'agent-presets'), path.join(runtimeRoot, 'dsh', 'agent-presets'), { recursive: true, filter: file => !fs.lstatSync(file).isSymbolicLink() });
  fs.cpSync(path.join(codeRoot, 'plugins', 'qq-agent-presets'), path.join(runtimeRoot, 'plugins', 'qq-agent-presets'), { recursive: true, filter: file => !fs.lstatSync(file).isSymbolicLink() && path.basename(file) !== 'node_modules' });
  fs.writeFileSync(path.join(runtimeRoot, 'state', 'mode.json'), JSON.stringify({ mode: 'reserved2', closedAgentPreset: '' }) + '\n', { flag: 'wx', mode: 0o600 });
  return { botId, expectedQQ, runtimeRoot, consolePort, configuration: path.join(runtimeRoot, 'config.json'), next: '准备独立SnowLuma与DSH；用户自行扫码；配置新实例凭据后运行setup，再启动bridge并在Manager核验。' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = {};
    for (const value of process.argv.slice(2)) { const match = /^--([a-zA-Z]+)=(.+)$/.exec(value); if (!match) throw new Error('参数格式为 --botId=bot-b --runtimeRoot=绝对路径 --expectedQQ=QQ --consolePort=3111 --snowlumaHttpUrl=http://127.0.0.1:3200 --snowlumaWsUrl=ws://127.0.0.1:3201 --snowlumaHome=绝对路径 --dshBaseUrl=http://127.0.0.1:3280 --dshHome=绝对路径'); args[match[1]] = ['consolePort'].includes(match[1]) ? Number(match[2]) : match[2]; }
    console.log(JSON.stringify(createBotInstance(args), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
