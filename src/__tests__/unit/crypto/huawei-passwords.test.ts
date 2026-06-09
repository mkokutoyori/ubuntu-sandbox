/**
 * Huawei VRP password schemes. The exact on-wire format is proprietary and
 * undocumented, so these reproduce the *algorithm family* with real crypto
 * rather than claiming byte-fidelity: irreversible-cipher = PBKDF2-HMAC-SHA256
 * (one-way), cipher = AES-256-CBC (reversible). The point is that the config
 * no longer displays the cleartext.
 */

import { describe, it, expect } from 'vitest';
import {
  huaweiIrreversibleCipher,
  huaweiCipher,
  huaweiDecipher,
} from '@/crypto/passwords';

describe('huaweiIrreversibleCipher (one-way)', () => {
  it('never returns the plaintext', () => {
    expect(huaweiIrreversibleCipher('Huawei@123')).not.toContain('Huawei@123');
  });

  it('is deterministic', () => {
    expect(huaweiIrreversibleCipher('Huawei@123')).toBe(huaweiIrreversibleCipher('Huawei@123'));
  });

  it('differs for different passwords', () => {
    expect(huaweiIrreversibleCipher('a')).not.toBe(huaweiIrreversibleCipher('b'));
  });

  it('produces a base64-shaped blob', () => {
    expect(huaweiIrreversibleCipher('secret')).toMatch(/^[A-Za-z0-9+/]+$/);
  });
});

describe('huaweiCipher / huaweiDecipher (reversible)', () => {
  it('round-trips arbitrary passwords', () => {
    for (const pw of ['a', 'Huawei@123', 'P@ssw0rd!', 'x'.repeat(16), 'éà😀']) {
      expect(huaweiDecipher(huaweiCipher(pw))).toBe(pw);
    }
  });

  it('never returns the plaintext', () => {
    expect(huaweiCipher('Admin@123')).not.toContain('Admin@123');
  });

  it('is deterministic', () => {
    expect(huaweiCipher('Admin@123')).toBe(huaweiCipher('Admin@123'));
  });

  it('produces a base64-shaped blob', () => {
    expect(huaweiCipher('secret')).toMatch(/^[A-Za-z0-9+/]+$/);
  });
});
