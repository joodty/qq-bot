import crypto from 'node:crypto';

export const TENANT_CHAT_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const TENANT_CHAT_MODELS = Object.freeze(['deepseek-flash', 'deepseek-v4-pro']);
const MAX_HISTORY = 20, MAX_INPUT_BYTES = 24_000, MAX_MESSAGE = 8_000, MAX_RESPONSE = 128_000;
const own = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key));
const ident = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
const failure = (code, message) => ({ handled: true, ok: false, error: { code, message } });
const safeError = code => ({ code, message: ({ AUTH: '你的模型密钥无效，请更新后再试。', BALANCE: '你的模型账户余额不足，已停止调用。', TIMEOUT: '模型请求超时，已停止；不会改用平台密钥。', BUSY: '当前请求较多，请稍后再试。', STALE: '人设或付费配置已变化，本次回复已停止。', STORAGE: '聊天档案暂不可用，已停止调用以保护原记录。', PROVIDER: '模型服务暂不可用，已停止；不会改用平台密钥。', BUDGET: '此会话今日额度不足或正在节流，请稍后再试。' })[code] || '聊天暂不可用，已停止本次调用。' });
function archiveKey(context) { return crypto.createHash('sha256').update(JSON.stringify([context.ownerUserId, context.botId, context.key, context.personaId, context.profileId])).digest('hex'); }
function validate(text) {
  let data; try { data = JSON.parse(text); } catch { throw new Error('STORAGE'); }
  if (!own(data, ['version', 'archives']) || data.version !== 1 || !Array.isArray(data.archives) || data.archives.length > 10000) throw new Error('STORAGE');
  const ids = new Set();
  for (const row of data.archives) {
    if (!own(row, ['id', 'ownerUserId', 'botId', 'key', 'personaId', 'profileId', 'messages', 'updatedAt'])
      || !['id', 'ownerUserId', 'botId', 'key', 'personaId', 'profileId'].every(field => ident(row[field]))
      || row.id !== archiveKey(row) || ids.has(row.id) || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0
      || !Array.isArray(row.messages) || row.messages.length > MAX_HISTORY || row.messages.length % 2 !== 0) throw new Error('STORAGE');
    ids.add(row.id);
    for (let i = 0; i < row.messages.length; i++) if (!own(row.messages[i], ['role', 'content']) || row.messages[i].role !== (i % 2 ? 'assistant' : 'user')
      || typeof row.messages[i].content !== 'string' || row.messages[i].content.length > MAX_MESSAGE) throw new Error('STORAGE');
    if (Buffer.byteLength(JSON.stringify(row.messages)) > MAX_INPUT_BYTES) throw new Error('STORAGE');
  }
  return data;
}
function normalizeUsage(value) {
  if (!value || !['prompt_tokens', 'completion_tokens'].every(field => Number.isSafeInteger(value[field]) && value[field] >= 0)) throw new Error('PROVIDER');
  const hit = value.prompt_cache_hit_tokens ?? value.prompt_tokens_details?.cached_tokens ?? 0;
  const miss = value.prompt_cache_miss_tokens ?? value.prompt_tokens - hit;
  if (![hit, miss].every(n => Number.isSafeInteger(n) && n >= 0) || hit + miss !== value.prompt_tokens) throw new Error('PROVIDER');
  return { inputTokens: miss, cacheReadTokens: hit, cacheWriteTokens: 0, outputTokens: value.completion_tokens,
    prompt_tokens: value.prompt_tokens, completion_tokens: value.completion_tokens, prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: miss };
}
async function readResponse(response) {
  const length = Number(response.headers?.get?.('content-length'));
  if (length > MAX_RESPONSE) throw new Error('PROVIDER');
  if (!response.body?.getReader) {
    const text = await response.text(); if (Buffer.byteLength(text) > MAX_RESPONSE) throw new Error('PROVIDER'); return JSON.parse(text);
  }
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > MAX_RESPONSE) throw new Error('PROVIDER'); chunks.push(Buffer.from(chunk.value)); } }
  finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Direct BYOK chat; funding secrets never leave this module's provider request.
 * Storage is the manager SQLite document adapter (transaction + readText/writeText CAS).
 * No local tools, platform credential fallback, custom endpoints, or redirects.
 */
export function createTenantChat({ storage, file, resolveFunding, getPersona, admit, settle, onUsage, fetchImpl = fetch, sendMessage, now = Date.now,
  timeoutMs = 30_000, maxConcurrent = 8, maxTenantConcurrent = 2, maxQueued = 32 } = {}) {
  if (!storage?.transaction || !storage?.readText || !storage?.writeText || !file || ![resolveFunding, getPersona, admit, settle, onUsage, sendMessage].every(fn => typeof fn === 'function')) throw new Error('Tenant chat dependencies required');
  const locks = new Map(), tenants = new Map(), cooldowns = new Map(); let active = 0, queued = 0;
  function load() {
    let raw; try { raw = storage.readText(file); } catch (error) { if (error.code !== 'ENOENT') throw new Error('STORAGE'); raw = null; }
    return { raw, data: raw === null ? { version: 1, archives: [] } : validate(raw) };
  }
  function history(context) { return storage.transaction(() => load().data.archives.find(row => row.id === archiveKey(context))?.messages ?? []); }
  function save(context, previous, messages) {
    return storage.transaction(() => {
      const { raw, data } = load(), id = archiveKey(context), current = data.archives.find(row => row.id === id);
      if (JSON.stringify(current?.messages ?? []) !== JSON.stringify(previous)) throw new Error('STORAGE');
      const trimmed = messages.slice(-MAX_HISTORY);
      while (trimmed.length && Buffer.byteLength(JSON.stringify(trimmed)) > MAX_INPUT_BYTES) trimmed.splice(0, 2);
      const row = { id, ownerUserId: context.ownerUserId, botId: context.botId, key: context.key, personaId: context.personaId, profileId: context.profileId, messages: trimmed, updatedAt: now() };
      if (current) Object.assign(current, row); else data.archives.push(row);
      const next = JSON.stringify(data); validate(next); storage.writeText(file, next, raw);
    });
  }
  async function identity(input) {
    const funding = await resolveFunding(input);
    if (!funding) throw new Error('AUTH');
    if (['trial', 'platform'].includes(funding.mode)) return { fallback: true };
    if (funding.mode !== 'byok' || !ident(funding.ownerUserId) || !ident(funding.profileId)
      || !Number.isSafeInteger(funding.credentialVersion) || funding.credentialVersion < 1
      || typeof funding.apiKey !== 'string' || !funding.apiKey || funding.apiKey.length > 512 || /[\x00-\x20\x7f]/.test(funding.apiKey)
      || !TENANT_CHAT_MODELS.includes(funding.model) || funding.endpoint !== 'https://api.deepseek.com') throw new Error('AUTH');
    const persona = await getPersona({ ...input, ownerUserId: funding.ownerUserId });
    const prompt = persona?.prompt ?? persona?.content;
    if (!ident(persona?.id) || typeof prompt !== 'string' || prompt.length > MAX_MESSAGE) throw new Error('STALE');
    return { funding, persona: { id: persona.id, prompt }, signature: crypto.createHash('sha256').update(JSON.stringify([funding.ownerUserId, funding.profileId, funding.credentialVersion, funding.apiKey, funding.model, persona.id, prompt])).digest('hex') };
  }
  async function run(input) {
    let first, context, reservation, usageReport, attempted = false, charged = false, settled = false, providerRejected = false;
    const requestId = crypto.randomUUID();
    try {
      first = await identity(input); if (first.fallback) return { handled: false, ok: true };
      context = { botId: input.botId, key: input.key, ownerUserId: first.funding.ownerUserId, profileId: first.funding.profileId, personaId: first.persona.id, model: first.funding.model, requestId };
      if (active >= maxConcurrent || (tenants.get(context.ownerUserId) || 0) >= maxTenantConcurrent) return failure('BUSY', safeError('BUSY').message);
      active++; tenants.set(context.ownerUserId, (tenants.get(context.ownerUserId) || 0) + 1);
      try {
        const previous = history(context);
        const current = async () => {
          if (input.guard && !(await input.guard())) throw new Error('STALE');
          const latest = await identity(input); if (latest.fallback || latest.signature !== first.signature) throw new Error('STALE');
        };
        await current();
        let messages = [...previous, { role: 'user', content: input.text }];
        const basePrompt = first.persona.prompt + '\n只能进行文本聊天。没有本地命令、文件或QQ管理工具；不要声称已执行操作。';
        while (messages.length > 1 && Buffer.byteLength(JSON.stringify(messages)) + Buffer.byteLength(basePrompt) > MAX_INPUT_BYTES) messages.splice(0, 2);
        if (Buffer.byteLength(JSON.stringify(messages)) + Buffer.byteLength(basePrompt) > MAX_INPUT_BYTES) throw new Error('PROVIDER');
        reservation = await admit({ ...context, maxTokens: 1024, inputTokenUpperBound: Buffer.byteLength(JSON.stringify(messages)) + Buffer.byteLength(basePrompt) });
        if (!reservation?.allowed) throw new Error('BUDGET');
        const degraded = reservation.state === 'degraded' || reservation.action === 'degrade';
        if (degraded && now() - (cooldowns.get(archiveKey(context)) ?? -Infinity) < 60_000) throw new Error('BUDGET');
        const maxTokens = degraded ? 256 : 1024;
        const system = basePrompt + (degraded ? '\n本轮最多120字，仅一条简短回复，不主动开启话题。' : '');
        await current(); cooldowns.set(archiveKey(context), now());
        const controller = new AbortController(); let timer;
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('TIMEOUT')); }, timeoutMs); });
        let parsed;
        try {
          attempted = true;
          parsed = await Promise.race([(async () => {
            const response = await fetchImpl(TENANT_CHAT_ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
              headers: { 'content-type': 'application/json', authorization: 'Bearer ' + first.funding.apiKey },
              body: JSON.stringify({ model: context.model, messages: [{ role: 'system', content: system }, ...messages], max_tokens: maxTokens, thinking: { type: 'disabled' }, stream: false }) });
            if (!response.ok) { const status = response.status; providerRejected = [400, 401, 402, 403, 404, 422, 429].includes(status); throw new Error(status === 401 || status === 403 ? 'AUTH' : status === 402 ? 'BALANCE' : 'PROVIDER'); }
            if (response.redirected) throw new Error('PROVIDER');
            return readResponse(response);
          })(), timeout]);
        } finally { clearTimeout(timer); }
        const usage = normalizeUsage(parsed?.usage); usageReport = usage; charged = true;
        await onUsage({ ...context, usage, at: now() });
        const content = parsed?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim() || content.length > MAX_MESSAGE) throw new Error('PROVIDER');
        const redacted = content.split(first.funding.apiKey).join('[已隐藏密钥]');
        const answer = degraded ? [...redacted].slice(0, 120).join('') : redacted;
        await current();
        save(context, previous, [...messages.map(message => ({ ...message, content: message.content.split(first.funding.apiKey).join('[已隐藏密钥]') })), { role: 'assistant', content: answer }]);
        await settle(reservation.id ?? null, { ...context, usage, outcome: 'success', charged: true }); settled = true;
        await current(); await sendMessage(context, answer, current);
        return { handled: true, ok: true, requestId };
      } finally { active--; tenants.set(context.ownerUserId, Math.max(0, (tenants.get(context.ownerUserId) || 1) - 1)); }
    } catch (error) {
      const known = safeError(['AUTH', 'BALANCE', 'TIMEOUT', 'BUSY', 'STALE', 'STORAGE', 'PROVIDER', 'BUDGET'].includes(error?.message) ? error.message : 'PROVIDER');
      if (reservation?.allowed && !settled) {
        try { await settle(reservation.id ?? null, { ...context, ...(usageReport ? { usage: usageReport } : {}), outcome: charged ? 'success' : attempted && !providerRejected ? 'uncertain' : 'rejected', charged, reason: known.code }); } catch {}
      }
      return failure(known.code, known.message);
    }
  }
  return {
    async chat(input) {
      if (!input || !ident(input.botId) || !/^(group|private):[1-9]\d*$/.test(String(input.key)) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > MAX_MESSAGE) return failure('INVALID', '消息或会话无效。');
      if (queued >= maxQueued) return failure('BUSY', safeError('BUSY').message);
      const key = JSON.stringify([input.botId, input.key]);
      const previous = locks.get(key) || Promise.resolve(); queued++;
      const pending = previous.catch(() => {}).then(() => run(input)); locks.set(key, pending);
      try { return await pending; } finally { queued--; if (locks.get(key) === pending) locks.delete(key); }
    },
    pending: () => ({ active, queued }),
  };
}
