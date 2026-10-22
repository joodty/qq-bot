const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const partial = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
const exact = (value, fields) => partial(value, fields) && fields.every(key => Object.hasOwn(value, key));
const privateFields = new Set(['apikey', 'token', 'machinetoken', 'consoletoken', 'accesstoken', 'authorization', 'cookie', 'password', 'encrypted', 'ciphertext', 'masterkeyid', 'sessionhash', 'codehash']);
// Node's own fetch sets Sec-Fetch-Mode:cors. Origin/site/destination plus a
// cookie identify browser channels; mode alone must not reject internal Node.
const browserHeaders = ['cookie', 'origin', 'sec-fetch-site', 'sec-fetch-dest', 'x-agent-call', 'x-agent-token'];

/** Tenant browser APIs and a separate, narrowly authenticated worker funding channel. */
export function createTenantRouter({ service, auth, manager, budget, readUsage = () => null,
  updateBudget, platformBot = () => null, afterRegistryChange = async () => {}, setTrial, onFundingChange = async () => {}, onboarding } = {}) {
  if (!service || !auth || !manager) throw new Error('tenant router requires service, auth and bot manager');
  function assertAccount(principal) {
    if (!principal) throw fail(401, '请先登录用户空间');
    if (!/^[a-f0-9]{32}$/.test(principal.id) || !['admin', 'user'].includes(principal.role) || principal.disabled || principal.kind === 'token') throw fail(403, '此操作需要账号登录，机器令牌不能代替用户身份');
  }
  function accounts() {
    // Trusted server use of the existing management channel. Never returned as a directory.
    const result = auth.list({ kind: 'token', role: 'admin' });
    if (!Array.isArray(result)) throw fail(503, '账号目录暂不可用'); return result;
  }
  function resolveAccount(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/.test(value.trim())) throw fail(400, '请输入完整账号名');
    const normalized = value.trim().toLowerCase(), row = accounts().find(user => user.username === normalized && !user.disabled);
    if (!row) throw fail(404, '目标账号不存在或已停用'); return row;
  }
  function safe(value, secrets, depth = 0) {
    if (depth > 40) throw fail(503, '返回数据过深');
    if (typeof value === 'string') { for (const secret of secrets) if (secret) value = value.replaceAll(secret, '[已隐藏]'); return value; }
    if (Array.isArray(value)) return value.map(row => safe(row, secrets, depth + 1));
    if (object(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !privateFields.has(key.toLowerCase())).map(([key, item]) => [key, safe(item, secrets, depth + 1)]));
    return value;
  }
  async function route({ req, url, principal, isAgent = false, readBody, sendJson, writeAllowed }) {
    if (!url.pathname.startsWith('/api/tenant/')) return false;
    const secrets = [];
    const send = (value, code = 200) => sendJson(safe(value, secrets), code);
    try {
      if (isAgent || req.headers['x-agent-call'] !== undefined || req.headers['x-agent-token'] !== undefined) throw fail(403, '智能体不能访问用户空间和费用密钥管理');
      assertAccount(principal);
      const onboardingPrincipal={...principal};
      if(principal.kind==='session'&&typeof req.headers.cookie==='string')Object.defineProperty(onboardingPrincipal,'cookieHeader',{value:req.headers.cookie});
      const path = url.pathname;
      if (req.method === 'GET' && path === '/api/tenant/overview') {
        const overview = service.overview(principal);
        if (overview.delegations?.length) { const users = accounts(); overview.delegations = overview.delegations.map(row => ({ ...row, username: users.find(user => user.id === row.userId)?.username ?? row.userId })); }
        const usage = await readUsage(principal, overview);
        send({ ok: true, overview: { ...overview, platformBot: await platformBot(), usage } }); return true;
      }
      if(req.method==='GET'&&path==='/api/tenant/bot-requests') {
        if(!onboarding)throw fail(503,'机器人开通申请服务尚未就绪');send({ok:true,...onboarding.list(onboardingPrincipal)});return true;
      }
      if(path==='/api/tenant/bot-requests'||path.startsWith('/api/tenant/bot-requests/')) {
        if(req.method!=='POST')throw fail(405,'请求方法不支持');
        if(!onboarding)throw fail(503,'机器人开通申请服务尚未就绪');
        if(typeof writeAllowed!=='function')throw fail(503,'缺少浏览器写入来源校验');writeAllowed();
        const body=await readBody(),actions={'/api/tenant/bot-requests':'create','/api/tenant/bot-requests/prepare':'prepare','/api/tenant/bot-requests/activate':'activate','/api/tenant/bot-requests/reject':'reject'};
        const action=actions[path];if(!action)throw fail(404,'申请操作不存在');send({ok:true,request:await onboarding[action](onboardingPrincipal,body)});return true;
      }
      const posts = ['profiles/save', 'profiles/delete', 'binding/issue', 'funding', 'trial', 'budget', 'bots', 'delegations'];
      if (!posts.some(suffix => path === '/api/tenant/' + suffix)) throw fail(404, '用户空间接口不存在');
      if (req.method !== 'POST') throw fail(405, '请求方法不支持');
      if (typeof writeAllowed !== 'function') throw fail(503, '缺少浏览器写入来源校验');
      writeAllowed(); const body = await readBody();
      if (!object(body)) throw fail(400, '请求必须为JSON对象');
      for (const name of ['apiKey', 'machineToken']) if (typeof body[name] === 'string') secrets.push(body[name]);
      if (path === '/api/tenant/profiles/save') send({ ok: true, profile: service.saveProfile(principal, body) });
      else if (path === '/api/tenant/profiles/delete') send({ ok: true, ...service.deleteProfile(principal, body) });
      else if (path === '/api/tenant/binding/issue') send({ ok: true, binding: service.issueBinding(principal, body) });
      else if (path === '/api/tenant/funding') {
        const funding = service.setFunding(principal, body);
        await onFundingChange(principal, funding);
        send({ ok: true, funding });
      }
      else if (path === '/api/tenant/trial') {
        if (principal.role !== 'admin') throw fail(403, '只有平台管理员能修改平台试用额度');
        send({ ok: true, trial: await (setTrial ? setTrial(principal, body) : service.updateTrial(principal, body)) });
      }
      else if (path === '/api/tenant/budget') {
        if (!exact(body, ['version', 'dailyLimitCny'])) throw fail(400, '私聊额度参数无效');
        if (!Number.isSafeInteger(body.version) || body.version < 1 || typeof body.dailyLimitCny !== 'number' || !Number.isFinite(body.dailyLimitCny)
          || body.dailyLimitCny < 0 || body.dailyLimitCny > 1000000 || Math.abs(body.dailyLimitCny * 1e6 - Math.round(body.dailyLimitCny * 1e6)) > 0.00001) throw fail(400, '私聊额度须为有效人民币金额和版本');
        const overview = service.overview(principal);
        const selected = overview.profiles.find(profile => profile.id === overview.privateFunding?.profileId && profile.enabled);
        if (!overview.qqBinding || !selected) throw fail(403, '只有选择有效自费来源后才能调整本人私聊额度');
        if (typeof updateBudget !== 'function') throw fail(503, '此实例尚未提供本人私聊额度设置');
        send({ ok: true, budget: await updateBudget(principal, body) });
      } else if (path === '/api/tenant/delegations') {
        if (!exact(body, ['botId', 'username', 'keys', 'version'])) throw fail(400, '成员委托参数无效');
        if (principal.role !== 'admin' && !service.ownsBot(principal, body.botId)) throw fail(403, '只有机器人所有者能分配会话');
        const target = resolveAccount(body.username);
        const delegation = service.delegate(principal, { botId: body.botId, userId: target.id, keys: body.keys, version: body.version });
        send({ ok: true, delegation: { ...delegation, username: target.username } });
      } else if (path === '/api/tenant/bots') {
        if(principal.role!=='admin')throw fail(403,'普通账号请在用户空间提交机器人开通申请，无需实例连接凭据');
        if (!partial(body, ['id', 'name', 'expectedQQ', 'port', 'machineToken', 'profileId']) || typeof body.profileId !== 'string') throw fail(400, '自有机器人接入参数无效');
        const profile = service.overview(principal).profiles.find(row => row.id === body.profileId && row.enabled);
        if (!profile) throw fail(404, '请先选择本人的可用自费配置');
        let added, claim;
        const checkSession = () => {
          if (principal.kind !== 'session' || typeof auth.authenticate !== 'function') return;
          const current = auth.authenticate(req.headers.cookie || principal.cookieHeader || '');
          if (!current || current.id !== principal.id) throw fail(401, '核验期间登录已失效，请重新登录');
        };
        try {
          const { profileId, ...connection } = body; added = manager.add(connection);
          const verified = await manager.verify(added.id); checkSession();
          claim = service.claimBot(principal, verified);
          service.setFunding(principal, { botId: added.id, profileId, version: 0 });
          const enabled = await manager.update(added.id, { enabled: true }); checkSession();
          await afterRegistryChange(); send({ ok: true, bot: { ...enabled, botId: added.id, ownerUserId: principal.id } });
        } catch (error) {
          let cleanupFailed = false;
          if (added) {
            try { await manager.update(added.id, { enabled: false }); } catch { cleanupFailed = true; }
            try { manager.remove(added.id); } catch { cleanupFailed = true; }
            if (claim) try { service.releaseBotClaim({ botId: added.id, ownerUserId: principal.id, version: claim.version }); } catch { cleanupFailed = true; }
            try { await afterRegistryChange(); } catch { cleanupFailed = true; }
          }
          if (cleanupFailed) throw fail(503, '机器人接入失败，部分清理仍待平台管理员处理；未切换到平台费用来源');
          throw error;
        }
      }
      return true;
    } catch (error) { send({ ok: false, error: error.message || '用户空间操作失败' }, Number(error.statusCode) || 500); return true; }
  }
  async function routeInternal({ req, url, readBody, sendJson }) {
    if (url.pathname !== '/api/internal/tenant') return false;
    try {
      if (req.method !== 'POST') throw fail(405, '内部接口仅接受POST');
      if (url.search || browserHeaders.some(name => req.headers[name] !== undefined) || typeof req.headers['x-console-token'] !== 'string') throw fail(403, '此接口只接受独立工作实例机器通道');
      const body = await readBody();
      if (!exact(body, ['action', 'botId', 'key']) || body.action !== 'funding') throw fail(400, '内部费用操作无效');
      if (!manager.authenticateWorker(body.botId, req.headers['x-console-token'])) throw fail(403, '工作实例身份不匹配或已停用');
      const funding = service.getFunding({ botId: body.botId, key: body.key });
      // No personal/primary credential is ever returned to a hosted worker.
      if (funding.mode === 'byok' && funding.source !== 'bot-owner' || ['platform', 'trial'].includes(funding.mode)) throw fail(403, '工作实例不能取得平台或其他用户的费用来源');
      sendJson({ ok: true, funding }); return true;
    } catch (error) { sendJson({ ok: false, error: error.message || '内部费用调用失败' }, Number(error.statusCode) || 500); return true; }
  }
  return { route, routeInternal };
}
