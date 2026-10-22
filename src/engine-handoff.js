// Keep the existing account database and non-paid QQ ownership verification
// available while a separate engine owns all AI work. No account migration.
const failure = () => Object.assign(new Error('聊天引擎已移交，此入口仅保留账号和只读管理'), {
  code: 'ENGINE_HANDOFF_MANAGEMENT_ONLY', statusCode: 503
});

export function normalizeEngineHandoff(value) {
  if (value === undefined) return { managementOnly: false };
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => key !== 'managementOnly')
      || typeof value.managementOnly !== 'boolean') throw new Error('engineHandoff.managementOnly 必须显式为布尔值');
  return { managementOnly: value.managementOnly };
}

export function createEngineHandoff(config) {
  const current = () => normalizeEngineHandoff((typeof config === 'function' ? config() : config)?.engineHandoff);
  const api = {
    managementOnly: () => current().managementOnly,
    assertChatEnabled() { if (api.managementOnly()) throw failure(); },
    assertSendAllowed(key, { verification = false } = {}) {
      if (api.managementOnly() && !(verification === true && /^private:[1-9]\d*$/.test(key))) throw failure();
    },
    requestAllowed({ method, pathname, isAgent = false }) {
      if (!api.managementOnly()) return true;
      if (isAgent) return false;
      if (['GET', 'HEAD'].includes(method)) return true;
      if (method !== 'POST') return false;
      return /^\/api\/auth\/(?:register|login|logout|password|bootstrap|users(?:\/update)?)$/.test(pathname)
        || pathname === '/api/tenant/binding/issue';
    },
    async stopLegacyWork(sessionIds, stop) {
      if (!api.managementOnly()) return { stopped: 0, failed: 0 };
      const ids = [...new Set(sessionIds.filter(value => typeof value === 'string' && value))];
      let stopped = 0, failed = 0;
      for (const id of ids) {
        try { await stop(id); stopped++; } catch { failed++; }
      }
      return { stopped, failed };
    }
  };
  current(); // Invalid configuration must fail closed at startup.
  return api;
}
