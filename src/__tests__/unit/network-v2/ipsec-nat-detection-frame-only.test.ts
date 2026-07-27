/**
 * NAT on an IPsec path is detected the way RFC 3947 detects it: the
 * responder compares the source address it actually received against the
 * identity the initiator claimed. Nothing reads the topology to find out
 * who is doing the translating.
 *
 * See docs/PRD-Frame-Only-Refactor.md P4.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

function makeRegistryUnusable(): void {
  const reg = EquipmentRegistry.getInstance() as unknown as Record<string, unknown>;
  const refuse = (name: string) => () => {
    throw new Error(`EquipmentRegistry.${name} reached while negotiating IKE`);
  };
  reg.getAll = refuse('getAll');
  reg.getById = refuse('getById');
}

async function configurePeer(
  r: CiscoRouter, outsideIp: string, insideIp: string,
  peerIp: string, localNet: string, remoteNet: string, defaultVia?: string,
) {
  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', `ip address ${outsideIp} 255.255.255.252`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/0', `ip address ${insideIp} 255.255.255.0`, 'no shutdown', 'exit',
    'crypto isakmp policy 10',
    'encryption aes 256', 'hash sha256', 'authentication pre-share', 'group 14', 'exit',
    `crypto isakmp key NatTSecret1 address ${peerIp}`,
    'crypto isakmp nat keepalive 20',
    'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
    'ip access-list extended VPN_ACL',
    `permit ip ${localNet} 0.0.0.255 ${remoteNet} 0.0.0.255`, 'exit',
    'crypto map CMAP 10 ipsec-isakmp',
    `set peer ${peerIp}`, 'set transform-set TSET', 'match address VPN_ACL', 'exit',
    'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit',
    ...(defaultVia ? [`ip route 0.0.0.0 0.0.0.0 ${defaultVia}`] : []),
    'end',
  ]) await r.executeCommand(cmd);
}

/** R1 — NAT box (masquerade + DNAT for IKE) — R2. */
async function natTunnel() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');
  const nat = new LinuxPC('linux-pc', 'NAT');

  new Cable('r1-nat').connect(r1.getPort('GigabitEthernet0/1')!, nat.getPort('eth0')!);
  new Cable('nat-r2').connect(nat.getPort('eth1')!, r2.getPort('GigabitEthernet0/1')!);
  new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);

  for (const cmd of [
    'sudo ip addr add 203.0.113.1/30 dev eth0',
    'sudo ip addr add 172.16.0.1/30 dev eth1',
    'sudo sysctl -w net.ipv4.ip_forward=1',
    'sudo iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE',
    'sudo iptables -t nat -A PREROUTING -i eth0 -p udp --dport 500 -j DNAT --to-destination 172.16.0.2:500',
    'sudo iptables -t nat -A PREROUTING -i eth0 -p udp --dport 4500 -j DNAT --to-destination 172.16.0.2:4500',
  ]) await nat.executeCommand(cmd);

  await configurePeer(r1, '203.0.113.2', '192.168.1.1', '203.0.113.1', '192.168.1.0', '192.168.2.0');
  await r1.executeCommand('enable');
  await r1.executeCommand('configure terminal');
  await r1.executeCommand('ip route 192.168.2.0 255.255.255.0 203.0.113.1');
  await r1.executeCommand('end');

  await configurePeer(r2, '172.16.0.2', '192.168.2.1', '203.0.113.2', '192.168.2.0', '192.168.1.0', '172.16.0.1');
  await r2.executeCommand('enable');
  await r2.executeCommand('configure terminal');
  await r2.executeCommand('ip route 192.168.1.0 255.255.255.0 172.16.0.1');
  await r2.executeCommand('end');

  await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
  await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await pc2.executeCommand('sudo ip route add default via 192.168.2.1');

  return { r1, r2, pc1, pc2, nat };
}

describe('NAT on an IPsec path is detected from the IKE exchange itself', () => {
  it('both peers mark the SA NAT-T with the registry refusing every lookup', async () => {
    const { r1, r2, pc2 } = await natTunnel();
    makeRegistryUnusable();

    await pc2.executeCommand('ping -c 2 192.168.1.10');
    const detailR1 = await r1.executeCommand('show crypto isakmp sa detail');
    const detailR2 = await r2.executeCommand('show crypto isakmp sa detail');
    expect(
      detailR1,
      'the responder saw a source address that did not match the claimed identity — that is the detection',
    ).toContain('NAT-T');
    expect(detailR2).toContain('NAT-T');
  }, 40000);

  it('the tunnel still carries traffic under the same conditions', async () => {
    const { pc2 } = await natTunnel();
    makeRegistryUnusable();

    const out = await pc2.executeCommand('ping -c 4 192.168.1.10');
    expect(out).toContain('4 received');
  }, 40000);
});
