import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, getEncKey, randomHex } from '../../src/crypto';

const KEY_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const KEY_B = (() => {
  const bytes = new Uint8Array(32);
  bytes[31] = 0x01;
  return btoa(String.fromCharCode(...bytes));
})();

describe('crypto', () => {
  describe('AES-GCM round trip', () => {
    it('preserves utf-8 plaintext', async () => {
      const k = await getEncKey(KEY_A);
      const ct = await encrypt('hello 世界 🌍', k);
      expect(await decrypt(ct, k)).toBe('hello 世界 🌍');
    });

    it('produces distinct ciphertexts for same plaintext (random IV)', async () => {
      const k = await getEncKey(KEY_A);
      const c1 = await encrypt('x', k);
      const c2 = await encrypt('x', k);
      expect(c1).not.toBe(c2);
      expect(await decrypt(c1, k)).toBe('x');
      expect(await decrypt(c2, k)).toBe('x');
    });

    it('decrypt with wrong key fails', async () => {
      const kA = await getEncKey(KEY_A);
      const kB = await getEncKey(KEY_B);
      const ct = await encrypt('hello', kA);
      await expect(decrypt(ct, kB)).rejects.toBeDefined();
    });
  });

  describe('getEncKey', () => {
    it('rejects key that is not 32 bytes', async () => {
      await expect(getEncKey('YWJj')).rejects.toThrow(/32 bytes/);
    });

    it('caches keys by base64 input', async () => {
      const k1 = await getEncKey(KEY_A);
      const k2 = await getEncKey(KEY_A);
      expect(k1).toBe(k2);
    });
  });

  describe('randomHex', () => {
    it('produces 2 hex chars per byte requested', () => {
      expect(randomHex(4)).toMatch(/^[0-9a-f]{8}$/);
      expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
    });

    it('returns different values across calls', () => {
      expect(randomHex(8)).not.toBe(randomHex(8));
    });
  });
});
