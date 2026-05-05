export interface Env {
  nfd: KVNamespace;
  ENV_MANAGER_BOT_TOKEN: string;
  ENV_HOST_UID: string;
  ENV_MASTER_ENC_KEY: string;
  ENV_ADMIN_SECRET?: string;
  ENV_DEBUG?: string;
}

export interface HostConfig {
  managerBotToken: string;
  managerBotId: string;
  managerWebhookSecret: string;
  hostUid: string;
  masterEncKey: string;
  adminSecret: string | null;
  debug: boolean;
}

export const RATE_LIMIT_WINDOW_SEC = 60;
export const RATE_LIMIT_MAX = 5;
export const MSG_MAP_TTL_SEC = 30 * 24 * 3600;
export const DEDUP_TTL_SEC = 5 * 60;

export async function parseHostConfig(env: Env): Promise<HostConfig> {
  const required = (n: string, v: string | undefined): string => {
    if (!v) throw new Error(`missing env ${n}`);
    return v;
  };
  const managerBotToken = required('ENV_MANAGER_BOT_TOKEN', env.ENV_MANAGER_BOT_TOKEN);
  const hostUid = required('ENV_HOST_UID', env.ENV_HOST_UID).trim();
  const masterEncKey = required('ENV_MASTER_ENC_KEY', env.ENV_MASTER_ENC_KEY);

  const m = managerBotToken.match(/^(\d+):/);
  if (!m) throw new Error('ENV_MANAGER_BOT_TOKEN format invalid');
  const managerBotId = m[1];

  return {
    managerBotToken,
    managerBotId,
    managerWebhookSecret: await deriveManagerWebhookSecret(managerBotToken),
    hostUid,
    masterEncKey,
    adminSecret: env.ENV_ADMIN_SECRET ?? null,
    debug: env.ENV_DEBUG === '1',
  };
}

const secretCache = new Map<string, string>();
async function deriveManagerWebhookSecret(token: string): Promise<string> {
  const cached = secretCache.get(token);
  if (cached) return cached;
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token + ':manager-webhook'),
  );
  const hex = [...new Uint8Array(buf)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  secretCache.set(token, hex);
  return hex;
}
