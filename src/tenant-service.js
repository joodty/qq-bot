import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TENANT_ENDPOINT = 'https://api.deepseek.com';
export const TENANT_MODELS = Object.freeze(['deepseek-flash', 'deepseek-v4-pro']);
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const partial = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const own = (value, key) => Object.hasOwn(value, key);
const clone = value => JSON.parse(JSON.stringify(value));
const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const bot = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const qq = value => typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
const key = value => typeof value === 'string' && /^(group|private):[1-9]\d*$/.test(value) && qq(value.split(':')[1]);
const time = value => Number.isSafeInteger(value) && value > 0;
const version = value => Number.isSafeInteger(value) && value >= 1;
const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000 && Math.abs(value * 1_000_000 - Math.round(value * 1_000_000)) < 0.00001;
const name = value => typeof value === 'string' && value === value.trim() && value.length >= 1 && value.length <= 80 && !/[\x00-\x1f\x7f]/.test(value);
const apiKey = value => typeof value === 'string' && /^sk-[A-Za-z0-9_-]{16,256}$/.test(value);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const fresh = () => ({ version: 1, masterKeyId: null,
  trial: { version: 1, enabled: true, dailyLimitCny: 0.1, totalDailyLimitCny: 1 },
  profiles: [], bindings: [], challenges: [], ownedBots: [], delegations: [], funding: [], trialOverrides: [] });

/** Validate the full tenant original before adopting it or updating any relational projection. */
export function validateTenantText(text) {
  const bad = () => { throw fail(503, '用户空间存储格式、版本或引用不受支持，已停止改写'); };
  let data; try { if (typeof text !== 'string' || Buffer.byteLength(text) > 16 * 1024 * 1024) bad(); data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { bad(); }
  if (!exact(data, ['version', 'masterKeyId', 'trial', 'profiles', 'bindings', 'challenges', 'ownedBots', 'delegations', 'funding', 'trialOverrides'])
    || data.version !== 1 || !(data.masterKeyId === null || hash(data.masterKeyId))
    || !exact(data.trial, ['version', 'enabled', 'dailyLimitCny', 'totalDailyLimitCny']) || !version(data.trial.version)
    || typeof data.trial.enabled !== 'boolean' || !money(data.trial.dailyLimitCny) || !money(data.trial.totalDailyLimitCny)) bad();
  for (const field of ['profiles', 'bindings', 'challenges', 'ownedBots', 'delegations', 'funding', 'trialOverrides']) if (!Array.isArray(data[field]) || data[field].length > 10000) bad();
  const profiles = new Map(), boundQqs = new Map(), boundUsers = new Set(), bots = new Map(), challengeIds = new Set(), challengeHashes = new Set(), funding = new Set(), scopes = new Set(), trialUsers = new Set();
  for (const p of data.profiles) {
    if (!exact(p, ['id', 'ownerUserId', 'name', 'model', 'version', 'provider', 'enabled', 'deleted', 'encrypted', 'createdAt', 'updatedAt', 'invalidReason'])
      || !id(p.id) || profiles.has(p.id) || !id(p.ownerUserId) || !name(p.name) || !TENANT_MODELS.includes(p.model) || !version(p.version)
      || p.provider !== 'deepseek' || typeof p.enabled !== 'boolean' || typeof p.deleted !== 'boolean' || p.deleted && p.enabled
      || !time(p.createdAt) || !time(p.updatedAt) || p.updatedAt < p.createdAt || ![null, 'provider-rejected'].includes(p.invalidReason)
      || !exact(p.encrypted, ['version', 'iv', 'tag', 'ciphertext']) || p.encrypted.version !== 1 || typeof p.encrypted.iv !== 'string' || !/^[a-f0-9]{24}$/.test(p.encrypted.iv)
      || typeof p.encrypted.tag !== 'string' || !/^[a-f0-9]{32}$/.test(p.encrypted.tag) || typeof p.encrypted.ciphertext !== 'string' || !/^(?:[a-f0-9]{2}){19,259}$/.test(p.encrypted.ciphertext)
      || data.masterKeyId === null) bad();
    profiles.set(p.id, p);
  }
  for (const row of data.bindings) {
    if (!exact(row, ['qq', 'userId', 'verifiedAt']) || !qq(row.qq) || !id(row.userId) || !time(row.verifiedAt) || boundQqs.has(row.qq) || boundUsers.has(row.userId)) bad();
    boundQqs.set(row.qq, row.userId); boundUsers.add(row.userId);
  }
  for (const row of data.challenges) {
    if (!exact(row, ['id', 'userId', 'qq', 'codeHash', 'createdAt', 'expiresAt', 'attempts', 'consumedAt']) || !id(row.id) || challengeIds.has(row.id)
      || !id(row.userId) || !qq(row.qq) || !hash(row.codeHash) || challengeHashes.has(row.codeHash) || !time(row.createdAt) || !time(row.expiresAt) || row.expiresAt <= row.createdAt
      || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || row.attempts > 5 || !(row.consumedAt === null || time(row.consumedAt)) || row.consumedAt !== null && row.consumedAt < row.createdAt) bad();
    challengeIds.add(row.id); challengeHashes.add(row.codeHash);
  }
  for (const row of data.ownedBots) {
    if (!exact(row, ['botId', 'ownerUserId', 'name', 'qq', 'version', 'verifiedAt', 'createdAt', 'updatedAt']) || !bot(row.botId) || row.botId === 'primary'
      || bots.has(row.botId) || [...bots.values()].some(other => other.qq === row.qq) || !id(row.ownerUserId) || !name(row.name) || !qq(row.qq)
      || !version(row.version) || !time(row.verifiedAt) || !time(row.createdAt) || !time(row.updatedAt) || row.updatedAt < row.createdAt) bad();
    bots.set(row.botId, row);
  }
  for (const row of data.delegations) {
    if (!exact(row, ['botId', 'userId', 'keys', 'version', 'updatedAt']) || !bots.has(row.botId) || !id(row.userId) || !version(row.version) || !time(row.updatedAt)
      || !Array.isArray(row.keys) || row.keys.length > 1000 || row.keys.some(value => !key(value)) || JSON.stringify(row.keys) !== JSON.stringify([...new Set(row.keys)].sort())
      || scopes.has(row.botId + '/' + row.userId)) bad();
    scopes.add(row.botId + '/' + row.userId);
  }
  for (const row of data.funding) {
    if (!exact(row, ['botId', 'key', 'ownerUserId', 'profileId', 'version', 'updatedAt']) || !bot(row.botId) || !id(row.ownerUserId) || !version(row.version) || !time(row.updatedAt)
      || !(row.profileId === null || profiles.get(row.profileId)?.ownerUserId === row.ownerUserId)
      || (row.botId === 'primary' ? !key(row.key) || !row.key.startsWith('private:') || boundQqs.get(row.key.slice(8)) !== row.ownerUserId : row.key !== null || bots.get(row.botId)?.ownerUserId !== row.ownerUserId)
      || funding.has(row.botId + '/' + row.key)) bad();
    funding.add(row.botId + '/' + row.key);
  }
  for (const row of data.trialOverrides) {
    if (!exact(row, ['userId', 'enabled', 'dailyLimitCny', 'version', 'updatedAt']) || !id(row.userId) || typeof row.enabled !== 'boolean'
      || !money(row.dailyLimitCny) || !version(row.version) || !time(row.updatedAt) || trialUsers.has(row.userId)) bad();
    trialUsers.add(row.userId);
  }
  return data;
}

export function createTenantService({ storage, file, masterKeyFile, now = Date.now, accountExists } = {}) {
  if (!storage?.transaction || !storage?.readText || !storage?.writeText || !file || !masterKeyFile) throw fail(503, '用户空间需要事务存储和独立主密钥路径');
  const exists = accountExists || (userId => !!storage.db?.prepare('SELECT id FROM accounts WHERE id=? AND disabled=0').get(userId));
  const activeAccount = userId => { const found = exists(userId); if (found !== true) throw fail(403, '账号不存在或已停用'); };
  function principalOf(principal) {
    if (!principal || !id(principal.id) || !['admin', 'user'].includes(principal.role) || principal.disabled) throw fail(403, '请先使用账号登录用户空间');
    activeAccount(principal.id); return principal;
  }
  function load() {
    let raw; try { raw = storage.readText(file); } catch (error) { if (error.code !== 'ENOENT') throw error; raw = null; }
    return { raw, data: raw === null ? fresh() : validateTenantText(raw) };
  }
  function master(data, create = false) {
    let value;
    try {
      const info = fs.lstatSync(masterKeyFile); if (!info.isFile() || info.isSymbolicLink()) throw fail(503, '用户密钥文件类型异常');
      value = fs.readFileSync(masterKeyFile); if (value.length !== 32) throw fail(503, '用户主密钥损坏，禁止覆盖');
      if (process.platform !== 'win32' && (info.mode & 0o077)) throw fail(503, '用户主密钥权限须为0600');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (data.masterKeyId !== null || data.profiles.some(profile => profile.encrypted !== null)) throw fail(503, '用户主密钥缺失，禁止生成新密钥覆盖已有密文');
      if (!create) return null;
      fs.mkdirSync(path.dirname(masterKeyFile), { recursive: true }); let fd;
      try { fd = fs.openSync(masterKeyFile, 'wx', 0o600); value = crypto.randomBytes(32); fs.writeFileSync(fd, value); fs.fsyncSync(fd); }
      catch (error) { if (error.code === 'EEXIST') return master(data, false); throw error; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    const fingerprint = digest(value);
    if (data.masterKeyId !== null && data.masterKeyId !== fingerprint) throw fail(503, '用户主密钥与密文不匹配，已停止自费调用');
    if (create) data.masterKeyId = fingerprint; return value;
  }
  function transact(run) {
    return storage.transaction(() => {
      const { raw, data } = load(), at = now(); if (!time(at)) throw fail(503, '用户空间时间无效');
      if (data.masterKeyId !== null) master(data);
      const result = run(data, at), next = JSON.stringify(data, null, 2) + '\n';
      if (next !== raw) { validateTenantText(next); storage.writeText(file, next, raw); }
      return result;
    });
  }
  function encrypt(data, p, value) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', master(data, true), iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from('qq-tenant-profile-v1/' + p.ownerUserId + '/' + p.id));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { version: 1, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') };
  }
  function decrypt(data, p) {
    try {
      const cipher = crypto.createDecipheriv('aes-256-gcm', master(data), Buffer.from(p.encrypted.iv, 'hex'), { authTagLength: 16 });
      cipher.setAAD(Buffer.from('qq-tenant-profile-v1/' + p.ownerUserId + '/' + p.id)); cipher.setAuthTag(Buffer.from(p.encrypted.tag, 'hex'));
      const value = Buffer.concat([cipher.update(Buffer.from(p.encrypted.ciphertext, 'hex')), cipher.final()]).toString('utf8');
      if (!apiKey(value)) throw new Error(); return value;
    } catch { throw fail(503, '用户自费密钥无法解密，已停止调用，不会改用平台密钥'); }
  }
  function owned(data, botId, principal) {
    const row = data.ownedBots.find(row => row.botId === botId); if (!row) throw fail(404, '自有机器人不存在');
    if (principal.role !== 'admin' && row.ownerUserId !== principal.id) throw fail(403, '没有该机器人的所有者权限'); return row;
  }
  const publicProfile = p => ({ id: p.id, name: p.name, model: p.model, provider: p.provider, version: p.version, configured: true, enabled: p.enabled, invalidReason: p.invalidReason, createdAt: p.createdAt, updatedAt: p.updatedAt });
  function trialFor(data, userId) {
    const override = data.trialOverrides.find(row => row.userId === userId);
    return { ...clone(data.trial), enabled: data.trial.enabled && (override?.enabled ?? true), dailyLimitCny: override?.dailyLimitCny ?? data.trial.dailyLimitCny,
      ...(override ? { overrideVersion: override.version } : {}) };
  }
  function fundingValue(data, row, source) {
    const p = data.profiles.find(p => p.id === row.profileId);
    if (!p || p.deleted || !p.enabled || p.ownerUserId !== row.ownerUserId) throw fail(503, '自费配置已失效，已停止调用，不会改用平台密钥');
    activeAccount(p.ownerUserId);
    return { mode: 'byok', source, ownerUserId: p.ownerUserId, profileId: p.id, credentialVersion: p.version,
      identity: p.ownerUserId + ':' + p.id + ':' + p.version, provider: 'deepseek', endpoint: TENANT_ENDPOINT, model: p.model, apiKey: decrypt(data, p) };
  }
  const expected = (supplied, actual) => { if (!Number.isSafeInteger(supplied) || supplied !== actual) throw fail(409, '配置已变更，请刷新后重试'); };
  transact(() => {});
  return {
    overview(principal) {
      principalOf(principal);
      return transact(data => {
        const binding = data.bindings.find(row => row.userId === principal.id) ?? null;
        const privateFunding = binding ? data.funding.find(row => row.botId === 'primary' && row.key === 'private:' + binding.qq) ?? null : null;
        const ownedBots = data.ownedBots.filter(row => row.ownerUserId === principal.id).map(row => {
          const funding = data.funding.find(f => f.botId === row.botId && f.key === null); return { ...clone(row), profileId: funding?.profileId ?? null, fundingVersion: funding?.version ?? 0 };
        });
        return { user: { id: principal.id, username: principal.username ?? '', role: principal.role }, mode: ownedBots.length ? 'hosted' : privateFunding?.profileId ? 'byok' : 'trial',
          profiles: data.profiles.filter(p => p.ownerUserId === principal.id && !p.deleted).map(publicProfile), qqBinding: clone(binding), qqBindings: binding ? [clone(binding)] : [],
          privateFunding: privateFunding ? { profileId: privateFunding.profileId, version: privateFunding.version } : null, ownedBots,
          delegations: clone(data.delegations.filter(row => row.userId === principal.id || ownedBots.some(bot => bot.botId === row.botId))), trial: trialFor(data, principal.id),
          ...(principal.role === 'admin' ? { platformTrial: clone(data.trial) } : {}), models: [...TENANT_MODELS],
          permissions: { canEditProfiles: true, canManagePlatformTrial: principal.role === 'admin', canManageOwnedBots: true } };
      });
    },
    saveProfile(principal, input) {
      principalOf(principal);
      if (!partial(input, ['id', 'name', 'model', 'apiKey', 'version']) || !name(input.name) || !TENANT_MODELS.includes(input.model)
        || own(input, 'apiKey') && !apiKey(input.apiKey)) throw fail(400, '请输入合法名称、官方支持模型及DeepSeek API密钥');
      return transact((data, at) => {
        let p;
        if (input.id !== undefined) {
          p = data.profiles.find(row => row.id === input.id && row.ownerUserId === principal.id && !row.deleted); if (!p) throw fail(404, '自费配置不存在');
          expected(input.version, p.version); p.version++; p.name = input.name; p.model = input.model; p.updatedAt = at;
        } else {
          expected(input.version, 0); if (!apiKey(input.apiKey)) throw fail(400, '创建自费配置需要API密钥');
          if (data.profiles.filter(row => row.ownerUserId === principal.id && !row.deleted).length >= 10) throw fail(409, '每个账号最多保存10个自费配置');
          p = { id: crypto.randomBytes(16).toString('hex'), ownerUserId: principal.id, name: input.name, model: input.model, provider: 'deepseek', version: 1,
            enabled: true, deleted: false, encrypted: null, createdAt: at, updatedAt: at, invalidReason: null }; data.profiles.push(p);
        }
        if (own(input, 'apiKey')) { p.encrypted = encrypt(data, p, input.apiKey); p.enabled = true; p.invalidReason = null; }
        return publicProfile(p);
      });
    },
    deleteProfile(principal, input) {
      principalOf(principal); if (!exact(input, ['id', 'version'])) throw fail(400, '自费配置删除参数无效');
      return transact((data, at) => {
        const p = data.profiles.find(row => row.id === input.id && row.ownerUserId === principal.id && !row.deleted); if (!p) throw fail(404, '自费配置不存在');
        expected(input.version, p.version); p.deleted = true; p.enabled = false; p.version++; p.updatedAt = at; return { id: p.id, deleted: true, version: p.version };
      });
    },
    invalidateProfile(profileId) {
      return transact((data, at) => {
        const p = data.profiles.find(row => row.id === profileId && !row.deleted); if (!p) throw fail(404, '自费配置不存在');
        p.enabled = false; p.invalidReason = 'provider-rejected'; p.version++; p.updatedAt = at; return { id: p.id, version: p.version };
      });
    },
    issueBinding(principal, input) {
      principalOf(principal); if (!exact(input, ['qq']) || !qq(input.qq)) throw fail(400, '请输入规范QQ号');
      return transact((data, at) => {
        if (data.bindings.some(row => row.userId === principal.id || row.qq === input.qq)) throw fail(409, '此账号或QQ已绑定，不能抢占现有绑定');
        data.challenges = data.challenges.filter(row => row.expiresAt >= at - 86400000);
        const recent = data.challenges.filter(row => row.userId === principal.id && row.createdAt > at - 600000);
        if (recent.length >= 5 || recent.some(row => row.createdAt > at - 30000)) throw fail(429, '验证码请求过于频繁，请稍后再试');
        for (const row of data.challenges) if (row.userId === principal.id && row.consumedAt === null) row.consumedAt = at;
        const code = crypto.randomBytes(9).toString('base64url'), expiresAt = at + 600000;
        data.challenges.push({ id: crypto.randomBytes(16).toString('hex'), userId: principal.id, qq: input.qq, codeHash: digest(code), createdAt: at, expiresAt, attempts: 0, consumedAt: null });
        return { qq: input.qq, code, expiresAt };
      });
    },
    consumeBinding(input) {
      if (!exact(input, ['qq', 'code']) || !qq(input.qq) || typeof input.code !== 'string' || input.code.length > 200) throw fail(400, 'QQ绑定验证码无效');
      const result = transact((data, at) => {
        if (data.bindings.some(row => row.qq === input.qq)) return { error: fail(409, '该QQ已绑定，不能抢占或重复消费验证码') };
        const candidates = data.challenges.filter(row => row.qq === input.qq && row.consumedAt === null && row.expiresAt > at && row.attempts < 5);
        const incoming = Buffer.from(digest(input.code), 'hex');
        const challenge = candidates.find(row => crypto.timingSafeEqual(Buffer.from(row.codeHash, 'hex'), incoming));
        if (!challenge) { for (const row of candidates) row.attempts++; return { error: fail(400, '验证码错误或已失效') }; }
        if (data.bindings.some(row => row.userId === challenge.userId)) return { error: fail(409, '账号已绑定其他QQ') };
        activeAccount(challenge.userId); challenge.consumedAt = at;
        const binding = { qq: input.qq, userId: challenge.userId, verifiedAt: at }; data.bindings.push(binding); return { binding: clone(binding) };
      });
      if (result.error) throw result.error; return result.binding;
    },
    resolvePrivateBinding(value) {
      if (!qq(String(value))) return null;
      return transact(data => {
        const row = data.bindings.find(row => row.qq === String(value)); if (!row || exists(row.userId) !== true) return null;
        return { ...clone(row), id: row.userId, role: 'user', key: 'private:' + row.qq, botScopes: [{ botId: 'primary', key: 'private:' + row.qq }] };
      });
    },
    getBindingByUser(userId) { if (!id(userId)) return null; return transact(data => clone(data.bindings.find(row => row.userId === userId) ?? null)); },
    claimBot(principal, metadata) {
      principalOf(principal);
      const botId = metadata?.botId ?? metadata?.id;
      if (!bot(botId) || botId === 'primary' || !name(metadata?.name) || !qq(String(metadata?.expectedQQ)) || String(metadata?.actualQQ) !== String(metadata?.expectedQQ)
        || !time(metadata?.verifiedAt) || metadata.qqOnline === false || metadata.dshReady === false) throw fail(400, '机器人必须先通过真实QQ身份核验');
      const ownerUserId = metadata.ownerUserId ?? principal.id;
      if (principal.role !== 'admin' && ownerUserId !== principal.id) throw fail(403, '不能替其他账号接管机器人'); activeAccount(ownerUserId);
      return transact((data, at) => {
        const prior = data.ownedBots.find(row => row.botId === botId);
        if (prior) { if (prior.ownerUserId !== ownerUserId || prior.qq !== String(metadata.expectedQQ)) throw fail(409, '机器人已归其他账号或身份发生变化'); return clone(prior); }
        if (data.ownedBots.some(row => row.qq === String(metadata.expectedQQ))) throw fail(409, '机器人QQ已登记');
        const row = { botId, ownerUserId, name: metadata.name, qq: String(metadata.expectedQQ), version: 1, verifiedAt: metadata.verifiedAt, createdAt: at, updatedAt: at };
        data.ownedBots.push(row); return clone(row);
      });
    },
    assignBot(principal, input) {
      principalOf(principal); if (principal.role !== 'admin') throw fail(403, '只有平台管理员能变更机器人所有者');
      if (!exact(input, ['botId', 'userId', 'version']) || !id(input.userId)) throw fail(400, '机器人归属参数无效'); activeAccount(input.userId);
      return transact((data, at) => {
        const row = owned(data, input.botId, principal); expected(input.version, row.version);
        if (row.ownerUserId === input.userId) return clone(row);
        row.ownerUserId = input.userId; row.version++; row.updatedAt = at;
        data.delegations = data.delegations.filter(scope => scope.botId !== row.botId);
        for (const funding of data.funding.filter(f => f.botId === row.botId)) { funding.ownerUserId = input.userId; funding.profileId = null; funding.version++; funding.updatedAt = at; }
        return clone(row);
      });
    },
    // Compensation for a newly registered worker that failed before activation.
    // Internal only: no HTTP route exposes this method or accepts its owner identity.
    releaseBotClaim(input) {
      if (!exact(input, ['botId', 'ownerUserId', 'version']) || !bot(input.botId) || !id(input.ownerUserId)) throw fail(400, '机器人接入补偿参数无效');
      return transact(data => {
        const row = data.ownedBots.find(row => row.botId === input.botId); if (!row) return { removed: false };
        if (row.ownerUserId !== input.ownerUserId || row.version !== input.version) throw fail(409, '机器人归属已变化，不能清除此接入记录');
        data.funding = data.funding.filter(row => row.botId !== input.botId);
        data.delegations = data.delegations.filter(row => row.botId !== input.botId);
        data.ownedBots = data.ownedBots.filter(row => row.botId !== input.botId); return { removed: true };
      });
    },
    ownsBot(principal, botId) { principalOf(principal); return transact(data => data.ownedBots.some(row => row.botId === botId && row.ownerUserId === principal.id)); },
    // Internal onboarding lookup also covers a disabled owner's existing bot.
    botOwner(botId) { return transact(data => { const row=data.ownedBots.find(row=>row.botId===botId);return row?{botId:row.botId,ownerUserId:row.ownerUserId,qq:row.qq,version:row.version}:null; }); },
    userBotIds(principal) { principalOf(principal); return transact(data => data.ownedBots.filter(row => row.ownerUserId === principal.id).map(row => row.botId)); },
    delegate(principal, input) {
      principalOf(principal);
      if (!exact(input, ['botId', 'userId', 'keys', 'version']) || !id(input.userId) || !Array.isArray(input.keys) || input.keys.length > 1000 || input.keys.some(value => !key(value))) throw fail(400, '机器人委托会话参数无效');
      activeAccount(input.userId);
      return transact((data, at) => {
        owned(data, input.botId, principal); let row = data.delegations.find(row => row.botId === input.botId && row.userId === input.userId);
        expected(input.version, row?.version ?? 0);
        if (!row) { row = { botId: input.botId, userId: input.userId, keys: [], version: 0, updatedAt: at }; data.delegations.push(row); }
        row.keys = [...new Set(input.keys)].sort(); row.version++; row.updatedAt = at; return clone(row);
      });
    },
    enrichPrincipal(principal) {
      principalOf(principal);
      return transact(data => {
        const scopes = new Map();
        const add = scope => { if (bot(scope?.botId) && key(scope?.key)) scopes.set(scope.botId + '/' + scope.key, { botId: scope.botId, key: scope.key }); };
        for (const scope of principal.botScopes ?? []) add(scope);
        for (const value of principal.conversationKeys ?? []) add({ botId: 'primary', key: value });
        const binding = data.bindings.find(row => row.userId === principal.id); if (binding) add({ botId: 'primary', key: 'private:' + binding.qq });
        for (const row of data.delegations.filter(row => row.userId === principal.id)) for (const value of row.keys) add({ botId: row.botId, key: value });
        const botScopes = [...scopes.values()].sort((a, b) => a.botId.localeCompare(b.botId) || a.key.localeCompare(b.key));
        return { ...principal, botScopes, conversationKeys: botScopes.filter(scope => scope.botId === 'primary').map(scope => scope.key),
          ownedBotIds: data.ownedBots.filter(row => row.ownerUserId === principal.id).map(row => row.botId) };
      });
    },
    setFunding(principal, input) {
      principalOf(principal); if (!partial(input, ['botId', 'key', 'profileId', 'version']) || !bot(input.botId) || !(input.profileId === null || id(input.profileId))) throw fail(400, '自费来源参数无效');
      return transact((data, at) => {
        let ownerUserId, targetKey = null;
        if (input.botId === 'primary') {
          const binding = data.bindings.find(row => row.userId === principal.id);
          if (!binding || input.key !== 'private:' + binding.qq) throw fail(403, '只能为已验证的本人私聊配置自费密钥'); ownerUserId = principal.id; targetKey = input.key;
        } else {
          const owner = owned(data, input.botId, principal); ownerUserId = owner.ownerUserId;
          if (input.key != null) throw fail(400, '自有机器人使用所有者明确选择的自费来源');
          if (principal.id !== ownerUserId && input.profileId !== null) throw fail(403, '自费来源必须由机器人所有者明确选择');
        }
        if (input.profileId !== null) {
          const p = data.profiles.find(row => row.id === input.profileId && row.ownerUserId === ownerUserId && !row.deleted && row.enabled); if (!p) throw fail(404, '可用的本人自费配置不存在');
          decrypt(data, p);
        }
        let row = data.funding.find(row => row.botId === input.botId && row.key === targetKey); expected(input.version, row?.version ?? 0);
        if (!row) { row = { botId: input.botId, key: targetKey, ownerUserId, profileId: null, version: 0, updatedAt: at }; data.funding.push(row); }
        row.profileId = input.profileId; row.version++; row.updatedAt = at; return { ...clone(row) };
      });
    },
    getFunding(input) {
      if (!exact(input, ['botId', 'key']) || !bot(input.botId) || !key(input.key)) throw fail(400, '自费会话标识无效');
      return transact(data => {
        // A hosted worker may receive only its owner's chosen bot credential.
        // Personal credentials are confined to the trusted primary engine.
        const binding = input.botId === 'primary' && input.key.startsWith('private:') ? data.bindings.find(row => row.qq === input.key.slice(8)) : null;
        if (binding) {
          activeAccount(binding.userId);
          const personal = data.funding.find(row => row.botId === 'primary' && row.key === input.key);
          if (personal?.profileId) return fundingValue(data, personal, 'private');
          if (input.botId === 'primary') {
            const trial = trialFor(data, binding.userId);
            return { mode: trial.enabled && trial.dailyLimitCny > 0 && trial.totalDailyLimitCny > 0 ? 'trial' : 'blocked', ownerUserId: binding.userId,
              ...trial, identity: 'trial:' + binding.userId, reason: trial.enabled && trial.dailyLimitCny > 0 && trial.totalDailyLimitCny > 0 ? null : '平台试用已暂停或额度为0' };
          }
        }
        if (input.botId === 'primary') return input.key.startsWith('group:') ? { mode: 'platform', identity: 'platform:primary' } : { mode: 'blocked', reason: '请先在用户空间生成验证码并绑定本人QQ' };
        const owner = data.ownedBots.find(row => row.botId === input.botId); if (!owner) return { mode: 'blocked', reason: '机器人尚未登记所有者' };
        activeAccount(owner.ownerUserId);
        const funding = data.funding.find(row => row.botId === input.botId && row.key === null);
        return funding?.profileId ? fundingValue(data, funding, 'bot-owner') : { mode: 'blocked', ownerUserId: owner.ownerUserId, reason: '机器人所有者尚未选择有效自费来源' };
      });
    },
    updateTrial(principal, input) {
      principalOf(principal); if (principal.role !== 'admin') throw fail(403, '只有平台管理员能修改平台试用额度');
      if (!partial(input, ['version', 'enabled', 'dailyLimitCny', 'totalDailyLimitCny']) || own(input, 'enabled') && typeof input.enabled !== 'boolean'
        || own(input, 'dailyLimitCny') && !money(input.dailyLimitCny) || own(input, 'totalDailyLimitCny') && !money(input.totalDailyLimitCny)) throw fail(400, '试用额度参数无效');
      return transact(data => { expected(input.version, data.trial.version); for (const k of ['enabled', 'dailyLimitCny', 'totalDailyLimitCny']) if (own(input, k)) data.trial[k] = input[k]; data.trial.version++; return clone(data.trial); });
    },
    setUserTrial(principal, input) {
      principalOf(principal); if (principal.role !== 'admin') throw fail(403, '只有平台管理员能修改用户试用额度');
      if (!exact(input, ['userId', 'enabled', 'dailyLimitCny', 'version']) || !id(input.userId) || typeof input.enabled !== 'boolean' || !money(input.dailyLimitCny)) throw fail(400, '用户试用额度参数无效');
      activeAccount(input.userId);
      return transact((data, at) => { let row = data.trialOverrides.find(row => row.userId === input.userId); expected(input.version, row?.version ?? 0);
        if (!row) { row = { userId: input.userId, enabled: true, dailyLimitCny: 0, version: 0, updatedAt: at }; data.trialOverrides.push(row); }
        row.enabled = input.enabled; row.dailyLimitCny = input.dailyLimitCny; row.version++; row.updatedAt = at; return clone(row); });
    },
  };
}
