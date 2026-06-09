/**
 * Cisco type-8 secrets ($8$) — PBKDF2-HMAC-SHA256, 20 000 iterations, encoded
 * with the crypt base64 alphabet. Vectors cross-checked with the hashcat 9200
 * example and glibc-backed PBKDF2 (python hashlib).
 */

import { describe, it, expect } from 'vitest';
import { ciscoType8 } from '@/crypto/passwords';

describe('ciscoType8 — reference vectors', () => {
  it.each([
    ['hashcat', 'TnGX/fE4KGHOVU', '$8$TnGX/fE4KGHOVU$pEhnEvxrvaynpi8j4f.EMHr6M.FzU8xnZnBr/tJdFWk'],
    ['cisco', 'aGvFwbeWFD/edQ', '$8$aGvFwbeWFD/edQ$aZTg6XAsBhnVP9UfiKkM.OG7oHhnH9nnwFQRQrYbBao'],
    ['password', '1234567890ABCD', '$8$1234567890ABCD$OJBv3j89uAbnIc07nJwvdbs1ghfiTsAH2d7IrHWXSNA'],
    ['cisco', 'saltsaltsaltsa', '$8$saltsaltsaltsa$ClWYAoAJtwxxY0tbkDLTT.Mtjxajfq2Js7lfSNKdgV2'],
  ])('ciscoType8(%j, %j)', (password, salt, expected) => {
    expect(ciscoType8(password, salt)).toBe(expected);
  });
});

describe('ciscoType8 — structure', () => {
  it('produces $8$<salt>$<43-char> using the crypt alphabet', () => {
    expect(ciscoType8('secret', 'abcdefghijklmn')).toMatch(
      /^\$8\$abcdefghijklmn\$[./0-9A-Za-z]{43}$/,
    );
  });

  it('is deterministic', () => {
    expect(ciscoType8('cisco', 'saltsaltsaltsa')).toBe(
      ciscoType8('cisco', 'saltsaltsaltsa'),
    );
  });

  it('honours a custom iteration count', () => {
    // Fewer rounds must yield a different (still valid) hash.
    expect(ciscoType8('cisco', 'saltsaltsaltsa', 1)).not.toBe(
      ciscoType8('cisco', 'saltsaltsaltsa'),
    );
  });
});
