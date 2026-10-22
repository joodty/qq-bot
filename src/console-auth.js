import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'qq_console_session';
const DAY = 86400000;
const HASH = /^[a-f0-9]{64}$/;
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key)) && fields.every(key => Object.hasOwn(value, key));
const positive = value => Number.isSafeInteger(value) && value > 0;
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');

export function normalizeConsoleScopeKey(value) {
  if (typeof value !== 'string') throw fail(400, '会话范围须为 group:群号 或 private:QQ号');
  const match = /^(group|private):(\d+)$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0) throw fail(400, '会话范围须为 group:群号 或 private:QQ号');
  return match[1] + ':' + Number(match[2]);
}
export function canAccessConversation(principal, key, botId = 'primary') {
  if (!principal) return false;
  if (principal.role === 'admin') return true;
  if (principal.role === 'user' && principal.ownedBotIds?.includes(botId)) {
    try { normalizeConsoleScopeKey(key); return true; } catch { return false; }
  }
  try { return principal.role === 'user' && consoleBotScopes(principal).some(scope => scope.botId === botId && scope.key === normalizeConsoleScopeKey(key)); }
  catch { return false; }
}
function usernameOf(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/.test(value)) throw fail(400, '账号须为3至32位字母、数字、点、下划线或短横线');
  return value.toLowerCase();
}
function passwordOf(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128 || !value.trim()) throw fail(400, '密码须为10至128个字符');
  return value;
}
function scopesOf(value) {
  if (!Array.isArray(value) || value.length > 500) throw fail(400, '会话范围须为不超过500项的数组');
  return [...new Set(value.map(normalizeConsoleScopeKey))].sort();
}
function botScopesOf(value) {
  if (!Array.isArray(value) || value.length > 1000) throw fail(400, '机器人会话范围须为不超过1000项的数组');
  const scopes = value.map(scope => {
    if (!exact(scope, ['botId', 'key']) || !/^[a-zA-Z0-9_-]{1,64}$/.test(scope.botId)) throw fail(400, '无效机器人会话范围');
    return { botId: scope.botId, key: normalizeConsoleScopeKey(scope.key) };
  });
  return [...new Map(scopes.map(scope => [JSON.stringify([scope.botId, scope.key]), scope])).values()]
    .sort((a, b) => a.botId.localeCompare(b.botId) || a.key.localeCompare(b.key));
}
export function consoleBotScopes(user) {
  return botScopesOf([...(user?.conversationKeys || []).map(key => ({ botId: 'primary', key })), ...(user?.botScopes || [])]);
}
function publicUser(user) {
  const { id, username, role, disabled, conversationKeys, createdAt, updatedAt } = user;
  const botScopes = consoleBotScopes(user);
  return { id, username, role, disabled, conversationKeys: botScopes.filter(scope => scope.botId === 'primary').map(scope => scope.key), botScopes, createdAt, updatedAt };
}
function cookieValue(header) {
  if (typeof header !== 'string' || header.length > 8192) return null;
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(COOKIE + '='));
  if (values.length !== 1) return null;
  const value = values[0].slice(COOKIE.length + 1);
  return /^[a-zA-Z0-9_-]{43}$/.test(value) ? value : null;
}

/** Fail closed on damaged/unknown storage. No account or session secret is returned to APIs. */
export function createConsoleAuth({ file, now = () => Date.now(), sessionTtlMs = 30 * DAY, storage, allowRegistration = true } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('console auth file required');
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 60000 || sessionTtlMs > 90 * DAY) throw new Error('invalid session TTL');
  if (typeof allowRegistration !== 'boolean') throw new Error('allowRegistration must be boolean');
  let queue = Promise.resolve();
  const revision = Symbol('storage revision');
  const limits = new Map();
  const dummySalt = crypto.randomBytes(16).toString('hex');
  const dummyKey = crypto.randomBytes(64).toString('hex');
  const corrupt = () => fail(503, '账号存储损坏或版本不受支持，已停止登录及改写；请管理员备份并修复');
  function read() {
    let text;
    try { text = storage ? storage.readText(file) : fs.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return Object.assign({ version: 1, users: [], sessions: [] }, { [revision]: null }); throw corrupt(); }
    let state;
    try { state = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw corrupt(); }
    if (!exact(state, ['version', 'users', 'sessions']) || state.version !== 1 || !Array.isArray(state.users) || !Array.isArray(state.sessions)
      || !state.users.length || state.users.length > 200 || state.sessions.length > 1000) throw corrupt();
    const ids = new Set(), names = new Set(), hashes = new Set(); let admins = 0;
    for (const user of state.users) {
      if (!exact(user, ['id', 'username', 'role', 'disabled', 'conversationKeys', 'password', 'passwordVersion', 'createdAt', 'updatedAt', ...(Object.hasOwn(user, 'botScopes') ? ['botScopes'] : [])])
        || !/^[a-f0-9]{32}$/.test(user.id) || ids.has(user.id) || typeof user.disabled !== 'boolean'
        || !['admin', 'user'].includes(user.role) || !positive(user.createdAt) || !positive(user.updatedAt) || !positive(user.passwordVersion)
        || !exact(user.password, ['algorithm', 'salt', 'key']) || user.password.algorithm !== 'scrypt-v1'
        || !/^[a-f0-9]{32}$/.test(user.password.salt) || !/^[a-f0-9]{128}$/.test(user.password.key)) throw corrupt();
      try { if (usernameOf(user.username) !== user.username || names.has(user.username) || JSON.stringify(scopesOf(user.conversationKeys)) !== JSON.stringify(user.conversationKeys)) throw corrupt(); }
      catch { throw corrupt(); }
      if (Object.hasOwn(user, 'botScopes')) {
        try { if (JSON.stringify(botScopesOf(user.botScopes)) !== JSON.stringify(user.botScopes)) throw corrupt(); } catch { throw corrupt(); }
      }
      if (user.role === 'admin') { admins++; if (user.disabled || consoleBotScopes(user).length) throw corrupt(); }
      ids.add(user.id); names.add(user.username);
    }
    if (admins !== 1) throw corrupt();
    for (const session of state.sessions) {
      if (!exact(session, ['hash', 'userId', 'passwordVersion', 'createdAt', 'expiresAt']) || !HASH.test(session.hash) || hashes.has(session.hash)
        || !ids.has(session.userId) || !positive(session.passwordVersion) || !positive(session.createdAt) || !positive(session.expiresAt)
        || session.expiresAt <= session.createdAt || session.expiresAt - session.createdAt > 90 * DAY) throw corrupt();
      hashes.add(session.hash);
    }
    state[revision] = text;
    return state;
  }
  function write(state) {
    state.sessions = state.sessions.filter(session => session.expiresAt > now()).sort((a, b) => b.createdAt - a.createdAt).slice(0, 1000);
    if (storage) { const text = JSON.stringify(state, null, 2) + '\n'; storage.writeText(file, text, state[revision]); state[revision] = text; return; }
    let latest;
    try { latest = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw corrupt(); latest = null; }
    if (latest !== state[revision]) throw fail(503, '账号存储在操作期间发生变化，已停止改写，请重新操作');
    state.sessions = state.sessions.filter(session => session.expiresAt > now()).sort((a, b) => b.createdAt - a.createdAt).slice(0, 1000);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + crypto.randomBytes(12).toString('hex') + '.tmp');
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(state, null, 2) + '\n', 'utf8'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
    } catch { throw fail(503, '账号存储写入失败，原数据未被重置'); }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
  }
  function transaction(fn) {
    const work = queue.then(async () => { const state = read(); return fn(state); });
    queue = work.catch(() => {}); return work;
  }
  async function passwordHash(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = await scrypt(passwordOf(password), salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return { algorithm: 'scrypt-v1', salt, key: derived.toString('hex') };
  }
  async function passwordMatches(password, stored) {
    const valid = typeof password === 'string' && password.length >= 1 && password.length <= 128;
    const derived = await scrypt(valid ? password : 'invalid-password', stored?.salt || dummySalt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return crypto.timingSafeEqual(derived, Buffer.from(stored?.key || dummyKey, 'hex')) && valid;
  }
  function rate(remote, username = '') {
    const t = now();
    for (const [key, value] of limits) if (t - value.start >= 15 * 60000) limits.delete(key);
    const keys = [['global', 120], ['ip:' + String(remote || 'unknown').slice(0, 150), 30], ['account:' + String(username).toLowerCase().slice(0, 128), 12]];
    for (const [key, max] of keys) if ((limits.get(key)?.count || 0) >= max) throw fail(429, '登录尝试过多，请15分钟后再试');
    for (const [key] of keys) { const value = limits.get(key) || { start: t, count: 0 }; value.count++; limits.set(key, value); }
  }
  function sessionFor(state, user) {
    const token = crypto.randomBytes(32).toString('base64url');
    state.sessions = state.sessions.filter(s => s.userId !== user.id || s.expiresAt > now()).sort((a, b) => b.createdAt - a.createdAt);
    const own = state.sessions.filter(s => s.userId === user.id);
    for (const old of own.slice(9)) state.sessions = state.sessions.filter(s => s !== old);
    state.sessions.push({ hash: hashToken(token), userId: user.id, passwordVersion: user.passwordVersion, createdAt: now(), expiresAt: now() + sessionTtlMs });
    return { token, user: publicUser(user) };
  }
  function current(state, principal, { admin = false } = {}) {
    if (!principal) throw fail(401, '请先登录');
    if (principal.kind === 'token') { if (admin) return null; throw fail(403, '此操作需要账号登录'); }
    const user = state.users.find(u => u.id === principal.id && !u.disabled && u.passwordVersion === principal.passwordVersion);
    const session = state.sessions.find(s => s.hash === principal.sessionHash && s.userId === user?.id && s.expiresAt > now());
    if (!user || !session) throw fail(401, '登录已失效，请重新登录');
    if (admin && user.role !== 'admin') throw fail(403, '仅管理员可管理账号');
    return user;
  }
  return {
    configured() { return read().users.length > 0; },
    registrationEnabled() { return allowRegistration && read().users.length > 0; },
    status(principal) { const state = read(); const loggedIn = principal?.kind === 'session'; return { ok: true, configured: state.users.length > 0, authenticated: loggedIn, user: loggedIn ? publicUser(principal) : null }; },
    authenticate(header) {
      const state = read(), token = cookieValue(header); if (!token) return null;
      const hashed = hashToken(token);
      const session = state.sessions.find(s => s.hash === hashed && s.expiresAt > now());
      const user = session && state.users.find(u => u.id === session.userId && !u.disabled && u.passwordVersion === session.passwordVersion);
      return user ? { ...publicUser(user), kind: 'session', passwordVersion: user.passwordVersion, sessionHash: hashed } : null;
    },
    cookie(token, secure = false) { return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionTtlMs / 1000)}${secure ? '; Secure' : ''}`; },
    clearCookie(secure = false) { return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`; },
    async bootstrap({ username = 'admin', password }, remote) {
      rate(remote, username);
      return transaction(async state => {
        if (state.users.length) throw fail(409, '管理员账号已经激活，请使用账号密码登录');
        const user = { id: crypto.randomBytes(16).toString('hex'), username: usernameOf(username), role: 'admin', disabled: false, conversationKeys: [], password: await passwordHash(password), passwordVersion: 1, createdAt: now(), updatedAt: now() };
        state.users.push(user); const result = sessionFor(state, user); write(state); return result;
      });
    },
    async login({ username, password }, remote) {
      rate(remote, username);
      return transaction(async state => {
        let name; try { name = usernameOf(username); } catch {}
        const user = state.users.find(u => u.username === name);
        const correct = await passwordMatches(password, user?.password);
        if (!user || user.disabled || !correct) throw fail(401, '账号或密码错误');
        const result = sessionFor(state, user); write(state); return result;
      });
    },
    async register(input, remote) {
      rate(remote, input?.username);
      if (!allowRegistration) throw fail(403, '普通账号注册暂未开放');
      if (!exact(input, ['username', 'password'])) throw fail(400, '注册只接受账号名与密码，不能指定身份或权限');
      const name = usernameOf(input.username), password = passwordOf(input.password);
      return transaction(async state => {
        if (!state.users.length) throw fail(409, '平台管理员尚未初始化，暂不能注册');
        if (state.users.length >= 200) throw fail(409, '账号数量已达上限');
        if (state.users.some(user => user.username === name)) throw fail(409, '账号名已存在');
        const user = { id: crypto.randomBytes(16).toString('hex'), username: name, role: 'user', disabled: false,
          conversationKeys: [], botScopes: [], password: await passwordHash(password), passwordVersion: 1,
          createdAt: now(), updatedAt: now() };
        state.users.push(user); const result = sessionFor(state, user);
        try { write(state); }
        catch (error) {
          // A separate auth instance may have won the same username during scrypt.
          // Re-read strictly; future/corrupt state still fails closed instead of retrying a write.
          if (read().users.some(existing => existing.username === name)) throw fail(409, '账号名已存在');
          throw error;
        }
        return result;
      });
    },
    list(principal) { const state = read(); current(state, principal, { admin: true }); return state.users.map(publicUser); },
    async create(principal, { username, password, conversationKeys = [], botScopes = [] }) {
      return transaction(async state => {
        current(state, principal, { admin: true });
        if (!state.users.length) throw fail(409, '请先激活管理员账号');
        if (state.users.length >= 200) throw fail(409, '账号数量已达上限');
        const name = usernameOf(username), scopes = botScopesOf([...scopesOf(conversationKeys).map(key => ({ botId: 'primary', key })), ...botScopesOf(botScopes)]);
        if (state.users.some(u => u.username === name)) throw fail(409, '账号名已存在');
        const user = { id: crypto.randomBytes(16).toString('hex'), username: name, role: 'user', disabled: false, conversationKeys: scopes.filter(scope => scope.botId === 'primary').map(scope => scope.key), botScopes: scopes, password: await passwordHash(password), passwordVersion: 1, createdAt: now(), updatedAt: now() };
        state.users.push(user); write(state); return publicUser(user);
      });
    },
    async update(principal, patch) {
      return transaction(async state => {
        current(state, principal, { admin: true });
        if (!patch || Object.keys(patch).some(k => !['id', 'username', 'password', 'conversationKeys', 'botScopes', 'disabled'].includes(k))) throw fail(400, '不支持的账号修改字段');
        const user = state.users.find(u => u.id === patch.id);
        if (!user) throw fail(404, '账号不存在');
        if (user.role === 'admin') throw fail(403, '唯一管理员不可改名、禁用或降级；请使用修改自己密码');
        if (Object.hasOwn(patch, 'username')) {
          const name = usernameOf(patch.username);
          if (state.users.some(u => u.id !== user.id && u.username === name)) throw fail(409, '账号名已存在');
          user.username = name;
        }
        if (Object.hasOwn(patch, 'disabled')) { if (typeof patch.disabled !== 'boolean') throw fail(400, 'disabled 必须为布尔值'); user.disabled = patch.disabled; }
        if (Object.hasOwn(patch, 'conversationKeys') || Object.hasOwn(patch, 'botScopes')) {
          const scopes = Object.hasOwn(patch, 'botScopes') ? botScopesOf(patch.botScopes) : consoleBotScopes(user).filter(scope => scope.botId !== 'primary');
          user.botScopes = botScopesOf([...scopes, ...(Object.hasOwn(patch, 'conversationKeys') ? scopesOf(patch.conversationKeys).map(key => ({ botId: 'primary', key })) : [])]);
          user.conversationKeys = user.botScopes.filter(scope => scope.botId === 'primary').map(scope => scope.key);
        }
        if (Object.hasOwn(patch, 'password')) { user.password = await passwordHash(patch.password); user.passwordVersion++; }
        user.updatedAt = now(); state.sessions = state.sessions.filter(s => s.userId !== user.id); write(state); return publicUser(user);
      });
    },
    async changePassword(principal, { currentPassword, newPassword }, remote) {
      rate(remote, principal?.username);
      return transaction(async state => {
        const user = current(state, principal);
        if (!await passwordMatches(currentPassword, user.password)) throw fail(401, '当前密码错误');
        user.password = await passwordHash(newPassword); user.passwordVersion++; user.updatedAt = now();
        state.sessions = state.sessions.filter(s => s.userId !== user.id); write(state); return { ok: true, reauthenticate: true };
      });
    },
    async logout(principal) {
      return transaction(state => { if (principal?.sessionHash) { state.sessions = state.sessions.filter(s => s.hash !== principal.sessionHash); write(state); } return { ok: true }; });
    }
  };
}

export function validateConsoleAuthText(text) {
  createConsoleAuth({ file: 'validation-only', storage: { readText: () => text } }).configured();
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}
