import crypto from 'node:crypto';
import { normalizeBotId, normalizeBotQQ } from './runtime-paths.js';

const error = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = ['id', 'name', 'expectedQQ', 'actualQQ', 'port', 'machineToken', 'enabled', 'verifiedAt', 'deleted'];
const workerRoots = new Set(['status', 'sessions', 'role', 'role-mode', 'roles', 'conversation-roles', 'group-roles', 'group-budgets', 'conversation-budgets', 'conversation-sessions', 'mode', 'whitelist', 'tokens', 'security', 'dsh', 'social', 'socialV2', 'slang', 'stickers', 'voice', 'feedback', 'images', 'session']);
const secretFields = new Set(['token', 'machinetoken', 'consoletoken', 'accesstoken', 'wsaccesstoken', 'authtoken', 'agenttoken', 'cookie', 'authorization', 'password', 'secret', 'apikey', 'sessionhash']);
export function normalizeWorkerPort(value) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw error(400, 'worker 端口须为1024至65535的整数');
  return value;
}
function nameOf(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\x00-\x1f]/.test(value)) throw error(400, '机器人名称须为1至80字符');
  return value.trim();
}
function tokenOf(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw error(400, '机器令牌须为16至128位字母、数字、下划线或短横线');
  return value;
}
// Callers authenticate and authorize browser principals before entering this adapter.
// No caller headers or arbitrary endpoint URLs cross this boundary.
export function createBotManager({ read, write, primary = {}, fetchImpl = fetch, now = Date.now, timeoutMs = 5000, maxResponseBytes = 4 * 1024 * 1024 } = {}) {
  if (typeof read !== 'function' || typeof write !== 'function') throw new Error('bot registry read/write adapter required');
  const main = () => { const p = typeof primary === 'function' ? primary() : primary; return { id: 'primary', name: p.name || '主机器人', expectedQQ: p.expectedQQ || null, actualQQ: p.actualQQ || null, port: p.port || 3100, enabled: true, verifiedAt: p.verifiedAt || null, isPrimary: true, qqOnline: p.qqOnline === true, dshReady: p.dshReady === true }; };
  function load() {
    let raw;
    try { raw = read(); } catch { throw error(503, '机器人注册表无法读取，已停止改写'); }
    if (raw == null) return { version: 1, bots: {} };
    let data;
    try { data = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw); } catch { throw error(503, '机器人注册表损坏，已停止改写'); }
    if (!object(data) || data.version !== 1 || Object.keys(data).some(key => !['version', 'bots'].includes(key)) || !object(data.bots)) throw error(503, '机器人注册表格式或版本不支持，已停止改写');
    const qqs = new Set(), ports = new Set();
    const p = main();
    if (p.expectedQQ || p.actualQQ) qqs.add(normalizeBotQQ(p.expectedQQ || p.actualQQ));
    ports.add(p.port);
    for (const [id, row] of Object.entries(data.bots)) {
      try {
        if (id === 'primary' || !object(row) || fields.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !fields.includes(key)) || normalizeBotId(id) !== row.id || nameOf(row.name) !== row.name || normalizeBotQQ(row.expectedQQ) !== row.expectedQQ
            || !(row.actualQQ === null || normalizeBotQQ(row.actualQQ) === row.actualQQ) || normalizeWorkerPort(row.port) !== row.port || tokenOf(row.machineToken) !== row.machineToken
            || typeof row.enabled !== 'boolean' || typeof row.deleted !== 'boolean' || !(row.verifiedAt === null || (Number.isSafeInteger(row.verifiedAt) && row.verifiedAt >= 0)) || (row.deleted && row.enabled)) throw new Error();
        if (!row.deleted) { if (qqs.has(row.expectedQQ) || ports.has(row.port)) throw new Error(); qqs.add(row.expectedQQ); ports.add(row.port); }
      } catch { throw error(503, '机器人注册表包含无效或重复记录，已停止改写'); }
    }
    return data;
  }
  const save = data => { try { write(data); } catch { throw error(503, '机器人注册表写入冲突或失败，原配置未被重置'); } };
  const publicRow = row => { const { machineToken, deleted, ...safe } = row; return { ...safe, isPrimary: false }; };
  const get = (data, id) => {
    normalizeBotId(id);
    if (id === 'primary') throw error(400, '主机器人使用本地接口，不能修改其连接');
    const row = data.bots[id]; if (!row || row.deleted) throw error(404, '机器人不存在'); return row;
  };
  const known = data => [...new Set([main().actualQQ, main().expectedQQ, ...Object.values(data.bots).map(row => row.expectedQQ)].filter(Boolean).map(normalizeBotQQ))];
  function unique(data, row) {
    const p = main();
    if (Object.values(data.bots).some(other => other.id !== row.id && other.machineToken === row.machineToken)) throw error(409, '每个机器人必须使用独立机器令牌');
    if ([p.expectedQQ, p.actualQQ].filter(Boolean).map(normalizeBotQQ).includes(row.expectedQQ) || row.port === p.port
        || Object.values(data.bots).some(other => !other.deleted && other.id !== row.id && (other.expectedQQ === row.expectedQQ || other.port === row.port))) throw error(409, '同一QQ或端口已被其他机器人使用');
  }
  async function call(row, path, { method = 'GET', body } = {}) {
    let response;
    try { response = await fetchImpl('http://127.0.0.1:' + row.port + path, { method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'x-console-token': row.machineToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    catch { throw error(502, '机器人连接不可用，请检查该实例'); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw error(502, '机器人接口不允许重定向'); }
    const declared = Number(response.headers.get('content-length'));
    if (declared > maxResponseBytes) { await response.body?.cancel(); throw error(502, '机器人响应过大'); }
    let text = '', bytes = 0;
    try {
      const decoder = new TextDecoder();
      for await (const chunk of response.body || []) { bytes += chunk.byteLength; if (bytes > maxResponseBytes) throw new Error(); text += decoder.decode(chunk, { stream: true }); }
      text += decoder.decode();
      return { status: response.status, data: JSON.parse(text) };
    } catch { throw error(502, '机器人响应格式错误或过大'); }
  }
  async function identity(row) {
    const result = await call(row, '/api/instance'); const value = result.data;
    if (result.status !== 200 || !value?.ok || value.botId !== row.id || String(value.expectedQQ) !== row.expectedQQ || String(value.actualQQ) !== row.expectedQQ || value.qqOnline !== true || value.dshReady !== true) throw error(502, '机器人身份未知、不匹配或尚未就绪，已拒绝路由');
    return value;
  }
  async function syncPeers(data, candidate) {
    const qqs = known(data);
    for (const row of Object.values(data.bots).filter(row => !row.deleted && (row.enabled || row.id === candidate.id))) {
      await identity(row);
      const result = await call(row, '/api/instance/peers', { method: 'POST', body: { qqs } });
      if (result.status !== 200 || !result.data?.ok) throw error(502, '机器人互聊过滤同步失败，未启用新机器人');
    }
  }
  function unchanged(before, current) {
    if (['expectedQQ', 'port', 'machineToken'].some(key => before[key] !== current[key])) throw error(409, '核验期间连接配置已变更，请重新核验');
  }
  function browserData(value, secrets, depth = 0) {
    if (depth > 40) throw error(502, '机器人响应结构过深');
    if (typeof value === 'string') {
      for (const secret of secrets) value = value.replaceAll(secret, '[已隐藏凭据]');
      return value.replace(/(【会话令牌】)[A-Za-z0-9_-]{16,}/g, '$1[已隐藏凭据]');
    }
    if (Array.isArray(value)) return value.map(item => browserData(item, secrets, depth + 1));
    if (object(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !secretFields.has(key.toLowerCase())).map(([key, item]) => [key, browserData(item, secrets, depth + 1)]));
    return value;
  }
  async function verify(id) {
    const before = get(load(), id); await identity(before); await syncPeers(load(), before);
    const data = load(), row = get(data, id); unchanged(before, row);
    row.actualQQ = row.expectedQQ; row.verifiedAt = now(); save(data);
    return publicRow(row);
  }
  return {
    list() { return [main(), ...Object.values(load().bots).filter(row => !row.deleted).map(publicRow)]; },
    knownBotQQs() { return known(load()); },
    authenticateWorker(id, token) {
      if (typeof id !== 'string' || id === 'primary' || typeof token !== 'string' || token.length > 128) return false;
      const data = load(), row = data.bots[id];
      if (!row || row.deleted || !row.enabled || row.verifiedAt === null || row.actualQQ !== row.expectedQQ) return false;
      if (Object.values(data.bots).some(other => other.id !== id && other.machineToken === row.machineToken)) return false;
      const supplied = Buffer.from(token), expected = Buffer.from(row.machineToken);
      return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    },
    add(input) {
      if (!object(input) || Object.keys(input).some(key => !['id', 'name', 'expectedQQ', 'port', 'machineToken', 'enabled'].includes(key)) || (input.enabled !== undefined && input.enabled !== false)) throw error(400, '新增仅接受连接字段，核验后才能启用');
      const data = load(), id = normalizeBotId(input.id || 'bot-' + crypto.randomBytes(6).toString('hex'));
      if (id === 'primary' || Object.hasOwn(data.bots, id)) throw error(409, '机器人ID已存在或为保留名称');
      const row = { id, name: nameOf(input.name), expectedQQ: normalizeBotQQ(input.expectedQQ), actualQQ: null, port: normalizeWorkerPort(input.port), machineToken: tokenOf(input.machineToken), enabled: false, verifiedAt: null, deleted: false };
      unique(data, row); data.bots[id] = row; save(data); return publicRow(row);
    },
    async update(id, patch) {
      if (!object(patch) || Object.keys(patch).some(key => !['name', 'expectedQQ', 'port', 'machineToken', 'enabled'].includes(key))) throw error(400, '无效的机器人更新字段');
      let data = load(), row = get(data, id), previous = { ...row };
      if (patch.name !== undefined) row.name = nameOf(patch.name);
      if (patch.expectedQQ !== undefined) row.expectedQQ = normalizeBotQQ(patch.expectedQQ);
      if (patch.port !== undefined) row.port = normalizeWorkerPort(patch.port);
      if (patch.machineToken) row.machineToken = tokenOf(patch.machineToken);
      if (patch.enabled !== undefined) { if (typeof patch.enabled !== 'boolean') throw error(400, 'enabled 须为布尔值'); row.enabled = patch.enabled; }
      const changed = ['expectedQQ', 'port', 'machineToken'].some(key => row[key] !== previous[key]);
      if (changed) { row.enabled = false; row.actualQQ = null; row.verifiedAt = null; }
      unique(data, row);
      if (patch.enabled === true) {
        await identity(row); await syncPeers({ ...data, bots: { ...data.bots, [id]: row } }, row);
        const current = load(); if (JSON.stringify(previous) !== JSON.stringify(get(current, id))) throw error(409, '核验期间机器人记录已修改，请重试');
        row.enabled = true; row.actualQQ = row.expectedQQ; row.verifiedAt = now(); current.bots[id] = row; data = current;
      }
      save(data); return publicRow(row);
    },
    verify,
    remove(id) { const data = load(), row = get(data, id); if (row.enabled) throw error(409, '请先停用机器人'); row.deleted = true; save(data); return { id, deleted: true }; },
    async proxy(id, options = {}) {
      if (Object.keys(options).some(key => !['method', 'path', 'body'].includes(key))) throw error(400, '禁止转发调用方请求头');
      const { method = 'GET', path, body } = options;
      if (!['GET', 'POST', 'DELETE', 'PATCH'].includes(method) || typeof path !== 'string' || path.length > 12000 || /[\x00-\x20\\#]/.test(path)) throw error(400, '无效的实例接口路径');
      const pathname = path.split('?')[0];
      if (!/^\/api\/[a-zA-Z0-9/_-]+$/.test(pathname) || pathname.includes('//') || pathname.includes('..')) throw error(400, '无效的实例接口路径');
      const internal = ['/api/internal/member', '/api/instance/peers'].includes(pathname);
      if (!internal && /^\/api\/(?:auth|bots|instance|internal)(?:\/|$)/.test(pathname)) throw error(403, '禁止代理此管理命名空间');
      if (!internal && (!workerRoots.has(pathname.split('/')[2]) || ['/api/security/console-token', '/api/security/token', '/api/socialV2/prompt'].includes(pathname))) throw error(403, '此实例接口未开放给统一控制台');
      const data = load(), row = get(data, id); if (!row.enabled || !row.verifiedAt) throw error(409, '机器人尚未核验启用');
      if (Object.values(data.bots).some(other => other.id !== id && other.machineToken === row.machineToken)) throw error(409, '机器令牌与其他机器人重复，已停止转发');
      await identity(row);
      const current = get(load(), id); unchanged(row, current); if (!current.enabled) throw error(409, '机器人已停用');
      const result = await call(current, path, { method, body });
      return { status: result.status, data: browserData(result.data, [...new Set([current.machineToken, ...Object.values(load().bots).map(row => row.machineToken)])]) };
    },
  };
}
