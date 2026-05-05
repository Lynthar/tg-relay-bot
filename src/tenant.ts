import { encrypt, decrypt, randomHex } from './crypto';
import * as tg from './telegram';
import { TelegramError } from './telegram';
import type { DisplayMode } from './types';

export interface StoredTenantCfg {
  tokenEnc: string;
  webhookSecret: string;
  hashSecret: string;
  adminUids: string[];
  ownerUid: string;
  botUsername: string;
  displayMode: DisplayMode;
  startMessage: string;
  createdAt: number;
  paused: boolean;
}

export interface TenantCfg {
  botId: string;
  botToken: string;
  botUsername: string;
  webhookSecret: string;
  hashSecret: string;
  adminUids: Set<string>;
  ownerUid: string;
  displayMode: DisplayMode;
  startMessage: string;
  createdAt: number;
  paused: boolean;
}

const DEFAULT_START =
  '你好，请直接发送消息，运营者将尽快回复。\n\nHi — send a message and the bot owner will reply shortly.';

function tenantKey(botId: string): string {
  return `tenant:${botId}:cfg`;
}

export async function getTenant(
  kv: KVNamespace,
  botId: string,
  encKey: CryptoKey,
): Promise<TenantCfg | null> {
  const raw = await kv.get<StoredTenantCfg>(tenantKey(botId), { type: 'json' });
  if (!raw) return null;
  const botToken = await decrypt(raw.tokenEnc, encKey);
  return {
    botId,
    botToken,
    botUsername: raw.botUsername,
    webhookSecret: raw.webhookSecret,
    hashSecret: raw.hashSecret,
    adminUids: new Set(raw.adminUids),
    ownerUid: raw.ownerUid,
    displayMode: raw.displayMode,
    startMessage: raw.startMessage,
    createdAt: raw.createdAt,
    paused: raw.paused,
  };
}

export async function getStored(
  kv: KVNamespace,
  botId: string,
): Promise<StoredTenantCfg | null> {
  return kv.get<StoredTenantCfg>(tenantKey(botId), { type: 'json' });
}

export async function putStored(
  kv: KVNamespace,
  botId: string,
  cfg: StoredTenantCfg,
): Promise<void> {
  await kv.put(tenantKey(botId), JSON.stringify(cfg));
}

export async function createTenant(
  kv: KVNamespace,
  encKey: CryptoKey,
  args: { token: string; ownerUid: string; botUsername: string; botId: string },
): Promise<StoredTenantCfg> {
  const tokenEnc = await encrypt(args.token, encKey);
  const cfg: StoredTenantCfg = {
    tokenEnc,
    webhookSecret: randomHex(32),
    hashSecret: randomHex(32),
    adminUids: [args.ownerUid],
    ownerUid: args.ownerUid,
    botUsername: args.botUsername,
    displayMode: 'native',
    startMessage: DEFAULT_START,
    createdAt: Date.now(),
    paused: false,
  };
  await putStored(kv, args.botId, cfg);
  return cfg;
}

export async function listTenantIds(kv: KVNamespace): Promise<string[]> {
  const list = await kv.list({ prefix: 'tenant:' });
  return list.keys
    .map((k) => k.name)
    .filter((k) => k.endsWith(':cfg'))
    .map((k) => k.slice('tenant:'.length, -':cfg'.length));
}

export async function listTenantsByOwner(
  kv: KVNamespace,
  ownerUid: string,
  encKey: CryptoKey,
): Promise<TenantCfg[]> {
  const ids = await listTenantIds(kv);
  const all = await Promise.all(ids.map((id) => getTenant(kv, id, encKey)));
  return all.filter((t): t is TenantCfg => t !== null && t.ownerUid === ownerUid);
}

export async function findTenantByUsername(
  kv: KVNamespace,
  encKey: CryptoKey,
  username: string,
  ownerUid?: string,
): Promise<TenantCfg | null> {
  const ids = await listTenantIds(kv);
  const all = await Promise.all(ids.map((id) => getTenant(kv, id, encKey)));
  const u = username.toLowerCase().replace(/^@/, '');
  return (
    all.find(
      (t): t is TenantCfg =>
        t !== null &&
        t.botUsername.toLowerCase() === u &&
        (ownerUid ? t.ownerUid === ownerUid : true),
    ) ?? null
  );
}

export async function deleteTenant(
  kv: KVNamespace,
  botId: string,
  encKey: CryptoKey,
): Promise<number> {
  const cfg = await getTenant(kv, botId, encKey);
  if (cfg) {
    try {
      await tg.deleteWebhook(cfg.botToken);
    } catch (e) {
      if (!(e instanceof TelegramError)) throw e;
    }
  }
  const list = await kv.list({ prefix: `tenant:${botId}:` });
  await Promise.all(list.keys.map((k) => kv.delete(k.name)));
  return list.keys.length;
}
