import type { KvStore } from './storage';

export interface Env {
  nfd: KvStore;
  ENV_MANAGER_BOT_TOKEN: string;
  ENV_HOST_UID: string;
  ENV_MASTER_ENC_KEY: string;
  ENV_PUBLIC_BASE_URL: string;
  ENV_ADMIN_SECRET?: string;
  ENV_DEBUG?: string;
}

export interface HostConfig {
  managerBotToken: string;
  managerBotId: string;
  managerWebhookSecret: string;
  hostUid: string;
  masterEncKey: string;
  publicBaseUrl: string;
  adminSecret: string | null;
  debug: boolean;
}

export const RATE_LIMIT_WINDOW_SEC = 60;
export const RATE_LIMIT_MAX = 5;
export const MSG_MAP_TTL_SEC = 30 * 24 * 3600;
export const DEDUP_TTL_SEC = 5 * 60;
export const MEDIA_GROUP_TAG_TTL_SEC = 60;
// Per-owner tenant cap (host exempt). KV write quota is platform-wide, so one
// over-enthusiastic friend must not be able to crowd out everyone else.
export const MAX_TENANTS_PER_UID = 3;
// Same quota logic per tenant: each admin adds Telegram calls + msg-map writes
// to every relayed message, and delivery is serial.
export const MAX_ADMINS_PER_TENANT = 10;
// Only `message` is ever processed; restricting the webhook saves Worker
// invocations (edited_message, callback_query, ... are never delivered).
export const ALLOWED_UPDATES = ['message'];

export async function parseHostConfig(env: Env): Promise<HostConfig> {
  const required = (n: string, v: string | undefined): string => {
    if (!v) throw new Error(`missing env ${n}`);
    return v;
  };
  const managerBotToken = required('ENV_MANAGER_BOT_TOKEN', env.ENV_MANAGER_BOT_TOKEN);
  const hostUid = required('ENV_HOST_UID', env.ENV_HOST_UID).trim();
  const masterEncKey = required('ENV_MASTER_ENC_KEY', env.ENV_MASTER_ENC_KEY);
  const publicBaseUrlRaw = required(
    'ENV_PUBLIC_BASE_URL',
    env.ENV_PUBLIC_BASE_URL,
  ).trim();
  if (!/^https:\/\//.test(publicBaseUrlRaw)) {
    throw new Error('ENV_PUBLIC_BASE_URL must start with https://');
  }
  // Telegram appends `/wh/{botId}` to this; trailing slashes would produce `//wh/...`.
  const publicBaseUrl = publicBaseUrlRaw.replace(/\/+$/, '');

  const m = managerBotToken.match(/^(\d+):/);
  if (!m) throw new Error('ENV_MANAGER_BOT_TOKEN format invalid');
  const managerBotId = m[1];

  return {
    managerBotToken,
    managerBotId,
    managerWebhookSecret: await deriveManagerWebhookSecret(managerBotToken),
    hostUid,
    masterEncKey,
    publicBaseUrl,
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
