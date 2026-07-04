/**
 * Cisco `crypto pki trustpoint`/`enroll`/`authenticate` produced realistic
 * output ("Certificate request sent...") but never called
 * CiscoRouter.installIkeCertAuth() — so configuring `authentication rsa-sig`
 * had zero effect on real negotiation (IkeOfferMessage.authMode only became
 * 'x509' when a cert was installed via direct test-only API calls).
 *
 * This drives the PKI flow entirely through real CLI commands and proves a
 * genuine IKEv2 tunnel establishes from real CA-issued certificates — and
 * that two trustpoints pointed at *different* CAs still correctly reject
 * each other, so this isn't just an always-pass shortcut.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetPkiCaRegistry } from '@/network/pki/PkiCaRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  resetPkiCaRegistry();
});

async function buildLab() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');
  new Cable('wan').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);
  return { r1, r2, pc1, pc2 };
}

async function configureBase(
  router: CiscoRouter,
  wanIp: string, peerWan: string, lanIp: string,
  localSubnet: string, remoteSubnet: string,
): Promise<void> {
  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', `ip address ${wanIp} 255.255.255.252`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/0', `ip address ${lanIp} 255.255.255.0`, 'no shutdown', 'exit',
    'crypto ikev2 proposal PROP', 'encryption aes-cbc-256', 'integrity sha256', 'group 14', 'exit',
    'crypto ikev2 policy POL', 'proposal PROP', 'exit',
    'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
    'ip access-list extended VPN_ACL',
    `permit ip ${localSubnet} 0.0.0.255 ${remoteSubnet} 0.0.0.255`, 'exit',
    `ip route ${remoteSubnet} 255.255.255.0 ${peerWan}`,
    'end',
  ]) await router.executeCommand(cmd);
}

async function enrollTrustpoint(router: CiscoRouter, caUrl: string, subject: string): Promise<string[]> {
  const out: string[] = [];
  for (const cmd of [
    'enable', 'configure terminal',
    'crypto pki trustpoint TP',
    `enrollment url ${caUrl}`,
    `subject-name ${subject}`,
    'revocation-check none',
    'exit',
    'crypto pki authenticate TP',
    'crypto pki enroll TP',
    'end',
  ]) out.push(await router.executeCommand(cmd));
  return out;
}

async function configureX509Profile(router: CiscoRouter, peerWan: string): Promise<void> {
  for (const cmd of [
    'enable', 'configure terminal',
    'crypto ikev2 profile PROF',
    `match identity remote address ${peerWan} 255.255.255.255`,
    'authentication remote rsa-sig', 'authentication local rsa-sig', 'exit',
    'crypto map CMAP 10 ipsec-isakmp',
    `set peer ${peerWan}`, 'set ikev2-profile PROF',
    'set transform-set TSET', 'match address VPN_ACL', 'exit',
    'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit', 'end',
  ]) await router.executeCommand(cmd);
}

async function seedPcs(pc1: LinuxPC, pc2: LinuxPC): Promise<void> {
  await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
  await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await pc2.executeCommand('sudo ip route add default via 192.168.2.1');
}

describe('crypto pki trustpoint — real CA enrollment wired to IKE cert auth', () => {
  it('enroll before authenticate is rejected (real IOS ordering)', async () => {
    const r1 = new CiscoRouter('R1');
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('crypto pki trustpoint TP');
    await r1.executeCommand('exit');
    const out = await r1.executeCommand('crypto pki enroll TP');
    expect(out).toMatch(/not authenticated/i);
  });

  it('authenticate + enroll install a real CA-issued cert (not "Pending enrollment")', async () => {
    const r1 = new CiscoRouter('R1');
    await enrollTrustpoint(r1, 'http://ca.example.com/pki', 'CN=r1.example.com');
    const certs = await r1.executeCommand('show crypto pki certificates');
    expect(certs).toContain('Status: Available');
    expect(certs).not.toContain('Pending enrollment');
    expect(certs).toContain('CN=r1.example.com');
  });

  it('two routers enrolling with the same CA URL establish a real IKEv2 tunnel over rsa-sig auth', async () => {
    const l = await buildLab();
    await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
    await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
    await enrollTrustpoint(l.r1, 'http://ca.example.com/pki', 'CN=10.0.12.1');
    await enrollTrustpoint(l.r2, 'http://ca.example.com/pki', 'CN=10.0.12.2');
    await configureX509Profile(l.r1, '10.0.12.2');
    await configureX509Profile(l.r2, '10.0.12.1');
    await seedPcs(l.pc1, l.pc2);

    const ping = await l.pc1.executeCommand('ping -c 2 192.168.2.10');
    expect(ping).toContain('2 received');
    const sa = await l.r1.executeCommand('show crypto ikev2 sa');
    expect(sa).toMatch(/READY/);
  });

  it('routers enrolled with different CA URLs (different CAs) do not trust each other', async () => {
    const l = await buildLab();
    await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
    await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
    await enrollTrustpoint(l.r1, 'http://ca-a.example.com/pki', 'CN=10.0.12.1');
    await enrollTrustpoint(l.r2, 'http://ca-b.example.com/pki', 'CN=10.0.12.2');
    await configureX509Profile(l.r1, '10.0.12.2');
    await configureX509Profile(l.r2, '10.0.12.1');
    await seedPcs(l.pc1, l.pc2);

    await l.pc1.executeCommand('ping -c 1 192.168.2.10');
    const detail = await l.r1.executeCommand('show crypto isakmp sa detail');
    expect(detail).toMatch(/Certificate unknown/i);
  });
});
