import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { getRuntimePaths, validateRuntimeIdentity } from '../src/runtime-paths.js';
import { createBotInstance } from './create-bot-instance.mjs';

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-runtime-isolation-'));
let passed = 0;
function test(name, run) { run(); passed++; console.log('PASS', name); }
try {
  test('without environment overrides primary code and runtime paths remain unchanged', () => {
    const p = getRuntimePaths({ codeRoot, env: {}, homeDir: temp });
    assert.equal(p.RUNTIME_ROOT, codeRoot); assert.equal(p.BOT_ID, 'primary'); assert.equal(p.DSH_HOME, path.join(temp, '.dsh'));
    assert.equal(validateRuntimeIdentity({}, p).botId, 'primary');
  });
  const instances = [];
  test('two instances use template-only configuration, fresh machine tokens and empty state and roles', () => {
    for (const [suffix, offset] of [['a', 0], ['b', 10]]) {
      const runtimeRoot = path.join(temp, suffix), dshHome = path.join(temp, 'dsh-' + suffix), snowlumaHome = path.join(temp, 'snow-' + suffix);
      const result = createBotInstance({ codeRoot, runtimeRoot, botId: 'bot-' + suffix, expectedQQ: offset + 222, consolePort: 3310 + offset, dshHome, snowlumaHome, dshBaseUrl: 'http://127.0.0.1:' + (3380 + offset), snowlumaHttpUrl: 'http://127.0.0.1:' + (3300 + offset), snowlumaWsUrl: 'ws://127.0.0.1:' + (3301 + offset) });
      const config = JSON.parse(fs.readFileSync(result.configuration)); instances.push({ result, config });
      assert.deepEqual(config.allow, { groups: [], private: [] }); assert.equal(config.allowAllWhenEmpty, false); assert.equal(config.ownerQQ, null);
      assert.equal(config.managerUrl, 'http://127.0.0.1:3100');
      assert.equal(config.dsh.authToken, ''); assert.equal(config.snowluma.accessToken, ''); assert.equal(config.snowluma.followDiscoveredEndpoint, false);
      assert.deepEqual(fs.readdirSync(path.join(runtimeRoot, 'roles')), []);
      assert.deepEqual(fs.readdirSync(path.join(runtimeRoot, 'state')), ['mode.json']);
      assert.equal(fs.existsSync(dshHome), false); assert.equal(fs.existsSync(snowlumaHome), false);
      assert.equal(JSON.stringify(result).includes(config.consoleToken), false);
    }
    assert.notEqual(instances[0].config.consoleToken, instances[1].config.consoleToken);
  });
  test('identity mismatch, unsafe shared runtime and shared DSH home refuse startup', () => {
    const i = instances[0], env = { QQ_BRIDGE_RUNTIME_ROOT: i.result.runtimeRoot, QQ_BRIDGE_BOT_ID: 'bot-a', QQ_BRIDGE_EXPECTED_QQ: '222', DSH_HOME: i.config.dsh.homeDir };
    const p = getRuntimePaths({ codeRoot, env }); validateRuntimeIdentity(i.config, p);
    assert.throws(() => validateRuntimeIdentity({ ...i.config, botId: 'bot-b' }, p));
    assert.throws(() => validateRuntimeIdentity({ ...i.config, expectedQQ: '333' }, p));
    assert.throws(() => getRuntimePaths({ codeRoot, env: { QQ_BRIDGE_BOT_ID: 'bot-a' } }));
    assert.throws(() => getRuntimePaths({ codeRoot, env: { ...env, DSH_HOME: path.join(os.homedir(), '.dsh') } }));
    for (const managerUrl of ['https://evil.invalid', 'http://127.0.0.1:3100/path', 'http://127.0.0.1:3100@evil.invalid', 'http://127.0.0.1:3111']) {
      assert.throws(() => createBotInstance({ codeRoot, runtimeRoot: path.join(temp,'invalid'), botId:'bot-invalid', expectedQQ:'444', consolePort:3391,
        dshHome:path.join(temp,'invalid-dsh'), snowlumaHome:path.join(temp,'invalid-snow'), managerUrl }), /managerUrl/);
    }
  });
  test('worker setup only writes its own preset bundle/home and passes runtime identity to MCP entries', () => {
    const i = instances[0];
    const source = fs.readFileSync(path.join(codeRoot, 'plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml'), 'utf8');
    const processResult = spawnSync(process.execPath, ['scripts/run-bot-instance.mjs', i.result.runtimeRoot, 'setup'], { cwd: codeRoot, env: { ...process.env, QQ_BRIDGE_SKIP_DSH_INSTALL: '1' }, encoding: 'utf8' });
    assert.equal(processResult.status, 0, processResult.stderr + processResult.stdout);
    const mcp = fs.readFileSync(path.join(i.config.dsh.homeDir, 'profiles/web/cordis.patch.yml'), 'utf8');
    assert.ok(mcp.includes('run-bot-instance.mjs')); assert.ok(mcp.includes(i.result.runtimeRoot.replaceAll("'", "''")));
    assert.equal(fs.readFileSync(path.join(codeRoot, 'plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml'), 'utf8'), source);
    assert.equal(fs.existsSync(instances[1].config.dsh.homeDir), false);
  });
  console.log(JSON.stringify({ passed, liveQqMessages: 0, liveModelRequests: 0 }));
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
