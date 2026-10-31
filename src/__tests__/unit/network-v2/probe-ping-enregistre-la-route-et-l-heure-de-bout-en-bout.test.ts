/**
 * `ping -R` et `ping -T` (iputils) et `ping -r` / `-s` (Windows) construisent l'option IP, les equipements du trajet y
 * ecrivent, et le client relit celle de la reponse. Mesure de depart :
 *  - sur la machine Linux, `-R` et `-T` etaient refuses (« this simulator cannot build the IP record-route option ») ;
 *  - sous Windows, `-r N` deduisait la route d'un traceroute et `-s N` affichait un nombre invente, aucun paquet ne portait
 *    l'option (le TODO [ip] le consignait).
 * La regle des extremites suit le noyau Linux (net/ipv4/ip_options.c) pour une machine Linux : l'emetteur ecrit sa propre
 * adresse a l'emission et a la reception, la cible deux fois (`ip_options_compile` a l'arrivee, `ip_options_echo` au depart
 * de la reponse), d'ou les huit adresses de `ping -R` a travers deux routeurs. Les autres piles gardent la regle de la
 * RFC 1122 §3.2.2.6 (la cible s'ecrit une fois). Le rendu suit `pr_options` d'iputils (ping/ping.c).
 *
 * Discrimine par `git stash` sur src/network : les 8 cas tombent avant (option refusee, route deduite d'un traceroute au lieu
 * de la reponse, ou prefixe `ping -D` pris sur l'heure du simulateur). Aucun TEMOIN ici : le laboratoire est celui de probe-option-timestamp-ipv4, deja verifie.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); EquipmentRegistry.resetInstance();
});

async function type(d: { executeCommand(cmd: string): Promise<string> }, cmds: readonly string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

async function routers() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const b = new LinuxPC('linux-pc', 'B', 200, 0);
  new Cable('r1-r2').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('r2-b').connect(r2.getPort('GigabitEthernet0/1')!, b.getPort('eth0')!);
  await type(r1, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 10.0.2.0 255.255.255.0 10.0.1.2', 'end']);
  await type(r2, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.1.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 10.0.0.0 255.255.255.0 10.0.1.1', 'end']);
  await type(b, ['ip link set eth0 up', 'ip addr add 10.0.2.10/24 dev eth0', 'ip route add default via 10.0.2.1']);
  return { r1, r2, b };
}

async function linuxLab() {
  const { r1 } = await routers();
  const a = new LinuxPC('linux-pc', 'A', -200, 0);
  new Cable('a-r1').connect(a.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  await type(a, ['ip link set eth0 up', 'ip addr add 10.0.0.10/24 dev eth0', 'ip route add default via 10.0.0.1']);
  await a.executeCommand('ping -c 1 10.0.2.10');
  return a;
}

describe('ping -R / -T sur une machine Linux', () => {
  it('-R rend les huit adresses du noyau a travers deux routeurs, puis « (same route) »', async () => {
    const a = await linuxLab();
    const out = String(await a.executeCommand('ping -R -c 2 -n 10.0.2.10')).split('\n');
    expect(out[0]).toBe('PING 10.0.2.10 (10.0.2.10) 56(124) bytes of data.');
    const at = out.findIndex(l => l.startsWith('RR: '));
    expect(out.slice(at, at + 8)).toEqual([
      'RR: \t10.0.0.10', '\t10.0.1.1', '\t10.0.2.1', '\t10.0.2.10', '\t10.0.2.10', '\t10.0.1.2', '\t10.0.0.1', '\t10.0.0.10',
    ]);
    expect(out[at + 8]).toBe('');
    expect(out.find(l => l.includes('icmp_seq=2'))).toMatch(/\t\(same route\)$/);
  });

  it('-T tsandaddr rend adresse et heure, la place manquante est comptee', async () => {
    const a = await linuxLab();
    const out = String(await a.executeCommand('ping -T tsandaddr -c 1 -n 10.0.2.10')).split('\n');
    const at = out.findIndex(l => l.startsWith('TS: '));
    expect(out[at]).toMatch(/^TS: \t10\.0\.0\.10\t\d+ absolute$/);
    expect(out.slice(at + 1, at + 4).map(l => l.split('\t')[1])).toEqual(['10.0.1.1', '10.0.2.1', '10.0.2.10']);
    expect(out[at + 4]).toBe('Unrecorded hops: 4');
  });

  it('-T tsonly rend des heures seules, la premiere en valeur absolue et les suivantes en ecarts', async () => {
    const a = await linuxLab();
    const out = String(await a.executeCommand('ping -T tsonly -c 1 -n 10.0.2.10')).split('\n');
    const at = out.findIndex(l => l.startsWith('TS: '));
    expect(out[at]).toMatch(/^TS: \t\d+ absolute$/);
    expect(out[at + 1]).toMatch(/^\t\d+$/);
  });

  it('-T tsprespec ne pose l heure que chez l equipement nomme', async () => {
    const a = await linuxLab();
    const out = String(await a.executeCommand('ping -T tsprespec -c 1 -n 10.0.1.1 10.0.2.10')).split('\n');
    const at = out.findIndex(l => l.startsWith('TS: '));
    expect(out[at]).toMatch(/^TS: \t10\.0\.1\.1\t\d+ absolute$/);
  });

  it('refuse -R avec -T et un type inconnu, dans les mots d iputils', async () => {
    const a = await linuxLab();
    expect(await a.executeCommand('ping -R -T tsonly 10.0.2.10')).toBe('ping: only one of -T or -R may be used');
    expect(await a.executeCommand('ping -T bad 10.0.2.10')).toBe('ping: invalid timestamp type: bad');
  });
});

describe('ping -r / -s sous Windows', () => {
  async function windowsLab() {
    const { r1 } = await routers();
    const pc = new WindowsPC('windows-pc', 'W', 0, 0);
    new Cable('w-r1').connect(pc.getPorts()[0], r1.getPort('GigabitEthernet0/0')!);
    await pc.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.10 255.255.255.0 10.0.0.1');
    await pc.executeCommand('ping -n 1 10.0.2.10');
    return pc;
  }

  it('-r 3 relit les trois premiers equipements du trajet dans la reponse', async () => {
    const pc = await windowsLab();
    const out = String(await pc.executeCommand('ping -n 1 -r 3 10.0.2.10')).split('\n');
    const at = out.indexOf('Route:');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(out.slice(at + 1, at + 4)).toEqual(['    10.0.1.1', '    10.0.2.1', '    10.0.2.10']);
  });

  it('-s 4 relit adresse et heure de chaque equipement', async () => {
    const pc = await windowsLab();
    const out = String(await pc.executeCommand('ping -n 1 -s 4 10.0.2.10')).split('\n');
    const at = out.indexOf('Timestamp:');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(out.slice(at + 1, at + 4).map(l => l.trim().split(' : ')[0])).toEqual(['10.0.1.1', '10.0.2.1', '10.0.2.10']);
    expect(out[at + 1]).toMatch(/^ {4}10\.0\.1\.1 : \d+$/);
  });
});

describe('ping -D prefixes the lines with the machine clock', () => {
  it('prints the epoch seconds of the date that was set, not the simulator date', async () => {
    const a = await linuxLab();
    await a.executeCommand('sudo date -s "2027-03-15 09:30:00"');
    const out = String(await a.executeCommand('ping -D -c 1 -n 10.0.2.10'));
    const stamp = Number(/^\[(\d+)\.\d+\] /m.exec(out)?.[1]);
    expect(Math.abs(stamp - Date.UTC(2027, 2, 15, 9, 30, 0) / 1000)).toBeLessThan(120);
  });
});
