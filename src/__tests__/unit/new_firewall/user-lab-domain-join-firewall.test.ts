/*
 * The user's lab, imported as exported: PC2, the Windows client of the LAN
 * (192.168.1.0/24), joins google.com — the domain WinServer1 controls at HQ
 * (192.168.30.0/24) — THROUGH FW1. Policy 1 (LAN_SUBNET -> HQ_ADDRESS,
 * service ALL, NAT) is what lets the join cross; the tests rewrite that
 * policy through FW1's CLI and read the effect on the wire:
 *
 *   - policy 1 as imported: the join crosses (witness);
 *   - policy 1 narrowed to DNS: the SRV lookup answers but the LDAP and
 *     Kerberos legs are dropped, so no computer account is created;
 *   - policy 1 given the AD services: the join crosses again;
 *   - policy 1 disabled: nothing crosses.
 *
 * Only configuration is added; topology and equipment are the lab's.
 */
import { describe, it, expect } from 'vitest';
import type { WindowsServer } from '@/network/devices/WindowsServer';
import type { WindowsPC } from '@/network/devices/WindowsPC';
import { addRoutesToHq, loadUserLab, type UserLab } from './userLab';
import { taper } from './fortigateBatteryHarness';
import { AD_SERVICES, ADMIN_CREDENTIAL, pointDnsAt, promoteDomainController, shell, windows } from './userLabDomain';

const JOIN = `Add-Computer -DomainName "google.com" -Credential "${ADMIN_CREDENTIAL}"`;

async function lanClientLab(): Promise<UserLab> {
  const lab = await loadUserLab();
  await addRoutesToHq(lab);
  const dcIp = await promoteDomainController(lab.WinServer1);
  await lab.PC2.executeCommand('ipconfig /renew');
  await pointDnsAt(lab.PC2, dcIp);
  return lab;
}

function joined(lab: UserLab): boolean {
  return (windows(lab.PC2) as WindowsPC).getDomainMembership()?.dnsName === 'google.com';
}

function accountOnDc(lab: UserLab): boolean {
  return (windows(lab.WinServer1) as WindowsServer).getDirectoryStore()!.getComputer('PC2') !== null;
}

describe('user lab — PC2 rejoint google.com à travers FW1', () => {
  it('TÉMOIN : la policy 1 d origine laisse passer la jonction', async () => {
    const lab = await lanClientLab();
    const out = await shell(lab.PC2, JOIN);
    expect(out).not.toMatch(/could not be contacted|network path was not found/i);
    expect(joined(lab)).toBe(true);
    expect(accountOnDc(lab)).toBe(true);
  });

  it('la policy 1 restreinte à DNS bloque la jonction', async () => {
    const lab = await lanClientLab();
    await taper(lab.FW1, ['config firewall policy', 'edit 1', 'set service "DNS"', 'next', 'end']);
    const srv = await lab.PC2.executeCommand('nslookup -type=SRV _ldap._tcp.dc._msdcs.google.com');
    expect(srv).toContain('389');
    await shell(lab.PC2, JOIN);
    expect(joined(lab)).toBe(false);
    expect(accountOnDc(lab)).toBe(false);
  });

  it('la policy 1 rouverte aux services AD laisse passer la jonction', async () => {
    const lab = await lanClientLab();
    await taper(lab.FW1, [
      ...AD_SERVICES,
      'config firewall policy', 'edit 1', 'set service "DNS" "AD-KERBEROS" "AD-LDAP" "AD-SMB-RPC"', 'next', 'end',
    ]);
    await shell(lab.PC2, JOIN);
    expect(joined(lab)).toBe(true);
    expect(accountOnDc(lab)).toBe(true);
  });

  it('la policy 1 désactivée ne laisse rien passer', async () => {
    const lab = await lanClientLab();
    await taper(lab.FW1, ['config firewall policy', 'edit 1', 'set status disable', 'next', 'end']);
    await shell(lab.PC2, JOIN);
    expect(joined(lab)).toBe(false);
    expect(accountOnDc(lab)).toBe(false);
  });
});
