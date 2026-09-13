import { encrypt, decrypt, randomHex } from './crypto';
import * as tg from './telegram';
import { TelegramError } from './telegram';
import { logError } from './security';
import type { DisplayMode } from './types';
import type { KvStore, KvListResult } from './storage';

export interface StoredTenantCfg {
  tokenEnc: string;
  // AES-GCM-encrypted at rest (current format). Operator ids are encrypted too: a dump
  // without the master key must not say which Telegram account runs which bot.
  webhookSecretEnc?: string;
  hashSecretEnc?: string;
  ownerUidEnc?: string;
  adminUidsEnc?: string;
  // Legacy plaintext from records written before encryption-at-rest. Still readable
  // until the host runs /host_migrate; never written by new code.
  webhookSecret?: string;
  hashSecret?: string;
  adminUids?: string[];
  ownerUid?: string;
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

// A listing row: the stored record plus its operator ids already decrypted.
export interface StoredEntry {
  botId: string;
  cfg: StoredTenantCfg;
  ownerUid: string;
  adminUids: string[];
}

export interface Operators {
  ownerUid: string;
  adminUids: string[];
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

export async function readOperators(
  cfg: StoredTenantCfg,
  encKey: CryptoKey,
): Promise<Operators> {
  const ownerUid = await storedSecret(cfg.ownerUidEnc, cfg.ownerUid, encKey, 'ownerUid');
  const adminUids = cfg.adminUidsEnc
    ? (JSON.parse(await decrypt(cfg.adminUidsEnc, encKey)) as string[])
    : cfg.adminUids;
  if (!adminUids) throw new Error('tenant cfg missing adminUids');
  return { ownerUid, adminUids };
}

export async function setAdminUids(
  cfg: StoredTenantCfg,
  adminUids: string[],
  encKey: CryptoKey,
): Promise<void> {
  cfg.adminUidsEnc = await encrypt(JSON.stringify(adminUids), encKey);
  delete cfg.adminUids;
}

// Encrypt any legacy plaintext secrets and operator ids in place. Returns true if cfg
// changed (caller persists). Idempotent.
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
  if (!cfg.ownerUidEnc && cfg.ownerUid) {
    cfg.ownerUidEnc = await encrypt(cfg.ownerUid, encKey);
    delete cfg.ownerUid;
    changed = true;
  }
  if (!cfg.adminUidsEnc && cfg.adminUids) {
    await setAdminUids(cfg, cfg.adminUids, encKey);
    changed = true;
  }
  return changed;
}

async function storedToTenant(
  botId: string,
  raw: StoredTenantCfg,
  encKey: CryptoKey,
): Promise<TenantCfg> {
  const operators = await readOperators(raw, encKey);
  return {
    botId,
    botToken: await decrypt(raw.tokenEnc, encKey),
    botUsername: raw.botUsername,
    webhookSecret: await storedSecret(raw.webhookSecretEnc, raw.webhookSecret, encKey, 'webhookSecret'),
    hashSecret: await storedSecret(raw.hashSecretEnc, raw.hashSecret, encKey, 'hashSecret'),
    adminUids: new Set(operators.adminUids),
    ownerUid: operators.ownerUid,
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
    ownerUidEnc: await encrypt(args.ownerUid, encKey),
    adminUidsEnc: await encrypt(JSON.stringify([args.ownerUid]), encKey),
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

// Operator ids that cannot be decrypted (changed or lost master key) come back empty rather
// than throwing: the host must still be able to find the record by username and purge it,
// which is the documented recovery path. Owner-filtered lookups simply never match it.
export async function getStoredEntry(
  kv: KvStore,
  botId: string,
  encKey: CryptoKey,
): Promise<StoredEntry | null> {
  const cfg = await getStored(kv, botId);
  if (!cfg) return null;
  try {
    return { botId, cfg, ...(await readOperators(cfg, encKey)) };
  } catch (e) {
    logError('operators_decrypt', e, { botId });
    return { botId, cfg, ownerUid: '', adminUids: [] };
  }
}

// Owner lookups decrypt every record: there is no owner index, and an index keyed by a
// plaintext UID would defeat encrypting it. Fine at personal scale (tens of tenants).
export async function listStored(kv: KvStore, encKey: CryptoKey): Promise<StoredEntry[]> {
  const ids = await listTenantIds(kv);
  const entries = await Promise.all(ids.map((id) => getStoredEntry(kv, id, encKey)));
  return entries.filter((x): x is StoredEntry => x !== null);
}

export async function listStoredByOwner(
  kv: KvStore,
  ownerUid: string,
  encKey: CryptoKey,
): Promise<StoredEntry[]> {
  const all = await listStored(kv, encKey);
  return all.filter((x) => x.ownerUid === ownerUid);
}

export async function findStoredByUsername(
  kv: KvStore,
  username: string,
  encKey: CryptoKey,
  ownerUid?: string,
): Promise<StoredEntry | null> {
  const all = await listStored(kv, encKey);
  const u = username.toLowerCase().replace(/^@/, '');
  return (
    all.find(
      (x) =>
        x.cfg.botUsername.toLowerCase() === u && (ownerUid ? x.ownerUid === ownerUid : true),
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
    // Best-effort: neither an unreachable Telegram nor an undecryptable token (changed or lost
    // master key) may block the local purge, or one wrong key would wedge /delete, /host_purge and
    // re-/setup together. An orphaned webhook only yields harmless 404s until the next setWebhook.
    try {
      const token = await decryptToken(raw, encKey);
      await tg.deleteWebhook(token);
    } catch (e) {
      if (!(e instanceof TelegramError)) logError('delete_webhook', e, { botId });
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
