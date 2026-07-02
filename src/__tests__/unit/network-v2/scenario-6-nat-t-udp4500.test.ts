/**
 * Scénario 6 — Traversée NAT pour IPsec (NAT-T, UDP encapsulation port 4500)
 *
 * Objectif : valider le mécanisme de NAT Traversal qui permet à un tunnel
 * IPsec de traverser un équipement effectuant du NAT (situation inévitable
 * lorsqu'un client VPN est derrière un routeur domestique ou un pare-feu
 * d'entreprise).
 *
 * Points de contrôle :
 *   - détection automatique du NAT pendant IKE (SA marquée NAT-T),
 *   - basculement de UDP 500 vers UDP 4500 pour ESP après détection,
 *   - paquets ESP encapsulés dans des datagrammes UDP sur le lien externe
 *     (capture côté NAT) versus ESP natif (proto 50) sans NAT,
 *   - keepalives UDP 4500 envoyés périodiquement pour maintenir la mapping
 *     NAT ouverte, même en l'absence de trafic applicatif.
 *
 * Critère de réussite : tunnel IPsec fonctionnel malgré le NAT, avec
 * basculement automatique vers UDP 4500 et maintien de la session grâce
 * aux keepalives.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, IP_PROTO_ESP, IP_PROTO_UDP, IPv4Packet, UDPPacket, EthernetFrame, ETHERTYPE_IPV4 } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';
import { getDefaultEventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';

interface WireProbe {
  udp4500: number;
  udp500: number;
  rawEsp: number;
  frames: EthernetFrame[];
}

function probePort(deviceId: string, portName: string): WireProbe {
  const probe: WireProbe = { udp4500: 0, udp500: 0, rawEsp: 0, frames: [] };
  const inspect = (frame: EthernetFrame): void => {
    if (frame.etherType !== ETHERTYPE_IPV4) return;
    const ip = frame.payload as IPv4Packet | undefined;
    if (!ip || typeof ip !== 'object') return;
    if (ip.protocol === IP_PROTO_UDP) {
      const udp = ip.payload as UDPPacket | undefined;
      if (!udp) return;
      if (udp.destinationPort === 4500 || udp.sourcePort === 4500) probe.udp4500++;
      if (udp.destinationPort === 500 || udp.sourcePort === 500) probe.udp500++;
    } else if (ip.protocol === IP_PROTO_ESP) {
      probe.rawEsp++;
    }
    probe.frames.push(frame);
  };
  getDefaultEventBus().subscribe('port.frame.tx-requested', (e) => {
    const p = e.payload as { deviceId?: string; portName?: string; frame: EthernetFrame };
    if (p.deviceId === deviceId && p.portName === portName) inspect(p.frame);
  });
  getDefaultEventBus().subscribe('port.frame.received', (e) => {
    const p = e.payload as { deviceId?: string; portName?: string; frame: EthernetFrame };
    if (p.deviceId === deviceId && p.portName === portName) inspect(p.frame);
  });
  return probe;
}

async function buildTunnel(opts: { withNat: boolean; natKeepalive?: number }) {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');
  const natRouter = opts.withNat ? new LinuxPC('linux-pc', 'NAT') : null;

  if (opts.withNat && natRouter) {
    new Cable('r1-nat').connect(r1.getPort('GigabitEthernet0/1')!, natRouter.getPort('eth0')!);
    new Cable('nat-r2').connect(natRouter.getPort('eth1')!, r2.getPort('GigabitEthernet0/1')!);
  } else {
    new Cable('wan').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  }
  new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);

  if (opts.withNat && natRouter) {
    await natRouter.executeCommand('sudo ip addr add 203.0.113.1/30 dev eth0');
    await natRouter.executeCommand('sudo ip addr add 172.16.0.1/30 dev eth1');
    await natRouter.executeCommand('sudo sysctl -w net.ipv4.ip_forward=1');
    await natRouter.executeCommand('sudo iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE');
    await natRouter.executeCommand(
      'sudo iptables -t nat -A PREROUTING -i eth0 -p udp --dport 500 -j DNAT --to-destination 172.16.0.2:500',
    );
    await natRouter.executeCommand(
      'sudo iptables -t nat -A PREROUTING -i eth0 -p udp --dport 4500 -j DNAT --to-destination 172.16.0.2:4500',
    );
  }

  const r2OutsideIp = opts.withNat ? '172.16.0.2' : '10.0.12.2';
  const r2OutsideMask = opts.withNat ? '255.255.255.252' : '255.255.255.252';
  const r1PeerIp = opts.withNat ? '203.0.113.1' : '10.0.12.2';
  const r2PeerIp = opts.withNat ? '203.0.113.2' : '10.0.12.1';
  const r1OutsideIp = opts.withNat ? '203.0.113.2' : '10.0.12.1';

  await r1.executeCommand('enable');
  await r1.executeCommand('configure terminal');
  await r1.executeCommand('interface GigabitEthernet0/1');
  await r1.executeCommand(`ip address ${r1OutsideIp} 255.255.255.252`);
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('exit');
  await r1.executeCommand('interface GigabitEthernet0/0');
  await r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('exit');
  await r1.executeCommand('crypto isakmp policy 10');
  await r1.executeCommand('encryption aes 256');
  await r1.executeCommand('hash sha256');
  await r1.executeCommand('authentication pre-share');
  await r1.executeCommand('group 14');
  await r1.executeCommand('exit');
  await r1.executeCommand(`crypto isakmp key NatTSecret1 address ${r1PeerIp}`);
  if (opts.natKeepalive !== undefined) {
    await r1.executeCommand(`crypto isakmp nat keepalive ${opts.natKeepalive}`);
  }
  await r1.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
  await r1.executeCommand('mode tunnel');
  await r1.executeCommand('exit');
  await r1.executeCommand('ip access-list extended VPN_ACL');
  await r1.executeCommand('permit ip 192.168.1.0 0.0.0.255 192.168.2.0 0.0.0.255');
  await r1.executeCommand('exit');
  await r1.executeCommand('crypto map CMAP 10 ipsec-isakmp');
  await r1.executeCommand(`set peer ${r1PeerIp}`);
  await r1.executeCommand('set transform-set TSET');
  await r1.executeCommand('match address VPN_ACL');
  await r1.executeCommand('exit');
  await r1.executeCommand('interface GigabitEthernet0/1');
  await r1.executeCommand('crypto map CMAP');
  await r1.executeCommand('exit');
  await r1.executeCommand(`ip route 192.168.2.0 255.255.255.0 ${r1PeerIp}`);
  await r1.executeCommand('end');

  await r2.executeCommand('enable');
  await r2.executeCommand('configure terminal');
  await r2.executeCommand('interface GigabitEthernet0/1');
  await r2.executeCommand(`ip address ${r2OutsideIp} ${r2OutsideMask}`);
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('exit');
  await r2.executeCommand('interface GigabitEthernet0/0');
  await r2.executeCommand('ip address 192.168.2.1 255.255.255.0');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('exit');
  if (opts.withNat) {
    await r2.executeCommand('ip route 0.0.0.0 0.0.0.0 172.16.0.1');
  }
  await r2.executeCommand('crypto isakmp policy 10');
  await r2.executeCommand('encryption aes 256');
  await r2.executeCommand('hash sha256');
  await r2.executeCommand('authentication pre-share');
  await r2.executeCommand('group 14');
  await r2.executeCommand('exit');
  await r2.executeCommand(`crypto isakmp key NatTSecret1 address ${r2PeerIp}`);
  if (opts.natKeepalive !== undefined) {
    await r2.executeCommand(`crypto isakmp nat keepalive ${opts.natKeepalive}`);
  }
  await r2.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
  await r2.executeCommand('mode tunnel');
  await r2.executeCommand('exit');
  await r2.executeCommand('ip access-list extended VPN_ACL');
  await r2.executeCommand('permit ip 192.168.2.0 0.0.0.255 192.168.1.0 0.0.0.255');
  await r2.executeCommand('exit');
  await r2.executeCommand('crypto map CMAP 10 ipsec-isakmp');
  await r2.executeCommand(`set peer ${r2PeerIp}`);
  await r2.executeCommand('set transform-set TSET');
  await r2.executeCommand('match address VPN_ACL');
  await r2.executeCommand('exit');
  await r2.executeCommand('interface GigabitEthernet0/1');
  await r2.executeCommand('crypto map CMAP');
  await r2.executeCommand('exit');
  if (!opts.withNat) {
    await r2.executeCommand(`ip route 192.168.1.0 255.255.255.0 ${r2PeerIp}`);
  } else {
    await r2.executeCommand(`ip route 192.168.1.0 255.255.255.0 172.16.0.1`);
  }
  await r2.executeCommand('end');

  await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
  await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await pc2.executeCommand('sudo ip route add default via 192.168.2.1');

  return { r1, r2, pc1, pc2, natRouter };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('Scenario 6 — NAT-T: ESP-in-UDP 4500 + periodic keepalives', () => {
  it('6.01 — with NAT on path, packets on the WAN link are UDP/4500 (no raw ESP)', async () => {
    const { r1, pc2 } = await buildTunnel({ withNat: true, natKeepalive: 20 });
    const wan = probePort(r1.getId(), 'GigabitEthernet0/1');

    const out = await pc2.executeCommand('ping -c 4 192.168.1.10');
    expect(out).toContain('4 received');

    expect(wan.udp4500).toBeGreaterThan(0);
    expect(wan.rawEsp).toBe(0);
  });

  it('6.02 — without NAT on path, packets on the WAN link are raw ESP (proto 50), no UDP/4500', async () => {
    const { r1, pc2 } = await buildTunnel({ withNat: false });
    const wan = probePort(r1.getId(), 'GigabitEthernet0/1');

    const out = await pc2.executeCommand('ping -c 4 192.168.1.10');
    expect(out).toContain('4 received');

    expect(wan.rawEsp).toBeGreaterThan(0);
    expect(wan.udp4500).toBe(0);
  });

  it('6.03 — NAT-T flag is asserted on both peers after detection', async () => {
    const { r1, r2, pc2 } = await buildTunnel({ withNat: true, natKeepalive: 20 });
    await pc2.executeCommand('ping -c 2 192.168.1.10');

    const detailR1 = await r1.executeCommand('show crypto isakmp sa detail');
    const detailR2 = await r2.executeCommand('show crypto isakmp sa detail');
    expect(detailR1).toContain('NAT-T');
    expect(detailR2).toContain('NAT-T');
    expect(detailR1).toMatch(/port.*4500|4500.*port/i);
    expect(detailR2).toMatch(/port.*4500|4500.*port/i);
  });

  it('6.04 — periodic NAT-T keepalives are emitted on UDP/4500 at the configured interval', async () => {
    const scheduler = new VirtualTimeScheduler();
    const { r1, r2, pc2 } = await buildTunnel({ withNat: true, natKeepalive: 20 });
    (r1 as unknown as { _getIPSecEngineInternal: () => { setScheduler(s: VirtualTimeScheduler): void } })
      ._getIPSecEngineInternal().setScheduler(scheduler);
    (r2 as unknown as { _getIPSecEngineInternal: () => { setScheduler(s: VirtualTimeScheduler): void } })
      ._getIPSecEngineInternal().setScheduler(scheduler);

    const initHandshake = await pc2.executeCommand('ping -c 1 192.168.1.10');
    expect(initHandshake).toContain('1 received');

    const wanR2 = probePort(r2.getId(), 'GigabitEthernet0/1');
    scheduler.advance(65 * 1000);

    expect(wanR2.udp4500).toBeGreaterThanOrEqual(3);
    expect(wanR2.rawEsp).toBe(0);
  });

  it('6.05 — tunnel session survives a long idle when only keepalives keep the NAT mapping alive', async () => {
    const scheduler = new VirtualTimeScheduler();
    const { r1, r2, pc1, pc2 } = await buildTunnel({ withNat: true, natKeepalive: 15 });
    (r1 as unknown as { _getIPSecEngineInternal: () => { setScheduler(s: VirtualTimeScheduler): void } })
      ._getIPSecEngineInternal().setScheduler(scheduler);
    (r2 as unknown as { _getIPSecEngineInternal: () => { setScheduler(s: VirtualTimeScheduler): void } })
      ._getIPSecEngineInternal().setScheduler(scheduler);

    await pc2.executeCommand('ping -c 1 192.168.1.10');
    scheduler.advance(90 * 1000);

    const saR1After = await r1.executeCommand('show crypto isakmp sa');
    const saR2After = await r2.executeCommand('show crypto isakmp sa');
    expect(saR1After).toContain('QM_IDLE');
    expect(saR2After).toContain('QM_IDLE');

    const pingAfterIdle = await pc2.executeCommand('ping -c 2 192.168.1.10');
    expect(pingAfterIdle).toContain('2 received');
    void pc1;
  });

  it('6.06 — without NAT, no NAT-T keepalives are emitted (would be pointless)', async () => {
    const scheduler = new VirtualTimeScheduler();
    const { r1, r2, pc2 } = await buildTunnel({ withNat: false, natKeepalive: 20 });
    (r1 as unknown as { _getIPSecEngineInternal: () => { setScheduler(s: VirtualTimeScheduler): void } })
      ._getIPSecEngineInternal().setScheduler(scheduler);
    (r2 as unknown as { _getIPSecEngineInternal: () => { setScheduler(s: VirtualTimeScheduler): void } })
      ._getIPSecEngineInternal().setScheduler(scheduler);
    await pc2.executeCommand('ping -c 1 192.168.1.10');

    const wanR2 = probePort(r2.getId(), 'GigabitEthernet0/1');
    scheduler.advance(65 * 1000);

    expect(wanR2.udp4500).toBe(0);
  });
});
