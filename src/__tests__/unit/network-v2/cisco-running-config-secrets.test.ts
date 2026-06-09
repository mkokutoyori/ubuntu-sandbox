/**
 * Integration guard: `show running-config` must not leak plaintext passwords.
 *
 * End-to-end, through the real CLI: configuring secrets/passwords and dumping
 * the config now routes plaintext through real md5crypt ($1$) and type-7.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { decryptType7, md5Crypt } from '@/crypto';

async function configured(commands: string[]): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  for (const c of commands) await r.executeCommand(c);
  await r.executeCommand('end');
  return r;
}

describe('enable secret in show running-config', () => {
  let config: string;
  beforeEach(async () => {
    const r = await configured(['enable secret cisco']);
    config = await r.executeCommand('show running-config');
  });

  it('emits a real md5crypt hash, not the cleartext', () => {
    expect(config).toMatch(/enable secret 5 \$1\$[./0-9A-Za-z]+\$[./0-9A-Za-z]{22}/);
    expect(config).not.toContain('enable secret 5 cisco');
  });

  it('the emitted hash verifies against md5crypt', () => {
    const m = /enable secret 5 (\$1\$[./0-9A-Za-z]+\$[./0-9A-Za-z]{22})/.exec(config);
    expect(m).not.toBeNull();
    const hash = m![1];
    const salt = hash.split('$')[2];
    expect(md5Crypt('cisco', salt)).toBe(hash);
  });
});

describe('username secret in show running-config', () => {
  it('hashes the plaintext user secret with md5crypt', async () => {
    const r = await configured(['username admin privilege 15 secret cisco']);
    const config = await r.executeCommand('show running-config');
    expect(config).toMatch(/username admin privilege 15 secret 5 \$1\$/);
    expect(config).not.toContain('secret 5 cisco');
  });
});

describe('enable password with service password-encryption', () => {
  it('type-7 encodes the plaintext (recoverable, but not cleartext)', async () => {
    const r = await configured(['enable password weakpass', 'service password-encryption']);
    const config = await r.executeCommand('show running-config');
    const m = /enable password 7 ([0-9A-F]+)/.exec(config);
    expect(m).not.toBeNull();
    expect(decryptType7(m![1])).toBe('weakpass');
    expect(config).not.toContain('enable password 0 weakpass');
  });

  it('leaves the password as cleartext type 0 when encryption is off', async () => {
    const r = await configured(['enable password weakpass']);
    const config = await r.executeCommand('show running-config');
    expect(config).toContain('enable password 0 weakpass');
  });
});
