/**
 * Cisco type-9 secrets ($9$) — scrypt (N=16384, r=1, p=1, 32-byte key) encoded
 * with the crypt base64 alphabet. Vectors cross-checked with the hashcat 9300
 * example and python hashlib.scrypt.
 */

import { describe, it, expect } from 'vitest';
import { ciscoType9 } from '@/crypto/passwords';

describe('ciscoType9 — reference vectors', () => {
  it.each([
    ['hashcat', '2MJBozw/9R3UsU', '$9$2MJBozw/9R3UsU$2lFhcKvpghcyw8deP25GOfyZaagyUOGBymkryvOdfo6'],
    ['cisco', 'saltsaltsaltsa', '$9$saltsaltsaltsa$x41LZkJebZBa0MAlDAaan33pTvyNBOnKoABAogAuBNg'],
    ['password', '1234567890ABCD', '$9$1234567890ABCD$GDrCfN0PR7MoDIwfu4T12iYwniP3OSXAdni82XPlCE2'],
  ])('ciscoType9(%j, %j)', (password, salt, expected) => {
    expect(ciscoType9(password, salt)).toBe(expected);
  });
});

describe('ciscoType9 — structure', () => {
  it('produces $9$<salt>$<43-char> using the crypt alphabet', () => {
    expect(ciscoType9('secret', 'abcdefghijklmn')).toMatch(
      /^\$9\$abcdefghijklmn\$[./0-9A-Za-z]{43}$/,
    );
  });

  it('is deterministic', () => {
    expect(ciscoType9('cisco', 'saltsaltsaltsa')).toBe(ciscoType9('cisco', 'saltsaltsaltsa'));
  });
});
