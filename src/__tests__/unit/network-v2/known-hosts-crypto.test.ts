/**
 * Migration guard: the hashed-known_hosts token (`|1|salt|hash`) must use a
 * real HMAC-SHA1 over the host name, keyed by the raw (base64-decoded) salt —
 * exactly OpenSSH's `HashKnownHosts yes` format — rather than the FNV stand-in.
 *
 * Oracle (Node crypto): HMAC-SHA1(salt=0x0b*20, "Hi There") base64 =
 * thcxhlUFcmTii8C2+zeMjvFGvgA=
 */

import { describe, it, expect } from 'vitest';
import {
  hashKnownHostsToken,
  isHashedKnownHostsToken,
  matchHashedHost,
} from '@/network/protocols/ssh/SshPureUtils';

const SALT_B64 = 'CwsLCwsLCwsLCwsLCwsLCwsLCws='; // 20 x 0x0b

describe('hashKnownHostsToken — real HMAC-SHA1', () => {
  it('matches the OpenSSH token for a known salt + host', () => {
    expect(hashKnownHostsToken('Hi There', SALT_B64)).toBe(
      `|1|${SALT_B64}|thcxhlUFcmTii8C2+zeMjvFGvgA=`,
    );
  });

  it('produces the |1|salt|hash shape with base64 fields', () => {
    const token = hashKnownHostsToken('router.lab');
    expect(token).toMatch(/^\|1\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+$/);
    expect(isHashedKnownHostsToken(token)).toBe(true);
  });

  it('is deterministic for the same host (stable derived salt)', () => {
    expect(hashKnownHostsToken('host-a')).toBe(hashKnownHostsToken('host-a'));
  });

  it('yields different hashes for different hosts', () => {
    expect(hashKnownHostsToken('host-a')).not.toBe(hashKnownHostsToken('host-b'));
  });
});

describe('matchHashedHost — round-trip', () => {
  it('matches the host that produced the token', () => {
    const token = hashKnownHostsToken('10.0.0.1');
    expect(matchHashedHost(token, '10.0.0.1')).toBe(true);
  });

  it('rejects a different host', () => {
    const token = hashKnownHostsToken('10.0.0.1');
    expect(matchHashedHost(token, '10.0.0.2')).toBe(false);
  });

  it('compares plaintext tokens directly', () => {
    expect(matchHashedHost('plain.host', 'plain.host')).toBe(true);
    expect(matchHashedHost('plain.host', 'other.host')).toBe(false);
  });
});
