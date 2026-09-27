/**
 * Un commutateur de niveau 3 vieillit l'ARP de ses SVI selon le delai de
 * la SVI, et `show ip arp` les nomme.
 *
 * Mesure de depart (0ec365c1) : sur un Catalyst, `arp timeout` tape sous
 * `interface Vlan1` etait lu comme `arp <ip>` et refuse
 * (« % Invalid IP address "timeout" ») ; `show interfaces Vlan1`
 * imprimait une constante 04:00:00 ; `show ip arp` rangeait le voisin
 * sous le port physique (FastEthernet0/1) au lieu de la SVI, omettait
 * l'adresse de la SVI elle-meme, et `show ip arp vlan 1` ne trouvait donc
 * jamais rien. Sur un commutateur Huawei, `arp expire-time` etait refuse
 * dans une Vlanif. Le vieillissement suivait le seul delai de la
 * plateforme.
 *
 * Autorites :
 * - captures IOS de ntc-templates (`cisco_ios_show_arp.raw`) et de
 *   genieparser (`ShowArp/golden_output_output.txt`) : une entree apprise
 *   par une SVI est rangee sous `Vlan10`, `Vlan100`, et l'adresse de la
 *   SVI y figure avec l'age `-` ;
 * - reference de commandes Cisco IOS, `arp timeout` : « This command is
 *   ignored when issued on interfaces that do not use ARP » — un port de
 *   commutation l'accepte sans effet ;
 * - reference de commandes Huawei, `arp expire-time` : 60 a 86400 s,
 *   1200 par defaut, sur une interface de niveau 3 ;
 * - capture VRP de ntc-templates (`huawei_vrp_display_arp_all.raw`) : sur
 *   un commutateur, la colonne INTERFACE garde le port physique (le VLAN
 *   s'imprime dessous), ce que la vue garde.
 *
 * Discrimination, mesuree sur le commit de base (0ec365c1) avec ce
 * fichier copie : 8 des 12 cas tombent. Passent des deux cotes : le
 * TEMOIN (le Catalyst apprend son voisin) ; « the IOS default keeps the
 * entry past ten minutes », qui garde que l'echeance n'arrive pas trop
 * tot ; « the VRP default of twenty minutes applies », parce que le
 * commit de base vieillit deja l'ARP du commutateur au delai de sa
 * plateforme — le cas garde que la SVI sans reglage le conserve ; et
 * « no arp timeout restores four hours », parce que la base refusait
 * `arp timeout` sur une SVI, qui ne quittait donc jamais 04:00:00 — il ne
 * discrimine qu'avec le cas de la running-config, qui prouve que la
 * valeur a bien ete posee.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<string[]> {
  const outputs: string[] = [];
  for (const command of commands) outputs.push(await device.executeCommand(command));
  return outputs;
}

const MINUTE = 60_000;
let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

async function neighbour(port: Parameters<Cable['connect']>[0]): Promise<void> {
  const pc = new LinuxPC('linux-pc', 'PC');
  new Cable('sw-pc').connect(port, pc.getPorts()[0]);
  await type(pc, ['sudo ip addr add 10.0.0.2/24 dev eth0', 'sudo ip link set eth0 up', 'ping -c 1 10.0.0.1']);
}

async function catalyst(svi: readonly string[] = []): Promise<CiscoSwitch> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 24, 0, 0);
  await type(sw, ['enable', 'configure terminal', 'ip routing', 'interface Vlan1',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', ...svi, 'end']);
  await neighbour(sw.getPort('FastEthernet0/1')!);
  return sw;
}

function row(table: string, address: string): string | undefined {
  return table.split('\n').find((line) => line.split(/\s+/)[1] === address);
}

describe('Catalyst: the ARP of an SVI belongs to the SVI', () => {
  it('WITNESS: the switch learns its neighbour', async () => {
    const sw = await catalyst();
    expect(row(await sw.executeCommand('show ip arp'), '10.0.0.2')).toBeDefined();
  });

  it('show ip arp files the neighbour under Vlan1', async () => {
    const sw = await catalyst();
    expect(row(await sw.executeCommand('show ip arp'), '10.0.0.2')).toMatch(/\sVlan1$/);
  });

  it('show ip arp lists the address of the SVI itself, with no age', async () => {
    const sw = await catalyst();
    expect(row(await sw.executeCommand('show ip arp'), '10.0.0.1')).toMatch(/^Internet\s+10\.0\.0\.1\s+-\s+\S+\s+ARPA\s+Vlan1$/);
  });

  it('show ip arp vlan 1 finds the neighbour', async () => {
    const sw = await catalyst();
    expect(row(await sw.executeCommand('show ip arp vlan 1'), '10.0.0.2')).toBeDefined();
  });

  it('arp timeout 600 on the SVI: accepted, and the entry is gone after ten minutes', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 24, 0, 0);
    const outputs = await type(sw, ['enable', 'configure terminal', 'ip routing', 'interface Vlan1',
      'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'arp timeout 600', 'end']);
    expect(outputs[6]).toBe('');
    await neighbour(sw.getPort('FastEthernet0/1')!);
    clock.advance(11 * MINUTE);
    expect(row(await sw.executeCommand('show ip arp'), '10.0.0.2')).toBeUndefined();
  });

  it('the IOS default keeps the entry past ten minutes', async () => {
    const sw = await catalyst();
    clock.advance(10 * MINUTE);
    expect(row(await sw.executeCommand('show ip arp'), '10.0.0.2')).toBeDefined();
  });

  it('the SVI timeout is in the running-config and in show interfaces', async () => {
    const sw = await catalyst(['arp timeout 600']);
    const config = (await sw.executeCommand('show running-config')).split('\n');
    expect(config.slice(config.indexOf('interface Vlan1'))).toContain(' arp timeout 600');
    expect(await sw.executeCommand('show interfaces Vlan1')).toContain('ARP Timeout 00:10:00');
  });

  it('no arp timeout restores four hours', async () => {
    const sw = await catalyst(['arp timeout 600']);
    await type(sw, ['configure terminal', 'interface Vlan1', 'no arp timeout', 'end']);
    expect(await sw.executeCommand('show interfaces Vlan1')).toContain('ARP Timeout 04:00:00');
  });
});

async function huawei(vlanif: readonly string[] = []): Promise<{ sw: HuaweiSwitch; outputs: string[] }> {
  const sw = new HuaweiSwitch('switch-huawei', 'SW2', 8, 0, 0);
  const outputs = await type(sw, ['system-view', 'vlan 10', 'quit', 'interface GigabitEthernet0/0/1',
    'port link-type access', 'port default vlan 10', 'quit', 'interface Vlanif10',
    'ip address 10.0.0.1 255.255.255.0', ...vlanif, 'quit', 'quit']);
  await neighbour(sw.getPort('GigabitEthernet0/0/1')!);
  return { sw, outputs };
}

function vrpRow(table: string): string | undefined {
  return table.split('\n').find((line) => line.startsWith('10.0.0.2 '));
}

describe('Huawei S: arp expire-time on the Vlanif decides the entry', () => {
  it('arp expire-time 600: ten minutes left, none after them', async () => {
    const { sw } = await huawei(['arp expire-time 600']);
    expect(vrpRow(await sw.executeCommand('display arp'))?.split(/\s+/)[2]).toBe('10');
    clock.advance(11 * MINUTE);
    expect(vrpRow(await sw.executeCommand('display arp'))).toBeUndefined();
  });

  it('the VRP default of twenty minutes applies without configuration', async () => {
    const { sw } = await huawei();
    clock.advance(21 * MINUTE);
    expect(vrpRow(await sw.executeCommand('display arp'))).toBeUndefined();
  });

  it('the Vlanif timeout is in the current configuration', async () => {
    const { sw } = await huawei(['arp expire-time 600']);
    const config = (await sw.executeCommand('display current-configuration')).split('\n');
    expect(config.slice(config.indexOf('interface Vlanif10'))).toContain(' arp expire-time 600');
  });

  it('arp expire-time below 60 s is a wrong parameter', async () => {
    const { outputs } = await huawei(['arp expire-time 30']);
    expect(outputs[9]).toContain('Wrong parameter');
  });
});
