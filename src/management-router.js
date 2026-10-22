// Account-authorized management routing. Worker credentials never reach browsers.
import { normalizeConsoleScopeKey, canAccessConversation } from './console-auth.js';

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const actions = Object.freeze({
  'GET /api/member/overview': 'overview',
  'GET /api/member/personas': 'list',
  'POST /api/member/personas/create': 'create',
  'POST /api/member/personas/update': 'update',
  'POST /api/member/personas/apply': 'apply',
  'GET /api/member/personas/history': 'history',
  'POST /api/member/personas/restore': 'restore',
});
export function hasBotAccess(principal, botId) {
  return principal?.role === 'admin' || (principal?.role === 'user' && (
    principal.ownedBotIds?.includes(botId)
    ||
    (botId === 'primary' && principal.conversationKeys?.length > 0)
    || principal.botScopes?.some(scope => scope.botId === botId)));
}
function trustedUser(value) {
  if (!value || !['admin', 'user'].includes(value.role)
      || (value.role === 'user' && !/^[a-f0-9]{32}$/.test(value.id))) throw fail(403, '无效的管理器账号身份');
  const scopes = Array.isArray(value.botScopes) ? value.botScopes : [];
  if (scopes.length > 1000 || scopes.some(s => !s || typeof s.botId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(s.botId)
      || normalizeConsoleScopeKey(s.key) !== s.key)) throw fail(403, '无效的管理器授权');
  return { id: value.id ?? null, username: String(value.username || ''), role: value.role,
    conversationKeys: (value.conversationKeys || []).map(normalizeConsoleScopeKey),
    botScopes: scopes.map(({ botId, key }) => ({ botId, key })),
    ownedBotIds: (value.ownedBotIds || []).filter(id => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) };
}

export function ownerProxyAllowed(method, pathname, body) {
  if (method === 'GET') return /^\/api\/(status|sessions|roles(?:\/content)?|role|role-mode|whitelist|conversation-roles|group-roles|conversation-sessions|conversation-budgets|group-budgets|tokens\/(?:summary|daily|series|turns|recent)|social|socialV2\/(?:config|activity|state|states|unread|recent|wake-config|initial-prompt|memory|sticker-list|voices|feedback|tool-log|active-members))$/.test(pathname);
  if (method !== 'POST') return false;
  if (['/api/social','/api/socialV2/config'].includes(pathname)) {
    const protectedFields = new Set(['agentpreset','learnerpreset','closedagentpreset','sessioncwd','homedir','path','dir','executable','command','apikey','token','authorization']);
    const protectedValue = (value, depth=0) => depth>20 || !!value && typeof value==='object' && Object.entries(value).some(([key,child])=>protectedFields.has(key.toLowerCase()) || protectedValue(child,depth+1));
    if(protectedValue(body))return false;
  }
  if (pathname === '/api/mode') return ['chat','reserved','reserved2','simulation'].includes(body?.mode) && !Object.hasOwn(body || {},'closedAgentPreset');
  return /^\/api\/(role|role-mode|roles\/(?:create|update|rename|delete|limit)|whitelist|conversation-roles|group-roles|conversation-sessions\/(?:activate|new|delete)|conversation-budgets|group-budgets|session\/reset|social|socialV2\/(?:config|activity|wake-config|wake|mark-read|memory-append|memory-update|memory-remove|memory-clear))$/.test(pathname);
}

export function createManagementRouter({ manager, memberService, botId = 'primary', worker = false,
  instance, overview, budget, conversationKeys = () => [], conversationLabel = key => key, setPeerQQs = () => {}, afterRegistryChange = async () => {} }) {
  async function member(action, principal, payload) {
    if (!hasBotAccess(principal, botId)) throw fail(403, '没有此机器人的授权');
    if (action === 'overview') return overview(principal);
    if (!['list', 'create', 'update', 'apply', 'history', 'restore'].includes(action)) throw fail(404, '未知成员操作');
    if (action === 'apply' && !canAccessConversation(principal, payload?.key, botId)) throw fail(403, '该群或私聊未授权');
    const result = await memberService[action](principal, payload);
    // Continue/new-session results are intentionally private to administrators.
    if (result && typeof result === 'object') {
      delete result.sessionId; delete result.recordId; delete result.dshSessionId;
    }
    return result;
  }
  return async function route({ req, url, principal, isAgent, tokenMatches,
    readBody, sendJson, writeAllowed }) {
    const routePath = url.pathname;
    const recognized = routePath === '/api/instance' || routePath.startsWith('/api/instance/')
      || routePath.startsWith('/api/internal/') || routePath === '/api/bots' || routePath.startsWith('/api/bots/')
      || routePath.startsWith('/api/member/') || ['/api/conversation-budgets','/api/group-budgets'].includes(routePath);
    if (!recognized) return false;
    try {
      if (isAgent) throw fail(403, '智能体不可访问管理账号或机器人目录');
      if (!principal) throw fail(401, '请先登录');
      if (req.method !== 'GET') writeAllowed();
      if (['/api/conversation-budgets','/api/group-budgets'].includes(routePath)) {
        if(principal.role!=='admin')throw fail(403,'仅管理员可配置机器人会话额度');
        if(!budget)throw fail(503,'此实例未启用持久预算存储');
        if(req.method==='POST') { const config=budget.update(await readBody());sendJson({ok:true,config});return true; }
        if(req.method==='GET') { const data=budget.overview(conversationKeys());data.conversations=data.conversations.map(row=>({...row,label:conversationLabel(row.key)}));data.groups=data.conversations;sendJson({ok:true,...data});return true; }
        throw fail(405,'请求方法不支持');
      }
      if (routePath === '/api/instance' && req.method === 'GET') {
        if (!tokenMatches || req.headers.cookie || !req.headers['x-console-token']) throw fail(403, '仅内部机器通道可核验实例');
        sendJson(instance()); return true;
      }
      if (routePath === '/api/instance/peers' && req.method === 'POST') {
        if (!worker || !tokenMatches || req.headers.cookie || !req.headers['x-console-token']) throw fail(403, '仅工作实例内部通道可同步机器人身份');
        const body = await readBody();
        if (!Array.isArray(body.qqs) || body.qqs.length > 200 || body.qqs.some(q => !/^[1-9]\d{0,15}$/.test(String(q)))) throw fail(400, '机器人 QQ 列表无效');
        setPeerQQs(body.qqs.map(String)); sendJson({ ok: true }); return true;
      }
      if (routePath === '/api/internal/member' && req.method === 'POST') {
        if (!worker || !tokenMatches || req.headers.cookie || !req.headers['x-console-token']) throw fail(403, '仅工作实例内部通道可执行成员操作');
        const body = await readBody(), user = trustedUser(body.principal);
        sendJson(await member(body.action, user, body.payload || {})); return true;
      }
      if (routePath.startsWith('/api/internal/') || routePath.startsWith('/api/instance/')) throw fail(404, '接口不存在');
      if (worker && (routePath === '/api/bots' || routePath.startsWith('/api/bots/'))) throw fail(403, '请使用统一管理入口');
      if (routePath === '/api/bots') {
        if (req.method === 'GET') {
          sendJson({ ok: true, bots: manager.list().filter(bot => hasBotAccess(principal, bot.id)) }); return true;
        }
        if (req.method === 'POST') {
          if (principal.role !== 'admin') throw fail(403, '仅管理员可添加机器人');
          const bot = manager.add(await readBody()); await afterRegistryChange();
          sendJson({ ok: true, bot }); return true;
        }
      }
      const target = /^\/api\/bots\/([a-z0-9][a-z0-9-]{0,63})(\/.*)?$/.exec(routePath);
      if (target) {
        const targetId = target[1], suffix = target[2] || '';
        if (!hasBotAccess(principal, targetId)) throw fail(403, '没有此机器人的授权');
        if (req.method === 'POST' && ['/verify', '/update', '/remove'].includes(suffix)) {
          if (principal.role !== 'admin' && !principal.ownedBotIds?.includes(targetId)) throw fail(403, '仅机器人所有者可修改机器人接入');
          let bot;
          if (suffix === '/verify') { await readBody(); bot = await manager.verify(targetId); }
          else if (suffix === '/update') {
            const patch = await readBody();
            if(principal.role !== 'admin' && Object.keys(patch).some(k=>!['name','enabled','port','machineToken'].includes(k)))throw fail(403,'机器人身份变更须由平台管理员处理');
            bot = await manager.update(targetId, patch);
          }
          else { await readBody(); bot = manager.remove(targetId); }
          await afterRegistryChange(); sendJson({ ok: true, bot }); return true;
        }
        const memberPath = suffix.startsWith('/member/') ? '/api' + suffix : null;
        const action = memberPath && actions[req.method + ' ' + memberPath];
        if (action) {
          const payload = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readBody();
          if (targetId === botId) sendJson(await member(action, principal, payload));
          else {
            const result = await manager.proxy(targetId, { method: 'POST', path: '/api/internal/member',
              body: { action, principal: trustedUser(principal), payload } });
            sendJson(result.data, result.status);
          }
          return true;
        }
        if (suffix.startsWith('/api/')) {
          const body = req.method === 'GET' ? undefined : await readBody();
          if (principal.role !== 'admin' && (!principal.ownedBotIds?.includes(targetId) || !ownerProxyAllowed(req.method,suffix,body))) throw fail(403, '此操作超出本人机器人的业务管理权限');
          if (/^\/api\/(auth|bots|internal|instance)(\/|$)/.test(suffix)) throw fail(403, '该接口不能转发');
          if (targetId === botId) throw fail(400, '主机器人请使用原管理接口');
          const result = await manager.proxy(targetId, { method: req.method, path: suffix + url.search,
            ...(req.method === 'GET' ? {} : { body }) });
          sendJson(result.data, result.status); return true;
        }
        throw fail(404, '接口不存在');
      }
      const action = actions[req.method + ' ' + routePath];
      if (action) {
        if (worker) throw fail(403, '工作实例的成员操作须由管理器转发');
        const payload = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readBody();
        sendJson(await member(action, principal, payload)); return true;
      }
      throw fail(404, '接口不存在');
    } catch (error) {
      sendJson({ ok: false, error: error.message || '管理操作失败' }, error.statusCode || 500);
      return true;
    }
  };
}
