/*
 * The PKI trustpoint sub-mode (`crypto pki trustpoint`) declared natively on
 * the socle instead of re-read from the trie.
 *
 * Measured before the change: 2 of the 7 cases fall — `ip-address zorglub` was
 * stored verbatim and rendered in the running-config, and `auto-enroll 150`
 * was accepted (a percentage beyond 100). The other five are witnesses:
 * the common settings, the `none` forms, the unknown enrollment method and
 * revocation mode the adapter already refused, and the enrollment reset.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function trustpoint(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of ['enable', 'configure terminal', 'crypto pki trustpoint TP']) {
    await r.executeCommand(l);
  }
  return r;
}

const CARET = /\^\n% Invalid input detected at '\^' marker\./;
const running = (r: Cli) => r.executeCommand('do show running-config');

describe('crypto pki trustpoint sub-mode', () => {
  it('witness: the common settings are recorded and rendered', async () => {
    const r = await trustpoint();
    for (const l of ['enrollment url http://10.0.0.1:80', 'subject-name CN=r1', 'rsakeypair K1',
      'fqdn r1.example.com', 'ip-address 10.0.0.1', 'revocation-check crl', 'auto-enroll 80 regenerate']) {
      expect(await r.executeCommand(l), l).toBe('');
    }
    const config = await running(r);
    for (const line of ['enrollment url http://10.0.0.1:80', 'subject-name CN=r1', 'rsakeypair K1',
      'fqdn r1.example.com', 'ip-address 10.0.0.1', 'revocation-check crl', 'auto-enroll 80 regenerate']) {
      expect(config, line).toContain(line);
    }
  });

  it('refuses an ip-address that is not an address', async () => {
    expect(await (await trustpoint()).executeCommand('ip-address zorglub')).toMatch(CARET);
  });

  it('witness: `ip-address none` and `serial-number none` are accepted', async () => {
    const r = await trustpoint();
    expect(await r.executeCommand('ip-address none')).toBe('');
    expect(await r.executeCommand('serial-number none')).toBe('');
  });

  it('refuses an auto-enroll percentage beyond 100', async () => {
    expect(await (await trustpoint()).executeCommand('auto-enroll 150')).toMatch(CARET);
  });

  it('refuses an auto-enroll word that is not a percentage', async () => {
    expect(await (await trustpoint()).executeCommand('auto-enroll zorglub')).toMatch(CARET);
  });

  it('witness: an unknown enrollment method or revocation mode is refused', async () => {
    const r = await trustpoint();
    expect(await r.executeCommand('enrollment zorglub')).toMatch(CARET);
    expect(await r.executeCommand('revocation-check zorglub')).toMatch(CARET);
  });

  it('witness: self-signed enrollment replaces an URL', async () => {
    const r = await trustpoint();
    await r.executeCommand('enrollment url http://10.0.0.1');
    await r.executeCommand('enrollment selfsigned');
    const config = await running(r);
    expect(config).toContain('enrollment selfsigned');
    expect(config).not.toContain('enrollment url');
  });
});
