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

async function configureEndpoint(
  router: CiscoRouter,
  side: {
    wanIp: string; peerWan: string;
    lanIp: string; localSubnet: string; remoteSubnet: string;
    proposal: string; policy: string; keyring: string; profile: string;
  },
  psk: string,
): Promise<void> {
  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', `ip address ${side.wanIp} 255.255.255.252`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/0', `ip address ${side.lanIp} 255.255.255.0`, 'no shutdown', 'exit',
    `crypto ikev2 proposal ${side.proposal}`, 'encryption aes-cbc-256', 'integrity sha256', 'group 14', 'exit',
    `crypto ikev2 policy ${side.policy}`, `proposal ${side.proposal}`, 'exit',
    `crypto ikev2 keyring ${side.keyring}`, 'peer PEER', `address ${side.peerWan}`, `pre-shared-key ${psk}`, 'exit', 'exit',
    `crypto ikev2 profile ${side.profile}`,
    `match identity remote address ${side.peerWan} 255.255.255.255`,
    'authentication remote pre-share', 'authentication local pre-share',
    `keyring local ${side.keyring}`, 'exit',
    'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
    'ip access-list extended VPN_TRAFFIC',
    `permit ip ${side.localSubnet} 0.0.0.255 ${side.remoteSubnet} 0.0.0.255`, 'exit',
    'crypto map CMAP 10 ipsec-isakmp',
    `set peer ${side.peerWan}`, `set ikev2-profile ${side.profile}`,
    'set transform-set TSET', 'match address VPN_TRAFFIC', 'exit',
    'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit',
    `ip route ${side.remoteSubnet.replace(/0$/, '0')} 255.255.255.0 ${side.peerWan}`,
    'end',
  ]) await router.executeCommand(cmd);
}

async function configureLab(l: Awaited<ReturnType<typeof buildLab>>): Promise<void> {
  const psk = 'IKEv2Scenario1Secret';
  await configureEndpoint(l.r1, {
    wanIp: '10.0.12.1', peerWan: '10.0.12.2',
    lanIp: '192.168.1.1', localSubnet: '192.168.1.0', remoteSubnet: '192.168.2.0',
    proposal: 'PROP_R1', policy: 'POL_R1', keyring: 'KR_R1', profile: 'PROF_R1',
  }, psk);
  await configureEndpoint(l.r2, {
    wanIp: '10.0.12.2', peerWan: '10.0.12.1',
    lanIp: '192.168.2.1', localSubnet: '192.168.2.0', remoteSubnet: '192.168.1.0',
    proposal: 'PROP_R2', policy: 'POL_R2', keyring: 'KR_R2', profile: 'PROF_R2',
  }, psk);
  await l.pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await l.pc1.executeCommand('sudo ip route add default via 192.168.1.1');
  await l.pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await l.pc2.executeCommand('sudo ip route add default via 192.168.2.1');
}

describe('Scénario 1 — Tunnel IPsec IKEv2 site-à-site: phase 1 puis phase 2, trafic ESP', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
  });

  it('avant tout trafic intéressant: pas d\'IKE SA, pas d\'IPSec SA', async () => {
    const l = await buildLab();
    await configureLab(l);
    const ikev2 = await l.r1.executeCommand('show crypto ikev2 sa');
    const ipsec = await l.r1.executeCommand('show crypto ipsec sa');
    expect(ikev2).not.toMatch(/READY/);
    expect(ipsec).toMatch(/#pkts encaps: 0|no active|No SAs|No IPSec SAs established/i);
  });

  it('un ping entre PC1 et PC2 déclenche l\'établissement du tunnel dans le bon ordre (phase 1 puis phase 2)', async () => {
    const l = await buildLab();
    await configureLab(l);
    const out = await l.pc1.executeCommand('ping -c 4 192.168.2.10');
    expect(out).toContain('4 received');
    const ikev2 = await l.r1.executeCommand('show crypto ikev2 sa');
    expect(ikev2).toContain('10.0.12.1');
    expect(ikev2).toContain('10.0.12.2');
    expect(ikev2).toMatch(/READY/);
    const ipsec = await l.r1.executeCommand('show crypto ipsec sa');
    expect(ipsec).toContain('#pkts encaps: 4');
    expect(ipsec).toContain('#pkts encrypt: 4');
    expect(ipsec).toContain('#pkts decaps: 4');
    expect(ipsec).toContain('#pkts decrypt: 4');
  });

  it('les SAs de phase 2 utilisent bien AES-256 + SHA-256 (transform-set annoncé)', async () => {
    const l = await buildLab();
    await configureLab(l);
    await l.pc1.executeCommand('ping -c 2 192.168.2.10');
    const ipsec = await l.r1.executeCommand('show crypto ipsec sa');
    expect(ipsec).toMatch(/esp-256-aes|esp-aes.*256/i);
    expect(ipsec).toMatch(/esp-sha256-hmac/i);
  });

  it('compteurs symétriques entre R1 et R2: encaps de l\'un = decaps de l\'autre', async () => {
    const l = await buildLab();
    await configureLab(l);
    await l.pc1.executeCommand('ping -c 3 192.168.2.10');
    const r1 = await l.r1.executeCommand('show crypto ipsec sa');
    const r2 = await l.r2.executeCommand('show crypto ipsec sa');
    const encapsR1 = /pkts encaps:\s*(\d+)/.exec(r1);
    const decapsR2 = /pkts decaps:\s*(\d+)/.exec(r2);
    const encapsR2 = /pkts encaps:\s*(\d+)/.exec(r2);
    const decapsR1 = /pkts decaps:\s*(\d+)/.exec(r1);
    expect(encapsR1).not.toBeNull();
    expect(decapsR2).not.toBeNull();
    expect(encapsR2).not.toBeNull();
    expect(decapsR1).not.toBeNull();
    expect(Number(encapsR1![1])).toBe(Number(decapsR2![1]));
    expect(Number(encapsR2![1])).toBe(Number(decapsR1![1]));
    expect(Number(encapsR1![1])).toBeGreaterThan(0);
  });

  it('le tunnel est visible sur les deux endpoints avec des identités locales/remotes miroirs', async () => {
    const l = await buildLab();
    await configureLab(l);
    await l.pc1.executeCommand('ping -c 1 192.168.2.10');
    const r1 = await l.r1.executeCommand('show crypto ipsec sa');
    const r2 = await l.r2.executeCommand('show crypto ipsec sa');
    expect(r1).toMatch(/local  ident \(addr\/mask\/prot\/port\): \(192\.168\.1\.0\//);
    expect(r1).toMatch(/remote ident \(addr\/mask\/prot\/port\): \(192\.168\.2\.0\//);
    expect(r2).toMatch(/local  ident \(addr\/mask\/prot\/port\): \(192\.168\.2\.0\//);
    expect(r2).toMatch(/remote ident \(addr\/mask\/prot\/port\): \(192\.168\.1\.0\//);
    expect(r1).toContain('current_peer 10.0.12.2');
    expect(r2).toContain('current_peer 10.0.12.1');
  });

  it('bidirectionnel: un ping de PC2 → PC1 réussit également via le tunnel déjà établi', async () => {
    const l = await buildLab();
    await configureLab(l);
    await l.pc1.executeCommand('ping -c 2 192.168.2.10');
    const out = await l.pc2.executeCommand('ping -c 2 192.168.1.10');
    expect(out).toContain('2 received');
    const ipsec = await l.r1.executeCommand('show crypto ipsec sa');
    const encaps = /pkts encaps:\s*(\d+)/.exec(ipsec);
    const decaps = /pkts decaps:\s*(\d+)/.exec(ipsec);
    expect(Number(encaps![1])).toBeGreaterThanOrEqual(2);
    expect(Number(decaps![1])).toBeGreaterThanOrEqual(2);
  });

  it('clear crypto session sur R1 réinitialise les SAs, un nouveau ping les rétablit', async () => {
    const l = await buildLab();
    await configureLab(l);
    await l.pc1.executeCommand('ping -c 1 192.168.2.10');
    const before = await l.r1.executeCommand('show crypto ikev2 sa');
    expect(before).toMatch(/READY/);
    await l.r1.executeCommand('clear crypto session');
    await l.pc1.executeCommand('ping -c 2 192.168.2.10');
    const after = await l.r1.executeCommand('show crypto ikev2 sa');
    expect(after).toMatch(/READY/);
    const ipsec = await l.r1.executeCommand('show crypto ipsec sa');
    expect(ipsec).toContain('#pkts encaps: 2');
  });
});
