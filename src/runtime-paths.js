import os from 'node:os';
import path from 'node:path';

export function normalizeBotId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new Error('botId 必须为1至64位小写字母、数字或短横线，并以字母或数字开头');
  return value;
}
export function normalizeBotQQ(value) {
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new Error('QQ 必须为正整数');
  return String(Number(value));
}
export function getRuntimePaths({ codeRoot, env = process.env, homeDir = os.homedir() } = {}) {
  if (!codeRoot || !path.isAbsolute(codeRoot)) throw new Error('codeRoot 必须为绝对路径');
  const CODE_ROOT = path.resolve(codeRoot);
  const RUNTIME_ROOT = path.resolve(env.QQ_BRIDGE_RUNTIME_ROOT || CODE_ROOT);
  const BOT_ID = normalizeBotId(env.QQ_BRIDGE_BOT_ID || 'primary');
  const EXPECTED_QQ = env.QQ_BRIDGE_EXPECTED_QQ ? normalizeBotQQ(env.QQ_BRIDGE_EXPECTED_QQ) : null;
  const DSH_HOME = path.resolve(env.DSH_HOME || (BOT_ID === 'primary' ? path.join(homeDir, '.dsh') : path.join(RUNTIME_ROOT, 'dsh-home')));
  if (BOT_ID !== 'primary' && RUNTIME_ROOT === CODE_ROOT) throw new Error('worker 必须使用独立运行目录');
  if (BOT_ID !== 'primary' && DSH_HOME === path.resolve(homeDir, '.dsh')) throw new Error('worker 不得复用默认共享DSH目录');
  return { CODE_ROOT, RUNTIME_ROOT, BOT_ID, EXPECTED_QQ, DSH_HOME, CONFIG_FILE: path.join(RUNTIME_ROOT, 'config.json'), STATE_DIR: path.join(RUNTIME_ROOT, 'state'), ROLES_DIR: path.join(RUNTIME_ROOT, 'roles') };
}
export function validateRuntimeIdentity(config, paths) {
  const id = normalizeBotId(config.botId || 'primary');
  if (id === 'primary' && config.managerWorker) throw new Error('worker 不能使用primary身份');
  if (id !== paths.BOT_ID) throw new Error('环境与配置的 botId 不一致，拒绝启动');
  const expectedQQ = config.expectedQQ == null ? paths.EXPECTED_QQ : normalizeBotQQ(config.expectedQQ);
  if (paths.EXPECTED_QQ && expectedQQ !== paths.EXPECTED_QQ) throw new Error('环境与配置的 QQ 不一致，拒绝启动');
  if (id !== 'primary' && (!config.managerWorker || !expectedQQ || paths.RUNTIME_ROOT === paths.CODE_ROOT)) throw new Error('worker 必须配置独立目录、managerWorker 和 expectedQQ');
  return { botId: id, expectedQQ };
}
