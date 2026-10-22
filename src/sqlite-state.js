import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validateConsoleAuthText, consoleBotScopes } from './console-auth.js';
import { createConversationRoleStore, validateConversationRolesText } from './conversation-roles.js';
import { validateConversationSessionsText } from './conversation-sessions.js';
import { createMemberPersonaService } from './member-personas.js';
import { createBotManager } from './bot-manager.js';
import { validateGroupBudgetText } from './group-budget.js';
import { validateTenantText } from './tenant-service.js';

const VERSION = 1;
const APPLICATION_ID = 0x51514254;
const problem = message => Object.assign(new Error(message), { statusCode: 503 });
const missing = file => Object.assign(new Error('SQLite文档不存在：' + file), { code: 'ENOENT' });
const TABLES = {
  state_meta: 'CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
  state_documents: 'CREATE TABLE state_documents (path TEXT PRIMARY KEY, kind TEXT NOT NULL, bot_id TEXT NOT NULL, raw_text TEXT, revision INTEGER NOT NULL CHECK(revision>0), migrated_at INTEGER NOT NULL) STRICT',
  accounts: "CREATE TABLE accounts (id TEXT PRIMARY KEY, document_path TEXT NOT NULL REFERENCES state_documents(path), username TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('admin','user')), disabled INTEGER NOT NULL CHECK(disabled IN (0,1)), password_algorithm TEXT NOT NULL, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, password_version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT",
  auth_sessions: 'CREATE TABLE auth_sessions (hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, password_version INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at)) STRICT',
  account_scopes: 'CREATE TABLE account_scopes (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, bot_id TEXT NOT NULL, conversation_key TEXT NOT NULL, PRIMARY KEY(account_id,bot_id,conversation_key)) STRICT',
  persona_identities: 'CREATE TABLE persona_identities (bot_id TEXT NOT NULL, id TEXT NOT NULL, document_path TEXT NOT NULL REFERENCES state_documents(path), name TEXT, deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), PRIMARY KEY(bot_id,id)) STRICT',
  archive_records: 'CREATE TABLE archive_records (bot_id TEXT NOT NULL, id TEXT NOT NULL, document_path TEXT NOT NULL REFERENCES state_documents(path), conversation_key TEXT NOT NULL, persona_id TEXT NOT NULL, session_id TEXT, policy TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, blocked INTEGER NOT NULL CHECK(blocked IN (0,1)), missing INTEGER NOT NULL CHECK(missing IN (0,1)), PRIMARY KEY(bot_id,id), UNIQUE(bot_id,session_id), FOREIGN KEY(bot_id,persona_id) REFERENCES persona_identities(bot_id,id)) STRICT',
  selected_sessions: 'CREATE TABLE selected_sessions (bot_id TEXT NOT NULL, conversation_key TEXT NOT NULL, archive_id TEXT NOT NULL, document_path TEXT NOT NULL REFERENCES state_documents(path), PRIMARY KEY(bot_id,conversation_key), FOREIGN KEY(bot_id,archive_id) REFERENCES archive_records(bot_id,id) ON DELETE CASCADE) STRICT',
  conversation_roles: 'CREATE TABLE conversation_roles (bot_id TEXT NOT NULL, conversation_key TEXT NOT NULL, role_name TEXT NOT NULL, document_path TEXT NOT NULL REFERENCES state_documents(path), PRIMARY KEY(bot_id,conversation_key)) STRICT',
  role_cards: 'CREATE TABLE role_cards (path TEXT PRIMARY KEY REFERENCES state_documents(path), bot_id TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL) STRICT',
  role_materializations: 'CREATE TABLE role_materializations (path TEXT PRIMARY KEY REFERENCES state_documents(path), revision INTEGER NOT NULL) STRICT',
  bots: 'CREATE TABLE bots (id TEXT PRIMARY KEY, document_path TEXT NOT NULL REFERENCES state_documents(path), name TEXT NOT NULL, expected_qq TEXT NOT NULL, actual_qq TEXT, port INTEGER NOT NULL, machine_token TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), verified_at INTEGER, deleted INTEGER NOT NULL CHECK(deleted IN (0,1))) STRICT',
  member_cards: 'CREATE TABLE member_cards (bot_id TEXT NOT NULL, id TEXT NOT NULL, document_path TEXT NOT NULL REFERENCES state_documents(path), owner_user_id TEXT NOT NULL, internal_role_name TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(bot_id,id), UNIQUE(bot_id,internal_role_name)) STRICT',
  member_revisions: 'CREATE TABLE member_revisions (bot_id TEXT NOT NULL, card_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, author_user_id TEXT NOT NULL, PRIMARY KEY(bot_id,card_id,version), FOREIGN KEY(bot_id,card_id) REFERENCES member_cards(bot_id,id) ON DELETE CASCADE) STRICT',
  budget_settings: 'CREATE TABLE budget_settings (bot_id TEXT PRIMARY KEY, document_path TEXT NOT NULL REFERENCES state_documents(path), config_version INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), default_limit_micros INTEGER NOT NULL CHECK(default_limit_micros>=0), default_reservation_micros INTEGER NOT NULL CHECK(default_reservation_micros>0), lease_ms INTEGER NOT NULL) STRICT',
  budget_overrides: 'CREATE TABLE budget_overrides (bot_id TEXT NOT NULL REFERENCES budget_settings(bot_id) ON DELETE CASCADE, conversation_key TEXT NOT NULL, enabled INTEGER CHECK(enabled IN (0,1)), limit_micros INTEGER CHECK(limit_micros>=0), PRIMARY KEY(bot_id,conversation_key)) STRICT',
  budget_reservations: "CREATE TABLE budget_reservations (bot_id TEXT NOT NULL REFERENCES budget_settings(bot_id) ON DELETE CASCADE, id TEXT NOT NULL, conversation_key TEXT NOT NULL, day TEXT NOT NULL, amount_micros INTEGER NOT NULL CHECK(amount_micros>0), observed_micros INTEGER NOT NULL CHECK(observed_micros>=0), state TEXT NOT NULL CHECK(state IN ('active','settled','released','expired')), operation_id TEXT, session_id TEXT, turn_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, settled_at INTEGER, actual_micros INTEGER, PRIMARY KEY(bot_id,id), UNIQUE(bot_id,operation_id)) STRICT",
  budget_days: 'CREATE TABLE budget_days (bot_id TEXT NOT NULL REFERENCES budget_settings(bot_id) ON DELETE CASCADE, conversation_key TEXT NOT NULL, day TEXT NOT NULL, spent_micros INTEGER NOT NULL CHECK(spent_micros>=0), PRIMARY KEY(bot_id,conversation_key,day)) STRICT',
  tenant_settings: 'CREATE TABLE tenant_settings (document_path TEXT PRIMARY KEY REFERENCES state_documents(path), master_key_id TEXT, trial_version INTEGER NOT NULL, trial_enabled INTEGER NOT NULL CHECK(trial_enabled IN (0,1)), trial_daily_micros INTEGER NOT NULL CHECK(trial_daily_micros>=0), trial_total_daily_micros INTEGER NOT NULL CHECK(trial_total_daily_micros>=0)) STRICT',
  tenant_profiles: 'CREATE TABLE tenant_profiles (id TEXT PRIMARY KEY, document_path TEXT NOT NULL REFERENCES tenant_settings(document_path), owner_user_id TEXT NOT NULL REFERENCES accounts(id), name TEXT NOT NULL, model TEXT NOT NULL, version INTEGER NOT NULL, provider TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), cipher_version INTEGER NOT NULL, iv TEXT NOT NULL, auth_tag TEXT NOT NULL, ciphertext TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, invalid_reason TEXT) STRICT',
  tenant_qq_bindings: 'CREATE TABLE tenant_qq_bindings (qq TEXT PRIMARY KEY, document_path TEXT NOT NULL REFERENCES tenant_settings(document_path), user_id TEXT NOT NULL UNIQUE REFERENCES accounts(id), verified_at INTEGER NOT NULL) STRICT',
  tenant_binding_challenges: 'CREATE TABLE tenant_binding_challenges (id TEXT PRIMARY KEY, document_path TEXT NOT NULL REFERENCES tenant_settings(document_path), user_id TEXT NOT NULL REFERENCES accounts(id), qq TEXT NOT NULL, code_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL CHECK(attempts>=0 AND attempts<=5), consumed_at INTEGER) STRICT',
  tenant_owned_bots: 'CREATE TABLE tenant_owned_bots (bot_id TEXT PRIMARY KEY, document_path TEXT NOT NULL REFERENCES tenant_settings(document_path), owner_user_id TEXT NOT NULL REFERENCES accounts(id), name TEXT NOT NULL, qq TEXT NOT NULL UNIQUE, version INTEGER NOT NULL, verified_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT',
  tenant_delegations: 'CREATE TABLE tenant_delegations (bot_id TEXT NOT NULL REFERENCES tenant_owned_bots(bot_id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES accounts(id), conversation_key TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(bot_id,user_id,conversation_key)) STRICT',
  tenant_funding: 'CREATE TABLE tenant_funding (document_path TEXT NOT NULL REFERENCES tenant_settings(document_path), bot_id TEXT NOT NULL, conversation_key TEXT NOT NULL, owner_user_id TEXT NOT NULL REFERENCES accounts(id), profile_id TEXT REFERENCES tenant_profiles(id), version INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(bot_id,conversation_key)) STRICT',
  tenant_trial_overrides: 'CREATE TABLE tenant_trial_overrides (user_id TEXT PRIMARY KEY REFERENCES accounts(id), document_path TEXT NOT NULL REFERENCES tenant_settings(document_path), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), daily_micros INTEGER NOT NULL CHECK(daily_micros>=0), version INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT',
};
const INDEXES = {
  accounts_one_admin: "CREATE UNIQUE INDEX accounts_one_admin ON accounts(role) WHERE role='admin'",
  persona_live_names: 'CREATE UNIQUE INDEX persona_live_names ON persona_identities(bot_id,name) WHERE deleted=0 AND name IS NOT NULL',
  bots_live_qq: 'CREATE UNIQUE INDEX bots_live_qq ON bots(expected_qq) WHERE deleted=0',
  bots_live_port: 'CREATE UNIQUE INDEX bots_live_port ON bots(port) WHERE deleted=0',
};
function readLegacy(file) {
  try {
    const bytes = fs.readFileSync(file);
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw problem('文档不是合法UTF-8，拒绝迁移或覆盖：' + path.basename(file)); }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function kindOf(file) {
  const base = path.basename(file);
  if (base === 'console-auth.json') return 'auth';
  if (base === 'conversation-roles.json') return 'conversation-roles';
  if (base === 'conversation-sessions.json') return 'conversation-sessions';
  if (base === 'member-personas.json') return 'member-personas';
  if (base === 'bot-registry.json') return 'bot-registry';
  if (base === 'current-role.json') return 'global-role';
  if (base === 'group-budget.json' || base === 'conversation-budget.json') return 'conversation-budget';
  if (base === 'tenants.json' || base === 'tenant-state.json') return 'tenants';
  return path.extname(file).toLowerCase() === '.md' ? 'role-card' : 'json';
}
function validateText(kind, text, bot = 'primary') {
  if (text === null) return null;
  if (typeof text !== 'string') throw problem('SQLite文档必须为文本');
  if (kind === 'auth') return validateConsoleAuthText(text);
  if (kind === 'conversation-roles') return validateConversationRolesText(text);
  if (kind === 'conversation-sessions') return validateConversationSessionsText(text);
  if (kind === 'conversation-budget') return validateGroupBudgetText(text, bot);
  if (kind === 'tenants') return validateTenantText(text);
  if (kind === 'global-role') {
    let data; try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw problem('全局人设状态JSON损坏'); }
    if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).length !== 2 || !Object.hasOwn(data, 'role') || !Object.hasOwn(data, 'mode')
      || !(data.role === null || (typeof data.role === 'string' && /^[\w\u4e00-\u9fff-]{1,40}$/.test(data.role) && data.role !== 'README'))
      || !['active', 'silent'].includes(data.mode)) throw problem('全局人设状态格式不受支持，已停止改写');
    return data;
  }
  if (kind === 'role-card') { if (Buffer.byteLength(text) > 65536) throw problem('角色卡超过64KiB'); return text; }
  if (kind === 'member-personas') {
    let data; try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw problem('成员人设JSON损坏'); }
    const content = new Map((Array.isArray(data?.cards) ? data.cards : []).map(card => [card?.internalRoleName, card?.content]));
    const service = createMemberPersonaService({ botId: bot, rolesDir: 'validation-only', file: 'validation-only',
      storage: { readText: () => text, writeText: () => { throw problem('校验过程禁止写入'); }, transaction: fn => fn() },
      readRole: name => content.get(name) ?? null, listTemplates: () => [], listBindings: () => [] });
    service.list({ id: 'validation-only', role: 'admin' }); return data;
  }
  if (kind === 'bot-registry') {
    createBotManager({ read: () => text, write: () => { throw problem('校验过程禁止写入'); }, primary: { port: -1 } }).list();
    return JSON.parse(text);
  }
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw problem('JSON文档损坏，拒绝导入或覆盖'); }
  if (!data || typeof data !== 'object' || (Object.hasOwn(data, 'version') && data.version !== 1)) throw problem('JSON文档格式或版本不受支持');
  return data;
}

/** SQLite owns state after each document's one-time validated import. Legacy files remain backups. */
export function createSqliteState({ file, root, botId = 'primary' } = {}) {
  if (!file || !root) throw new Error('SQLite file and root are required');
  root = path.resolve(root); file = path.resolve(file);
  const documentPath = value => {
    const absolute = path.resolve(root, value);
    const relative = path.relative(root, absolute);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw problem('文档路径必须位于SQLite根目录内');
    return relative.split(path.sep).join('/');
  };
  documentPath(file);
  const absolutePath = key => path.join(root, ...key.split('/'));
  const validBot = id => { if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw problem('无效机器人标识'); return id; };
  validBot(botId);
  function initialLegacy() {
    const documents = [];
    for (const name of ['console-auth.json', 'conversation-roles.json', 'conversation-sessions.json', 'member-personas.json', 'bot-registry.json', 'current-role.json', 'group-budget.json', 'conversation-budget.json', 'tenants.json', 'tenant-state.json']) {
      const target = path.join(root, 'state', name), kind = kindOf(target); let raw = readLegacy(target);
      if (name === 'conversation-roles.json' && raw === null) raw = JSON.stringify(createConversationRoleStore(target, path.join(root, 'state/group-roles.json'), () => {}).read());
      validateText(kind, raw, botId); documents.push({ path: documentPath(target), kind, raw, bot: botId });
    }
    const roleDir = path.join(root, 'roles');
    if (fs.existsSync(roleDir)) for (const entry of fs.readdirSync(roleDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.toLowerCase() === 'readme.md') continue;
      const target = path.join(roleDir, entry.name), raw = readLegacy(target); validateText('role-card', raw);
      documents.push({ path: documentPath(target), kind: 'role-card', raw, bot: botId });
    }
    return documents;
  }
  // Validate legacy before even creating a new database file.
  let imported = fs.existsSync(file) ? null : initialLegacy();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) { let fd; try { fd = fs.openSync(file, 'wx', 0o600); } catch (error) { if (error.code !== 'EEXIST') throw error; } finally { if (fd !== undefined) fs.closeSync(fd); } }
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true, timeout: 5000, allowExtension: false });
  let depth = 0, sequence = 0, closed = false, ready = false, checkedSchema = -1;
  function assertFormat() {
    if (!ready) return;
    if (db.prepare('PRAGMA user_version').get().user_version !== VERSION || db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID) throw problem('SQLite格式或版本已变化，禁止降级或覆盖');
    const schema = db.prepare('PRAGMA schema_version').get().schema_version;
    if (schema !== checkedSchema) {
      for (const [name, sql] of Object.entries({ ...TABLES, ...INDEXES })) if (db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name)?.sql?.trim() !== sql.trim()) throw problem('SQLite结构校验失败：' + name);
      checkedSchema = schema;
    }
  }
  function transaction(fn) {
    if (closed) throw problem('SQLite连接已经关闭');
    assertFormat();
    const savepoint = 'state_tx_' + (++sequence), nested = depth > 0;
    db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE'); depth++; let committed = false;
    try {
      const result = fn(db);
      if (result && typeof result.then === 'function') throw problem('SQLite事务回调必须同步，不能跨await持锁');
      db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT'); committed = true; return result;
    } catch (error) { try { db.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK'); if (nested) db.exec(`RELEASE ${savepoint}`); } catch {} throw error; }
    finally { depth--; if (committed && !nested) flushMaterializations(); }
  }
  const run = (sql, ...values) => db.prepare(sql).run(...values);
  function projection(key, kind, bot, data) {
    if (kind === 'auth') {
      run('DELETE FROM auth_sessions WHERE account_id IN (SELECT id FROM accounts WHERE document_path=?)', key);
      run('DELETE FROM account_scopes WHERE account_id IN (SELECT id FROM accounts WHERE document_path=?)', key);
      const keep = new Set();
      for (const user of data?.users || []) {
        keep.add(user.id);
        run('INSERT INTO accounts VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,role=excluded.role,disabled=excluded.disabled,password_algorithm=excluded.password_algorithm,password_salt=excluded.password_salt,password_hash=excluded.password_hash,password_version=excluded.password_version,created_at=excluded.created_at,updated_at=excluded.updated_at', user.id, key, user.username, user.role, Number(user.disabled), user.password.algorithm, user.password.salt, user.password.key, user.passwordVersion, user.createdAt, user.updatedAt);
        for (const scope of consoleBotScopes(user)) run('INSERT INTO account_scopes VALUES (?,?,?)', user.id, scope.botId, scope.key);
      }
      for (const row of db.prepare('SELECT id FROM accounts WHERE document_path=?').all(key)) if (!keep.has(row.id)) run('DELETE FROM accounts WHERE id=?', row.id);
      for (const session of data?.sessions || []) run('INSERT INTO auth_sessions VALUES (?,?,?,?,?)', session.hash, session.userId, session.passwordVersion, session.createdAt, session.expiresAt);
    } else if (kind === 'conversation-roles') {
      run('DELETE FROM conversation_roles WHERE document_path=?', key);
      for (const [conversation, role] of Object.entries(data?.roles || {})) run('INSERT INTO conversation_roles VALUES (?,?,?,?)', bot, conversation, role, key);
    } else if (kind === 'conversation-sessions') {
      run('UPDATE persona_identities SET deleted=1 WHERE document_path=?', key);
      for (const [id, persona] of Object.entries(data?.personas || {})) run('INSERT INTO persona_identities VALUES (?,?,?,?,?) ON CONFLICT(bot_id,id) DO UPDATE SET name=excluded.name,deleted=excluded.deleted', bot, id, key, persona.name, Number(persona.deleted));
      for (const [id, record] of Object.entries(data?.records || {})) run('INSERT INTO archive_records VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(bot_id,id) DO UPDATE SET conversation_key=excluded.conversation_key,persona_id=excluded.persona_id,session_id=excluded.session_id,policy=excluded.policy,created_at=excluded.created_at,last_used_at=excluded.last_used_at,blocked=excluded.blocked,missing=excluded.missing', bot, id, key, record.key, record.personaId, record.sessionId, record.policy, record.createdAt, record.lastUsedAt, Number(record.blocked), Number(record.missing));
      run('DELETE FROM selected_sessions WHERE document_path=?', key);
      for (const [conversation, id] of Object.entries(data?.selected || {})) run('INSERT INTO selected_sessions VALUES (?,?,?,?)', bot, conversation, id, key);
      for (const row of db.prepare('SELECT id FROM archive_records WHERE document_path=?').all(key)) if (!Object.hasOwn(data?.records || {}, row.id)) run('DELETE FROM archive_records WHERE bot_id=? AND id=?', bot, row.id);
      for (const row of db.prepare('SELECT id FROM persona_identities WHERE document_path=?').all(key)) if (!Object.hasOwn(data?.personas || {}, row.id)) run('DELETE FROM persona_identities WHERE bot_id=? AND id=?', bot, row.id);
    } else if (kind === 'role-card') {
      if (data === null) run('DELETE FROM role_cards WHERE path=?', key);
      else run('INSERT INTO role_cards VALUES (?,?,?,?) ON CONFLICT(path) DO UPDATE SET bot_id=excluded.bot_id,name=excluded.name,content=excluded.content', key, bot, path.basename(key, '.md'), data);
    } else if (kind === 'bot-registry') {
      const keep = new Set();
      for (const row of Object.values(data?.bots || {})) {
        keep.add(row.id);
        run('INSERT INTO bots VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,expected_qq=excluded.expected_qq,actual_qq=excluded.actual_qq,port=excluded.port,machine_token=excluded.machine_token,enabled=excluded.enabled,verified_at=excluded.verified_at,deleted=excluded.deleted', row.id, key, row.name, row.expectedQQ, row.actualQQ, row.port, row.machineToken, Number(row.enabled), row.verifiedAt, Number(row.deleted));
      }
      for (const row of db.prepare('SELECT id FROM bots WHERE document_path=?').all(key)) if (!keep.has(row.id)) run('DELETE FROM bots WHERE id=?', row.id);
    } else if (kind === 'tenants') {
      const before = db.prepare('SELECT document_path FROM tenant_settings').all().find(row => row.document_path !== key);
      if (data !== null && before) throw problem('同一数据库不能使用两份用户空间文档');
      run('DELETE FROM tenant_funding WHERE document_path=?', key);
      run('DELETE FROM tenant_delegations WHERE bot_id IN (SELECT bot_id FROM tenant_owned_bots WHERE document_path=?)', key);
      run('DELETE FROM tenant_owned_bots WHERE document_path=?', key);
      run('DELETE FROM tenant_binding_challenges WHERE document_path=?', key);
      run('DELETE FROM tenant_qq_bindings WHERE document_path=?', key);
      run('DELETE FROM tenant_trial_overrides WHERE document_path=?', key);
      run('DELETE FROM tenant_profiles WHERE document_path=?', key);
      if (data === null) { run('DELETE FROM tenant_settings WHERE document_path=?', key); return; }
      run('INSERT INTO tenant_settings VALUES (?,?,?,?,?,?) ON CONFLICT(document_path) DO UPDATE SET master_key_id=excluded.master_key_id,trial_version=excluded.trial_version,trial_enabled=excluded.trial_enabled,trial_daily_micros=excluded.trial_daily_micros,trial_total_daily_micros=excluded.trial_total_daily_micros', key, data.masterKeyId, data.trial.version, Number(data.trial.enabled), Math.round(data.trial.dailyLimitCny * 1e6), Math.round(data.trial.totalDailyLimitCny * 1e6));
      for (const p of data.profiles) run('INSERT INTO tenant_profiles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', p.id, key, p.ownerUserId, p.name, p.model, p.version, p.provider, Number(p.enabled), Number(p.deleted), p.encrypted.version, p.encrypted.iv, p.encrypted.tag, p.encrypted.ciphertext, p.createdAt, p.updatedAt, p.invalidReason);
      for (const row of data.bindings) run('INSERT INTO tenant_qq_bindings VALUES (?,?,?,?)', row.qq, key, row.userId, row.verifiedAt);
      for (const row of data.challenges) run('INSERT INTO tenant_binding_challenges VALUES (?,?,?,?,?,?,?,?,?)', row.id, key, row.userId, row.qq, row.codeHash, row.createdAt, row.expiresAt, row.attempts, row.consumedAt);
      for (const row of data.ownedBots) run('INSERT INTO tenant_owned_bots VALUES (?,?,?,?,?,?,?,?,?)', row.botId, key, row.ownerUserId, row.name, row.qq, row.version, row.verifiedAt, row.createdAt, row.updatedAt);
      for (const row of data.delegations) for (const conversation of row.keys) run('INSERT INTO tenant_delegations VALUES (?,?,?,?,?)', row.botId, row.userId, conversation, row.version, row.updatedAt);
      for (const row of data.funding) run('INSERT INTO tenant_funding VALUES (?,?,?,?,?,?,?)', key, row.botId, row.key ?? '', row.ownerUserId, row.profileId, row.version, row.updatedAt);
      for (const row of data.trialOverrides) run('INSERT INTO tenant_trial_overrides VALUES (?,?,?,?,?,?)', row.userId, key, Number(row.enabled), Math.round(row.dailyLimitCny * 1e6), row.version, row.updatedAt);
    } else if (kind === 'conversation-budget') {
      const before = db.prepare('SELECT document_path FROM budget_settings WHERE bot_id=?').get(bot);
      if (data === null) { if (before?.document_path === key) run('DELETE FROM budget_settings WHERE bot_id=?', bot); return; }
      if (before && before.document_path !== key) throw problem('同一机器人不能使用两个预算文档');
      const config = data.config, unit = value => Math.round(value * 1_000_000);
      run('INSERT INTO budget_settings VALUES (?,?,?,?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET config_version=excluded.config_version,enabled=excluded.enabled,default_limit_micros=excluded.default_limit_micros,default_reservation_micros=excluded.default_reservation_micros,lease_ms=excluded.lease_ms', bot, key, data.configVersion, Number(config.enabled), unit(config.defaultDailyLimitCny), unit(config.defaultReservationCny), config.leaseMs);
      run('DELETE FROM budget_overrides WHERE bot_id=?', bot);
      run('DELETE FROM budget_reservations WHERE bot_id=?', bot);
      run('DELETE FROM budget_days WHERE bot_id=?', bot);
      for (const [conversation, override] of Object.entries(config.groups)) run('INSERT INTO budget_overrides VALUES (?,?,?,?)', bot, conversation, override.enabled === undefined ? null : Number(override.enabled), override.dailyLimitCny === undefined ? null : unit(override.dailyLimitCny));
      for (const row of data.reservations) run('INSERT INTO budget_reservations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', bot, row.id, row.key, row.date, unit(row.amountCny), unit(row.observedCostCny), row.state, row.operationId, row.sessionId, row.turnId, row.createdAt, row.updatedAt, row.expiresAt, row.settledAt, row.actualCny === null ? null : unit(row.actualCny));
      for (const row of data.days) run('INSERT INTO budget_days VALUES (?,?,?,?)', bot, row.key, row.date, unit(row.spentCny));
    } else if (kind === 'member-personas') {
      const keep = new Set();
      for (const card of data?.cards || []) {
        keep.add(card.id);
        run('INSERT INTO member_cards VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(bot_id,id) DO UPDATE SET owner_user_id=excluded.owner_user_id,internal_role_name=excluded.internal_role_name,name=excluded.name,content=excluded.content,version=excluded.version,created_at=excluded.created_at,updated_at=excluded.updated_at', bot, card.id, key, card.ownerUserId, card.internalRoleName, card.name, card.content, card.version, card.createdAt, card.updatedAt);
        run('DELETE FROM member_revisions WHERE bot_id=? AND card_id=?', bot, card.id);
        for (const row of card.history) run('INSERT INTO member_revisions VALUES (?,?,?,?,?,?,?)', bot, card.id, row.version, row.name, row.content, row.createdAt, row.authorUserId);
      }
      for (const row of db.prepare('SELECT id FROM member_cards WHERE document_path=?').all(key)) if (!keep.has(row.id)) run('DELETE FROM member_cards WHERE bot_id=? AND id=?', bot, row.id);
    }
  }
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const application = db.prepare('PRAGMA application_id').get().application_id;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (version === 0 && !tables.length && application === 0) {
      imported ||= initialLegacy();
      transaction(() => {
        for (const sql of [...Object.values(TABLES), ...Object.values(INDEXES)]) db.exec(sql);
        db.exec(`PRAGMA user_version=${VERSION}; PRAGMA application_id=${APPLICATION_ID}`);
        run('INSERT INTO state_meta VALUES (?,?)', 'format', 'qq-bridge-sqlite-state-v1');
        for (const doc of imported) {
          run('INSERT INTO state_documents VALUES (?,?,?,?,?,?)', doc.path, doc.kind, doc.bot, doc.raw, 1, Date.now());
          projection(doc.path, doc.kind, doc.bot, validateText(doc.kind, doc.raw, doc.bot));
        }
        run('INSERT INTO state_meta VALUES (?,?)', 'primary_legacy_imported', '1');
      });
    } else {
      if (version !== VERSION || application !== APPLICATION_ID) throw problem('SQLite格式或版本不受支持，禁止降级或覆盖');
      for (const [name, sql] of Object.entries({ ...TABLES, ...INDEXES })) {
        const actual = db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name)?.sql;
        if (actual?.trim() !== sql.trim()) throw problem('SQLite结构校验失败：' + name);
      }
      if (db.prepare("SELECT value FROM state_meta WHERE key='format'").get()?.value !== 'qq-bridge-sqlite-state-v1'
        || db.prepare("SELECT value FROM state_meta WHERE key='primary_legacy_imported'").get()?.value !== '1') throw problem('SQLite迁移元数据不完整');
    }
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw problem('SQLite完整性校验失败');
    fs.chmodSync(file, 0o600);
    ready = true; assertFormat();
  } catch (error) { db.close(); closed = true; throw error; }

  function rowFor(value, bot) {
    assertFormat();
    const key = documentPath(value); let row = db.prepare('SELECT * FROM state_documents WHERE path=?').get(key);
    if (!row) transaction(() => {
      row = db.prepare('SELECT * FROM state_documents WHERE path=?').get(key);
      if (row) return;
      const kind = kindOf(key), raw = readLegacy(absolutePath(key)); const data = validateText(kind, raw, bot);
      run('INSERT INTO state_documents VALUES (?,?,?,?,?,?)', key, kind, bot, raw, 1, Date.now()); projection(key, kind, bot, data);
      row = db.prepare('SELECT * FROM state_documents WHERE path=?').get(key);
    });
    if (row.bot_id !== bot && row.kind !== 'auth') throw problem('SQLite文档不属于当前机器人');
    return row;
  }
  function readText(value, bot = botId) {
    const row = rowFor(value, bot);
    if (row.raw_text === null) throw missing(value);
    validateText(row.kind, row.raw_text, row.bot_id); return row.raw_text;
  }
  function writeInternal(value, text, expected, bot) {
    if (expected === undefined || (expected !== null && typeof expected !== 'string')) throw problem('SQLite写入必须提供读取到的expectedText，禁止无条件覆盖');
    const key = documentPath(value), kind = kindOf(key), data = validateText(kind, text, bot);
    return transaction(() => {
      const row = rowFor(value, bot);
      if (row.raw_text !== expected) throw problem('SQLite文档在操作期间发生变化，已停止改写，请重试');
      if (row.raw_text === text) return row.revision;
      run('UPDATE state_documents SET raw_text=?,revision=revision+1 WHERE path=?', text, key);
      projection(key, kind, bot, data);
      const revision = row.revision + 1;
      if (kind === 'role-card') run('INSERT INTO role_materializations VALUES (?,?) ON CONFLICT(path) DO UPDATE SET revision=excluded.revision', key, revision);
      return revision;
    });
  }
  function materializeText(value) {
    assertFormat();
    const key = documentPath(value), row = db.prepare('SELECT * FROM state_documents WHERE path=?').get(key);
    if (!row || row.kind !== 'role-card') throw problem('只支持物化已迁移角色卡');
    const target = absolutePath(key), text = row.raw_text;
    try {
      if (text === null) fs.rmSync(target, { force: true });
      else if (readLegacy(target) !== text) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const temp = target + '.' + crypto.randomBytes(12).toString('hex') + '.tmp'; let fd;
        try { fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temp, target); }
        finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
      }
      run('DELETE FROM role_materializations WHERE path=? AND revision=?', key, row.revision);
    } catch (error) { throw Object.assign(problem('角色卡已提交数据库但文件镜像未同步，请重试物化：' + error.message), { committed: true }); }
  }
  function flushMaterializations() { if (depth) return; for (const row of db.prepare('SELECT path FROM role_materializations').all()) materializeText(absolutePath(row.path)); }
  function writeText(value, text, expected, bot = botId) { const result = writeInternal(value, text, expected, bot); flushMaterializations(); return result; }
  const adapter = bot => ({
    db, file, root, botId: validBot(bot), transaction,
    readText: value => readText(value, bot),
    writeText: (value, text, expected) => writeText(value, text, expected, bot),
    deleteText: (value, expected) => writeText(value, null, expected, bot),
    renameText(from, to, expectedFrom, expectedTo = null) {
      transaction(() => { writeInternal(to, expectedFrom, expectedTo, bot); writeInternal(from, null, expectedFrom, bot); }); flushMaterializations();
    },
    listDocuments(prefix = root) {
      const resolved = path.resolve(root, prefix);
      const relative = resolved === root ? '' : documentPath(resolved).replace(/\/$/, '') + '/';
      return db.prepare('SELECT path,kind,revision FROM state_documents WHERE bot_id=? AND raw_text IS NOT NULL ORDER BY path').all(bot)
        .filter(row => row.path.startsWith(relative)).map(row => ({ ...row, file: absolutePath(row.path) }));
    },
    materializeText, flushMaterializations,
    forBot: id => adapter(validBot(id)),
    close() { if (!closed) { db.close(); closed = true; } },
  });
  // The database is authoritative: repair worker mirrors, without touching an
  // unchanged original during migration. A failed mirror prevents worker start.
  try { for (const row of db.prepare("SELECT path FROM state_documents WHERE kind='role-card'").all()) materializeText(absolutePath(row.path)); flushMaterializations(); }
  catch (error) { db.close(); closed = true; throw error; }
  return adapter(botId);
}
