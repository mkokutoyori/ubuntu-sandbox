/**
 * `diagnose debug flow filter` accepte `sport`, `dport` et `vd` : le port source et le port destination se testent séparément (là où `port` retient
 * les deux sens), `vd` restreint la trace à un domaine virtuel, et la commande sans argument affiche l'état de chaque critère.
 *
 * MESURÉ avant correctif : `sport`, `dport` et `vd` répondaient « command parse error » ; avant correctif (git stash de src/network) 4 cas sur 5 tombent,
 * le témoin (addr seul) passe dans les deux états.
 */
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


const trace = async (fgt: Cmd, pc: Cmd, filters: string[]): Promise<string> => {
  await taper(fgt, ['diagnose debug reset', 'diagnose debug flow filter clear', ...filters,
    'diagnose debug flow trace start 20', 'diagnose debug enable']);
  await pc.executeCommand('curl -s -m 2 http://192.168.20.10:80/');
  return fgt.executeCommand('diagnose debug enable');
};

describe('diagnose debug flow filter : sport, dport, vd', () => {
  it('témoin : addr seul laisse passer la trace', async () => {
    const { fgt, pcLan } = await laboratoire();
    expect(await trace(fgt, pcLan, ['diagnose debug flow filter addr 192.168.20.10'])).toContain('trace_id=');
  });

  it('dport 80 retient le SYN vers le port 80, dport 81 ne retient rien', async () => {
    const { fgt, pcLan } = await laboratoire();
    expect(await trace(fgt, pcLan, ['diagnose debug flow filter dport 80'])).toContain('trace_id=');
    expect(await trace(fgt, pcLan, ['diagnose debug flow filter dport 81'])).not.toContain('trace_id=');
  });

  it("sport 8080 ne retient rien : le SYN part d'un port éphémère et la réponse du port 80 n'en vient pas", async () => {
    const { fgt, pcLan } = await laboratoire();
    expect(await trace(fgt, pcLan, ['diagnose debug flow filter sport 8080'])).not.toContain('trace_id=');
  });

  it('vd est lu : le filtre affiche le domaine retenu, et un autre domaine ne retient rien', async () => {
    const { fgt, pcLan } = await laboratoire();
    await taper(fgt, ['diagnose debug flow filter vd root']);
    expect(await fgt.executeCommand('diagnose debug flow filter')).toContain('vd: root');
    expect(await trace(fgt, pcLan, ['diagnose debug flow filter vd other'])).not.toContain('trace_id=');
    expect(await trace(fgt, pcLan, ['diagnose debug flow filter vd root'])).toContain('trace_id=');
  });

  it("le filtre affiché porte sport et dport", async () => {
    const { fgt } = await laboratoire();
    await taper(fgt, ['diagnose debug flow filter sport 1234', 'diagnose debug flow filter dport 80']);
    const shown = await fgt.executeCommand('diagnose debug flow filter');
    expect(shown).toContain('sport: 1234');
    expect(shown).toContain('dport: 80');
  });
});
