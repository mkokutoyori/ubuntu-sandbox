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

async function laboratoire(opmode: 'nat' | 'transparent' = 'nat') {
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
    'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config firewall policy', 'edit 1', 'set name "LAN-DMZ"',
    'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
    'set action accept', 'set logtraffic all', 'next',
    'edit 2', 'set name "DMZ-LAN"',
    'set srcintf "port3"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
    'set action accept', 'next', 'end',
  ]);
  if (opmode === 'transparent') {
    await taper(fgt, ['config system settings', 'set opmode transparent', 'end']);
  }
  return { fgt, pcLan, srvDmz };
}

describe('un paquet qui TRAVERSE le pare-feu perd un saut', () => {
  it('la reponse d\'echo revient avec un TTL decremente', async () => {
    const { pcLan } = await laboratoire();

    const sortie = await pcLan.executeCommand('ping -c 1 192.168.20.10');

    expect(sortie).toMatch(/, 0% packet loss/);
    expect(sortie).toMatch(/ttl=63\b/);
  });

  it('le pare-feu repond a SON PROPRE echo avec un TTL plein', async () => {
    const { pcLan } = await laboratoire();

    const sortie = await pcLan.executeCommand('ping -c 1 192.168.10.1');

    expect(sortie).toMatch(/, 0% packet loss/);
    expect(sortie).toMatch(/ttl=64\b/);
  });

  it('un paquet arrive a TTL 1 est JETE et le pare-feu le dit', async () => {
    const { fgt, pcLan } = await laboratoire();

    const sortie = await pcLan.executeCommand('ping -c 1 -t 1 192.168.20.10');

    expect(sortie).toMatch(/100% packet loss|Time to live exceeded/);
    expect(await fgt.executeCommand('diagnose sys session list')).not.toContain('ERREUR');
  });

  it('le pare-feu APPARAIT dans un traceroute qui le traverse', async () => {
    const { pcLan } = await laboratoire();

    const sortie = await pcLan.executeCommand('traceroute -n 192.168.20.10');

    expect(sortie).toContain('192.168.10.1');
    expect(sortie).toContain('192.168.20.10');
  });

  it('la SESSION deja ouverte decremente aussi — le chemin rapide n\'echappe pas', async () => {
    const { pcLan } = await laboratoire();
    await pcLan.executeCommand('ping -c 1 192.168.20.10');

    const second = await pcLan.executeCommand('ping -c 2 192.168.20.10');

    expect(second).toMatch(/, 0% packet loss/);
    expect(second).not.toMatch(/ttl=64\b/);
  });

  it('le TTL epuise est nomme dans la trace de flux', async () => {
    const { fgt, pcLan } = await laboratoire();
    await taper(fgt, [
      'diagnose debug reset', 'diagnose debug flow filter clear',
      'diagnose debug flow filter addr 192.168.20.10',
      'diagnose debug flow trace start 20', 'diagnose debug enable',
    ]);
    await pcLan.executeCommand('ping -c 1 -t 1 192.168.20.10');

    expect(await fgt.executeCommand('diagnose debug enable')).toMatch(/ttl/i);
  });

  it('en mode transparent le pare-feu est un PONT : il ne decremente pas', async () => {
    const { pcLan } = await laboratoire('transparent');

    const sortie = await pcLan.executeCommand('ping -c 1 192.168.20.10');

    if (/, 0% packet loss/.test(sortie)) expect(sortie).toMatch(/ttl=64\b/);
  });
});
