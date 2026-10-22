import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => own(value, key));
const keyOf = value => {
  if (typeof value !== 'string') throw fail(400, '会话须为 group:群号 或 private:QQ号');
  const match = /^(group|private):(\d+)$/.exec(value.trim());
  if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0) throw fail(400, '会话标识无效');
  return match[1] + ':' + Number(match[2]);
};
const idOf = value => {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw fail(404, '人设不存在');
  return value;
};
const nameOf = value => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\x00-\x1f\x7f/\\]/.test(value) || ['.', '..'].includes(value.trim())) throw fail(400, '人设名称须为1至80个字符，不能包含路径或换行');
  return value.trim();
};
const safeTemplate = name => typeof name === 'string' && /^[\w\u4e00-\u9fff-]{1,40}$/.test(name) && name !== 'README' && !/^member_[a-f0-9]{32}$/.test(name);
const internalOf = id => 'member_' + id;

/** Member cards have independent identities and names; only generated names touch disk. */
export function createMemberPersonaService({ storage, rolesDir, botId = 'primary', file, activateRole, listBindings = () => [], readRole, writeRole, listTemplates: providedTemplates, now = () => Date.now(), maxContentBytes = 65536, maxHistory = 100 } = {}) {
  if (!storage || typeof storage.readText !== 'function' || typeof storage.writeText !== 'function' || typeof storage.transaction !== 'function') throw new Error('member persona storage requires synchronous readText/writeText/transaction');
  if (typeof rolesDir !== 'string' || !rolesDir || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(botId)) throw new Error('invalid member persona bot or roles directory');
  const document = file || path.join(rolesDir, '..', 'state', 'member-personas.json');
  const corrupt = () => fail(503, '成员人设存储损坏或版本不受支持，已停止改写，请管理员备份并修复');
  const contentOf = value => {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxContentBytes) throw fail(400, '人设正文不能为空，且不得超过' + maxContentBytes + '字节');
    return value;
  };
  function assertPrincipal(principal) {
    if (!principal || !['admin', 'user'].includes(principal.role) || principal.disabled || typeof principal.id !== 'string' || !principal.id || principal.id.length > 128) throw fail(403, '请使用已授权的账号操作人设');
    if (principal.role === 'admin') return;
    if (!principal.ownedBotIds?.includes(botId) && !scopeKeys(principal).length) throw fail(403, '此账号尚未获分配该机器人的会话');
  }
  function scopeKeys(principal) {
    const values = [];
    for (const scope of principal?.botScopes || []) if (scope?.botId === botId) values.push(scope.key);
    if (botId === 'primary') values.push(...(principal?.conversationKeys || []));
    return [...new Set(values.map(value => { try { return keyOf(value); } catch { return null; } }).filter(Boolean))];
  }
  function allowed(principal, key) { return principal?.role === 'admin' || principal?.ownedBotIds?.includes(botId) || scopeKeys(principal).includes(key); }
  function assertTarget(principal, value) { assertPrincipal(principal); const key = keyOf(value); if (!allowed(principal, key)) throw fail(403, '此账号没有该机器人中这个会话的人设权限'); return key; }
  function read() {
    let raw;
    try { raw = storage.readText(document); } catch (error) { if (error.code === 'ENOENT') raw = null; else throw corrupt(); }
    if (raw == null) return { raw: null, data: { version: 1, cards: [] } };
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 16 * 1024 * 1024) throw corrupt();
    let data;
    try { data = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw corrupt(); }
    if (!exact(data, ['version', 'cards']) || data.version !== 1 || !Array.isArray(data.cards) || data.cards.length > 1000) throw corrupt();
    const seen = new Set();
    try {
      for (const card of data.cards) {
        if (!exact(card, ['id', 'botId', 'ownerUserId', 'internalRoleName', 'name', 'content', 'version', 'createdAt', 'updatedAt', 'history']) || card.botId !== botId || idOf(card.id) !== card.id || seen.has(card.id)
            || card.internalRoleName !== internalOf(card.id) || typeof card.ownerUserId !== 'string' || !card.ownerUserId || card.ownerUserId.length > 128
            || nameOf(card.name) !== card.name || contentOf(card.content) !== card.content || !Number.isSafeInteger(card.createdAt) || card.createdAt <= 0 || !Number.isSafeInteger(card.updatedAt) || card.updatedAt < card.createdAt
            || !Number.isSafeInteger(card.version) || card.version < 1 || !Array.isArray(card.history) || card.history.length !== card.version || card.history.length > maxHistory) throw corrupt();
        for (let i = 0; i < card.history.length; i++) {
          const entry = card.history[i];
          if (!exact(entry, ['version', 'name', 'content', 'createdAt', 'authorUserId']) || entry.version !== i + 1 || nameOf(entry.name) !== entry.name || contentOf(entry.content) !== entry.content
              || !Number.isSafeInteger(entry.createdAt) || entry.createdAt < card.createdAt || typeof entry.authorUserId !== 'string' || !entry.authorUserId || entry.authorUserId.length > 128) throw corrupt();
        }
        const last = card.history.at(-1);
        if (last.name !== card.name || last.content !== card.content || last.createdAt !== card.updatedAt) throw corrupt();
        seen.add(card.id);
      }
    } catch { throw corrupt(); }
    return { raw, data };
  }
  function bindings() {
    const rows = listBindings();
    if (!Array.isArray(rows)) throw fail(503, '无法读取当前人设绑定，已停止操作');
    return rows.map(row => ({ key: keyOf(row.key), internalRoleName: row.internalRoleName }));
  }
  function affected(card, principal, all = false) {
    return [...new Set(bindings().filter(row => row.internalRoleName === card.internalRoleName && (all || allowed(principal, row.key))).map(row => row.key))].sort();
  }
  function assertEditable(card, principal) {
    if (principal.role !== 'admin' && card.ownerUserId !== principal.id) throw fail(404, '人设不存在');
    if (principal.role !== 'admin' && affected(card, principal, true).some(key => !allowed(principal, key))) throw fail(409, '该人设还被你无权管理的会话使用；请复制为新卡，再应用到已授权会话');
  }
  function find(data, id, principal) { const card = data.cards.find(card => card.id === idOf(id)); if (!card || (principal.role !== 'admin' && card.ownerUserId !== principal.id)) throw fail(404, '人设不存在'); return card; }
  function visible(card, principal) { return { id: card.id, botId, ...(principal.role === 'admin' ? { ownerUserId: card.ownerUserId } : {}), name: card.name, content: card.content, version: card.version, createdAt: card.createdAt, updatedAt: card.updatedAt, affectedConversations: affected(card, principal) }; }
  function rolePath(card) { return path.join(rolesDir, card.internalRoleName + '.md'); }
  function readRoleFile(target) {
    try { const info = fs.lstatSync(target); if (!info.isFile() || info.isSymbolicLink()) throw fail(503, '人设文件类型异常，已停止改写'); return fs.readFileSync(target); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function writeRoleFile(target, bytes) {
    fs.mkdirSync(rolesDir, { recursive: true });
    const temp = path.join(rolesDir, '.' + path.basename(target) + '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
    let fd;
    try { fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temp, target); }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  function roleBytes(name) {
    if (typeof readRole !== 'function') return readRoleFile(path.join(rolesDir, name + '.md'));
    const content = readRole(name);
    if (content == null) return null;
    if (typeof content !== 'string') throw fail(503, '人设正文存储格式异常');
    return Buffer.from(content, 'utf8');
  }
  function setRoleBytes(name, bytes) {
    if (typeof writeRole === 'function') return writeRole(name, bytes.toString('utf8'));
    return writeRoleFile(path.join(rolesDir, name + '.md'), bytes);
  }
  function mutate(principal, run) {
    assertPrincipal(principal);
    let oldFile, changedFile, result;
    try {
      storage.transaction(() => {
        const state = read(); const value = run(state.data); const card = value.card;
        const text = JSON.stringify(state.data, null, 2) + '\n';
        if (Buffer.byteLength(text, 'utf8') > 16 * 1024 * 1024) throw fail(409, '成员人设存储已达容量上限，请联系管理员');
        changedFile = rolePath(card); oldFile = typeof writeRole === 'function' ? undefined : readRoleFile(changedFile);
        storage.writeText(document, text, state.raw);
        setRoleBytes(card.internalRoleName, Buffer.from(card.content, 'utf8'));
        result = { ok: true, persona: visible(card, principal), affectedConversations: affected(card, principal) };
      });
      return result;
    } catch (error) {
      if (!error.committed && changedFile && oldFile !== undefined) {
        try { if (oldFile === null) fs.unlinkSync(changedFile); else writeRoleFile(changedFile, oldFile); }
        catch (rollbackError) { if (rollbackError.code !== 'ENOENT') throw fail(503, '人设操作失败且文件回退失败，请管理员检查；存储未降级覆盖'); }
      }
      throw error;
    }
  }
  function templates(principal) {
    assertPrincipal(principal);
    if (typeof providedTemplates === 'function') {
      const rows = providedTemplates();
      if (!Array.isArray(rows)) throw fail(503, '模板列表暂不可用');
      return rows.filter(row => safeTemplate(typeof row === 'string' ? row : row?.name)).map(row => {
        const name = typeof row === 'string' ? row : row.name;
        const content = typeof row?.content === 'string' ? row.content : roleBytes(name)?.toString('utf8');
        return typeof content === 'string' && Buffer.byteLength(content, 'utf8') <= maxContentBytes ? { name, content } : null;
      }).filter(Boolean);
    }
    let names;
    try { names = fs.readdirSync(rolesDir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return names.filter(file => file.endsWith('.md') && safeTemplate(file.slice(0, -3))).sort().map(file => {
      const content = readRoleFile(path.join(rolesDir, file));
      if (!content || content.length > maxContentBytes) return null;
      return { name: file.slice(0, -3), content: content.toString('utf8') };
    }).filter(Boolean);
  }
  function appendRevision(card, principal, name, content) {
    if (card.history.length >= maxHistory) throw fail(409, '该人设版本数量已达上限，请复制为新卡继续编辑');
    card.name = name; card.content = content; card.version++; card.updatedAt = Math.max(now(), card.updatedAt);
    card.history.push({ version: card.version, name, content, createdAt: card.updatedAt, authorUserId: principal.id });
  }
  const service = {
    list(principal) { assertPrincipal(principal); const data = read().data; return { ok: true, botId, personas: data.cards.filter(card => principal.role === 'admin' || card.ownerUserId === principal.id).map(card => visible(card, principal)), templates: templates(principal) }; },
    create(principal, input = {}) {
      assertPrincipal(principal); let source;
      if (input.copyFrom !== undefined) { if (!safeTemplate(input.copyFrom)) throw fail(400, '模板名称无效'); source = templates(principal).find(template => template.name === input.copyFrom); if (!source) throw fail(404, '模板不存在'); }
      const name = nameOf(input.name), content = contentOf(input.content ?? source?.content);
      return mutate(principal, data => {
        if (data.cards.length >= 1000 || data.cards.filter(card => card.ownerUserId === principal.id).length >= 100) throw fail(409, '人设数量已达上限');
        const id = crypto.randomBytes(16).toString('hex'), time = now();
        const card = { id, botId, ownerUserId: principal.id, internalRoleName: internalOf(id), name, content, version: 1, createdAt: time, updatedAt: time, history: [{ version: 1, name, content, createdAt: time, authorUserId: principal.id }] };
        if (roleBytes(card.internalRoleName) !== null) throw fail(503, '人设标识冲突，请重试');
        data.cards.push(card); return { card };
      });
    },
    update(principal, input = {}) {
      return mutate(principal, data => {
        const card = find(data, input.id, principal); assertEditable(card, principal);
        if (!Number.isSafeInteger(input.version) || input.version !== card.version) throw fail(409, '人设已被更新，请先刷新后再保存');
        appendRevision(card, principal, input.name === undefined ? card.name : nameOf(input.name), contentOf(input.content)); return { card };
      });
    },
    history(principal, input = {}) { assertPrincipal(principal); const card = find(read().data, input.id, principal); return { ok: true, id: card.id, version: card.version, history: card.history.map(({ version, name, content, createdAt }) => ({ version, name, content, createdAt })) }; },
    restore(principal, input = {}) {
      return mutate(principal, data => {
        const card = find(data, input.id, principal); assertEditable(card, principal);
        if (!Number.isSafeInteger(input.version) || input.version !== card.version) throw fail(409, '人设已被更新，请先刷新后再恢复');
        const target = card.history.find(entry => entry.version === input.targetVersion); if (!target) throw fail(404, '历史版本不存在');
        appendRevision(card, principal, target.name, target.content); return { card };
      });
    },
    async apply(principal, input = {}) {
      const key = assertTarget(principal, input.key);
      if (Number(input.id != null) + Number(input.templateName != null) + Number(input.inherit === true) !== 1) throw fail(400, '请选择本人角色卡、管理员模板或沿用全局');
      let internalRoleName, name, persona;
      if (input.inherit === true) { internalRoleName = null; name = null; }
      else if (input.id != null) { const card = find(read().data, input.id, principal); internalRoleName = card.internalRoleName; name = card.name; persona = visible(card, principal); if (!roleBytes(internalRoleName)?.equals(Buffer.from(card.content, 'utf8'))) throw fail(503, '人设正文与版本不一致，请联系管理员检查'); }
      else { if (!safeTemplate(input.templateName) || !templates(principal).some(row => row.name === input.templateName)) throw fail(404, '模板不存在'); internalRoleName = input.templateName; name = input.templateName; }
      if (typeof activateRole !== 'function') throw fail(503, '此机器人暂不可切换人设');
      // The binding callback owns the existing session-switch transaction and must
      // recheck its live principal/bot permissions before committing an async switch.
      await activateRole(key, internalRoleName, principal);
      return { ok: true, key, role: name, inherited: input.inherit === true, ...(persona ? { persona } : {}) };
    },
    displayNameForRole(internalRoleName) { if (typeof internalRoleName !== 'string') return internalRoleName; if (!/^member_[a-f0-9]{32}$/.test(internalRoleName)) return internalRoleName; return read().data.cards.find(card => card.internalRoleName === internalRoleName)?.name ?? '已移除的人设'; },
  };
  // SQLite is authoritative after a crash between a role-file rename and commit.
  // Rebuild only this bot's generated files; invalid storage always fails closed.
  for (const card of read().data.cards) {
    if (!roleBytes(card.internalRoleName)?.equals(Buffer.from(card.content, 'utf8'))) {
      if (typeof writeRole === 'function') throw fail(503, '人设正文与版本存储不一致，请管理员检查');
      setRoleBytes(card.internalRoleName, Buffer.from(card.content, 'utf8'));
    }
  }
  return service;
}
