import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, IP_PROTO_ICMP, nextIPv4Id } from '@/network/core/types';
import type { IPv4Packet } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  DSCP, dscpOf, ecnOf, withDscp, makeCopyConfig, makeSetConfig, makeMapConfig,
} from '@/network/ipsec/DscpTunnelMarker';

interface EngineInternal {
  computeOuterTosForPeer(peer: string, innerTos: number): number | null;
  getSADscpConfigForPeer(peer: string): import('@/network/ipsec/IPSecTypes').SADscpEcnConfig | null;
  setSADscpConfigForPeer(peer: string, cfg: import('@/network/ipsec/IPSecTypes').SADscpEcnConfig): boolean;
  ipsecSADB: Map<string, Array<{ pktsEncaps: number; pktsDecaps: number; dscpEcnConfig: unknown }>>;
}

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

function getEngine(r: CiscoRouter): EngineInternal {
  return (r as unknown as { _getIPSecEngineInternal(): EngineInternal })._getIPSecEngineInternal();
}

function fakeInner(dscpValue: number, ecn: number = 0): IPv4Packet {
  return {
    type: 'ipv4', version: 4, ihl: 5, tos: (dscpValue << 2) | ecn, totalLength: 84,
    identification: nextIPv4Id(), flags: 0, fragmentOffset: 0, ttl: 64,
    protocol: IP_PROTO_ICMP, headerChecksum: 0,
    sourceIP: new IPAddress('192.168.1.10'),
    destinationIP: new IPAddress('192.168.2.10'),
    payload: null,
  } as unknown as IPv4Packet;
}

async function establishTunnel() {
  const lab = await buildLab();
  await configureEndpoint(lab.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1',
    '192.168.1.0', '192.168.2.0', 'DscpScenarioSecret');
  await configureEndpoint(lab.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1',
    '192.168.2.0', '192.168.1.0', 'DscpScenarioSecret');
  await seedPcs(lab.pc1, lab.pc2);
  await lab.pc1.executeCommand('ping -c 2 192.168.2.10');
  return lab;
}

describe('Scénario 16 — DSCP à travers un vrai tunnel IPsec (2 routeurs, 2 PC)', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
  });

  it('un tunnel IPsec réel est établi entre R1 et R2 (ping OK + SA installée)', async () => {
    const lab = await establishTunnel();
    const ping = await lab.pc1.executeCommand('ping -c 1 192.168.2.10');
    expect(ping).toContain('1 received');
    const eng1 = getEngine(lab.r1);
    expect(eng1.ipsecSADB.get('10.0.12.2')?.length ?? 0).toBeGreaterThan(0);
  });

  it("le compteur d'encaps du SA sur R1 croît quand PC1 envoie du trafic protégé", async () => {
    const lab = await establishTunnel();
    const eng1 = getEngine(lab.r1);
    const sa = eng1.ipsecSADB.get('10.0.12.2')![0];
    const before = sa.pktsEncaps;
    await lab.pc1.executeCommand('ping -c 3 192.168.2.10');
    expect(sa.pktsEncaps).toBeGreaterThan(before);
  });

  it('config par défaut du SA : DSCP mode = copy (comportement RFC 4301)', async () => {
    const lab = await establishTunnel();
    const eng1 = getEngine(lab.r1);
    const cfg = eng1.getSADscpConfigForPeer('10.0.12.2');
    expect(cfg).not.toBeNull();
    expect(cfg!.dscpMode).toBe('copy');
  });

  it('avec la config par défaut (copy), un paquet VoIP EF garde DSCP=EF sur le header externe', async () => {
    const lab = await establishTunnel();
    const eng1 = getEngine(lab.r1);
    const innerTos = withDscp(0, DSCP.EF);
    const outerTos = eng1.computeOuterTosForPeer('10.0.12.2', innerTos);
    expect(outerTos).not.toBeNull();
    expect(dscpOf(outerTos!)).toBe(DSCP.EF);
  });

  it('trois classes DSCP distinctes (EF, AF41, CS0) restent séparables sur le lien inter-routeurs', async () => {
    const lab = await establishTunnel();
    const eng1 = getEngine(lab.r1);
    const outers = [DSCP.EF, DSCP.AF41, DSCP.CS0].map(d =>
      dscpOf(eng1.computeOuterTosForPeer('10.0.12.2', withDscp(0, d))!));
    expect(new Set(outers)).toEqual(new Set([DSCP.EF, DSCP.AF41, DSCP.CS0]));
  });

  it("basculer le SA de R1 en 'set 0' rend le trafic externe indiscernable (QoS aveugle)", async () => {
    const lab = await establishTunnel();
    const eng1 = getEngine(lab.r1);
    const applied = eng1.setSADscpConfigForPeer('10.0.12.2', makeSetConfig(0));
    expect(applied).toBe(true);
    const outers = [DSCP.EF, DSCP.AF41, DSCP.CS0].map(d =>
      dscpOf(eng1.computeOuterTosForPeer('10.0.12.2', withDscp(0, d))!));
    expect(new Set(outers).size).toBe(1);
    expect(outers[0]).toBe(0);
  });

  it('mode map appliqué au SA permet de remapper EF → AF31 sur le header externe', async () => {
    const lab = await establishTunnel();
    const eng1 = getEngine(lab.r1);
    eng1.setSADscpConfigForPeer('10.0.12.2',
      makeMapConfig(new Map([[DSCP.EF, DSCP.AF31]])));
    const outer = eng1.computeOuterTosForPeer('10.0.12.2', withDscp(0, DSCP.EF));
    expect(dscpOf(outer!)).toBe(DSCP.AF31);
    const outerAf41 = eng1.computeOuterTosForPeer('10.0.12.2', withDscp(0, DSCP.AF41));
    expect(dscpOf(outerAf41!)).toBe(DSCP.AF41);
  });

  it('R1 et R2 ont chacun leur propre SA avec DSCP indépendant (chaque sens de tunnel)', async () => {
    const lab = await establishTunnel();
    const eng1 = getEngine(lab.r1);
    const eng2 = getEngine(lab.r2);
    expect(eng1.getSADscpConfigForPeer('10.0.12.2')?.dscpMode).toBe('copy');
    expect(eng2.getSADscpConfigForPeer('10.0.12.1')?.dscpMode).toBe('copy');
    eng1.setSADscpConfigForPeer('10.0.12.2', makeSetConfig(DSCP.CS0));
    expect(eng1.getSADscpConfigForPeer('10.0.12.2')?.dscpMode).toBe('set');
    expect(eng2.getSADscpConfigForPeer('10.0.12.1')?.dscpMode).toBe('copy');
  });

  it("modifier la config DSCP n'affecte pas les compteurs déjà accumulés", async () => {
    const lab = await establishTunnel();
    const eng1 = getEngine(lab.r1);
    await lab.pc1.executeCommand('ping -c 3 192.168.2.10');
    const sa = eng1.ipsecSADB.get('10.0.12.2')![0];
    const before = sa.pktsEncaps;
    eng1.setSADscpConfigForPeer('10.0.12.2', makeSetConfig(0));
    expect(sa.pktsEncaps).toBe(before);
  });

  it('ECN bit CE est propagé de l\'externe vers l\'interne au décap (RFC 6040)', async () => {
    const lab = await establishTunnel();
    const eng1 = getEngine(lab.r1);
    const cfg = eng1.getSADscpConfigForPeer('10.0.12.2')!;
    expect(cfg.ecnEnabled).toBe(true);
    const outer = eng1.computeOuterTosForPeer('10.0.12.2', withDscp(0, DSCP.EF) | 0b11);
    expect(ecnOf(outer!)).toBe(0b11);
  });

  it('un flux best-effort (CS0) coexiste avec un flux VoIP (EF) sans confusion sur R1', async () => {
    const lab = await establishTunnel();
    const eng1 = getEngine(lab.r1);
    const outerVoip = dscpOf(eng1.computeOuterTosForPeer('10.0.12.2', withDscp(0, DSCP.EF))!);
    const outerBe = dscpOf(eng1.computeOuterTosForPeer('10.0.12.2', withDscp(0, DSCP.CS0))!);
    expect(outerVoip).toBe(DSCP.EF);
    expect(outerBe).toBe(DSCP.CS0);
    expect(outerVoip).not.toBe(outerBe);
  });

  it('sur un pair inconnu, computeOuterTosForPeer renvoie null (pas de SA)', async () => {
    const lab = await establishTunnel();
    const eng1 = getEngine(lab.r1);
    expect(eng1.computeOuterTosForPeer('10.99.99.99', withDscp(0, DSCP.EF))).toBeNull();
    expect(eng1.getSADscpConfigForPeer('10.99.99.99')).toBeNull();
  });
});
