/**
 * Une horloge par machine, qui suit l'ordonnanceur.
 *
 * Mesure de depart (7d9c2b40), dans un laboratoire en temps virtuel :
 * apres 1 h 02 min 03 s, `show clock` et `display clock` des routeurs et
 * commutateurs Cisco et Huawei n'avaient pas bouge ; `show version`
 * annoncait toujours « uptime is 0 minutes », `display version`
 * « 0 days, 0 hours, 0 minutes » (une constante), et l'uptime de la
 * FortiGate restait nul alors que son heure systeme avancait. Apres
 * `clock set 10:00:00 1 Jan 2030`, `show ip dhcp binding` datait le bail
 * du jour reel, en contradiction avec `show clock` ; un bail echu ne
 * l'etait jamais sur un routeur ; un `reload` ne remettait pas l'uptime a
 * zero ; et `show reload` decomptait sur l'horloge murale un delai que
 * l'ordonnanceur decomptait de son cote.
 *
 * Autorites :
 * - `show ip dhcp binding` : capture IOS-XE de genieparser
 *   (`ShowIpDhcpBinding/golden_output1_output.txt`) pour l'echeance
 *   « Feb 08 2022 11:11 AM » et le type « Automatic » ; capture IOS de
 *   ntc-templates (`cisco_ios_show_ip_dhcp_binding.raw`) pour « Manual »
 *   et « Infinite » ;
 * - `display version` : captures VRP5 de ntc-templates
 *   (`huawei_vrp_display_version3.raw` a `6.raw`) — « Huawei AR6280 Router
 *   uptime is 60 weeks, 4 days, 11 hours, 20 minutes », « 0 week, 0 day,
 *   0 hour, 3 minutes » — et, pour un S5720, la documentation Huawei
 *   (« HUAWEI S5720-56C-HI-AC Routing Switch uptime is 0 week, 0 day,
 *   21 hours, 7 minutes »).
 *
 * Discrimination, mesuree sur le commit de base (7d9c2b40) avec ce
 * fichier copie : 11 des 13 cas tombent. Passent des deux cotes : le
 * TEMOIN (un client obtient un bail du routeur) et « before the lease
 * runs out », une absence que la base tient parce que rien n'y expirait,
 * et qui garde que l'echeance n'arrive pas trop tot. Le cas du `reload`
 * est mene sous minuteurs factices, ou l'horloge murale de la base avance
 * aussi : il y tombe sur la remise a zero seule.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<void> {
  for (const command of commands) await device.executeCommand(command);
}

const ONE_HOUR_TWO_MINUTES_THREE_SECONDS = 3_723_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function iosClockMs(text: string): number {
  const m = /(\d\d):(\d\d):(\d\d)\.\d+ \S+ \w+ (\w+) (\d+) (\d+)/.exec(text);
  if (!m) throw new Error(`not an IOS clock: ${text}`);
  return Date.UTC(Number(m[6]), MONTHS.indexOf(m[4]), Number(m[5]), Number(m[1]), Number(m[2]), Number(m[3]));
}

function vrpClockMs(text: string): number {
  const m = /(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(text);
  if (!m) throw new Error(`not a VRP clock: ${text}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function lineWith(text: string, needle: string): string {
  return text.split('\n').find((line) => line.includes(needle)) ?? '';
}

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

afterEach(() => { vi.useRealTimers(); });

describe('the calendar clock moves with the time that passes on the machine', () => {
  it('show clock on a Cisco router', async () => {
    const router = new CiscoRouter('R1', 0, 0);
    const before = iosClockMs(await router.executeCommand('show clock'));
    clock.advance(ONE_HOUR_TWO_MINUTES_THREE_SECONDS);
    const after = iosClockMs(await router.executeCommand('show clock'));
    expect(after - before).toBe(ONE_HOUR_TWO_MINUTES_THREE_SECONDS);
  });

  it('show clock on a Cisco switch', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 0, 0);
    const before = iosClockMs(await sw.executeCommand('show clock'));
    clock.advance(ONE_HOUR_TWO_MINUTES_THREE_SECONDS);
    const after = iosClockMs(await sw.executeCommand('show clock'));
    expect(after - before).toBe(ONE_HOUR_TWO_MINUTES_THREE_SECONDS);
  });

  it('display clock on a Huawei router', async () => {
    const router = new HuaweiRouter('AR1', 0, 0);
    const before = vrpClockMs(await router.executeCommand('display clock'));
    clock.advance(ONE_HOUR_TWO_MINUTES_THREE_SECONDS);
    const after = vrpClockMs(await router.executeCommand('display clock'));
    expect(after - before).toBe(ONE_HOUR_TWO_MINUTES_THREE_SECONDS);
  });
});

describe('uptime is the time the machine has been up', () => {
  it('show version on a Cisco router', async () => {
    const router = new CiscoRouter('R1', 0, 0);
    clock.advance(ONE_HOUR_TWO_MINUTES_THREE_SECONDS);
    expect(lineWith(await router.executeCommand('show version'), 'uptime is'))
      .toBe('R1 uptime is 1 hour, 2 minutes');
  });

  it('display version on a Huawei router names the product and counts weeks, days, hours and minutes', async () => {
    const router = new HuaweiRouter('AR1', 0, 0);
    clock.advance(ONE_HOUR_TWO_MINUTES_THREE_SECONDS);
    expect(lineWith(await router.executeCommand('display version'), 'uptime is'))
      .toBe('Huawei AR2220 Router uptime is 0 week, 0 day, 1 hour, 2 minutes');
  });

  it('display version on a Huawei switch', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW2', 0, 0);
    clock.advance(8 * 86_400_000 + 2 * 3_600_000 + 60_000);
    expect(lineWith(await sw.executeCommand('display version'), 'uptime is'))
      .toBe('HUAWEI S5720-28X-LI-AC Routing Switch uptime is 1 week, 1 day, 2 hours, 1 minute');
  });

  it('get system performance status on a FortiGate', async () => {
    const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    clock.advance(ONE_HOUR_TWO_MINUTES_THREE_SECONDS);
    expect(lineWith(await firewall.executeCommand('get system performance status'), 'Uptime:'))
      .toBe('Uptime: 0 days, 1 hours, 2 minutes');
  });

  it('a reload starts the count again', async () => {
    __setDefaultScheduler(null);
    vi.useFakeTimers();
    const router = new CiscoRouter('R1', 0, 0);
    await router.executeCommand('enable');
    vi.advanceTimersByTime(2 * 3_600_000);
    expect(lineWith(await router.executeCommand('show version'), 'uptime is')).toMatch(/^R1 uptime is 2 hours/);
    await router.executeCommand('reload');
    expect(lineWith(await router.executeCommand('show version'), 'uptime is')).toBe('R1 uptime is 0 minutes');
  });

  it('show reload counts down on the clock that fires the reload', async () => {
    const router = new CiscoRouter('R1', 0, 0);
    await type(router, ['enable', 'reload in 10']);
    clock.advance(4 * 60_000);
    expect(await router.executeCommand('show reload')).toBe('Reload scheduled in 6 minutes 0 seconds');
  });
});

async function dhcpLab(lease: string, range: 'one-address' | 'whole-subnet' = 'whole-subnet') {
  const router = new CiscoRouter('R1', 0, 0);
  const lan = new CiscoSwitch('switch-cisco', 'LAN', 100, 0);
  new Cable('r1-lan').connect(router.getPort('GigabitEthernet0/0')!, lan.getPorts()[0]);
  await type(router, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit',
    'ip dhcp excluded-address 192.168.1.1 192.168.1.99',
    ...(range === 'one-address' ? ['ip dhcp excluded-address 192.168.1.101 192.168.1.254'] : []),
    'ip dhcp pool LAN', 'network 192.168.1.0 255.255.255.0', lease, 'end']);
  let nextPort = 1;
  const lease4 = async (name: string) => {
    const host = new LinuxPC('linux-pc', name);
    const cable = new Cable(`lan-${nextPort}`);
    cable.connect(host.getPorts()[0], lan.getPorts()[nextPort]);
    nextPort += 1;
    await host.executeCommand('sudo dhclient eth0');
    const address = /inet (\d+\.\d+\.\d+\.\d+)/.exec(await host.executeCommand('ip -4 addr show eth0'))?.[1];
    return { cable, address };
  };
  return { router, lease4 };
}

describe('a router DHCP lease lives on the router clock', () => {
  it('WITNESS: a client obtains a lease from the router pool', async () => {
    const { lease4 } = await dhcpLab('lease 1');
    expect((await lease4('A')).address).toBe('192.168.1.100');
  });

  it('show ip dhcp binding dates the lease on the clock show clock reads, as IOS writes it', async () => {
    const { router, lease4 } = await dhcpLab('lease 1');
    await router.executeCommand('clock set 10:00:00 1 Jan 2030');
    await lease4('A');
    expect(lineWith(await router.executeCommand('show ip dhcp binding'), '192.168.1.100'))
      .toMatch(/^192\.168\.1\.100\s+\S+\s+Jan 02 2030 10:00 AM\s+Automatic$/);
  });

  it('before the lease runs out, the address of an unplugged client is not offered again', async () => {
    const { lease4 } = await dhcpLab('lease 0 0 5', 'one-address');
    (await lease4('A')).cable.disconnect();
    clock.advance(2 * 60_000);
    expect((await lease4('B')).address).toBeUndefined();
  });

  it('once the lease has run out, the same address goes to the next client', async () => {
    const { lease4 } = await dhcpLab('lease 0 0 5', 'one-address');
    (await lease4('A')).cable.disconnect();
    clock.advance(10 * 60_000);
    expect((await lease4('B')).address).toBe('192.168.1.100');
  });
});
