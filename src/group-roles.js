import fs from 'node:fs';

export function normalizeGroupId(value) {
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value).trim())) throw new Error('群号必须是正整数');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('群号必须是安全范围内的正整数');
  return String(number);
}

// This file is operator configuration, independent of resettable conversation state.
// Every update rereads it; unreadable/corrupt/future data is never replaced by defaults.
export function createGroupRoleStore(file, writeJson) {
  const validRole = role => typeof role === 'string' && /^[\w\u4e00-\u9fff-]{1,40}$/.test(role) && role !== 'README';
  function read() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, groups: {} }; throw new Error('群人设配置无法读取，已停止改写'); }
    let data;
    try { data = JSON.parse(raw.replace(/^\uFEFF/, '')); }
    catch { throw new Error('群人设配置损坏，已停止改写；请先备份并修复 state/group-roles.json'); }
    if (!data || Array.isArray(data) || data.version !== 1 || !data.groups || Array.isArray(data.groups) || typeof data.groups !== 'object'
        || Object.keys(data).some(key => !['version', 'groups'].includes(key))) throw new Error('群人设配置格式或版本不受支持，已停止改写');
    for (const [id, role] of Object.entries(data.groups)) {
      if (normalizeGroupId(id) !== id || !validRole(role)) throw new Error('群人设配置包含无效群号或角色，已停止改写');
    }
    return data;
  }
  return {
    read,
    get(id) { return read().groups[normalizeGroupId(id)] ?? null; },
    set(id, role) {
      const data = read();
      id = normalizeGroupId(id);
      if (role !== null && !validRole(role)) throw new Error('无效的群人设');
      if ((data.groups[id] ?? null) === role) return false;
      if (role === null) delete data.groups[id]; else data.groups[id] = role;
      writeJson(file, data);
      return true;
    },
    rename(from, to) {
      const data = read();
      if (!validRole(to)) throw new Error('无效的群人设');
      const ids = Object.keys(data.groups).filter(id => data.groups[id] === from);
      for (const id of ids) data.groups[id] = to;
      if (ids.length) writeJson(file, data);
      return ids;
    },
  };
}
