// Minimal KV contract — any backend satisfying this can drop in for env.nfd.
export interface KvStore {
  get(key: string): Promise<string | null>;
  get<T = unknown>(key: string, options: { type: 'json' }): Promise<T | null>;
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

export interface MsgMapEntry {
  chatId: number | string;
  userKey: string;
  createdAt: number;
}

// Keyed by (adminId, adminMessageId): Telegram message_ids are unique only within a single
// chat, so forwards delivered to different admins can carry the same message_id. Without the
// admin dimension the entries collide and a reply can be routed to the wrong guest.
export async function putMsgMap(
  skv: ScopedKV,
  adminId: string,
  adminMessageId: number,
  entry: MsgMapEntry,
  ttlSec: number,
): Promise<void> {
  await skv.put(`msg-map-${adminId}-${adminMessageId}`, JSON.stringify(entry), ttlSec);
}

export async function getMsgMap(
  skv: ScopedKV,
  adminId: string,
  adminMessageId: number,
): Promise<MsgMapEntry | null> {
  return await skv.getJson<MsgMapEntry>(`msg-map-${adminId}-${adminMessageId}`);
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
