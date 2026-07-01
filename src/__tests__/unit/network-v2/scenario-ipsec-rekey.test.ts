import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

async function configureEndpoint(
  r: CiscoRouter, wanIp: string, peerWan: string, lanIp: string,
  localSubnet: string, remoteSubnet: string,
  phase1Sec: number, phase2Sec: number, psk: string,
): Promise<void> {
  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', `ip address ${wanIp} 255.255.255.252`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/0', `ip address ${lanIp} 255.255.255.0`, 'no shutdown', 'exit',
    'crypto isakmp policy 10',
    'encryption aes 256', 'hash sha256', 'authentication pre-share', 'group 14',
    `lifetime ${phase1Sec}`, 'exit',
    `crypto isakmp key ${psk} address ${peerWan}`,
    'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
    'ip access-list extended VPN_ACL',
    `permit ip ${localSubnet} 0.0.0.255 ${remoteSubnet} 0.0.0.255`, 'exit',
    'crypto map CMAP 10 ipsec-isakmp',
    `set peer ${peerWan}`, 'set transform-set TSET', 'match address VPN_ACL',
    `set security-association lifetime seconds ${phase2Sec}`, 'exit',
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

function parseSpis(ipsecOut: string): { in: string[]; out: string[] } {
  const inSpis = Array.from(ipsecOut.matchAll(/inbound esp sas:[\s\S]*?spi:\s*0x([0-9a-f]+)/gi)).map(m => m[1].toLowerCase());
  const outSpis = Array.from(ipsecOut.matchAll(/outbound esp sas:[\s\S]*?spi:\s*0x([0-9a-f]+)/gi)).map(m => m[1].toLowerCase());
  if (inSpis.length === 0 && outSpis.length === 0) {
    const all = Array.from(ipsecOut.matchAll(/spi:\s*0x([0-9a-f]+)/gi)).map(m => m[1].toLowerCase());
    return { in: all, out: all };
  }
  return { in: inSpis, out: outSpis };
}

describe('Scénario 4 — Renouvellement des SA IPsec (rekey phase 1 / phase 2)', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lifetimes courts sont bien enregistrés dans la crypto map / policy', async () => {
    const l = await buildLab();
    await configureEndpoint(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0', 3600, 1800, 'Secret');
    await configureEndpoint(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0', 3600, 1800, 'Secret');
    const isakmp = await l.r1.executeCommand('show crypto isakmp policy');
    expect(isakmp).toMatch(/lifetime:\s*3600/i);
    const map = await l.r1.executeCommand('show crypto map');
    expect(map).toMatch(/1800 seconds/);
  });

  it('après établissement, show crypto ipsec sa expose des SPI initiaux non nuls', async () => {
    const l = await buildLab();
    await configureEndpoint(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0', 3600, 1800, 'Secret');
    await configureEndpoint(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0', 3600, 1800, 'Secret');
    await seedPcs(l.pc1, l.pc2);
    await l.pc1.executeCommand('ping -c 1 192.168.2.10');
    const ipsec = await l.r1.executeCommand('show crypto ipsec sa');
    const spis = parseSpis(ipsec);
    expect(spis.in.length + spis.out.length).toBeGreaterThan(0);
    for (const s of [...spis.in, ...spis.out]) expect(s).toMatch(/^[0-9a-f]{1,8}$/);
  });

  it('après expiration de la SA de phase 2, un nouveau trafic déclenche un rekey avec de nouveaux SPI', async () => {
    const l = await buildLab();
    await configureEndpoint(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0', 3600, 1800, 'Secret');
    await configureEndpoint(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0', 3600, 1800, 'Secret');
    await seedPcs(l.pc1, l.pc2);
    await l.pc1.executeCommand('ping -c 2 192.168.2.10');
    const before = parseSpis(await l.r1.executeCommand('show crypto ipsec sa'));
    const beforeSet = new Set([...before.in, ...before.out]);
    vi.setSystemTime(new Date('2026-07-01T00:31:00Z'));
    await l.pc1.executeCommand('ping -c 2 192.168.2.10');
    const after = parseSpis(await l.r1.executeCommand('show crypto ipsec sa'));
    const afterSet = new Set([...after.in, ...after.out]);
    expect([...afterSet].some(s => !beforeSet.has(s))).toBe(true);
  });

  it('un flux TCP répété survit au rekey: les pings avant et après expiration réussissent tous', async () => {
    const l = await buildLab();
    await configureEndpoint(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0', 3600, 1800, 'Secret');
    await configureEndpoint(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0', 3600, 1800, 'Secret');
    await seedPcs(l.pc1, l.pc2);
    const p1 = await l.pc1.executeCommand('ping -c 2 192.168.2.10');
    expect(p1).toContain('2 received');
    vi.setSystemTime(new Date('2026-07-01T00:31:00Z'));
    const p2 = await l.pc1.executeCommand('ping -c 2 192.168.2.10');
    expect(p2).toContain('2 received');
    vi.setSystemTime(new Date('2026-07-01T01:05:00Z'));
    const p3 = await l.pc1.executeCommand('ping -c 2 192.168.2.10');
    expect(p3).toContain('2 received');
  });

  it('après rekey, la nouvelle SA encapsule bien le trafic (compteurs > 0 sur la nouvelle SA)', async () => {
    const l = await buildLab();
    await configureEndpoint(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0', 3600, 1800, 'Secret');
    await configureEndpoint(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0', 3600, 1800, 'Secret');
    await seedPcs(l.pc1, l.pc2);
    await l.pc1.executeCommand('ping -c 3 192.168.2.10');
    vi.setSystemTime(new Date('2026-07-01T00:31:00Z'));
    await l.pc1.executeCommand('ping -c 2 192.168.2.10');
    const after = /pkts encaps:\s*(\d+)/.exec(await l.r1.executeCommand('show crypto ipsec sa'));
    expect(after).not.toBeNull();
    expect(Number(after![1])).toBeGreaterThan(0);
  }, 15000);

  it('recheckIKESALifetimes déclenche le rekey de phase 1 quand la SA IKE est expirée', async () => {
    const l = await buildLab();
    await configureEndpoint(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0', 3600, 1800, 'Secret');
    await configureEndpoint(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0', 3600, 1800, 'Secret');
    await seedPcs(l.pc1, l.pc2);
    await l.pc1.executeCommand('ping -c 1 192.168.2.10');
    const eng = (l.r1 as unknown as { _getIPSecEngineInternal(): { recheckIKESALifetimes(): void; getIkeSpiForPeer(peer: string): string | undefined } })._getIPSecEngineInternal();
    const spiFor = (peer: string) => {
      const db = (eng as unknown as { ikeSADB: Map<string, { spi: string }> }).ikeSADB;
      return db.get(peer)?.spi;
    };
    const spiBefore = spiFor('10.0.12.2');
    expect(spiBefore).toBeDefined();
    vi.setSystemTime(new Date('2026-07-01T02:00:00Z'));
    eng.recheckIKESALifetimes();
    const spiAfter = spiFor('10.0.12.2');
    expect(spiAfter).toBeDefined();
    expect(spiAfter).not.toBe(spiBefore);
  });

  it('debug crypto isakmp: la trace de rekey est visible dans le journal', async () => {
    const l = await buildLab();
    await configureEndpoint(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0', 3600, 1800, 'Secret');
    await configureEndpoint(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0', 3600, 1800, 'Secret');
    await seedPcs(l.pc1, l.pc2);
    await l.r1.executeCommand('debug crypto isakmp');
    await l.pc1.executeCommand('ping -c 1 192.168.2.10');
    const eng = (l.r1 as unknown as { _getIPSecEngineInternal(): { recheckIKESALifetimes(): void } })._getIPSecEngineInternal();
    vi.setSystemTime(new Date('2026-07-01T02:00:00Z'));
    eng.recheckIKESALifetimes();
    const entries = Logger.getLogs();
    const rekey = entries.find(e => /rekey/i.test(e.message ?? ''));
    expect(rekey).toBeDefined();
  });
});
