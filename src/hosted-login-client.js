import fs from 'node:fs';

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export function publicLoginState(value) {
  const states = ['starting', 'waiting_scan', 'waiting_confirm', 'expired', 'connecting', 'ready', 'mismatch', 'stopped'];
  if (!value || !states.includes(value.state)) throw fail(502, 'QQ 登录服务返回了无效状态');
  const result = { state: value.state };
  if (Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0) result.expiresAt = value.expiresAt;
  if (typeof value.qrImage === 'string' && value.qrImage.length <= 600000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value.qrImage)) {
    const bytes=Buffer.from(value.qrImage.slice('data:image/png;base64,'.length),'base64');
    if(bytes.length>=24&&bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a'&&bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(16)<=700&&bytes.readUInt32BE(20)>0&&bytes.readUInt32BE(20)<=800)result.qrImage=value.qrImage;
  }
  return result;
}

/** Private, fixed-loopback broker. Browser input never selects a host or port. */
export function createHostedLoginClient({ file, read = name => fs.readFileSync(name, 'utf8'), fetchImpl = fetch, timeoutMs = 25000 } = {}) {
  function configuration() {
    let config;
    try { config = JSON.parse(read(file)); }
    catch { throw fail(503, '平台尚未启用网页 QQ 扫码接入，请联系管理员'); }
    if (!config || Object.keys(config).sort().join() !== 'port,token' || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535
        || typeof config.token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(config.token)) throw fail(503, 'QQ 扫码接入配置无效');
    return config;
  }
  async function call(action, input) {
    if (!validId(input?.requestId)) throw fail(400, 'QQ 登录申请无效');
    const config = configuration(); let response;
    try {
      response = await fetchImpl('http://127.0.0.1:' + config.port + '/internal/login/' + action, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', 'x-login-service-token': config.token }, body: JSON.stringify(input),
      });
    } catch { throw fail(503, 'QQ 登录服务暂时不可用，请稍后重试'); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw fail(502, 'QQ 登录服务不能重定向'); }
    let bytes = 0, text = '';
    try {
      const decoder = new TextDecoder();
      for await (const chunk of response.body || []) { bytes += chunk.byteLength; if (bytes > 750000) throw Error(); text += decoder.decode(chunk, { stream: true }); }
      text += decoder.decode(); const result = JSON.parse(text);
      if (!response.ok || !result.ok) {
        const messages = { CAPACITY: '服务器的机器人名额已用完，请联系管理员扩容后重试', BUSY: '登录环境正在准备，请稍后重试', MISSING: '登录环境尚未准备，请重新开始扫码', CONFLICT: '这个 QQ 的登录申请已被其他接入占用', RESOURCE: '服务器当前资源不足，请稍后重试' };
        throw fail([400,404,409,429,503].includes(response.status) ? response.status : 503, messages[result.code] || 'QQ 登录操作失败，请稍后重试');
      }
      return result;
    } catch (error) { if (error.statusCode) throw error; throw fail(502, 'QQ 登录服务响应无效或过大'); }
  }
  return {
    available() { try { configuration(); return true; } catch { return false; } },
    async start(input) {
      const result = await call('start', input), row = result.connection;
      if (!row || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.id) || row.id === 'primary' || row.expectedQQ !== input.botQQ
          || !Number.isInteger(row.port) || row.port < 1024 || row.port > 65535 || !/^[A-Za-z0-9_-]{16,128}$/.test(row.machineToken || '')) throw fail(502, '独立机器人连接核验失败');
      return { connection: { id: row.id, name: input.name, expectedQQ: row.expectedQQ, port: row.port, machineToken: row.machineToken }, login: publicLoginState(result.login) };
    },
    async status(input) { return publicLoginState((await call('status', input)).login); },
    async refresh(input) { return publicLoginState((await call('refresh', input)).login); },
    async cancel(input) { await call('cancel', input); return { state: 'stopped' }; },
  };
}
