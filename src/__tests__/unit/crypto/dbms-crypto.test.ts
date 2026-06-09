/**
 * DBMS_CRYPTO package routines — HASH / MAC / ENCRYPT / DECRYPT backed by the
 * real crypto module. Routines are invoked directly (they don't touch the
 * session); an integration test exercises the SQL*Plus dispatch separately.
 */

import { describe, it, expect } from 'vitest';
import { builtinPackageRegistry } from '@/database/oracle/packages';
import type { PackageCallContext } from '@/database/oracle/packages';
import { sha256, hmac, SHA256, bytesToHex, hexToBytes, utf8ToBytes } from '@/crypto';

const ctx = { session: {}, rawCall: '' } as unknown as PackageCallContext;
const call = (name: string, args: string[]): string | null =>
  builtinPackageRegistry.resolve(name)!.invoke(args, ctx);

describe('DBMS_CRYPTO.HASH', () => {
  it('HASH_SH256 (typ 4) of text equals real SHA-256, uppercase hex', () => {
    expect(call('DBMS_CRYPTO.HASH', ['Hello', '4'])).toBe(
      bytesToHex(sha256(utf8ToBytes('Hello'))).toUpperCase(),
    );
  });

  it('treats a valid hex argument as RAW bytes', () => {
    // 48656C6C6F == "Hello" → same digest as the text form.
    expect(call('DBMS_CRYPTO.HASH', ['48656C6C6F', '4'])).toBe(
      call('DBMS_CRYPTO.HASH', ['Hello', '4']),
    );
  });

  it('supports MD5 (2), SHA1 (3), SHA512 (6)', () => {
    expect(call('DBMS_CRYPTO.HASH', ['x', '2'])).toMatch(/^[0-9A-F]{32}$/);
    expect(call('DBMS_CRYPTO.HASH', ['x', '3'])).toMatch(/^[0-9A-F]{40}$/);
    expect(call('DBMS_CRYPTO.HASH', ['x', '6'])).toMatch(/^[0-9A-F]{128}$/);
  });
});

describe('DBMS_CRYPTO.MAC', () => {
  it('HMAC_SH256 (typ 3) equals real HMAC-SHA256', () => {
    const key = '0b'.repeat(20);
    const expected = bytesToHex(hmac(SHA256, hexToBytes(key), utf8ToBytes('Hi There'))).toUpperCase();
    expect(call('DBMS_CRYPTO.MAC', ['Hi There', '3', key])).toBe(expected);
  });
});

describe('DBMS_CRYPTO.ENCRYPT / DECRYPT (AES-CBC)', () => {
  const key = '00'.repeat(32); // AES-256
  const iv = '00'.repeat(16);

  it('round-trips a plaintext through ENCRYPT then DECRYPT', () => {
    const ct = call('DBMS_CRYPTO.ENCRYPT', ['48656C6C6F', '4360', key, iv])!; // "Hello"
    expect(ct).toMatch(/^[0-9A-F]+$/);
    expect(ct).not.toContain('48656C6C6F');
    const pt = call('DBMS_CRYPTO.DECRYPT', [ct, '4360', key, iv]);
    expect(pt).toBe('48656C6C6F');
  });
});
