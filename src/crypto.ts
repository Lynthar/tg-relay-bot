const enc = new TextEncoder();
const dec = new TextDecoder();

const keyCache = new Map<string, CryptoKey>();

export async function getEncKey(masterKeyB64: string): Promise<CryptoKey> {
  const cached = keyCache.get(masterKeyB64);
  if (cached) return cached;
  const raw = base64ToBytes(masterKeyB64);
  if (raw.length !== 32) {
    throw new Error(
      'ENV_MASTER_ENC_KEY must be 32 bytes base64-encoded (e.g. `openssl rand -base64 32`)',
    );
  }
  const key = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
  keyCache.set(masterKeyB64, key);
  return key;
}

export async function encrypt(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext),
  );
  return bytesToBase64(concat(iv, new Uint8Array(ct)));
}

export async function decrypt(b64: string, key: CryptoKey): Promise<string> {
  const all = base64ToBytes(b64);
  const iv = all.subarray(0, 12);
  const ct = all.subarray(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return dec.decode(pt);
}

export function randomHex(byteLen: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLen));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
