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
 * Deux défauts du plan SVI sont apparus en pingant le lab livré, et se mesurent sur le même banc :
 *  - le ping résolvait l'ARP de la CIBLE au lieu du prochain saut : une cible derrière une passerelle n'était atteinte que
 *    si la passerelle répondait à l'ARP à sa place (proxy ARP) ;
 *  - la réponse d'écho à une source hors du sous-réseau partait en diffusion de niveau 2 (aucune entrée ARP pour cette source),
 *    donc une passerelle de type switch la jetait : `PC-WIN` n'atteignait pas `10.99.0.3` (la gestion de SW-HW) alors que
 *    SW-CORE y arrivait. La réponse suit désormais la route vers la source, comme le fait `tracert`.
 *
 * Le rendu de `ping` et de `tracert` est désormais UN module (`shells/huawei/huaweiPing.ts`) lu par le routeur et par
 * le switch : deux écritures d'un même format divergent, et le routeur gardait en plus deux gestionnaires IPv4 / IPv6.
 *
 * Discrimination `git stash` : 10 cas tombent avant le correctif — les sept `ping` / `tracert` du premier lab (« reaches the
 * router », « reaches a host behind the router », « reaches a host behind a gateway that does not answer ARP for it »,
 * « traces the path through the router », « reports the loss », « counts the packets », « goes through the pipe filter »),
 * « renders shutdown for a Vlanif the operator shut », et sur le lab à passerelle switch « answers a ping from a host beyond
 * its gateway » et « pings a host beyond its gateway ». Le cas « answers a ping… » tombe aussi avec la seule réponse d'écho
 * ancienne restaurée (mesure faite en la remettant dans l'arbre corrigé).
 *
 * Passent des deux côtés, et pourquoi :
 *  - « the router answers the switch » et « the gateway answers the switch » — TÉMOINS : prouvent que les deux labs (câble,
 *    VLAN, adresses) sont sains, donc qu'un échec des autres cas accuse la commande et non la topologie.
 *  - « refuses an IPv6 target » — NON-RÉGRESSION : avant, TOUTE saisie de `ping` était refusée avec ce même texte ; le
 *    cas fige que la commande, désormais connue, refuse encore ce que ce switch n'a pas de pile pour porter.
 *  - « a lifted Vlanif is not rendered shutdown » — NON-RÉGRESSION : le correctif écrit `shutdown` pour l'éteinte, il ne
 *    doit pas l'écrire pour la levée.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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

  it('ping reaches a host behind a gateway that does not answer ARP for it', async () => {
    const { huawei, router } = await lab();
    await play(router, ['configure terminal', 'interface GigabitEthernet0/0', 'no ip proxy-arp', 'end']);
    const output = await huawei.executeCommand('ping -c 2 198.51.100.10');
    expect(output).toContain('2 packet(s) transmitted, 2 packet(s) received, 0% packet loss');
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

async function behindALayer3Switch() {
  const core = new CiscoSwitch('switch-cisco', 'SW-CORE', 26, 0, 0);
  const huawei = new HuaweiSwitch('switch-huawei', 'SW-HW', 24, 0, 0);
  const host = new LinuxPC('linux-pc', 'HOST', 0, 0);
  for (const device of [core, huawei, host]) device.powerOn();
  new Cable('host').connect(host.getPort('eth0')!, core.getPort('FastEthernet0/1')!);
  new Cable('management').connect(huawei.getPort('GigabitEthernet0/0/1')!, core.getPort('FastEthernet0/2')!);
  await play(core, [
    'enable', 'configure terminal', 'ip routing', 'vlan 10', 'vlan 99', 'exit',
    'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 10',
    'interface FastEthernet0/2', 'switchport mode access', 'switchport access vlan 99',
    'interface Vlan10', 'ip address 10.10.0.1 255.255.255.0', 'no shutdown',
    'interface Vlan99', 'ip address 10.99.0.1 255.255.255.0', 'no shutdown', 'end',
  ]);
  await play(host, ['ip addr add 10.10.0.11/24 dev eth0', 'ip route add default via 10.10.0.1']);
  await play(huawei, [
    'system-view', 'vlan batch 99', 'interface GigabitEthernet0/0/1', 'port link-type access', 'port default vlan 99', 'quit',
    'interface Vlanif99', 'ip address 10.99.0.3 255.255.255.0', 'undo shutdown', 'quit',
    'ip route-static 0.0.0.0 0.0.0.0 10.99.0.1', 'return',
  ]);
  return { core, huawei, host };
}

describe('Probe — a Huawei switch behind a layer 3 switch', () => {
  it('TEMOIN: the gateway answers the switch', async () => {
    const { core } = await behindALayer3Switch();
    expect(await core.executeCommand('ping 10.99.0.3')).toContain('Success rate is 100 percent');
  }, 60_000);

  it('answers a ping from a host beyond its gateway', async () => {
    const { host } = await behindALayer3Switch();
    expect(await host.executeCommand('ping -c 2 10.99.0.3')).toContain('2 received');
  }, 60_000);

  it('pings a host beyond its gateway', async () => {
    const { huawei } = await behindALayer3Switch();
    expect(await huawei.executeCommand('ping -c 2 10.10.0.11'))
      .toContain('2 packet(s) transmitted, 2 packet(s) received, 0% packet loss');
  }, 60_000);
});
