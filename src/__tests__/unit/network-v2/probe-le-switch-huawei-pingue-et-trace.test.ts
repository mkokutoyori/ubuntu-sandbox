/**
 * Sonde — un switch Huawei pingue et trace depuis sa propre interface VLAN, et `display current-configuration` dit
 * `shutdown` pour une interface VLAN éteinte.
 *
 * Mesure d'origine (exercice 0 du tutoriel NTP, test 5 : `ping` depuis SW-HW vers le routeur) :
 *  - `HuaweiSwitchShell` n'enregistrait ni `ping` ni `tracert` (seul `HuaweiVRPShell` le faisait) : la saisie rendait
 *    `Error: Unrecognized command found at '^' position.` sur un S5700 qui possède les deux commandes ;
 *  - `Switch` n'avait pas de traceroute : seul l'écho existait, sans moyen de lire les ICMP d'erreur (TTL épuisé,
 *    destination injoignable) qui reviennent à l'interface VLAN ;
 *  - une interface VLAN éteinte par l'opérateur (`shutdown`) était rendue sans `shutdown` : un export suivi d'un import la
 *    levait (`*down` devenait `down`).
 *
 * Le rendu de `ping` et de `tracert` est désormais UN module (`shells/huawei/huaweiPing.ts`) lu par le routeur et par
 * le switch : deux écritures d'un même format divergent, et le routeur gardait en plus deux gestionnaires IPv4 / IPv6.
 *
 * Discrimination `git stash` : 7 cas tombent avant le correctif — les six `ping` / `tracert` (« reaches the router »,
 * « reaches a host behind the router », « traces the path through the router », « reports the loss », « counts the
 * packets », « goes through the pipe filter ») et « renders shutdown for a Vlanif the operator shut ».
 *
 * Passent des deux côtés, et pourquoi :
 *  - « the router answers the switch » — TÉMOIN : prouve que le lab est sain (câble, VLAN, adresses), donc qu'un échec
 *    des cas ci-dessus accuse la commande et non la topologie.
 *  - « refuses an IPv6 target » — NON-RÉGRESSION : avant, TOUTE saisie de `ping` était refusée avec ce même texte ; le
 *    cas fige que la commande, désormais connue, refuse encore ce que ce switch n'a pas de pile pour porter.
 *  - « a lifted Vlanif is not rendered shutdown » — NON-RÉGRESSION : le correctif écrit `shutdown` pour l'éteinte, il ne
 *    doit pas l'écrire pour la levée.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

type Cli = { executeCommand(command: string): Promise<string> };

async function play(device: Cli, lines: string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

async function lab() {
  const huawei = new HuaweiSwitch('switch-huawei', 'SW-HW', 24, 0, 0);
  const router = new CiscoRouter('R', 0, 0);
  const host = new LinuxPC('linux-pc', 'HOST', 0, 0);
  for (const device of [huawei, router, host]) device.powerOn();
  new Cable('uplink').connect(router.getPort('GigabitEthernet0/0')!, huawei.getPort('GigabitEthernet0/0/1')!);
  new Cable('lan').connect(router.getPort('GigabitEthernet0/1')!, host.getPort('eth0')!);
  await play(router, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown',
    'interface GigabitEthernet0/1', 'ip address 198.51.100.1 255.255.255.0', 'no shutdown',
    'exit', 'ip route 10.0.0.0 255.0.0.0 10.0.0.2', 'end',
  ]);
  await play(host, ['ip addr add 198.51.100.10/24 dev eth0', 'ip route add default via 198.51.100.1']);
  await play(huawei, [
    'system-view', 'interface Vlanif1', 'ip address 10.0.0.2 255.255.255.252', 'undo shutdown', 'quit',
    'ip route-static 0.0.0.0 0.0.0.0 10.0.0.1', 'return',
  ]);
  return { huawei, router, host };
}

describe('Probe — a Huawei switch pings and traces from its VLAN interface', () => {
  it('TEMOIN: the router answers the switch', async () => {
    const { router } = await lab();
    expect(await router.executeCommand('ping 10.0.0.2')).toMatch(/Success rate is (80|100) percent/);
  }, 60_000);

  it('ping reaches the router', async () => {
    const { huawei } = await lab();
    const output = await huawei.executeCommand('ping -c 2 10.0.0.1');
    expect(output).toContain('Reply from 10.0.0.1: bytes=56 Sequence=1');
    expect(output).toContain('2 packet(s) transmitted, 2 packet(s) received, 0% packet loss');
  }, 60_000);

  it('ping reaches a host behind the router', async () => {
    const { huawei } = await lab();
    const output = await huawei.executeCommand('ping -c 2 198.51.100.10');
    expect(output).toContain('Reply from 198.51.100.10: bytes=56 Sequence=2');
  }, 60_000);

  it('tracert traces the path through the router', async () => {
    const { huawei } = await lab();
    const output = await huawei.executeCommand('tracert 198.51.100.10');
    expect(output).toMatch(/tracert to 198\.51\.100\.10/);
    expect(output).toMatch(/ 1 10\.0\.0\.1 /);
    expect(output).toMatch(/ 2 198\.51\.100\.10 /);
  }, 60_000);

  it('ping reports the loss for an address nobody holds', async () => {
    const { huawei } = await lab();
    const output = await huawei.executeCommand('ping -c 2 198.51.100.99');
    expect(output).toContain('Request timeout');
    expect(output).toContain('2 packet(s) transmitted, 0 packet(s) received, 100% packet loss');
  }, 60_000);

  it('ping counts the packets it was asked to send', async () => {
    const { huawei } = await lab();
    expect(await huawei.executeCommand('ping -c 3 10.0.0.1'))
      .toContain('3 packet(s) transmitted, 3 packet(s) received');
  }, 60_000);

  it('ping output goes through the pipe filter', async () => {
    const { huawei } = await lab();
    expect(await huawei.executeCommand('ping -c 2 10.0.0.1 | include received'))
      .toBe('2 packet(s) transmitted, 2 packet(s) received, 0% packet loss');
  }, 60_000);

  it('ping refuses an IPv6 target, which this switch has no stack for', async () => {
    const { huawei } = await lab();
    expect(await huawei.executeCommand('ping ipv6 ::1'))
      .toContain("Unrecognized command found at '^' position.");
  }, 60_000);
});

describe('Probe — display current-configuration renders the VLAN interface state', () => {
  it('renders shutdown for a Vlanif the operator shut', async () => {
    const huawei = new HuaweiSwitch('switch-huawei', 'SW-HW', 24, 0, 0);
    huawei.powerOn();
    await play(huawei, ['system-view', 'interface Vlanif1', 'shutdown', 'quit', 'return']);
    const configuration = await huawei.executeCommand('display current-configuration');
    expect(configuration).toMatch(/interface Vlanif1\n shutdown\n/);
  }, 60_000);

  it('a lifted Vlanif is not rendered shutdown', async () => {
    const huawei = new HuaweiSwitch('switch-huawei', 'SW-HW', 24, 0, 0);
    huawei.powerOn();
    await play(huawei, ['system-view', 'interface Vlanif1', 'shutdown', 'undo shutdown', 'quit', 'return']);
    const configuration = await huawei.executeCommand('display current-configuration');
    expect(configuration).not.toMatch(/interface Vlanif1\n shutdown/);
  }, 60_000);
});
