/**
 * Sonde — un switch Cisco porte un port routé (`no switchport`).
 *
 * Mesure d'origine (lab NTP, lien SW-CORE vers le routeur de bordure) : `no switchport` rendait `% Incomplete command.`
 * et `ip address` sur un port physique rendait `% IP addresses may not be configured on L2 links.` — le switch ne savait
 * pas faire un port L3, le lien routeur passait par un VLAN de transit.
 *
 * Le port routé est celui d'IOS : un VLAN INTERNE (à partir de 1006), caché de `show vlan`, porté par une interface L3 liée
 * au port physique. Le plan SVI existant (ARP, routage, ping, traceroute, relais DHCP) est réutilisé tel quel ; ce qui change
 * est le NOM sous lequel chaque vue la montre : le port, jamais `Vlan1006`.
 *
 * Discrimination `git stash` : 12 cas tombent avant le correctif — tous ceux de « a routed port » sauf le dernier.
 *
 * Passent des deux côtés, et pourquoi :
 *  - « the uplink is connected on a switched port » — TÉMOIN : prouve que le lab (câble, adresses) est sain, donc qu'un
 *    échec des cas routés accuse le port routé et non la topologie.
 *  - « L2 commands stay available on a switched port » — NON-RÉGRESSION : le refus de `switchport ...` ne vaut que pour un
 *    port routé.
 *  - « turns back into a switched port with `switchport` » — NON-RÉGRESSION : avant le correctif le port ne quittait jamais
 *    le niveau 2 ; le cas fige que le retour à `switchport` laisse un port commuté sain, sans adresse et sans `no switchport`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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

async function play(device: Cli, lines: string[]): Promise<string[]> {
  const answers: string[] = [];
  for (const line of lines) answers.push(await device.executeCommand(line));
  return answers;
}

const PORT = 'FastEthernet0/1';

async function lab(routed = true) {
  const switchCore = new CiscoSwitch('switch-cisco', 'SW-CORE', 26, 0, 0);
  const router = new CiscoRouter('R-EDGE', 0, 0);
  const host = new LinuxPC('linux-pc', 'HOST', 0, 0);
  for (const device of [switchCore, router, host]) device.powerOn();
  new Cable('uplink').connect(router.getPort('GigabitEthernet0/0')!, switchCore.getPort(PORT)!);
  new Cable('lan').connect(router.getPort('GigabitEthernet0/1')!, host.getPort('eth0')!);
  await play(router, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown',
    'interface GigabitEthernet0/1', 'ip address 198.51.100.1 255.255.255.0', 'no shutdown',
    'exit', 'ip route 10.0.0.0 255.0.0.0 10.0.0.2', 'end',
  ]);
  await play(host, ['ip addr add 198.51.100.10/24 dev eth0', 'ip route add default via 198.51.100.1']);
  await play(switchCore, [
    'enable', 'configure terminal', 'ip routing', `interface ${PORT}`,
    ...(routed ? ['no switchport', 'ip address 10.0.0.2 255.255.255.252'] : []),
    'no shutdown', 'exit', 'ip route 0.0.0.0 0.0.0.0 10.0.0.1', 'end',
  ]);
  return { switchCore, router, host };
}

describe('Probe — a switched port, the witness', () => {
  it('TEMOIN: the uplink is connected on a switched port', async () => {
    const { switchCore } = await lab(false);
    expect(await switchCore.executeCommand('show interfaces status')).toMatch(/Fa0\/1\s+connected\s+1\s/);
  }, 60_000);

  it('L2 commands stay available on a switched port', async () => {
    const { switchCore } = await lab(false);
    const answers = await play(switchCore, ['configure terminal', `interface ${PORT}`, 'switchport mode access', 'switchport access vlan 10']);
    expect(answers[2]).toBe('');
    expect(answers[3]).toBe('');
  }, 60_000);
});

describe('Probe — a routed port', () => {
  it('accepts an address and talks to its neighbour', async () => {
    const { switchCore } = await lab();
    expect(await switchCore.executeCommand('ping 10.0.0.1')).toContain('Success rate is 100 percent');
  }, 60_000);

  it('is reached from the neighbour', async () => {
    const { router } = await lab();
    expect(await router.executeCommand('ping 10.0.0.2')).toMatch(/Success rate is (80|100) percent/);
  }, 60_000);

  it('routes towards the network behind the neighbour', async () => {
    const { switchCore } = await lab();
    expect(await switchCore.executeCommand('ping 198.51.100.10')).toContain('Success rate is 100 percent');
  }, 60_000);

  it('carries the traffic of a host across the switch', async () => {
    const { host } = await lab();
    expect(await host.executeCommand('ping -c 1 10.0.0.2')).toContain('1 received');
  }, 60_000);

  it('is written in the running configuration as a routed port', async () => {
    const { switchCore } = await lab();
    const block = await switchCore.executeCommand(`show running-config interface ${PORT}`);
    expect(block).toContain(' no switchport\n ip address 10.0.0.2 255.255.255.252');
    expect(block).not.toContain('switchport access vlan');
  }, 60_000);

  it('shows its address under its own name in the interface summary', async () => {
    const { switchCore } = await lab();
    const brief = await switchCore.executeCommand('show ip interface brief');
    expect(brief).toMatch(/FastEthernet0\/1\s+10\.0\.0\.2\s+YES manual up\s+up/);
    expect(brief).not.toMatch(/Vlan1006/);
  }, 60_000);

  it('is listed as routed, with no switchport', async () => {
    const { switchCore } = await lab();
    expect(await switchCore.executeCommand('show interfaces status')).toMatch(/Fa0\/1\s+connected\s+routed/);
    expect(await switchCore.executeCommand(`show interfaces ${PORT} switchport`)).toContain('Switchport: Disabled');
  }, 60_000);

  it('appears in the routing table under the port name', async () => {
    const { switchCore } = await lab();
    const table = await switchCore.executeCommand('show ip route');
    expect(table).toContain('C        10.0.0.0/30 is directly connected, FastEthernet0/1');
    expect(table).toContain('L        10.0.0.2/32 is directly connected, FastEthernet0/1');
  }, 60_000);

  it('is absent from the VLAN table', async () => {
    const { switchCore } = await lab();
    const vlans = await switchCore.executeCommand('show vlan brief');
    expect(vlans).not.toContain('Fa0/1,');
    expect(vlans).not.toContain('1006');
  }, 60_000);

  it('appears in the ARP table under the port name', async () => {
    const { switchCore } = await lab();
    await switchCore.executeCommand('ping 10.0.0.1');
    expect(await switchCore.executeCommand('show ip arp')).toMatch(/Internet\s+10\.0\.0\.1\s+\d+\s+[0-9a-f.]+\s+ARPA\s+FastEthernet0\/1/);
  }, 60_000);

  it('refuses the layer 2 commands, which a routed port does not carry', async () => {
    const { switchCore } = await lab();
    const answers = await play(switchCore, ['configure terminal', `interface ${PORT}`, 'switchport mode access']);
    expect(answers[2]).toBe("% Invalid input detected at '^' marker.");
  }, 60_000);

  it('goes down with the port and its address stays configured', async () => {
    const { switchCore } = await lab();
    await play(switchCore, ['configure terminal', `interface ${PORT}`, 'shutdown', 'end']);
    expect(await switchCore.executeCommand('show ip interface brief'))
      .toMatch(/FastEthernet0\/1\s+10\.0\.0\.2\s+YES manual administratively down\s+down/);
    expect(await switchCore.executeCommand('ping 10.0.0.1')).toContain('Success rate is 0 percent');
  }, 60_000);

  it('turns back into a switched port with `switchport`, address gone', async () => {
    const { switchCore } = await lab();
    await play(switchCore, ['configure terminal', `interface ${PORT}`, 'switchport', 'end']);
    expect(await switchCore.executeCommand(`show running-config interface ${PORT}`)).not.toContain('no switchport');
    expect(await switchCore.executeCommand('show ip interface brief')).toMatch(/FastEthernet0\/1\s+unassigned/);
    expect(await switchCore.executeCommand('show vlan brief')).toContain('Fa0/1');
  }, 60_000);
});
