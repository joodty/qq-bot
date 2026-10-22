import fs from 'node:fs';
import { createGroupRoleStore } from './group-roles.js';

export function normalizeConversationRoleKey(value) {
  if (typeof value !== 'string') throw new Error('会话必须是 group:群号 或 private:QQ号');
  const match = /^(group|private):(\d+)$/.exec(value.trim());
  if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0) throw new Error('会话必须是 group:群号 或 private:QQ号');
  return match[1] + ':' + Number(match[2]);
}

export function createConversationRoleStore(file, legacyFile, writeJson, { storage } = {}) {
  const legacy = createGroupRoleStore(legacyFile, writeJson);
  const validRole = role => typeof role === 'string' && /^[\w\u4e00-\u9fff-]{1,40}$/.test(role) && role !== 'README';
  const revision = Symbol('conversation roles revision');
  function write(data) {
    if (storage) { const text = JSON.stringify(data, null, 2) + '\n'; storage.writeText(file, text, data[revision]); data[revision] = text; }
    else writeJson(file, data);
  }
  function read() {
    let raw;
    try { raw = storage ? storage.readText(file) : fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('会话人设配置无法读取，已停止改写');
      // Read old group assignments without changing the old file or creating a new one.
      const migrated = { version: 1, roles: Object.fromEntries(Object.entries(legacy.read().groups).map(([id, role]) => ['group:' + id, role])) };
      migrated[revision] = null;
      if (storage) write(migrated);
      return migrated;
    }
    let data;
    try { data = JSON.parse(raw.replace(/^\uFEFF/, '')); }
    catch { throw new Error('会话人设配置损坏，已停止改写；请先备份并修复 state/conversation-roles.json'); }
    if (!data || Array.isArray(data) || data.version !== 1 || !data.roles || typeof data.roles !== 'object' || Array.isArray(data.roles)
        || Object.keys(data).some(key => !['version', 'roles'].includes(key))) throw new Error('会话人设配置格式或版本不受支持，已停止改写');
    for (const [key, role] of Object.entries(data.roles)) {
      if (normalizeConversationRoleKey(key) !== key || !validRole(role)) throw new Error('会话人设配置包含无效会话或角色，已停止改写');
    }
    data[revision] = raw;
    return data;
  }
  return {
    read,
    get(key) { return read().roles[normalizeConversationRoleKey(key)] ?? null; },
    set(key, role) {
      const data = read(); key = normalizeConversationRoleKey(key);
      if (role !== null && !validRole(role)) throw new Error('无效的会话人设');
      if ((data.roles[key] ?? null) === role) return false;
      if (role === null) delete data.roles[key]; else data.roles[key] = role;
      write(data); return true;
    },
    rename(from, to) {
      const data = read();
      if (!validRole(to)) throw new Error('无效的会话人设');
      const keys = Object.keys(data.roles).filter(key => data.roles[key] === from);
      for (const key of keys) data.roles[key] = to;
      if (keys.length) write(data);
      return keys;
    },
  };
}

export function validateConversationRolesText(text) {
  return createConversationRoleStore('validation-only', 'validation-only-legacy', () => {}, { storage: { readText: () => text } }).read();
}
