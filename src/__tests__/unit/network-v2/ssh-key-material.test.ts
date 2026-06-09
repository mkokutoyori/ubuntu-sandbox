/**
 * Migration guard: SSH host/user key material must be derived from a real
 * SHA-256 counter-mode expansion, not the historical FNV stand-in. The
 * material stays deterministic and base64-shaped, but is now cryptographically
 * derived. Oracle: base64(sha256(`${seed}#${i}`)) blocks, padding stripped.
 */

import { describe, it, expect } from 'vitest';
import { deriveKeyMaterial } from '@/network/protocols/ssh/sshKeyMaterial';

describe('deriveKeyMaterial', () => {
  it('matches the SHA-256 reference for a single block (43 chars)', () => {
    expect(deriveKeyMaterial('ssh-ed25519:host1', 43)).toBe(
      '6DrnEEjdAH42E90l2FYdPjI+TBuuSBqtYHB7h70FkL4',
    );
  });

  it('spans multiple SHA-256 blocks for longer requests', () => {
    expect(deriveKeyMaterial('seed', 50)).toBe(
      'h0I/F4xOUs84tdXs4XGkwxXUL/JMHFDRdiQQbnWhQvMwpXnzsy',
    );
  });

  it('returns exactly the requested length', () => {
    expect(deriveKeyMaterial('x', 43).length).toBe(43);
    expect(deriveKeyMaterial('x', 64).length).toBe(64);
    expect(deriveKeyMaterial('x', 1).length).toBe(1);
  });

  it('uses the base64 alphabet (no padding, no whitespace)', () => {
    expect(deriveKeyMaterial('host', 64)).toMatch(/^[A-Za-z0-9+/]+$/);
  });

  it('is deterministic', () => {
    expect(deriveKeyMaterial('same', 43)).toBe(deriveKeyMaterial('same', 43));
  });

  it('diverges for different seeds', () => {
    expect(deriveKeyMaterial('seed-a', 43)).not.toBe(deriveKeyMaterial('seed-b', 43));
  });

  it('is prefix-stable across lengths', () => {
    const short = deriveKeyMaterial('host', 20);
    const long = deriveKeyMaterial('host', 80);
    expect(long.startsWith(short)).toBe(true);
  });
});
