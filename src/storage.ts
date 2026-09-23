// Cloudflare KV refuses an expiration less than 60 seconds out, and it is one of the three
// backends behind KvStore. The local two enforce the same floor, so a too-short window fails
// on the track it was written on instead of only on Workers in production.
export const MIN_EXPIRATION_TTL_SEC = 60;

export function assertExpirationTtl(ttlSec: number | undefined): void {
  if (ttlSec !== undefined && ttlSec < MIN_EXPIRATION_TTL_SEC) {
    throw new RangeError(
      `expirationTtl must be at least ${MIN_EXPIRATION_TTL_SEC}s, got ${ttlSec}`,
    );
  }
}

// Minimal KV contract — any backend satisfying this can drop in for env.nfd.
export interface KvStore {
  get(key: string): Promise<string | null>;
  get<T = unknown>(key: string, options: { type: 'json' }): Promise<T | null>;
  /**
   * @param options.expirationTtl Seconds until the entry expires. Must be at least
   *   {@link MIN_EXPIRATION_TTL_SEC} — every backend rejects a smaller value.
   * @throws RangeError when `expirationTtl` is below that floor.
   */
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string }): Promise<KvListResult>;
}

export interface KvListResult {
  keys: { name: string }[];
  list_complete: boolean;
  cursor?: string;
}

export class ScopedKV {
  constructor(
    private inner: KvStore,
    private prefix: string,
  ) {}

  async getString(key: string): Promise<string | null> {
    return this.inner.get(this.prefix + key);
  }

  async getJson<T>(key: string): Promise<T | null> {
    return this.inner.get<T>(this.prefix + key, { type: 'json' });
  }

  async put(key: string, value: string, ttlSec?: number): Promise<void> {
    return this.inner.put(
      this.prefix + key,
      value,
      ttlSec ? { expirationTtl: ttlSec } : undefined,
    );
  }

  async delete(key: string): Promise<void> {
    return this.inner.delete(this.prefix + key);
  }

  async list(subPrefix: string = ''): Promise<KvListResult> {
    return this.inner.list({ prefix: this.prefix + subPrefix });
  }

  // Like list(), but returns key names relative to the scope prefix.
  async listScoped(subPrefix: string = ''): Promise<{ names: string[]; complete: boolean }> {
    const res = await this.inner.list({ prefix: this.prefix + subPrefix });
    return {
      names: res.keys.map((k) => k.name.slice(this.prefix.length)),
      complete: res.list_complete,
    };
  }
}

// No hash rides along with the chatId: a row pairing a UID with a hash lets a dump join that UID
// to every key built from the hash. Readers derive userKey from chatId (older rows also carry it).
export interface MsgMapEntry {
  chatId: number | string;
  createdAt: number;
}

// Keyed by (adminKey, adminMessageId): Telegram message_ids are unique only within a single
// chat, so forwards delivered to different admins can carry the same message_id. adminKey is
// operatorKey(adminUid, hashSecret) — the raw UID must not appear in a key (see security.ts).
export async function putMsgMap(
  skv: ScopedKV,
  adminKey: string,
  adminMessageId: number,
  entry: MsgMapEntry,
  ttlSec: number,
): Promise<void> {
  await skv.put(`msg-map-${adminKey}-${adminMessageId}`, JSON.stringify(entry), ttlSec);
}

export async function getMsgMap(
  skv: ScopedKV,
  adminKey: string,
  adminMessageId: number,
): Promise<MsgMapEntry | null> {
  return await skv.getJson<MsgMapEntry>(`msg-map-${adminKey}-${adminMessageId}`);
}

// Pre-admin-scoped key format. Only safe to consult when the tenant has exactly one admin
// (a single admin chat cannot collide with itself). Removable once entries written before
// the key-format change have aged out (MSG_MAP_TTL_SEC).
export async function getLegacyMsgMap(
  skv: ScopedKV,
  adminMessageId: number,
): Promise<MsgMapEntry | null> {
  return await skv.getJson<MsgMapEntry>(`msg-map-${adminMessageId}`);
}

// Points from the warning the bot sent an admin (about a reply that may identify them)
// to the copy delivered to the guest, so the admin can /recall it. Short-lived like msg-map.
export interface RecallEntry {
  chatId: number | string;
  messageId: number;
}

export async function putRecall(
  skv: ScopedKV,
  adminKey: string,
  warningMessageId: number,
  entry: RecallEntry,
  ttlSec: number,
): Promise<void> {
  await skv.put(`recall-${adminKey}-${warningMessageId}`, JSON.stringify(entry), ttlSec);
}

export async function getRecall(
  skv: ScopedKV,
  adminKey: string,
  warningMessageId: number,
): Promise<RecallEntry | null> {
  return await skv.getJson<RecallEntry>(`recall-${adminKey}-${warningMessageId}`);
}

export async function deleteRecall(
  skv: ScopedKV,
  adminKey: string,
  warningMessageId: number,
): Promise<void> {
  await skv.delete(`recall-${adminKey}-${warningMessageId}`);
}
