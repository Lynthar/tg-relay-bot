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

export interface StoredEntry {
  botId: string;
  cfg: StoredTenantCfg;
}

const DEFAULT_START =
  '你好，请直接发送消息，运营者将尽快回复。\n\nHi — send a message and the bot owner will reply shortly.';

function tenantKey(botId: string): string {
  return `tenant:${botId}:cfg`;
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

export async function deleteStored(kv: KVNamespace, botId: string): Promise<void> {
  await kv.delete(tenantKey(botId));
}

export async function decryptToken(
  cfg: StoredTenantCfg,
  encKey: CryptoKey,
): Promise<string> {
  return decrypt(cfg.tokenEnc, encKey);
}

async function storedToTenant(
  botId: string,
  raw: StoredTenantCfg,
  encKey: CryptoKey,
): Promise<TenantCfg> {
  return {
    botId,
    botToken: await decrypt(raw.tokenEnc, encKey),
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

export async function getTenant(
  kv: KVNamespace,
  botId: string,
  encKey: CryptoKey,
): Promise<TenantCfg | null> {
  const raw = await getStored(kv, botId);
  return raw ? storedToTenant(botId, raw, encKey) : null;
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
  const ids: string[] = [];
  let cursor: string | undefined = undefined;
  for (;;) {
    const list: KVNamespaceListResult<unknown, string> = await kv.list({
      prefix: 'tenant:',
      cursor,
    });
    for (const k of list.keys) {
      if (k.name.endsWith(':cfg')) {
        ids.push(k.name.slice('tenant:'.length, -':cfg'.length));
      }
    }
    if (list.list_complete) break;
    cursor = list.cursor;
  }
  return ids;
}

export async function listStored(kv: KVNamespace): Promise<StoredEntry[]> {
  const ids = await listTenantIds(kv);
  const entries = await Promise.all(
    ids.map(async (id) => {
      const cfg = await getStored(kv, id);
      return cfg ? { botId: id, cfg } : null;
    }),
  );
  return entries.filter((x): x is StoredEntry => x !== null);
}

export async function listStoredByOwner(
  kv: KVNamespace,
  ownerUid: string,
): Promise<StoredEntry[]> {
  const all = await listStored(kv);
  return all.filter((x) => x.cfg.ownerUid === ownerUid);
}

export async function findStoredByUsername(
  kv: KVNamespace,
  username: string,
  ownerUid?: string,
): Promise<StoredEntry | null> {
  const all = await listStored(kv);
  const u = username.toLowerCase().replace(/^@/, '');
  return (
    all.find(
      (x) =>
        x.cfg.botUsername.toLowerCase() === u &&
        (ownerUid ? x.cfg.ownerUid === ownerUid : true),
    ) ?? null
  );
}

export async function deleteTenant(
  kv: KVNamespace,
  botId: string,
  encKey: CryptoKey,
): Promise<number> {
  const raw = await getStored(kv, botId);
  if (raw) {
    try {
      const token = await decryptToken(raw, encKey);
      await tg.deleteWebhook(token);
    } catch (e) {
      if (!(e instanceof TelegramError)) throw e;
    }
  }
  let total = 0;
  let cursor: string | undefined = undefined;
  for (;;) {
    const list: KVNamespaceListResult<unknown, string> = await kv.list({
      prefix: `tenant:${botId}:`,
      cursor,
    });
    await Promise.all(list.keys.map((k) => kv.delete(k.name)));
    total += list.keys.length;
    if (list.list_complete) break;
    cursor = list.cursor;
  }
  return total;
}
