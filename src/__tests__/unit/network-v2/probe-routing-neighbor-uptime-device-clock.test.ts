/**
 * Le temps de vie d'un voisin EIGRP ou BGP se lit sur l'horloge de
 * l'ordonnanceur de son moteur.
 *
 * Mesure de depart (1f01e4f0), sous horloge virtuelle : 90 s apres la
 * formation de l'adjacence, `show ip eigrp neighbors` donnait au voisin
 * un Uptime de 00:00:00 ; `get router info bgp summary` (Up/Down) et
 * `get router info bgp neighbors` (`up for`) disaient 00:00:00 d'une
 * session etablie depuis 90 s. La table des voisins partagee par EIGRP
 * et BGP datait ses transitions avec Date.now().
 *
 * Autorites : Cisco IOS, `show ip eigrp neighbors` (colonne Uptime,
 * `hh:mm:ss` le premier jour) ; FortiOS, `get router info bgp summary`
 * (colonne Up/Down) et `get router info bgp neighbors` (`BGP state =
 * Established, up for hh:mm:ss`).
 *
 * Discrimination, mesuree sur le commit de base (1f01e4f0) avec ce
 * fichier copie : 3 des 5 cas tombent. Passent des deux cotes les deux
 * TEMOINS : l'adjacence EIGRP se forme, la session BGP de la FortiGate
 * s'etablit.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<void> {
  for (const command of commands) await device.executeCommand(command);
}

function secondsOf(clock: string): number {
  const [hours, minutes, seconds] = clock.split(':').map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

async function eigrpLab() {
  const clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 100, 0);
  new Cable('r1-r2').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  for (const [router, address] of [[r1, '10.0.12.1'], [r2, '10.0.12.2']] as const) {
    await type(router, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', `ip address ${address} 255.255.255.0`, 'no shutdown', 'exit',
      'router eigrp 10', 'network 10.0.12.0 0.0.0.255', 'end']);
  }
  return { clock, r1, r2 };
}

async function bgpLab() {
  const clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const r1 = new CiscoRouter('R1', 200, 0);
  new Cable('fgt-r1').connect(fw.getPort('port2')!, r1.getPort('GigabitEthernet0/0')!);
  await type(fw, ['config system interface', 'edit port2', 'set ip 10.0.0.1 255.255.255.0', 'next', 'end']);
  await type(r1, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
    'router bgp 65002', 'bgp router-id 2.2.2.2', 'neighbor 10.0.0.1 remote-as 65001', 'end']);
  await type(fw, ['config router bgp', 'set as 65001', 'set router-id 1.1.1.1',
    'config neighbor', 'edit "10.0.0.2"', 'set remote-as 65002', 'next', 'end', 'end']);
  clock.advance(45_000);
  return { clock, fw, r1 };
}

describe('routing neighbour uptime runs on the engine clock', () => {
  it('WITNESS: the EIGRP adjacency forms', async () => {
    const { r1 } = await eigrpLab();
    expect(await r1.executeCommand('show ip eigrp neighbors')).toContain('10.0.12.2');
  });

  it('show ip eigrp neighbors: 90 s later, the neighbour has been up 90 s', async () => {
    const { clock, r1 } = await eigrpLab();
    await r1.executeCommand('show ip eigrp neighbors');
    clock.advance(90_000);
    const uptime = /^0\s+10\.0\.12\.2\s+\S+\s+\d+\s+(\d\d:\d\d:\d\d)/m.exec(await r1.executeCommand('show ip eigrp neighbors'));
    expect(uptime).not.toBeNull();
    expect(secondsOf(uptime![1])).toBeGreaterThanOrEqual(90);
  });

  it('WITNESS: the FortiGate BGP session establishes', async () => {
    const { fw } = await bgpLab();
    expect(await fw.executeCommand('get router info bgp neighbors')).toContain('BGP state = Established');
  });

  it('get router info bgp summary: Up/Down counts the time since the session came up', async () => {
    const { clock, fw } = await bgpLab();
    clock.advance(90_000);
    const upDown = /^10\.0\.0\.2\s+4\s+65002\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d\d:\d\d:\d\d)/m
      .exec(await fw.executeCommand('get router info bgp summary'));
    expect(upDown).not.toBeNull();
    expect(secondsOf(upDown![1])).toBeGreaterThanOrEqual(90);
  });

  it('get router info bgp neighbors: up for the same time', async () => {
    const { clock, fw } = await bgpLab();
    clock.advance(90_000);
    const upFor = /BGP state = Established, up for (\d\d:\d\d:\d\d)/.exec(await fw.executeCommand('get router info bgp neighbors'));
    expect(upFor).not.toBeNull();
    expect(secondsOf(upFor![1])).toBeGreaterThanOrEqual(90);
  });
});
