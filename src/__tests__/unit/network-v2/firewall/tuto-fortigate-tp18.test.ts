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

const CLE = 'CleLabTeletravail2026!';

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pcLan = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
  const portable = new FortiGate('firewall-fortinet', 'PORTABLE', 200, 0);

  new Cable('lan').connect(pcLan.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('wan').connect(fgt.getPort('port1')!, portable.getPort('port1')!);

  await taper(pcLan, [
    'ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1',
  ]);
  await taper(portable, [
    'config system global', 'set hostname PORTABLE', 'end',
    'config system interface', 'edit port1', 'set mode static',
    'set ip 203.0.113.50 255.255.255.0', 'set allowaccess ping', 'next', 'end',
  ]);

  await taper(fgt, [
    'config system interface',
    'edit port1', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end',
    'config user local', 'edit "marie.durand"', 'set type password',
    'set passwd "Direction2026!"', 'set status enable', 'next', 'end',
    'config user group', 'edit "GRP-Teletravailleurs"',
    'set member "marie.durand"', 'next', 'end',
    'config firewall address',
    'edit "NET-LAN"', 'set subnet 192.168.10.0 255.255.255.0', 'next',
    'edit "NET-VPN-Clients"', 'set subnet 192.168.200.0 255.255.255.0', 'next',
    'end',
  ]);
  return { fgt, pcLan, portable };
}

async function dialup(fgt: FortiGate, splitInclude = true): Promise<string[]> {
  return taper(fgt, [
    'config vpn ipsec phase1-interface', 'edit "VPN-Teletravail"',
    'set type dynamic',
    'set interface "port1"',
    'set ike-version 2',
    'set peertype dialup',
    'set net-device disable',
    'set mode-cfg enable',
    'set proposal aes256-sha256',
    'set dhgrp 14',
    'set authusrgrp "GRP-Teletravailleurs"',
    `set psksecret "${CLE}"`,
    'set ipv4-start-ip 192.168.200.10',
    'set ipv4-end-ip 192.168.200.50',
    'set ipv4-netmask 255.255.255.0',
    ...(splitInclude ? ['set ipv4-split-include "NET-LAN"'] : []),
    'set ipv4-dns-server1 192.168.10.1',
    'set dpd on-idle',
    'next', 'end',
    'config vpn ipsec phase2-interface', 'edit "VPN-Teletravail-P2"',
    'set phase1name "VPN-Teletravail"',
    'set proposal aes256-sha256', 'set pfs enable', 'set dhgrp 14',
    'next', 'end',
    'config firewall policy', 'edit 30',
    'set name "Teletravail-vers-LAN"',
    'set srcintf "VPN-Teletravail"', 'set dstintf "port2"',
    'set srcaddr "NET-VPN-Clients"', 'set dstaddr "NET-LAN"',
    'set groups "GRP-Teletravailleurs"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'set logtraffic all', 'next', 'end',
  ]);
}

async function composer(
  portable: FortiGate, utilisateur = 'marie.durand', motDePasse = 'Direction2026!',
): Promise<string[]> {
  const sorties = await taper(portable, [
    'config vpn ipsec phase1-interface', 'edit "VERS-SIEGE"',
    'set interface "port1"',
    'set ike-version 2',
    'set remote-gw 203.0.113.1',
    'set proposal aes256-sha256',
    'set dhgrp 14',
    'set mode-cfg enable',
    'set xauthtype client',
    `set authusr "${utilisateur}"`,
    `set authpasswd "${motDePasse}"`,
    `set psksecret "${CLE}"`,
    'next', 'end',
    'config vpn ipsec phase2-interface', 'edit "VERS-SIEGE-P2"',
    'set phase1name "VERS-SIEGE"',
    'set proposal aes256-sha256', 'set pfs enable', 'set dhgrp 14',
    'next', 'end',
  ]);
  await portable.executeCommand('diagnose vpn tunnel up VERS-SIEGE');
  return sorties;
}

describe('TP 18 — un acces teletravailleur', () => {
  it('etape 2 : une phase 1 DIAL-UP se declare avec sa reserve d\'adresses',
    async () => {
      const { fgt } = await laboratoire();
      propre(await dialup(fgt));

      const conf = await fgt.executeCommand('show vpn ipsec phase1-interface');
      expect(conf).toContain('set type dynamic');
      expect(conf).toContain('set peertype dialup');
      expect(conf).toContain('set mode-cfg enable');
      expect(conf).toContain('set ipv4-start-ip 192.168.200.10');
      expect(conf).toContain('set ipv4-end-ip 192.168.200.50');
      expect(conf).toContain('set authusrgrp "GRP-Teletravailleurs"');
      expect(conf).not.toContain(CLE);
    });

  it('etape 2 : une reserve INVERSEE est refusee', async () => {
    const { fgt } = await laboratoire();
    await dialup(fgt);

    const vu = await fgt.executeCommand('config vpn ipsec phase1-interface');
    expect(vu).not.toMatch(/Unknown action/i);
    await fgt.executeCommand('edit "VPN-Teletravail"');
    await fgt.executeCommand('set ipv4-start-ip 192.168.200.90');
    const refus = await fgt.executeCommand('next');
    await fgt.executeCommand('end');

    expect(refus).toMatch(/Command fail/i);
    expect(refus).toMatch(/ipv4-end-ip|ipv4-start-ip/);
  });

  it('etape 2 : un groupe d\'authentification INCONNU est refuse', async () => {
    const { fgt } = await laboratoire();
    await fgt.executeCommand('config vpn ipsec phase1-interface');
    await fgt.executeCommand('edit "VPN-X"');
    const refus = await fgt.executeCommand('set authusrgrp "GRP-Absent"');
    await taper(fgt, ['next', 'end']);

    expect(refus).toMatch(/Command fail|entry not found|does not exist/i);
  });

  it('etape 4 : le tunnel dial-up est une interface de politique', async () => {
    const { fgt } = await laboratoire();
    await dialup(fgt);

    expect(await fgt.executeCommand('show firewall policy 30'))
      .toContain('set srcintf "VPN-Teletravail"');
  });

  it('etape 5 et 7 : le client obtient une adresse de la RESERVE', async () => {
    const { fgt, portable } = await laboratoire();
    await dialup(fgt);

    propre(await composer(portable));

    expect(await portable.executeCommand('get system interface'))
      .toMatch(/192\.168\.200\.\d+/);
  });

  it('etape 6 : `diagnose vpn ike gateway list` nomme le client et son adresse',
    async () => {
      const { fgt, portable } = await laboratoire();
      await dialup(fgt);
      await composer(portable);

      const vue = await fgt.executeCommand(
        'diagnose vpn ike gateway list name VPN-Teletravail');
      expect(vue).toContain('VPN-Teletravail');
      expect(vue).toMatch(/assigned/i);
      expect(vue).toMatch(/192\.168\.200\.\d+/);
    });

  it('etape 8 : le teletravailleur joint le LAN', async () => {
    const { fgt, portable } = await laboratoire();
    await dialup(fgt);
    await composer(portable);

    const vu = await portable.executeCommand('execute ping 192.168.10.10');
    expect(vu).toMatch(/0% packet loss/);
  });

  it('etape 9 : en SPLIT, la route par defaut ne change PAS', async () => {
    const { fgt, portable } = await laboratoire();
    await dialup(fgt, true);
    await composer(portable);

    const apres = await portable.executeCommand('get router info routing-table all');
    expect(apres).toContain('192.168.10.0');
    expect(apres).toContain('VERS-SIEGE');
  });

  it('etape 10 : sans SPLIT, la route par defaut passe par le tunnel', async () => {
    const { fgt, portable } = await laboratoire();
    await dialup(fgt, false);
    await composer(portable);

    const apres = await portable.executeCommand('get router info routing-table all');
    expect(apres).not.toContain('192.168.10.0');
  });

  it('un utilisateur HORS du groupe est refuse', async () => {
    const { fgt, portable } = await laboratoire();
    await taper(fgt, [
      'config user local', 'edit "paul.stagiaire"', 'set type password',
      'set passwd "Stagiaire2026!"', 'set status enable', 'next', 'end',
    ]);
    await dialup(fgt);

    await composer(portable, 'paul.stagiaire', 'Stagiaire2026!');

    expect(await portable.executeCommand('get system interface'))
      .not.toMatch(/192\.168\.200\.\d+/);
  });
});
