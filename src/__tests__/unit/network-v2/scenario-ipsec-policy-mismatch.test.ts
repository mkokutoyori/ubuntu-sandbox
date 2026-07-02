import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

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

async function configureIkev1(
  router: CiscoRouter,
  wanIp: string, peerWan: string, lanIp: string,
  localSubnet: string, remoteSubnet: string,
  enc: string, hash: string, group: number,
  psk: string,
): Promise<void> {
  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', `ip address ${wanIp} 255.255.255.252`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/0', `ip address ${lanIp} 255.255.255.0`, 'no shutdown', 'exit',
    'crypto isakmp policy 10',
    `encryption ${enc}`,
    `hash ${hash}`,
    'authentication pre-share',
    `group ${group}`,
    'lifetime 86400',
    'exit',
    `crypto isakmp key ${psk} address ${peerWan}`,
    'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
    'ip access-list extended VPN_ACL',
    `permit ip ${localSubnet} 0.0.0.255 ${remoteSubnet} 0.0.0.255`, 'exit',
    'crypto map CMAP 10 ipsec-isakmp',
    `set peer ${peerWan}`, 'set transform-set TSET', 'match address VPN_ACL', 'exit',
    'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit',
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

describe('Scénario 2 — Échec de négociation IKE par politique incompatible', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
  });

  it('R1 propose AES-256/SHA-256/DH14, R2 accepte 3DES/MD5/DH1: aucun tunnel ne s\'établit, ping échoue', async () => {
    const l = await buildLab();
    await configureIkev1(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0', 'aes 256', 'sha256', 14, 'secret42');
    await configureIkev1(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0', '3des', 'md5', 1, 'secret42');
    await seedPcs(l.pc1, l.pc2);
    const ping = await l.pc1.executeCommand('ping -c 2 192.168.2.10');
    expect(ping).toMatch(/100% packet loss|Destination Host Unreachable|Network is unreachable/i);
  });

  it('show crypto isakmp sa côté initiateur montre un état MM_NO_STATE (aucune SA établie)', async () => {
    const l = await buildLab();
    await configureIkev1(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0', 'aes 256', 'sha256', 14, 'secret42');
    await configureIkev1(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0', '3des', 'md5', 1, 'secret42');
    await seedPcs(l.pc1, l.pc2);
    await l.pc1.executeCommand('ping -c 1 192.168.2.10');
    const sa = await l.r1.executeCommand('show crypto isakmp sa');
    expect(sa).toMatch(/MM_NO_STATE/);
    expect(sa).not.toMatch(/QM_IDLE/);
  });

  it('show crypto isakmp sa detail expose la cause exacte du rejet (No matching policy) et la phase', async () => {
    const l = await buildLab();
    await configureIkev1(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0', 'aes 256', 'sha256', 14, 'secret42');
    await configureIkev1(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0', '3des', 'md5', 1, 'secret42');
    await seedPcs(l.pc1, l.pc2);
    await l.pc1.executeCommand('ping -c 1 192.168.2.10');
    const detail = await l.r1.executeCommand('show crypto isakmp sa detail');
    expect(detail).toMatch(/Last negotiation failure:.*No matching policy.*phase 1/i);
  });

  it('show crypto ipsec sa: aucun compteur encrypt/decrypt car la phase 2 n\'est jamais atteinte', async () => {
    const l = await buildLab();
    await configureIkev1(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0', 'aes 256', 'sha256', 14, 'secret42');
    await configureIkev1(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0', '3des', 'md5', 1, 'secret42');
    await seedPcs(l.pc1, l.pc2);
    await l.pc1.executeCommand('ping -c 3 192.168.2.10');
    const ipsec = await l.r1.executeCommand('show crypto ipsec sa');
    if (/#pkts encaps/.test(ipsec)) {
      expect(ipsec).toMatch(/#pkts encaps: 0/);
      expect(ipsec).toMatch(/#pkts encrypt: 0/);
    } else {
      expect(ipsec).toMatch(/No IPSec SAs established/i);
    }
  });

  it('symétrie du diagnostic: R2 (répondeur) rapporte aussi un rejet sur sa politique locale', async () => {
    const l = await buildLab();
    await configureIkev1(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0', 'aes 256', 'sha256', 14, 'secret42');
    await configureIkev1(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0', '3des', 'md5', 1, 'secret42');
    await seedPcs(l.pc1, l.pc2);
    await l.pc1.executeCommand('ping -c 1 192.168.2.10');
    const r2Sa = await l.r2.executeCommand('show crypto isakmp sa');
    const r2Detail = await l.r2.executeCommand('show crypto isakmp sa detail');
    expect(r2Sa).toMatch(/MM_NO_STATE/);
    expect(r2Detail).toMatch(/No matching policy/i);
  });

  it('après correction des politiques (mise en accord des deux côtés), un nouveau ping établit le tunnel', async () => {
    const l = await buildLab();
    await configureIkev1(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0', 'aes 256', 'sha256', 14, 'secret42');
    await configureIkev1(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0', '3des', 'md5', 1, 'secret42');
    await seedPcs(l.pc1, l.pc2);
    await l.pc1.executeCommand('ping -c 1 192.168.2.10');
    for (const cmd of [
      'enable', 'configure terminal',
      'no crypto isakmp policy 10',
      'crypto isakmp policy 10',
      'encryption aes 256', 'hash sha256', 'authentication pre-share', 'group 14', 'lifetime 86400',
      'end',
      'clear crypto isakmp sa',
    ]) await l.r2.executeCommand(cmd);
    await l.r1.executeCommand('clear crypto isakmp sa');
    const ping = await l.pc1.executeCommand('ping -c 4 192.168.2.10');
    expect(ping).toMatch(/4 received|0% packet loss/);
    const sa = await l.r1.executeCommand('show crypto isakmp sa');
    expect(sa).toMatch(/QM_IDLE|MM_ACTIVE|READY/);
  });
});
