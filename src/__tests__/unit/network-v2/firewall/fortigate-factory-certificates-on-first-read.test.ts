/*
 * Probe — a FortiGate generates its four factory certificates when they are
 * first READ, not when the box is built.
 *
 * Measured before the change (git stash of src/network): 2 of the 3 cases
 * fail — the constructor alone generated 4 RSA certificate authorities
 * (~55 ms per FortiGate, the heaviest line of a battery lab's CPU profile),
 * so both "generates none" cases saw 4 calls.
 * Passing either way:
 *   - "show vpn certificate local" is the WITNESS: the four factory entries
 *     still exist and still carry their PEM once they are read.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';

interface Cli { executeCommand(command: string): Promise<string> }

async function type(fw: Cli, lines: readonly string[]): Promise<void> {
  for (const line of lines) await fw.executeCommand(line);
}

describe('FortiGate factory certificates are generated on first read', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('building the box generates none', () => {
    const generate = vi.spyOn(CertificateAuthority, 'generate');
    createDevice('firewall-fortinet', 0, 0);
    expect(generate).not.toHaveBeenCalled();
  });

  it('configuring interfaces and a policy generates none', async () => {
    const generate = vi.spyOn(CertificateAuthority, 'generate');
    const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Cli;
    await type(fw, [
      'config system interface', 'edit port1', 'set mode static',
      'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping ssh http https', 'next', 'end',
      'config firewall policy', 'edit 1', 'set srcintf "port1"', 'set dstintf "wan1"',
      'set srcaddr "all"', 'set dstaddr "all"', 'set action accept',
      'set schedule "always"', 'set service "ALL"', 'next', 'end',
    ]);
    expect(generate).not.toHaveBeenCalled();
  });

  it('show vpn certificate local lists the four factory entries with their PEM', async () => {
    const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Cli;
    const output = await fw.executeCommand('show vpn certificate local');
    for (const name of ['Fortinet_CA_SSL', 'Fortinet_CA_Untrusted', 'Fortinet_Factory', 'self-sign']) {
      expect(output).toContain(`edit "${name}"`);
    }
    expect(output).toContain('BEGIN CERTIFICATE');
  });
});
