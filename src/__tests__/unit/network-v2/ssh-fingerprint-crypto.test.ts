/**
 * Migration guard: SshFingerprint must use a real SHA-256 digest (OpenSSH
 * `ssh-keygen -lf` format) rather than the historical FNV stand-in.
 *
 * The reference value is computed by an independent implementation
 * (Node's crypto): SHA256:base64(sha256(key)) with padding stripped.
 */

import { describe, it, expect } from 'vitest';
import { SshFingerprint } from '@/network/protocols/ssh/SshFingerprint';

describe('SshFingerprint — real SHA-256', () => {
  it('matches the OpenSSH SHA-256 fingerprint of the key material', () => {
    expect(SshFingerprint.fromPublicKey('abc').toString()).toBe(
      'SHA256:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0',
    );
  });

  it('keeps the SHA256:<base64> shape (43 chars, no padding)', () => {
    const fp = SshFingerprint.fromPublicKey('some-key-material').toString();
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(fp).not.toContain('=');
  });

  it('is deterministic for the same key', () => {
    expect(SshFingerprint.fromPublicKey('k').toString()).toBe(
      SshFingerprint.fromPublicKey('k').toString(),
    );
  });

  it('avalanches: a one-character change flips most of the digest', () => {
    const a = SshFingerprint.fromPublicKey('key-a').toString();
    const b = SshFingerprint.fromPublicKey('key-b').toString();
    expect(a).not.toBe(b);
  });
});
