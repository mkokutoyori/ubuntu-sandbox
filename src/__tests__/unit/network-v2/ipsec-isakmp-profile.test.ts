/**
 * `crypto isakmp profile` (keyring, match identity address, self-identity)
 * was pure CLI scaffolding — stored in an untyped ad-hoc Map nothing on the
 * real negotiation path ever read. IKEv1 PSK resolution always fell back to
 * the flat `crypto isakmp key ... address ...` table regardless of any
 * profile/keyring configuration. This drives real two-router IKEv1 tunnels
 * where the ONLY PSK available is the one bound through a profile's
 * `crypto keyring` — proving genuine wiring, not a silent fallback.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../support/fastPing';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
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
    'crypto isakmp policy 10', 'encryption aes 256', 'hash sha256', 'authentication pre-share', 'group 14', 'exit',
    'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
    'ip access-list extended VPN_ACL',
    `permit ip ${localSubnet} 0.0.0.255 ${remoteSubnet} 0.0.0.255`, 'exit',
    `ip route ${remoteSubnet} 255.255.255.0 ${peerWan}`,
    'end',
  ]) await router.executeCommand(cmd);
}

async function seedPcs(pc1: LinuxPC, pc2: LinuxPC): Promise<void> {
  await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
  await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await pc2.executeCommand('sudo ip route add default via 192.168.2.1');
}

describe('crypto isakmp profile / keyring — real PSK and identity resolution', () => {
  it('a profile-scoped keyring PSK establishes a real tunnel with no global "crypto isakmp key" configured at all', async () => {
    const l = await buildLab();
    await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
    await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');

    for (const cmd of [
      'enable', 'configure terminal',
      'crypto keyring KR1', 'pre-shared-key address 10.0.12.2 key ProfileOnlySecret', 'exit',
      'crypto isakmp profile PROF1', 'keyring KR1', 'match identity address 10.0.12.2', 'exit',
      'crypto map CMAP 10 ipsec-isakmp', 'set peer 10.0.12.2', 'set transform-set TSET',
      'set isakmp-profile PROF1', 'match address VPN_ACL', 'exit',
      'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit', 'end',
    ]) await l.r1.executeCommand(cmd);

    for (const cmd of [
      'enable', 'configure terminal',
      'crypto keyring KR2', 'pre-shared-key address 10.0.12.1 key ProfileOnlySecret', 'exit',
      'crypto isakmp profile PROF2', 'keyring KR2', 'match identity address 10.0.12.1', 'exit',
      'crypto map CMAP 10 ipsec-isakmp', 'set peer 10.0.12.1', 'set transform-set TSET',
      'set isakmp-profile PROF2', 'match address VPN_ACL', 'exit',
      'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit', 'end',
    ]) await l.r2.executeCommand(cmd);

    await seedPcs(l.pc1, l.pc2);
    const ping = await pingOnSimulatedClock(l.pc1, 'ping -c 2 192.168.2.10');
    expect(ping).toContain('2 received');
    const sa = await l.r1.executeCommand('show crypto isakmp sa');
    expect(sa).toContain('QM_IDLE');
  });

  it('a mismatched keyring PSK (wrong secret) is rejected — not silently accepted via some fallback', async () => {
    const l = await buildLab();
    await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
    await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');

    for (const cmd of [
      'enable', 'configure terminal',
      'crypto keyring KR1', 'pre-shared-key address 10.0.12.2 key SecretA', 'exit',
      'crypto isakmp profile PROF1', 'keyring KR1', 'match identity address 10.0.12.2', 'exit',
      'crypto map CMAP 10 ipsec-isakmp', 'set peer 10.0.12.2', 'set transform-set TSET',
      'set isakmp-profile PROF1', 'match address VPN_ACL', 'exit',
      'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit', 'end',
    ]) await l.r1.executeCommand(cmd);

    for (const cmd of [
      'enable', 'configure terminal',
      'crypto keyring KR2', 'pre-shared-key address 10.0.12.1 key SecretB', 'exit',
      'crypto isakmp profile PROF2', 'keyring KR2', 'match identity address 10.0.12.1', 'exit',
      'crypto map CMAP 10 ipsec-isakmp', 'set peer 10.0.12.1', 'set transform-set TSET',
      'set isakmp-profile PROF2', 'match address VPN_ACL', 'exit',
      'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit', 'end',
    ]) await l.r2.executeCommand(cmd);

    await seedPcs(l.pc1, l.pc2);
    await pingOnSimulatedClock(l.pc1, 'ping -c 1 192.168.2.10');
    const detail = await l.r1.executeCommand('show crypto isakmp sa detail');
    expect(detail).toMatch(/PSK mismatch|authentication failed/i);
  });

  it('"match identity address" gates the profile: a profile bound to the WRONG peer address does not donate its keyring PSK', async () => {
    const l = await buildLab();
    await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
    await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');

    for (const cmd of [
      'enable', 'configure terminal',
      'crypto keyring KR1', 'pre-shared-key address 10.0.12.2 key ProfileOnlySecret', 'exit',
      // Profile is bound to a DIFFERENT (wrong) address than the real peer.
      'crypto isakmp profile PROF1', 'keyring KR1', 'match identity address 203.0.113.9', 'exit',
      'crypto map CMAP 10 ipsec-isakmp', 'set peer 10.0.12.2', 'set transform-set TSET',
      'set isakmp-profile PROF1', 'match address VPN_ACL', 'exit',
      'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit', 'end',
    ]) await l.r1.executeCommand(cmd);

    for (const cmd of [
      'enable', 'configure terminal',
      'crypto keyring KR2', 'pre-shared-key address 10.0.12.1 key ProfileOnlySecret', 'exit',
      'crypto isakmp profile PROF2', 'keyring KR2', 'match identity address 10.0.12.1', 'exit',
      'crypto map CMAP 10 ipsec-isakmp', 'set peer 10.0.12.1', 'set transform-set TSET',
      'set isakmp-profile PROF2', 'match address VPN_ACL', 'exit',
      'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit', 'end',
    ]) await l.r2.executeCommand(cmd);

    await seedPcs(l.pc1, l.pc2);
    await pingOnSimulatedClock(l.pc1, 'ping -c 1 192.168.2.10');
    const detail = await l.r1.executeCommand('show crypto isakmp sa detail');
    expect(detail).toMatch(/PSK mismatch|authentication failed/i);
  });

  it('"self-identity fqdn" is really carried in the IKE offer — the responder authenticates it by that name, not by IP', async () => {
    const l = await buildLab();
    await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
    await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');

    for (const cmd of [
      'enable', 'configure terminal',
      'crypto isakmp profile PROF1', 'self-identity fqdn r1.example.com', 'exit',
      'crypto map CMAP 10 ipsec-isakmp', 'set peer 10.0.12.2', 'set transform-set TSET',
      'set isakmp-profile PROF1', 'match address VPN_ACL', 'exit',
      'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit', 'end',
    ]) await l.r1.executeCommand(cmd);

    // R2 has NO key for R1's real IP — only for the FQDN identity R1 will present.
    for (const cmd of [
      'enable', 'configure terminal',
      'crypto isakmp key ProfileOnlySecret address r1.example.com',
      'crypto map CMAP 10 ipsec-isakmp', 'set peer 10.0.12.1', 'set transform-set TSET',
      'match address VPN_ACL', 'exit',
      'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit', 'end',
    ]) await l.r2.executeCommand(cmd);
    // R1 needs a key for R2's real IP to authenticate R2's side of the exchange.
    await l.r1.executeCommand('enable');
    await l.r1.executeCommand('configure terminal');
    await l.r1.executeCommand('crypto isakmp key ProfileOnlySecret address 10.0.12.2');
    await l.r1.executeCommand('end');

    await seedPcs(l.pc1, l.pc2);
    const ping = await pingOnSimulatedClock(l.pc1, 'ping -c 2 192.168.2.10');
    expect(ping).toContain('2 received');
  });
});
