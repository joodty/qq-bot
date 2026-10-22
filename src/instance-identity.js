import { normalizeBotQQ } from './runtime-paths.js';

const fail = () => Object.assign(new Error('机器人QQ身份尚未核验、已变化或HTTP账号不匹配，已拒绝操作'), { code: 'INSTANCE_IDENTITY_REQUIRED', statusCode: 403 });
export function createInstanceIdentity({ expectedQQ = null, getWsInfo, getHttpInfo } = {}) {
  const expected = expectedQQ == null ? null : normalizeBotQQ(expectedQQ);
  if (expected && (typeof getWsInfo !== 'function' || typeof getHttpInfo !== 'function')) throw new Error('固定QQ身份需要WS与HTTP核验接口');
  let epoch = 0, verified = false, wsQQ = null, httpQQ = null;
  const qqOf = info => { try { return normalizeBotQQ(info?.user_id ?? info?.data?.user_id); } catch { return null; } };
  function revoke() { epoch++; verified = false; wsQQ = null; httpQQ = null; }
  function allowed(event) { return expected === null || (verified && wsQQ === expected && httpQQ === expected && (!event || String(event.self_id ?? '') === expected)); }
  async function verify() {
    revoke(); const ownEpoch = epoch;
    if (expected === null) return true;
    try {
      const [ws, http] = await Promise.all([getWsInfo(), getHttpInfo()]);
      if (epoch !== ownEpoch) return false;
      wsQQ = qqOf(ws); httpQQ = qqOf(http);
      if (wsQQ !== expected || httpQQ !== expected) { revoke(); return false; }
      verified = true; return true;
    } catch { if (epoch === ownEpoch) revoke(); return false; }
  }
  async function assertHttp() {
    if (expected === null) return true;
    if (!allowed()) throw fail();
    const ownEpoch = epoch;
    let qq;
    try { qq = qqOf(await getHttpInfo()); }
    catch { if (epoch === ownEpoch) revoke(); throw fail(); }
    if (epoch !== ownEpoch) throw fail();
    if (qq !== expected) { revoke(); throw fail(); }
    return true;
  }
  return { revoke, verify, allowed, assertHttp, assert() { if (!allowed()) throw fail(); }, get generation() { return epoch; }, get verifiedQQ() { return allowed() ? expected : null; } };
}
