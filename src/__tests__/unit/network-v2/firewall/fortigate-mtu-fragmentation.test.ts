import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function laboratoire(mtuSortie?: number) {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pcLan = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
  const srvDmz = new LinuxServer('linux-server', 'SRV-DMZ', 200, 0);

  new Cable('lan').connect(pcLan.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('dmz').connect(fgt.getPort('port3')!, srvDmz.getPort('eth0')!);

  await taper(pcLan, [
    'ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1',
  ]);
  await taper(srvDmz, [
    'ip addr add 192.168.20.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.20.1',
  ]);
  await taper(fgt, [
    'config system interface',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port3', 'set mode static',
    'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping',
    ...(mtuSortie === undefined
      ? [] : ['set mtu-override enable', `set mtu ${mtuSortie}`]),
    'next', 'end',
    'config firewall policy',
    'edit 1', 'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
    'set action accept', 'next',
    'edit 2', 'set srcintf "port3"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
    'set action accept', 'next', 'end',
  ]);
  return { fgt, pcLan, srvDmz };
}

describe('le pare-feu fait respecter le MTU de son interface de sortie', () => {
  it('un datagramme qui TIENT passe sans etre touche', async () => {
    const { fgt, pcLan } = await laboratoire(600);
    await pcLan.executeCommand('ping -c 1 -s 100 192.168.20.10');

    const capture = await fgt.executeCommand(
      "diagnose sniffer packet port3 'host 192.168.20.10' 4 30");

    expect(capture.match(/192\.168\.10\.10 -> 192\.168\.20\.10/g) ?? [])
      .toHaveLength(1);
  });

  it('DF pose et trop gros : le pare-feu refuse et NOMME le MTU', async () => {
    const { pcLan } = await laboratoire(600);

    const sortie = await pcLan.executeCommand(
      'ping -c 1 -M do -s 1200 192.168.20.10');

    expect(sortie).toContain('Frag needed and DF set (mtu = 600)');
    expect(sortie).toContain('From 192.168.10.1');
    expect(sortie).toMatch(/100% packet loss/);
  });

  it('`set mtu` SANS `mtu-override` ne contraint rien, comme sur un vrai FortiGate',
    async () => {
      const { fgt, pcLan } = await laboratoire();
      await taper(fgt, [
        'config system interface', 'edit port3', 'set mtu 600', 'next', 'end',
      ]);

      expect(await pcLan.executeCommand('ping -c 1 -M do -s 1200 192.168.20.10'))
        .toMatch(/, 0% packet loss/);
    });

  it('la trace de flux nomme le refus pour MTU', async () => {
    const { fgt, pcLan } = await laboratoire(600);
    await taper(fgt, [
      'diagnose debug reset', 'diagnose debug flow filter clear',
      'diagnose debug flow filter addr 192.168.20.10',
      'diagnose debug flow trace start 20', 'diagnose debug enable',
    ]);
    await pcLan.executeCommand('ping -c 1 -M do -s 1200 192.168.20.10');

    expect(await fgt.executeCommand('diagnose debug enable')).toMatch(/mtu/i);
  });

  it('DF absent et trop gros : le datagramme part en PLUSIEURS morceaux',
    async () => {
      const { fgt, pcLan } = await laboratoire(600);

      expect(await pcLan.executeCommand('ping -c 1 -s 1200 192.168.20.10'))
        .toMatch(/, 0% packet loss/);

      const capture = await fgt.executeCommand(
        "diagnose sniffer packet port3 'host 192.168.20.10' 4 30");

      expect((capture.match(/192\.168\.10\.10 -> 192\.168\.20\.10/g) ?? []).length)
        .toBeGreaterThan(1);
    });

  it('sans contrainte de MTU, le meme envoi passe entier', async () => {
    const { fgt, pcLan } = await laboratoire();

    expect(await pcLan.executeCommand('ping -c 1 -M do -s 1200 192.168.20.10'))
      .toMatch(/, 0% packet loss/);

    const capture = await fgt.executeCommand(
      "diagnose sniffer packet port3 'host 192.168.20.10' 4 30");

    expect(capture.match(/192\.168\.10\.10 -> 192\.168\.20\.10/g) ?? [])
      .toHaveLength(1);
  });
});
