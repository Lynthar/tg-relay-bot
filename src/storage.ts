export class ScopedKV {
  constructor(
    private inner: KVNamespace,
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

  async list(subPrefix: string = ''): Promise<KVNamespaceListResult<unknown, string>> {
    return this.inner.list({ prefix: this.prefix + subPrefix });
  }
}

export interface MsgMapEntry {
  chatId: number | string;
  userKey: string;
  createdAt: number;
}

export async function putMsgMap(
  skv: ScopedKV,
  adminMessageId: number,
  entry: MsgMapEntry,
  ttlSec: number,
): Promise<void> {
  await skv.put(`msg-map-${adminMessageId}`, JSON.stringify(entry), ttlSec);
}

export async function getMsgMap(
  skv: ScopedKV,
  adminMessageId: number,
): Promise<MsgMapEntry | null> {
  return await skv.getJson<MsgMapEntry>(`msg-map-${adminMessageId}`);
}
