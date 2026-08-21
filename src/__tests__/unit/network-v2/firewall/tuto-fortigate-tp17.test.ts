import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../../support/fastPing';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(c: string): Promise<string> }
async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

function propre(sorties: string[]): void {
  for (const s of sorties) {
    expect(s).not.toMatch(/Unknown action|command parse error|Invalid|entry not found/i);
  }
}

const CLE = 'CleLabFortiGate2026!';

async function laboratoire() {
  const fgt1 = new FortiGate('firewall-fortinet', 'FGT-01', -200, 0);
  const fgt2 = new FortiGate('firewall-fortinet', 'FGT-02', 200, 0);
  const pcParis = new LinuxPC('linux-pc', 'PC-PARIS', -400, 0);
  const pcLyon = new LinuxPC('linux-pc', 'PC-LYON', 400, 0);

  new Cable('transit').connect(fgt1.getPort('port1')!, fgt2.getPort('port1')!);
  new Cable('paris').connect(pcParis.getPort('eth0')!, fgt1.getPort('port2')!);
  new Cable('lyon').connect(pcLyon.getPort('eth0')!, fgt2.getPort('port2')!);

  await taper(pcParis, [
    'ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1',
  ]);
  await taper(pcLyon, [
    'ip addr add 192.168.50.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.50.1',
  ]);

  await taper(fgt1, [
    'config system global', 'set hostname FGT-01', 'end',
    'config system interface',
    'edit port1', 'set mode static', 'set ip 203.0.113.1 255.255.255.0',
    'set allowaccess ping', 'next',
    'edit port2', 'set alias "LAN-Paris"', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end',
    'config firewall address',
    'edit "NET-LAN"', 'set subnet 192.168.10.0 255.255.255.0', 'next',
    'edit "NET-LYON"', 'set subnet 192.168.50.0 255.255.255.0', 'next',
    'end',
  ]);
  await taper(fgt2, [
    'config system global', 'set hostname FGT-02', 'end',
    'config system interface',
    'edit port1', 'set mode static', 'set ip 203.0.113.50 255.255.255.0',
    'set allowaccess ping', 'next',
    'edit port2', 'set alias "LAN-Lyon"', 'set mode static',
    'set ip 192.168.50.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end',
    'config firewall address',
    'edit "NET-LAN"', 'set subnet 192.168.50.0 255.255.255.0', 'next',
    'edit "NET-PARIS"', 'set subnet 192.168.10.0 255.255.255.0', 'next',
    'end',
  ]);
  return { fgt1, fgt2, pcParis, pcLyon };
}

async function phase1(
  fgt: FortiGate, nom: string, pair: string, cle = CLE,
): Promise<string[]> {
  return taper(fgt, [
    'config vpn ipsec phase1-interface', `edit "${nom}"`,
    'set interface "port1"',
    'set ike-version 2',
    'set peertype any',
    'set net-device disable',
    'set proposal aes256-sha256',
    'set dhgrp 14',
    `set remote-gw ${pair}`,
    `set psksecret "${cle}"`,
    'set dpd on-idle',
    'next', 'end',
  ]);
}

async function phase2(
  fgt: FortiGate, nom: string, p1: string, src: string, dst: string,
): Promise<string[]> {
  return taper(fgt, [
    'config vpn ipsec phase2-interface', `edit "${nom}"`,
    `set phase1name "${p1}"`,
    'set proposal aes256-sha256',
    'set pfs enable',
    'set dhgrp 14',
    `set src-subnet ${src} 255.255.255.0`,
    `set dst-subnet ${dst} 255.255.255.0`,
    'set auto-negotiate enable',
    'next', 'end',
  ]);
}

async function routeEtPolitiques(
  fgt: FortiGate, tunnel: string, distant: string, local: string,
): Promise<string[]> {
  return taper(fgt, [
    'config router static', 'edit 10',
    `set dst ${distant} 255.255.255.0`,
    `set device "${tunnel}"`, 'next', 'end',
    'config firewall policy', 'edit 20',
    'set name "Local-vers-Distant"',
    'set srcintf "port2"', `set dstintf "${tunnel}"`,
    'set srcaddr "NET-LAN"', `set dstaddr "${local}"`,
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'set logtraffic all', 'next',
    'edit 21',
    'set name "Distant-vers-Local"',
    `set srcintf "${tunnel}"`, 'set dstintf "port2"',
    `set srcaddr "${local}"`, 'set dstaddr "NET-LAN"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'set logtraffic all', 'next', 'end',
  ]);
}

async function tunnelComplet(fgt1: FortiGate, fgt2: FortiGate): Promise<void> {
  await phase1(fgt1, 'VPN-Lyon', '203.0.113.50');
  await phase2(fgt1, 'VPN-Lyon-P2', 'VPN-Lyon', '192.168.10.0', '192.168.50.0');
  await routeEtPolitiques(fgt1, 'VPN-Lyon', '192.168.50.0', 'NET-LYON');

  await phase1(fgt2, 'VPN-Paris', '203.0.113.1');
  await phase2(fgt2, 'VPN-Paris-P2', 'VPN-Paris', '192.168.50.0', '192.168.10.0');
  await routeEtPolitiques(fgt2, 'VPN-Paris', '192.168.10.0', 'NET-PARIS');
}

describe('TP 17 — monter un tunnel entre deux sites', () => {
  it('etape 2 : les deux passerelles se voient AVANT tout VPN', async () => {
    const { fgt1 } = await laboratoire();
    const vu = await fgt1.executeCommand('execute ping 203.0.113.50');

    expect(vu).toMatch(/bytes from 203\.0\.113\.50/);
    expect(vu).toMatch(/0% packet loss/);
  });

  it('etape 4 : la phase 1 se declare et se relit', async () => {
    const { fgt1 } = await laboratoire();
    propre(await phase1(fgt1, 'VPN-Lyon', '203.0.113.50'));

    const conf = await fgt1.executeCommand('show vpn ipsec phase1-interface');
    expect(conf).toContain('edit "VPN-Lyon"');
    expect(conf).toContain('set ike-version 2');
    expect(conf).toContain('set proposal aes256-sha256');
    expect(conf).toContain('set dhgrp 14');
    expect(conf).toContain('set remote-gw 203.0.113.50');
    expect(conf).not.toContain(CLE);
  });

  it('etape 5 : la phase 2 se declare et se relit', async () => {
    const { fgt1 } = await laboratoire();
    await phase1(fgt1, 'VPN-Lyon', '203.0.113.50');
    propre(await phase2(fgt1, 'VPN-Lyon-P2', 'VPN-Lyon', '192.168.10.0', '192.168.50.0'));

    const conf = await fgt1.executeCommand('show vpn ipsec phase2-interface');
    expect(conf).toContain('edit "VPN-Lyon-P2"');
    expect(conf).toContain('set phase1name "VPN-Lyon"');
    expect(conf).toContain('set src-subnet 192.168.10.0 255.255.255.0');
    expect(conf).toContain('set dst-subnet 192.168.50.0 255.255.255.0');
  });

  it('etape 7 : le tunnel est une INTERFACE, utilisable en route et en politique',
    async () => {
      const { fgt1 } = await laboratoire();
      await phase1(fgt1, 'VPN-Lyon', '203.0.113.50');
      await phase2(fgt1, 'VPN-Lyon-P2', 'VPN-Lyon', '192.168.10.0', '192.168.50.0');
      propre(await routeEtPolitiques(fgt1, 'VPN-Lyon', '192.168.50.0', 'NET-LYON'));

      expect(await fgt1.executeCommand('get router info routing-table all'))
        .toContain('VPN-Lyon');
      expect(await fgt1.executeCommand('show firewall policy 20'))
        .toContain('set dstintf "VPN-Lyon"');
    });

  it('etape 8 : `get vpn ipsec tunnel summary` rend `selectors(total,up): 1/1`',
    async () => {
      const { fgt1, fgt2 } = await laboratoire();
      await tunnelComplet(fgt1, fgt2);
      await fgt1.executeCommand('diagnose vpn ike gateway clear name VPN-Lyon');

      const vue = await fgt1.executeCommand('get vpn ipsec tunnel summary');
      expect(vue).toContain('VPN-Lyon');
      expect(vue).toContain('203.0.113.50');
      expect(vue).toMatch(/selectors\(total,up\): 1\/1/);
    });

  it('etape 8 : `diagnose vpn tunnel list` rend le detail negocie', async () => {
    const { fgt1, fgt2 } = await laboratoire();
    await tunnelComplet(fgt1, fgt2);

    const vue = await fgt1.executeCommand('diagnose vpn tunnel list');
    expect(vue).toContain('VPN-Lyon');
    expect(vue).toMatch(/aes.?256/i);
    expect(vue).toMatch(/sha256/i);
  });

  it('etape 9 : un ping traverse le tunnel entre les deux LAN', async () => {
    const { fgt1, fgt2, pcParis } = await laboratoire();
    await tunnelComplet(fgt1, fgt2);

    const vu = await pingOnSimulatedClock(pcParis, 'ping -c 3 -W 1 192.168.50.10');
    expect(vu).toMatch(/, 0% packet loss/);
  });

  it('etape 9 : ce qui passe sur le transit est CHIFFRE', async () => {
    const { fgt1, fgt2, pcParis } = await laboratoire();
    await tunnelComplet(fgt1, fgt2);
    await pingOnSimulatedClock(pcParis, 'ping -c 2 -W 1 192.168.50.10');

    const capture = await fgt1.executeCommand(
      "diagnose sniffer packet port1 'udp port 4500 or esp' 4 20");
    expect(capture).toMatch(/esp|ESP|4500/);
    expect(capture).not.toContain('192.168.50.10');
  });

  it('etape 10 : une cle DISCORDANTE fait echouer la phase 1', async () => {
    const { fgt1, fgt2 } = await laboratoire();
    await tunnelComplet(fgt1, fgt2);
    await taper(fgt2, [
      'config vpn ipsec phase1-interface', 'edit "VPN-Paris"',
      'set psksecret "MauvaiseCle"', 'next', 'end',
    ]);
    await fgt1.executeCommand('diagnose vpn ike gateway clear name VPN-Lyon');

    const vue = await fgt1.executeCommand('get vpn ipsec tunnel summary');
    expect(vue).toMatch(/selectors\(total,up\): 1\/0/);

    const passerelle = await fgt1.executeCommand('diagnose vpn ike gateway list');
    expect(passerelle).toContain('IKE SA: created 0/0');
  });

  it('etape 11 : un selecteur NON miroir donne `selectors(total,up): 1/0`', async () => {
    const { fgt1, fgt2, pcParis } = await laboratoire();
    await tunnelComplet(fgt1, fgt2);
    await taper(fgt2, [
      'config vpn ipsec phase2-interface', 'edit "VPN-Paris-P2"',
      'set dst-subnet 192.168.99.0 255.255.255.0', 'next', 'end',
    ]);
    await fgt1.executeCommand('diagnose vpn ike gateway clear name VPN-Lyon');

    const vue = await fgt1.executeCommand('get vpn ipsec tunnel summary');
    expect(vue).toMatch(/selectors\(total,up\): 1\/0/);

    const passerelle = await fgt1.executeCommand('diagnose vpn ike gateway list');
    expect(passerelle).toContain('IKE SA: created 1/1');
    expect(passerelle).toContain('IPsec SA: created 0/1');

    const vu = await pingOnSimulatedClock(pcParis, 'ping -c 2 -W 1 192.168.50.10');
    expect(vu).toMatch(/100% packet loss/);
  });

  it('la cle partagee ne parait NULLE PART en clair', async () => {
    const { fgt1, fgt2 } = await laboratoire();
    await tunnelComplet(fgt1, fgt2);

    const conf = await fgt1.executeCommand('show');
    expect(conf).not.toContain(CLE);
    expect(await fgt2.executeCommand('show vpn ipsec phase1-interface'))
      .not.toContain(CLE);
  });
});
