import { encrypt, decrypt, randomHex } from './crypto';
import * as tg from './telegram';
import { TelegramError } from './telegram';
import type { DisplayMode } from './types';
import type { KvStore, KvListResult } from './storage';

export interface StoredTenantCfg {
  tokenEnc: string;
  // AES-GCM-encrypted at rest (current format).
  webhookSecretEnc?: string;
  hashSecretEnc?: string;
  // Legacy plaintext from records written before encryption-at-rest. Still readable
  // until the host runs /host_migrate; never written by new code.
  webhookSecret?: string;
  hashSecret?: string;
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
  kv: KvStore,
  botId: string,
): Promise<StoredTenantCfg | null> {
  return kv.get<StoredTenantCfg>(tenantKey(botId), { type: 'json' });
}

export async function putStored(
  kv: KvStore,
  botId: string,
  cfg: StoredTenantCfg,
): Promise<void> {
  await kv.put(tenantKey(botId), JSON.stringify(cfg));
}

export async function deleteStored(kv: KvStore, botId: string): Promise<void> {
  await kv.delete(tenantKey(botId));
}

export async function decryptToken(
  cfg: StoredTenantCfg,
  encKey: CryptoKey,
): Promise<string> {
  return decrypt(cfg.tokenEnc, encKey);
}

async function storedSecret(
  enc: string | undefined,
  legacyPlain: string | undefined,
  encKey: CryptoKey,
  what: string,
): Promise<string> {
  if (enc) return decrypt(enc, encKey);
  if (legacyPlain) return legacyPlain;
  throw new Error(`tenant cfg missing ${what}`);
}

export async function storedWebhookSecret(
  cfg: StoredTenantCfg,
  encKey: CryptoKey,
): Promise<string> {
  return storedSecret(cfg.webhookSecretEnc, cfg.webhookSecret, encKey, 'webhookSecret');
}

// Encrypt any legacy plaintext secrets in place. Returns true if cfg changed
// (caller persists). Idempotent.
export async function encryptLegacySecrets(
  cfg: StoredTenantCfg,
  encKey: CryptoKey,
): Promise<boolean> {
  let changed = false;
  if (!cfg.hashSecretEnc && cfg.hashSecret) {
    cfg.hashSecretEnc = await encrypt(cfg.hashSecret, encKey);
    delete cfg.hashSecret;
    changed = true;
  }
  if (!cfg.webhookSecretEnc && cfg.webhookSecret) {
    cfg.webhookSecretEnc = await encrypt(cfg.webhookSecret, encKey);
    delete cfg.webhookSecret;
    changed = true;
  }
  return changed;
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
    webhookSecret: await storedSecret(raw.webhookSecretEnc, raw.webhookSecret, encKey, 'webhookSecret'),
    hashSecret: await storedSecret(raw.hashSecretEnc, raw.hashSecret, encKey, 'hashSecret'),
    adminUids: new Set(raw.adminUids),
    ownerUid: raw.ownerUid,
    displayMode: raw.displayMode,
    startMessage: raw.startMessage,
    createdAt: raw.createdAt,
    paused: raw.paused,
  };
}

export async function getTenant(
  kv: KvStore,
  botId: string,
  encKey: CryptoKey,
): Promise<TenantCfg | null> {
  const raw = await getStored(kv, botId);
  return raw ? storedToTenant(botId, raw, encKey) : null;
}

export interface CreatedTenant {
  cfg: StoredTenantCfg;
  // Plaintext copies for the caller (webhook registration, tests) — stored only encrypted.
  webhookSecret: string;
  hashSecret: string;
}

export async function createTenant(
  kv: KvStore,
  encKey: CryptoKey,
  args: { token: string; ownerUid: string; botUsername: string; botId: string },
): Promise<CreatedTenant> {
  const webhookSecret = randomHex(32);
  const hashSecret = randomHex(32);
  const cfg: StoredTenantCfg = {
    tokenEnc: await encrypt(args.token, encKey),
    webhookSecretEnc: await encrypt(webhookSecret, encKey),
    hashSecretEnc: await encrypt(hashSecret, encKey),
    adminUids: [args.ownerUid],
    ownerUid: args.ownerUid,
    botUsername: args.botUsername,
    displayMode: 'native',
    startMessage: DEFAULT_START,
    createdAt: Date.now(),
    paused: false,
  };
  await putStored(kv, args.botId, cfg);
  return { cfg, webhookSecret, hashSecret };
}

export async function listTenantIds(kv: KvStore): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined = undefined;
  for (;;) {
    const list: KvListResult = await kv.list({
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

export async function listStored(kv: KvStore): Promise<StoredEntry[]> {
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
  kv: KvStore,
  ownerUid: string,
): Promise<StoredEntry[]> {
  const all = await listStored(kv);
  return all.filter((x) => x.cfg.ownerUid === ownerUid);
}

export async function findStoredByUsername(
  kv: KvStore,
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
  kv: KvStore,
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
    const list: KvListResult = await kv.list({
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
