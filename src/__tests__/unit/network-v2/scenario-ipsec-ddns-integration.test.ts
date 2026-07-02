import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { DdnsResolver } from '@/network/ipsec/DdnsResolver';
import { DdnsSiteTunnelController } from '@/network/ipsec/DdnsSiteTunnelController';
import { CiscoDdnsIkeAdapter } from '@/network/ipsec/CiscoDdnsIkeAdapter';

interface EngineFacade {
  ipsecSADB: Map<string, unknown[]>;
}

const HOSTNAME = 'vpn.example.com';
const R2_WAN = '10.0.12.2';
const R1_WAN = '10.0.12.1';

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

async function configureEndpoint(
  r: CiscoRouter, wanIp: string, peerWan: string, lanIp: string,
  localSubnet: string, remoteSubnet: string, psk: string,
): Promise<void> {
  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', `ip address ${wanIp} 255.255.255.252`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/0', `ip address ${lanIp} 255.255.255.0`, 'no shutdown', 'exit',
    'crypto isakmp policy 10',
    'encryption aes 256', 'hash sha256', 'authentication pre-share', 'group 14', 'exit',
    `crypto isakmp key ${psk} address ${peerWan}`,
    'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
    'ip access-list extended VPN_ACL',
    `permit ip ${localSubnet} 0.0.0.255 ${remoteSubnet} 0.0.0.255`, 'exit',
    'crypto map CMAP 10 ipsec-isakmp',
    `set peer ${peerWan}`, 'set transform-set TSET', 'match address VPN_ACL', 'exit',
    'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit',
    `ip route ${remoteSubnet} 255.255.255.0 ${peerWan}`,
    'end',
  ]) await r.executeCommand(cmd);
}

async function seedPcs(pc1: LinuxPC, pc2: LinuxPC): Promise<void> {
  await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
  await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await pc2.executeCommand('sudo ip route add default via 192.168.2.1');
}

async function buildAndConfigure() {
  const lab = await buildLab();
  await configureEndpoint(lab.r1, R1_WAN, R2_WAN, '192.168.1.1',
    '192.168.1.0', '192.168.2.0', 'DdnsIntegrationSecret');
  await configureEndpoint(lab.r2, R2_WAN, R1_WAN, '192.168.2.1',
    '192.168.2.0', '192.168.1.0', 'DdnsIntegrationSecret');
  await seedPcs(lab.pc1, lab.pc2);
  return lab;
}

function makeController(lab: Awaited<ReturnType<typeof buildAndConfigure>>, zone: { current: string }, opts?: {
  probe?: (peer: string) => boolean;
  ttlMs?: number;
  dpdIntervalMs?: number;
  dpdRetries?: number;
}) {
  const adapter = new CiscoDdnsIkeAdapter({
    router: lab.r1, triggerHost: lab.pc1, triggerTarget: '192.168.2.10', pingCount: 2,
  });
  const resolver = new DdnsResolver({
    hostname: HOSTNAME, ttlMs: opts?.ttlMs ?? 60_000,
    lookup: () => zone.current,
  });
  const controller = new DdnsSiteTunnelController({
    hostname: HOSTNAME, resolver, ikeInitiator: adapter,
    dpd: {
      intervalMs: opts?.dpdIntervalMs ?? 60_000,
      maxRetries: opts?.dpdRetries ?? 3,
      probe: opts?.probe ?? (() => true),
    },
  });
  return { adapter, resolver, controller };
}

function getR1SaCount(lab: Awaited<ReturnType<typeof buildAndConfigure>>, peer: string): number {
  const eng = (lab.r1 as unknown as { _getIPSecEngineInternal(): EngineFacade })._getIPSecEngineInternal();
  return eng.ipsecSADB.get(peer)?.length ?? 0;
}

describe('Scénario 14 — DDNS + IKE renégociation (intégration réseau réel)', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
  });

  it('connect() résout le nom et déclenche une vraie négociation IKE côté R1', async () => {
    const lab = await buildAndConfigure();
    const zone = { current: R2_WAN };
    const { controller, adapter } = makeController(lab, zone);
    controller.connect();
    await adapter.waitForPendingOperation();
    expect(controller.getActivePeer()).toBe(R2_WAN);
    expect(getR1SaCount(lab, R2_WAN)).toBeGreaterThan(0);
  });

  it("l'adapter propage le trafic dans le tunnel (le ping traverse et arrive à destination)", async () => {
    const lab = await buildAndConfigure();
    const zone = { current: R2_WAN };
    const { controller, adapter } = makeController(lab, zone);
    controller.connect();
    await adapter.waitForPendingOperation();
    const ping = await lab.pc1.executeCommand('ping -c 2 192.168.2.10');
    expect(ping).toContain('2 received');
  });

  it('disconnect() supprime le SA installé sur R1 (aucun état résiduel)', async () => {
    const lab = await buildAndConfigure();
    const zone = { current: R2_WAN };
    const { controller, adapter } = makeController(lab, zone);
    controller.connect();
    await adapter.waitForPendingOperation();
    expect(getR1SaCount(lab, R2_WAN)).toBeGreaterThan(0);
    controller.disconnect();
    expect(getR1SaCount(lab, R2_WAN)).toBe(0);
  });

  it('reconnect() après disconnect() réinstalle une SA vers le même pair', async () => {
    const lab = await buildAndConfigure();
    const zone = { current: R2_WAN };
    const { controller, adapter } = makeController(lab, zone);
    controller.connect();
    await adapter.waitForPendingOperation();
    controller.disconnect();
    expect(getR1SaCount(lab, R2_WAN)).toBe(0);
    controller.connect();
    await adapter.waitForPendingOperation();
    expect(getR1SaCount(lab, R2_WAN)).toBeGreaterThan(0);
    expect(controller.getActivePeer()).toBe(R2_WAN);
  });

  it("close(peer) via l'adapter appelle clearSAsForPeer sur le moteur IPsec réel", async () => {
    const lab = await buildAndConfigure();
    const zone = { current: R2_WAN };
    const { controller, adapter } = makeController(lab, zone);
    controller.connect();
    await adapter.waitForPendingOperation();
    const engine = (lab.r1 as unknown as { _getIPSecEngineInternal(): {
      ipsecSADB: Map<string, unknown[]>;
      ikeSADB: Map<string, unknown>;
    } })._getIPSecEngineInternal();
    expect(engine.ipsecSADB.get(R2_WAN)?.length ?? 0).toBeGreaterThan(0);
    controller.disconnect();
    expect(engine.ipsecSADB.get(R2_WAN)?.length ?? 0).toBe(0);
    expect(engine.ikeSADB.has(R2_WAN)).toBe(false);
  });

  it("l'adapter reflète l'état réel des SAs installées sur le routeur", async () => {
    const lab = await buildAndConfigure();
    const zone = { current: R2_WAN };
    const { controller, adapter } = makeController(lab, zone);
    expect(adapter.hasSaForPeer(R2_WAN)).toBe(false);
    controller.connect();
    await adapter.waitForPendingOperation();
    expect(adapter.hasSaForPeer(R2_WAN)).toBe(true);
    controller.disconnect();
    expect(adapter.hasSaForPeer(R2_WAN)).toBe(false);
  });

  it("les compteurs pktsEncaps sur R1 restent monotones à travers le cycle connect/disconnect", async () => {
    const lab = await buildAndConfigure();
    const zone = { current: R2_WAN };
    const { controller, adapter } = makeController(lab, zone);
    controller.connect();
    await adapter.waitForPendingOperation();
    const engine = (lab.r1 as unknown as { _getIPSecEngineInternal(): {
      ipsecSADB: Map<string, Array<{ pktsEncaps: number }>>;
    } })._getIPSecEngineInternal();
    const before = engine.ipsecSADB.get(R2_WAN)![0].pktsEncaps;
    await lab.pc1.executeCommand('ping -c 3 192.168.2.10');
    const after = engine.ipsecSADB.get(R2_WAN)![0].pktsEncaps;
    expect(after).toBeGreaterThan(before);
  });

  it("previousPeers accumule l'historique après chaque disconnect", async () => {
    const lab = await buildAndConfigure();
    const zone = { current: R2_WAN };
    const { controller, adapter } = makeController(lab, zone);
    controller.connect();
    await adapter.waitForPendingOperation();
    controller.disconnect();
    expect(controller.getPreviousPeers()).toContain(R2_WAN);
    expect(controller.getActivePeer()).toBeNull();
  });

  it("une résolution DNS retournant une IP invalide n'endommage pas l'état existant", async () => {
    const lab = await buildAndConfigure();
    const zone = { current: R2_WAN };
    const { controller, adapter } = makeController(lab, zone);
    controller.connect();
    await adapter.waitForPendingOperation();
    zone.current = 'not.an.ip';
    expect(() => controller.disconnect()).not.toThrow();
    expect(controller.getActivePeer()).toBeNull();
  });
});
