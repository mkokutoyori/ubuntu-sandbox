/**
 * La FortiGate repond en SNMP comme `config system snmp` le dit, et
 * l'`allowaccess` d'usine est celui qu'elle applique.
 *
 * Mesure de depart : `config system snmp` n'existait pas (« unknown
 * configuration path »), aucune requete SNMP n'etait servie, et
 * `allowaccess snmp` etait accepte et rendu sans moteur derriere. En
 * chemin, quatre defauts d'un meme fait — l'`allowaccess` des ports du
 * chassis :
 * - il n'etait ecrit que dans l'arbre de configuration : une FortiGate
 *   neuve servait TOUS les services d'administration sur toutes ses
 *   interfaces (le plan de gestion, vide, repondait « tout est permis »),
 *   si bien que `nc` joignait le telnet de port1 alors que sa
 *   configuration d'usine (ping https ssh http fgfm) ne le permet pas ;
 * - des qu'une AUTRE interface etait validee, port1 cessait de repondre
 *   au ping que sa configuration autorise ;
 * - `execute factoryreset` retirait port1 de la configuration (« port1
 *   does not exist ») et laissait l'equipement sur son ancienne adresse ;
 * - la ligne que `show` imprime ne se retapait pas : `fgfm` (« FortiManager
 *   access », reference 7.6.3) manquait a l'enumeration.
 * Deux references visaient en outre une table `system vdom` qui n'existe
 * pas : `set vdoms` d'une communaute et `set vdom` d'un administrateur
 * refusaient tout domaine virtuel, `root` compris. L'agent SNMP partage
 * repondait toujours depuis le port 161, meme a une requete recue sur
 * `query-v2c-port 1161` — le cas l'observe sur le cable, puisque net-snmp,
 * qui apparie par le seul request-id, lirait la reponse quand meme. Et
 * ifMtu valait 1500 en dur, quand `show interfaces` lit le MTU du port.
 *
 * Autorites : la reference CLI FortiOS 7.6.3 pour les attributs, bornes et
 * valeurs par defaut de `system snmp sysinfo|community|mib-view` ; le
 * guide d'administration 7.6.3 (« Enabling ha-direct in a non-HA
 * environment will make SNMP unusable ») ; FORTINET-FORTIGATE-MIB,
 * revision 202504040000Z (fgtVM64 = fgModel 30, fgSystemInfo) ; des
 * captures de FortiGate reelles (donnees de test LibreNMS : ifDescr porte
 * la `description` de l'interface, ifName son nom, fgSysVersion s'ecrit
 * « v7.2.6,build1575,230926 (GA.F) ») ; sysServices = 78 est celui du
 * transcript snmpwalk du guide d'administration FortiOS 6.2
 * (FortiGate-140D-POE).
 *
 * Discrimination, mesuree sur le commit de base avec ce fichier copie :
 * 23 des 24 cas tombent. « WITNESS: the manager reaches the firewall »
 * passe des deux cotes : il prouve que le banc est sain. Chaque refus est
 * mesure DANS LE MEME CAS contre un temoin qui ne differe que par le
 * critere eprouve (une autre communaute, un autre port, le service ajoute
 * ensuite), si bien qu'aucun refus ne passe a vide la ou rien ne repond.
 * Le cas du port d'ecoute deplace a aussi ete mesure seul, l'agent
 * remis a repondre depuis 161 : il tombe sur l'examen du cable.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import type { IPv4Packet, UDPPacket } from '@/network/core/types';
import type { SnmpPacket } from '@/network/snmp/types';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<void> {
  for (const command of commands) await device.executeCommand(command);
}

const TIMEOUT = 'Timeout: No Response from 10.0.0.1';
const NMS_HOST = ['set ip 10.0.0.10 255.255.255.255'];

function sysinfo(status = 'enable'): string[] {
  return ['config system snmp sysinfo', `set status ${status}`, 'set description "edge firewall"',
    'set contact-info "noc@example.net"', 'set location "Rack 4"', 'end'];
}

function community(
  id: number, name: string, hosts: readonly (readonly string[])[], settings: readonly string[] = [],
): string[] {
  return ['config system snmp community', `edit ${id}`, `set name "${name}"`, ...settings, 'config hosts',
    ...hosts.flatMap((host, index) => [`edit ${index + 1}`, ...host, 'next']), 'end', 'next', 'end'];
}

function mibView(name: string, settings: readonly string[]): string[] {
  return ['config system snmp mib-view', `edit "${name}"`, ...settings, 'next', 'end'];
}

async function lab(options: { allowaccess?: string; snmp?: readonly string[] } = {}) {
  const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const nms = new LinuxPC('linux-pc', 'NMS');
  const cable = new Cable('nms-fgt');
  cable.connect(nms.getPorts()[0], firewall.getPort('port1')!);
  await type(firewall, ['config system interface', 'edit port1', 'set ip 10.0.0.1 255.255.255.0',
    `set allowaccess ${options.allowaccess ?? 'ping snmp'}`, 'next', 'end']);
  await type(firewall, options.snmp ?? [...sysinfo(), ...community(1, 'public', [NMS_HOST])]);
  await type(nms, ['sudo ip addr add 10.0.0.10/24 dev eth0', 'sudo ip link set eth0 up']);
  return { firewall, nms, cable };
}

function responseSourcePorts(cable: Cable): number[] {
  const bus = new EventBus();
  cable.setEventBus(bus);
  const ports: number[] = [];
  bus.subscribe('cable.frame.delivered', (event) => {
    const udp = (event.payload.frame.payload as IPv4Packet | undefined)?.payload as UDPPacket | undefined;
    const snmp = udp?.type === 'udp' ? udp.payload as SnmpPacket | undefined : undefined;
    if (snmp?.type === 'snmp' && snmp.pduType === 'get-response') ports.push(udp!.sourcePort);
  });
  return ports;
}

async function walk(nms: Shell, args: string): Promise<string[]> {
  return (await nms.executeCommand(`snmpwalk -t 1 -r 0 ${args}`)).split('\n');
}

const SYS_NAME = '1.3.6.1.2.1.1.5';
const ANSWERED = 'iso.3.6.1.2.1.1.5.0 = STRING: "FGT"';

describe('a FortiGate answers SNMP the way config system snmp says', () => {
  it('WITNESS: the manager reaches the firewall', async () => {
    const { nms } = await lab();
    expect(await nms.executeCommand('ping -c 1 10.0.0.1')).toContain(' 0% packet loss');
  });

  it('serves the system group from sysinfo and the hostname', async () => {
    const { nms } = await lab();
    const lines = await walk(nms, '-v2c -c public 10.0.0.1 1.3.6.1.2.1.1');
    expect(lines).toContain('iso.3.6.1.2.1.1.1.0 = STRING: "edge firewall"');
    expect(lines).toContain('iso.3.6.1.2.1.1.2.0 = OID: iso.3.6.1.4.1.12356.101.1.30');
    expect(lines.some((line) => /^iso\.3\.6\.1\.2\.1\.1\.3\.0 = Timeticks: \(\d+\) /.test(line))).toBe(true);
    expect(lines).toContain('iso.3.6.1.2.1.1.4.0 = STRING: "noc@example.net"');
    expect(lines).toContain(ANSWERED);
    expect(lines).toContain('iso.3.6.1.2.1.1.6.0 = STRING: "Rack 4"');
    expect(lines).toContain('iso.3.6.1.2.1.1.7.0 = INTEGER: 78');
    expect(lines).toHaveLength(7);
  });

  it('answers SNMPv1 with the same values', async () => {
    const { nms } = await lab();
    expect(await walk(nms, `-v1 -c public 10.0.0.1 ${SYS_NAME}`)).toContain(ANSWERED);
  });

  it('names the firewall by the hostname config system global sets', async () => {
    const { firewall, nms } = await lab();
    await type(firewall, ['config system global', 'set hostname "EDGE-FW"', 'end']);
    expect(await walk(nms, `-v2c -c public 10.0.0.1 ${SYS_NAME}`))
      .toContain('iso.3.6.1.2.1.1.5.0 = STRING: "EDGE-FW"');
  });

  it('serves the firmware and the serial number get system status prints', async () => {
    const { firewall, nms } = await lab();
    const status = await firewall.executeCommand('get system status');
    const version = /^Version: FortiGate-VM64 (.+)$/m.exec(status)?.[1];
    const serial = /^Serial-Number: (\S+)$/m.exec(status)?.[1];
    expect(version).toMatch(/^v7\.6\.3,build\d+,\d{6} \(/);
    expect(await walk(nms, '-v2c -c public 10.0.0.1 1.3.6.1.4.1.12356.101.4.1.1'))
      .toContain(`iso.3.6.1.4.1.12356.101.4.1.1.0 = STRING: "${version}"`);
    expect(await walk(nms, '-v2c -c public 10.0.0.1 1.3.6.1.4.1.12356.100.1.1.1'))
      .toContain(`iso.3.6.1.4.1.12356.100.1.1.1.0 = STRING: "${serial}"`);
  });

  it('serves the memory capacity get system status and get system performance status announce', async () => {
    const { firewall, nms } = await lab();
    const ramMb = Number(/(\d+) MB RAM/.exec(await firewall.executeCommand('get system status'))?.[1]);
    const performance = await firewall.executeCommand('get system performance status');
    const totalKib = Number(/Memory: (\d+)k total/.exec(performance)?.[1]);
    expect(totalKib).toBe(ramMb * 1024);
    expect(await walk(nms, '-v2c -c public 10.0.0.1 1.3.6.1.4.1.12356.101.4.1.5'))
      .toContain(`iso.3.6.1.4.1.12356.101.4.1.5.0 = Gauge32: ${totalKib}`);
  });

  it('describes each interface by its configured description and names it by its name', async () => {
    const { firewall, nms } = await lab();
    await type(firewall, ['config system interface', 'edit port1', 'set description "to the NMS"', 'next', 'end']);
    const descriptions = await walk(nms, '-v2c -c public 10.0.0.1 1.3.6.1.2.1.2.2.1.2');
    expect(descriptions[0]).toBe('iso.3.6.1.2.1.2.2.1.2.1 = STRING: "to the NMS"');
    expect(descriptions[1]).toBe('iso.3.6.1.2.1.2.2.1.2.2 = ""');
    expect((await walk(nms, '-v2c -c public 10.0.0.1 1.3.6.1.2.1.31.1.1.1.1'))[0])
      .toBe('iso.3.6.1.2.1.31.1.1.1.1.1 = STRING: "port1"');
  });

  it('serves the MTU the interface is configured with, as show system interface does', async () => {
    const { firewall, nms } = await lab();
    await type(firewall, ['config system interface', 'edit port1', 'set mtu-override enable', 'set mtu 1400',
      'next', 'end']);
    expect(await firewall.executeCommand('show system interface port1')).toContain('set mtu 1400');
    expect(await walk(nms, '-v2c -c public 10.0.0.1 1.3.6.1.2.1.2.2.1.4'))
      .toContain('iso.3.6.1.2.1.2.2.1.4.1 = INTEGER: 1400');
  });

  it('an interface without allowaccess snmp stays silent until snmp is appended', async () => {
    const { firewall, nms } = await lab({ allowaccess: 'ping' });
    expect(await walk(nms, `-v2c -c public 10.0.0.1 ${SYS_NAME}`)).toContain(TIMEOUT);
    await type(firewall, ['config system interface', 'edit port1', 'append allowaccess snmp', 'next', 'end']);
    expect(await walk(nms, `-v2c -c public 10.0.0.1 ${SYS_NAME}`)).toContain(ANSWERED);
  });

  it('sysinfo status disable silences the agent until it is enabled', async () => {
    const { firewall, nms } = await lab({ snmp: [...sysinfo('disable'), ...community(1, 'public', [NMS_HOST])] });
    expect(await walk(nms, `-v2c -c public 10.0.0.1 ${SYS_NAME}`)).toContain(TIMEOUT);
    await type(firewall, ['config system snmp sysinfo', 'set status enable', 'end']);
    expect(await walk(nms, `-v2c -c public 10.0.0.1 ${SYS_NAME}`)).toContain(ANSWERED);
  });

  it('a disabled community is not answered while an enabled one is', async () => {
    const { nms } = await lab({ snmp: [...sysinfo(),
      ...community(1, 'public', [NMS_HOST], ['set status disable']),
      ...community(2, 'private', [NMS_HOST])] });
    expect(await walk(nms, `-v2c -c public 10.0.0.1 ${SYS_NAME}`)).toContain(TIMEOUT);
    expect(await walk(nms, `-v2c -c private 10.0.0.1 ${SYS_NAME}`)).toContain(ANSWERED);
  });

  it('a manager outside the community hosts is not answered', async () => {
    const { nms } = await lab({ snmp: [...sysinfo(),
      ...community(1, 'public', [['set ip 10.0.0.99 255.255.255.255']]),
      ...community(2, 'subnet', [['set ip 10.0.0.0 255.255.255.0']])] });
    expect(await walk(nms, `-v2c -c public 10.0.0.1 ${SYS_NAME}`)).toContain(TIMEOUT);
    expect(await walk(nms, `-v2c -c subnet 10.0.0.1 ${SYS_NAME}`)).toContain(ANSWERED);
  });

  it('a host that only receives traps is not answered', async () => {
    const { nms } = await lab({ snmp: [...sysinfo(),
      ...community(1, 'public', [[...NMS_HOST, 'set host-type trap']]),
      ...community(2, 'queries', [[...NMS_HOST, 'set host-type query']])] });
    expect(await walk(nms, `-v2c -c public 10.0.0.1 ${SYS_NAME}`)).toContain(TIMEOUT);
    expect(await walk(nms, `-v2c -c queries 10.0.0.1 ${SYS_NAME}`)).toContain(ANSWERED);
  });

  it('ha-direct on a standalone unit makes SNMP unusable for that host', async () => {
    const { nms } = await lab({ snmp: [...sysinfo(),
      ...community(1, 'public', [[...NMS_HOST, 'set ha-direct enable']]),
      ...community(2, 'direct', [NMS_HOST])] });
    expect(await walk(nms, `-v2c -c public 10.0.0.1 ${SYS_NAME}`)).toContain(TIMEOUT);
    expect(await walk(nms, `-v2c -c direct 10.0.0.1 ${SYS_NAME}`)).toContain(ANSWERED);
  });

  it('query-v1-status disable refuses SNMPv1 and keeps SNMPv2c', async () => {
    const { nms } = await lab({ snmp: [...sysinfo(),
      ...community(1, 'public', [NMS_HOST], ['set query-v1-status disable'])] });
    expect(await walk(nms, `-v1 -c public 10.0.0.1 ${SYS_NAME}`)).toContain(TIMEOUT);
    expect(await walk(nms, `-v2c -c public 10.0.0.1 ${SYS_NAME}`)).toContain(ANSWERED);
  });

  it('query-v2c-port moves the SNMPv2c listener, and the answer leaves from that port', async () => {
    const { nms, cable } = await lab({ snmp: [...sysinfo(),
      ...community(1, 'public', [NMS_HOST], ['set query-v2c-port 1161'])] });
    expect(await walk(nms, `-v2c -c public 10.0.0.1 ${SYS_NAME}`)).toContain(TIMEOUT);
    const sources = responseSourcePorts(cable);
    expect(await walk(nms, `-v2c -c public 10.0.0.1:1161 ${SYS_NAME}`)).toContain(ANSWERED);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((port) => port === 1161)).toBe(true);
  });

  it('a mib-view shows the community only the subtrees it includes', async () => {
    const { nms } = await lab({ snmp: [...sysinfo(),
      ...mibView('system-only', ['set include 1.3.6.1.2.1.1']),
      ...community(1, 'public', [NMS_HOST], ['set mib-view "system-only"'])] });
    const lines = await walk(nms, '-v2c -c public 10.0.0.1 1.3.6.1.2.1');
    expect(lines).toContain(ANSWERED);
    expect(lines.some((line) => line.startsWith('iso.3.6.1.2.1.2.'))).toBe(false);
    expect(lines[lines.length - 1])
      .toBe('iso.3.6.1.2.1.1.7.0 = No more variables left in this MIB View (It is past the end of the MIB tree)');
  });

  it('an excluded subtree leaves the view', async () => {
    const { nms } = await lab({ snmp: [...sysinfo(),
      ...mibView('no-iftable', ['set include 1.3.6.1.2.1', 'set exclude 1.3.6.1.2.1.2']),
      ...community(1, 'public', [NMS_HOST], ['set mib-view "no-iftable"'])] });
    const lines = await walk(nms, '-v2c -c public 10.0.0.1 1.3.6.1.2.1');
    expect(lines.some((line) => line.startsWith('iso.3.6.1.2.1.2.'))).toBe(false);
    expect(lines).toContain('iso.3.6.1.2.1.31.1.1.1.1.1 = STRING: "port1"');
  });

  it('a community restricted to a VDOM sees only the interfaces of that VDOM', async () => {
    const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    const nms = new LinuxPC('linux-pc', 'NMS');
    new Cable('nms-fgt').connect(nms.getPorts()[0], firewall.getPort('port1')!);
    await type(firewall, ['config system global', 'set vdom-mode multi-vdom', 'end',
      'config vdom', 'edit customer', 'next', 'end', 'config global',
      'config system interface', 'edit port1', 'set ip 10.0.0.1 255.255.255.0', 'set allowaccess ping snmp', 'next',
      'edit port2', 'set vdom customer', 'next', 'edit port3', 'set vdom customer', 'next', 'end',
      ...sysinfo(),
      ...community(1, 'tenant', [NMS_HOST], ['set vdoms customer']),
      ...community(2, 'provider', [NMS_HOST], ['set vdoms root']), 'end']);
    await type(nms, ['sudo ip addr add 10.0.0.10/24 dev eth0', 'sudo ip link set eth0 up']);
    expect(await walk(nms, '-v2c -c tenant 10.0.0.1 1.3.6.1.2.1.31.1.1.1.1')).toEqual([
      'iso.3.6.1.2.1.31.1.1.1.1.2 = STRING: "port2"',
      'iso.3.6.1.2.1.31.1.1.1.1.3 = STRING: "port3"',
    ]);
    const provider = await walk(nms, '-v2c -c provider 10.0.0.1 1.3.6.1.2.1.31.1.1.1.1');
    expect(provider).toContain('iso.3.6.1.2.1.31.1.1.1.1.1 = STRING: "port1"');
    expect(provider).not.toContain('iso.3.6.1.2.1.31.1.1.1.1.2 = STRING: "port2"');
  });

  it('an administrator can be scoped to a VDOM that exists', async () => {
    const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    await type(firewall, ['config system admin', 'edit "ops"', 'set accprofile "prof_admin"', 'set vdom "root"',
      'set password Str0ng!Pass', 'next', 'end']);
    expect(await firewall.executeCommand('show system admin ops')).toContain('set vdom "root"');
  });
});

describe('the factory allowaccess of a FortiGate is the one it enforces', () => {
  async function factoryLab() {
    const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    const nms = new LinuxPC('linux-pc', 'NMS');
    new Cable('nms-fgt').connect(nms.getPorts()[0], firewall.getPort('port1')!);
    await type(nms, ['sudo ip addr add 192.168.1.10/24 dev eth0', 'sudo ip link set eth0 up']);
    return { firewall, nms };
  }

  it('a fresh unit serves ssh on port1 but not telnet, which its factory allowaccess leaves out', async () => {
    const { nms } = await factoryLab();
    expect(await nms.executeCommand('nc -z -v -w 2 192.168.1.99 22')).toContain('succeeded');
    expect(await nms.executeCommand('nc -z -v -w 2 192.168.1.99 23')).toContain('timed out');
  });

  it('the factory allowaccess that show prints can be typed back', async () => {
    const { firewall } = await factoryLab();
    const shown = /set allowaccess (.+)$/m.exec(await firewall.executeCommand('show system interface port1'))?.[1];
    expect(shown).toBe('ping https ssh http fgfm');
    await firewall.executeCommand('config system interface');
    await firewall.executeCommand('edit port1');
    expect(await firewall.executeCommand(`set allowaccess ${shown}`)).toBe('');
  });

  it('configuring another interface keeps port1 answering the ping its configuration allows', async () => {
    const { firewall, nms } = await factoryLab();
    await type(firewall, ['config system interface', 'edit port2', 'set ip 10.9.9.1 255.255.255.0',
      'set allowaccess ping', 'next', 'end']);
    expect(await nms.executeCommand('ping -c 1 192.168.1.99')).toContain(' 0% packet loss');
  });

  it('a factory reset brings port1 back, in the configuration and on the wire', async () => {
    const { firewall, nms } = await factoryLab();
    await type(firewall, ['config system interface', 'edit port1', 'set ip 10.0.0.1 255.255.255.0',
      'set allowaccess ping snmp', 'next', 'end']);
    await firewall.executeCommand('execute factoryreset');
    const port1 = await firewall.executeCommand('show system interface port1');
    expect(port1).toContain('set ip 192.168.1.99 255.255.255.0');
    expect(port1).toContain('set allowaccess ping https ssh http fgfm');
    expect(await nms.executeCommand('ping -c 1 192.168.1.99')).toContain(' 0% packet loss');
  });
});
