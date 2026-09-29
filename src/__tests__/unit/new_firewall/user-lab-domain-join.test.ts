/*
 * The user's lab (lan_with_firewall_fortigate.topology), imported as
 * exported: WinServer1 is promoted to a domain controller for google.com —
 * the DSRM password entered through a nested `(Read-Host -AsSecureString
 * …)`, the form this branch makes interactive — and PC4, the Windows client
 * on the same HQ segment (192.168.30.0/24 behind R3), joins that domain
 * without ever being told the DC's address: it points its DNS client at the
 * DC and `Add-Computer -DomainName google.com` locates it by the
 * `_ldap._tcp.dc._msdcs.google.com` SRV record the promotion published.
 *
 * Only configuration is added; the topology and the equipment are those of
 * the imported lab. WinServer1 and PC4 hang off HQ_MAIN_SW, so they share
 * the 192.168.30.0/24 broadcast domain and reach each other directly.
 */
import { describe, it, expect } from 'vitest';
import type { WindowsServer } from '@/network/devices/WindowsServer';
import type { WindowsPC } from '@/network/devices/WindowsPC';
import { loadUserLab, type UserLab } from './userLab';
import { ADMIN_CREDENTIAL, pointDnsAt, promoteDomainController, shell, windows } from './userLabDomain';

async function domainReadyLab(): Promise<{ lab: UserLab; dcIp: string }> {
  const lab = await loadUserLab();
  const dcIp = await promoteDomainController(lab.WinServer1);
  await lab.PC4.executeCommand('ipconfig /renew');
  await pointDnsAt(lab.PC4, dcIp);
  return { lab, dcIp };
}

const JOIN = `Add-Computer -DomainName "google.com" -Credential "${ADMIN_CREDENTIAL}"`;

describe('user lab — WinServer1 devient contrôleur de domaine google.com', () => {
  it('la promotion via (Read-Host) publie le SRV du localisateur de DC', async () => {
    const lab = await loadUserLab();
    const dcIp = await promoteDomainController(lab.WinServer1);
    expect((windows(lab.WinServer1) as WindowsServer).getDirectoryStore()).not.toBeNull();
    const srv = await lab.WinServer1.executeCommand(`nslookup -type=SRV _ldap._tcp.dc._msdcs.google.com ${dcIp}`);
    expect(srv).toContain('389');
    expect(srv).toMatch(/google\.com/i);
  });

  it('PC4 rejoint google.com sans qu on lui nomme le DC', async () => {
    const { lab } = await domainReadyLab();
    const out = await shell(lab.PC4, JOIN);
    expect(out).not.toMatch(/could not be contacted|not recognized/i);
    expect((windows(lab.PC4) as WindowsPC).getDomainMembership()?.dnsName).toBe('google.com');
    expect((windows(lab.WinServer1) as WindowsServer).getDirectoryStore()!.getComputer('PC4')).not.toBeNull();
  });

  it('un utilisateur du domaine ouvre une session sur PC4 une fois joint', async () => {
    const { lab } = await domainReadyLab();
    await shell(lab.PC4, JOIN);
    const res = (windows(lab.PC4) as WindowsPC).logonDomain('GOOGLE\\jdupont', 'Passw0rd!');
    expect(res.ok).toBe(true);
    expect((windows(lab.PC4) as WindowsPC).getDomainSession()?.sam).toBe('jdupont');
  });
});
