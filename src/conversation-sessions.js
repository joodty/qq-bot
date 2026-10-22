import fs from 'node:fs';
import crypto from 'node:crypto';
import { normalizeConversationRoleKey } from './conversation-roles.js';

const nameValid = name => name === null || (typeof name === 'string' && /^[\w\u4e00-\u9fff-]{1,40}$/.test(name) && name !== 'README');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const idFor = (prefix, seed) => prefix + '_' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
const newId = prefix => prefix + '_' + crypto.randomBytes(16).toString('hex');

export function createConversationSessionStore(file, writeJson, { legacy = () => [], now = Date.now, storage } = {}) {
  const migrationTime = now();
  const revision = Symbol('conversation session storage revision');
  function validate(data) {
    if (!object(data) || data.version !== 1 || Object.keys(data).some(k => !['version', 'personas', 'records', 'selected'].includes(k))
        || !object(data.personas) || !object(data.records) || !object(data.selected)) throw new Error('会话存档格式或版本不受支持，已停止改写');
    const liveNames = new Set(), sessionIds = new Set();
    for (const [id, p] of Object.entries(data.personas)) {
      if (!/^p_[a-f0-9]{32}$/.test(id) || !object(p) || !nameValid(p.name) || typeof p.deleted !== 'boolean'
          || Object.keys(p).some(k => !['name', 'deleted'].includes(k))) throw new Error('会话存档包含无效人设');
      if (!p.deleted) { if (liveNames.has(p.name)) throw new Error('会话存档人设身份重复'); liveNames.add(p.name); }
    }
    for (const [id, r] of Object.entries(data.records)) {
      if (!/^c_[a-f0-9]{32}$/.test(id) || !object(r) || !Object.hasOwn(data.personas, r.personaId)
          || normalizeConversationRoleKey(r.key) !== r.key
          || !(r.sessionId === null || (typeof r.sessionId === 'string' && r.sessionId.length > 0 && r.sessionId.length <= 300))
          || !(r.policy === null || (typeof r.policy === 'string' && r.policy.length <= 4000))
          || !Number.isSafeInteger(r.createdAt) || r.createdAt < 0 || !Number.isSafeInteger(r.lastUsedAt) || r.lastUsedAt < 0
          || typeof r.blocked !== 'boolean' || typeof r.missing !== 'boolean'
          || Object.keys(r).some(k => !['key', 'personaId', 'sessionId', 'policy', 'createdAt', 'lastUsedAt', 'blocked', 'missing'].includes(k))) throw new Error('会话存档包含无效记录');
      if (r.sessionId) { if (sessionIds.has(r.sessionId)) throw new Error('同一模型会话不能归属多个存档'); sessionIds.add(r.sessionId); }
    }
    for (const [key, id] of Object.entries(data.selected)) {
      if (normalizeConversationRoleKey(key) !== key || !Object.hasOwn(data.records, id) || data.records[id].key !== key) throw new Error('会话存档当前选择无效');
    }
    return data;
  }
  function persona(data, name) {
    if (!nameValid(name)) throw new Error('无效人设名称');
    const existing = Object.entries(data.personas).find(([, p]) => !p.deleted && p.name === name);
    if (existing) return existing[0];
    const id = newId('p'); data.personas[id] = { name, deleted: false }; return id;
  }
  function addRecord(data, key, personaId, { sessionId = null, policy = null, timestamp = now(), id = newId('c') } = {}) {
    key = normalizeConversationRoleKey(key);
    data.records[id] = { key, personaId, sessionId, policy, createdAt: timestamp, lastUsedAt: timestamp, blocked: false, missing: false };
    return id;
  }
  function read() {
    let raw;
    try { raw = storage ? storage.readText(file) : fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('会话存档无法读取，已停止改写');
      const data = { version: 1, personas: {}, records: {}, selected: {} };
      for (const row of legacy()) {
        const pid = idFor('p', JSON.stringify(row.role ?? null));
        data.personas[pid] = { name: row.role ?? null, deleted: false };
        const id = addRecord(data, row.key, pid, { sessionId: row.sessionId, policy: row.policy ?? null, timestamp: migrationTime, id: idFor('c', JSON.stringify([row.key, row.sessionId])) });
        data.selected[row.key] = id;
      }
      data[revision] = null;
      if (storage) write(validate(data));
      return validate(data);
    }
    let data;
    try { data = JSON.parse(raw.replace(/^\uFEFF/, '')); }
    catch { throw new Error('会话存档损坏，已停止改写；请备份并修复 state/conversation-sessions.json'); }
    data[revision] = raw;
    return validate(data);
  }
  function write(data) {
    validate(data);
    if (storage) { const text = JSON.stringify(data, null, 2) + '\n'; storage.writeText(file, text, data[revision]); data[revision] = text; return; }
    let current;
    try { current = fs.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('会话存档无法读取，已停止改写'); current = null; }
    if (current !== data[revision]) throw new Error('会话存档在操作期间发生变化，已停止改写，请重试');
    writeJson(file, data);
    data[revision] = fs.readFileSync(file, 'utf8');
  }
  function choose(data, key, name, { id, fresh = false, policy } = {}) {
    key = normalizeConversationRoleKey(key);
    const pid = persona(data, name);
    if (id) {
      const r = data.records[id];
      if (!r || r.key !== key || r.personaId !== pid || r.missing) throw new Error('无法继续该会话存档');
    } else if (!fresh) {
      const selected = data.selected[key];
      const eligible = ([, r]) => r.key === key && r.personaId === pid && !r.missing && !r.blocked && (!r.sessionId || r.policy === policy);
      if (selected && eligible([selected, data.records[selected]])) id = selected;
      else id = Object.entries(data.records).filter(eligible).sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt)[0]?.[0];
    }
    if (!id) id = addRecord(data, key, pid);
    data.selected[key] = id; data.records[id].lastUsedAt = now();
    return id;
  }
  function rename(from, to) {
    const data = read(); let changed = false;
    for (const p of Object.values(data.personas)) if (!p.deleted && p.name === from) { p.name = to; changed = true; }
    if (changed) write(data);
  }
  function removePersona(name) {
    const data = read(); let changed = false;
    for (const p of Object.values(data.personas)) if (!p.deleted && p.name === name) { p.deleted = true; changed = true; }
    if (changed) write(data);
  }
  return { read, write, persona, addRecord, choose, rename, removePersona };
}

export function validateConversationSessionsText(text) {
  return createConversationSessionStore('validation-only', () => {}, { storage: { readText: () => text } }).read();
}
