/**
 * Integration guard: Huawei `display current-configuration` must not leak the
 * cleartext local-user password — irreversible-cipher is hashed (PBKDF2), and
 * cipher is real, reversible AES.
 */

import { describe, it, expect } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { huaweiDecipher } from '@/crypto';

async function configured(commands: string[]): Promise<HuaweiRouter> {
  const r = new HuaweiRouter('R1');
  await r.executeCommand('system-view');
  await r.executeCommand('aaa');
  for (const c of commands) await r.executeCommand(c);
  await r.executeCommand('quit');
  await r.executeCommand('quit');
  return r;
}

describe('Huawei local-user secrets in display current-configuration', () => {
  it('hashes an irreversible-cipher password (no cleartext)', async () => {
    const r = await configured(['local-user admin password irreversible-cipher Huawei@123']);
    const config = await r.executeCommand('display current-configuration');
    expect(config).toContain('local-user admin password irreversible-cipher');
    expect(config).not.toContain('Huawei@123');
  });

  it('encrypts a cipher password with reversible AES (no cleartext)', async () => {
    const r = await configured(['local-user admin password cipher Admin@123']);
    const config = await r.executeCommand('display current-configuration');
    const m = /local-user admin password cipher ([A-Za-z0-9+/]+)/.exec(config);
    expect(m).not.toBeNull();
    expect(config).not.toContain('cipher Admin@123');
    // The displayed blob is genuine AES — it decrypts back to the password.
    expect(huaweiDecipher(m![1])).toBe('Admin@123');
  });
});
