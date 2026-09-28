/**
 * Une FortiGate imprime l'age de chaque route apprise, dans le format de
 * zebra, et une route que la reconvergence reinstalle a l'identique garde
 * le sien.
 *
 * Mesure de depart (1202a1e0), FortiGate — Cisco R1 en OSPF, RIP ou BGP,
 * sous horloge virtuelle : aucune route apprise ne portait d'age
 * (`O       172.16.0.0/24 [110/2] via 10.0.0.2, port2`), la table ne
 * retenait aucun instant d'installation, et `get router info bgp
 * summary` ecrivait `25:00:45` d'une session etablie depuis 25 heures.
 *
 * Autorites : sortie capturee de `get router info routing-table all`
 * conservee par ntc-templates (tests/fortinet/get_router_info_routing-
 * table_all) — `O*E2    0.0.0.0/0 [110/10] via 10.149.127.253,
 * Tu-Hub01-Main, 03w2d20h`, `O       10.80.58.224/27 [110/201] via
 * 10.149.127.253, Tu-Hub01-Main, 3d13h31m`, `O E2    10.80.130.0/24
 * [110/20] via 10.149.127.253, Tu-Hub01-Main, 22:00:53`, `B
 * 10.160.0.0/23 [20/0] via 10.142.0.74, port3, 2d18h02m`, et les routes
 * statiques et connectees sans age ; sortie d'une FortiGate 7.2-7.6
 * (infosecmonkey) : `R       10.0.2.0/24 [120/2] via 198.18.1.2, port2,
 * 00:04:12` — l'age d'une route RIP court depuis son installation, pas
 * depuis le dernier rafraichissement ; `get router info bgp summary`
 * (blog.boll.ch, « FortiGate BGP Troubleshooting Guide ») : Up/Down
 * `4d20h36m`.
 *
 * Discrimination, mesuree sur le commit de base (1202a1e0) avec ce
 * fichier copie : 9 des 11 cas tombent. Passent des deux cotes le TEMOIN
 * (la FortiGate apprend 172.16.0.0/24 par OSPF) et la NON-REGRESSION
 * « statiques et connectees ne portent pas d'age ».
 */
import { describe, it, expect, vi } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<void> {
  for (const command of commands) await device.executeCommand(command);
}

vi.setConfig({ testTimeout: 60_000 });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function lab(protocol: 'ospf' | 'rip' | 'bgp') {
  const clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const r1 = new CiscoRouter('R1', 200, 0);
  const far = new LinuxPC('linux-pc', 'FAR', 400, 0);
  new Cable('fgt-r1').connect(fw.getPort('port2')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('r1-far').connect(r1.getPort('GigabitEthernet0/1')!, far.getPorts()[0]);
  await type(fw, ['config system interface', 'edit port2', 'set ip 10.0.0.1 255.255.255.0', 'next', 'end',
    'config router static', 'edit 1', 'set dst 198.51.100.0 255.255.255.0', 'set gateway 10.0.0.2',
    'set device "port2"', 'next', 'end']);
  await type(r1, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 172.16.0.1 255.255.255.0', 'no shutdown', 'exit', 'end']);
  await type(far, ['sudo ip addr add 172.16.0.10/24 dev eth0', 'sudo ip link set eth0 up']);
  if (protocol === 'ospf') {
    await type(r1, ['configure terminal', 'router ospf 1', 'router-id 2.2.2.2',
      'network 10.0.0.0 0.0.0.255 area 0', 'network 172.16.0.0 0.0.0.255 area 0', 'end']);
    await type(fw, ['config router ospf', 'set router-id 1.1.1.1', 'config area', 'edit 0.0.0.0', 'next', 'end',
      'config network', 'edit 1', 'set prefix 10.0.0.0 255.255.255.0', 'set area 0.0.0.0', 'next', 'end', 'end']);
  }
  if (protocol === 'rip') {
    await type(r1, ['configure terminal', 'router rip', 'version 2', 'no auto-summary',
      'network 10.0.0.0', 'network 172.16.0.0', 'end']);
    await type(fw, ['config router rip', 'set version 2',
      'config network', 'edit 1', 'set prefix 10.0.0.0 255.255.255.0', 'next', 'end', 'end']);
  }
  if (protocol === 'bgp') {
    await type(r1, ['configure terminal', 'router bgp 65002', 'bgp router-id 2.2.2.2',
      'neighbor 10.0.0.1 remote-as 65001', 'network 172.16.0.0 mask 255.255.255.0', 'end']);
    await type(fw, ['config router bgp', 'set as 65001', 'set router-id 1.1.1.1',
      'config neighbor', 'edit "10.0.0.2"', 'set remote-as 65002', 'next', 'end', 'end']);
  }
  clock.advance(45_000);
  return { clock, fw, r1 };
}

const table = (fw: FortiGate) => fw.executeCommand('get router info routing-table all');

function ageOf(output: string, code: string, prefix: string): string | null {
  const line = output.split('\n').find((candidate) => candidate.startsWith(code) && candidate.includes(` ${prefix} `));
  return line?.match(/, ([0-9dhmw:]+)$/)?.[1] ?? null;
}

function seconds(age: string): number {
  const [hours, minutes, secs] = age.split(':').map(Number);
  return hours * 3600 + minutes * 60 + secs;
}

describe('learned routes carry their age on a FortiGate', () => {
  it('WITNESS: the firewall learns 172.16.0.0/24 over OSPF', async () => {
    const { fw } = await lab('ospf');
    expect(await table(fw)).toMatch(/^O\s+172\.16\.0\.0\/24 \[110\/\d+\] via 10\.0\.0\.2, port2/m);
  });

  it('an OSPF route ends with its age after the interface', async () => {
    const { clock, fw } = await lab('ospf');
    clock.advance(90_000);
    const age = ageOf(await table(fw), 'O', '172.16.0.0/24');
    expect(age).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(seconds(age!)).toBeGreaterThanOrEqual(90);
  });

  it('a route the reconvergence installs again unchanged keeps its age', async () => {
    const { clock, fw, r1 } = await lab('ospf');
    clock.advance(60_000);
    const before = seconds(ageOf(await table(fw), 'O', '172.16.0.0/24')!);
    await type(r1, ['configure terminal', 'interface Loopback5', 'ip address 203.0.113.1 255.255.255.255',
      'exit', 'router ospf 1', 'network 203.0.113.1 0.0.0.0 area 0', 'end']);
    clock.advance(30_000);
    const routes = await table(fw);
    expect(routes).toContain('203.0.113.1/32');
    expect(seconds(ageOf(routes, 'O', '172.16.0.0/24')!)).toBeGreaterThanOrEqual(before + 30);
  });

  it('a route that turns external at the same cost and next hop is a new route: its age restarts', async () => {
    const { clock, fw, r1 } = await lab('ospf');
    await type(r1, ['configure terminal', 'interface GigabitEthernet0/1', 'ip ospf cost 19', 'end']);
    clock.advance(120_000);
    expect(await table(fw)).toMatch(/^O\s+172\.16\.0\.0\/24 \[110\/20\] via 10\.0\.0\.2, port2, /m);
    await type(r1, ['configure terminal', 'router ospf 1', 'no network 172.16.0.0 0.0.0.255 area 0',
      'redistribute connected subnets', 'end']);
    clock.advance(30_000);
    const routes = await table(fw);
    expect(routes).toMatch(/^O E2\s+172\.16\.0\.0\/24 \[110\/20\] via 10\.0\.0\.2, port2, /m);
    expect(seconds(ageOf(routes, 'O E2', '172.16.0.0/24')!)).toBeLessThan(60);
  });

  it('a RIP route ages from its installation, not from its last refresh', async () => {
    const { clock, fw } = await lab('rip');
    clock.advance(300_000);
    expect(seconds(ageOf(await table(fw), 'R', '172.16.0.0/24')!)).toBeGreaterThanOrEqual(300);
  });

  it('a BGP route carries its age too', async () => {
    const { clock, fw } = await lab('bgp');
    clock.advance(90_000);
    expect(ageOf(await table(fw), 'B', '172.16.0.0/24')).toMatch(/^00:0[1-2]:\d\d$/);
  });

  it('past one day the age reads days, hours and minutes', async () => {
    const { clock, fw } = await lab('ospf');
    clock.advance(DAY + HOUR);
    expect(ageOf(await table(fw), 'O', '172.16.0.0/24')).toMatch(/^1d01h0\dm$/);
  });

  it('past one week the age reads weeks, days and hours', async () => {
    const { clock, fw } = await lab('rip');
    clock.advance(8 * DAY + HOUR);
    expect(ageOf(await table(fw), 'R', '172.16.0.0/24')).toMatch(/^01w1d01h$/);
  });

  it('static and connected routes carry no age', async () => {
    const { clock, fw } = await lab('ospf');
    clock.advance(90_000);
    const routes = await table(fw);
    expect(routes).toMatch(/^S\s+198\.51\.100\.0\/24 \[10\/0\] via 10\.0\.0\.2, port2$/m);
    expect(routes).toMatch(/^C\s+10\.0\.0\.0\/24 is directly connected, port2$/m);
  });

  it('the routing database prints the same age', async () => {
    const { clock, fw } = await lab('ospf');
    clock.advance(90_000);
    expect(await fw.executeCommand('get router info routing-table database'))
      .toMatch(/^O\s+\*> 172\.16\.0\.0\/24 \[110\/\d+\] via 10\.0\.0\.2, port2, 00:0[1-2]:\d\d$/m);
  });

  it('get router info bgp summary: past one day, Up/Down reads days, hours and minutes', async () => {
    const { clock, fw } = await lab('bgp');
    clock.advance(DAY + HOUR);
    expect(await fw.executeCommand('get router info bgp summary')).toMatch(/^10\.0\.0\.2 .* 1d01h0\dm /m);
  });
});
