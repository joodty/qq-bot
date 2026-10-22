// Synthetic usage records shared by the offline dashboard and browser integration tests.
// No QQ identifiers, production state, provider credentials, or paid requests are used.
export function tokenDailyRecords(at = Date.now()) {
  const day = new Date(at + 8 * 3600000).toISOString().slice(0, 10);
  const midnight = Date.parse(day + 'T00:00:00+08:00');
  const record = (sid, key, seq, t, b, extra = {}) => ({ k: 'turn', sid, key, seq, turn: seq, step: 1, retry: 0, t, model: 'deepseek-flash', b, ...extra });
  return [
    record('fixture-group-old', 'group:123456789', 1, midnight - 1000, { cacheMiss: 1000000, output: 250000 }),
    record('fixture-group-new', 'group:123456789', 1, midnight + 1000, { cacheMiss: 2000000, cacheHit: 500000, output: 500000 }),
    record('fixture-private', 'private:100001', 1, midnight + 2000, { cacheMiss: 100000, output: 10000 }),
    record('fixture-owner', 'owner:100002', 1, midnight + 3000, { cacheHit: 100000, output: 20000 }, { model: 'unknown-fixture-model' }),
    record('fixture-internal', 'internal:黑话学习', 1, midnight + 4000, { cacheMiss: 1000, output: 1000 }),
    { k: 'base', sid: 'fixture-history', key: 'group:987654321', seq: 50, t: midnight, model: 'deepseek-flash', b: { cacheMiss: 12345, output: 456 } }
  ];
}
