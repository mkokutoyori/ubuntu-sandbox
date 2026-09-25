/**
 * `snmpwalk` sur Linux, clone de net-snmp 5.9.1, et l'agent SNMP qu'il
 * interroge.
 *
 * Mesure de depart : aucune commande SNMP n'existait cote Linux, et
 * l'agent des routeurs ne tenait debout que face a un autre routeur. Il
 * repondait VERS le port 161 du demandeur depuis un port ephemere (un
 * gestionnaire lie a un port ephemere ne recoit rien), prenait le
 * demandeur lui-meme pour prochain saut sur l'interface d'entree (la
 * reponse ne traversait une passerelle que si celle-ci faisait du
 * proxy-ARP, actif par defaut sur IOS, absent par defaut sous Linux),
 * repondait depuis l'adresse de l'interface d'entree plutot que depuis
 * l'adresse interrogee (une Loopback /32 passait pour la diffusion de
 * son propre prefixe, voir `probe-a-slash-31-has-no-broadcast-address`),
 * repondait en v2c a une requete v1, melangeait le noSuchName de la v1
 * aux exceptions de la v2c, et servait ifPhysAddress comme un texte au
 * lieu de six octets. Un Cisco neuf repondait a la communaute `public` alors
 * que `show snmp` y affichait `SNMP agent not enabled` et que la
 * running-config n'en disait rien ; et `show snmp` restait a zero hors
 * d'un bus injecte, en rendant un seul compteur sous quatre libelles.
 *
 * L'autorite est le code de net-snmp lui-meme (apps/snmpwalk.c,
 * snmplib/mib.c, snmp_parse_args.c, snmp_api.c) et, pour ce que
 * l'empaquetage Ubuntu change (chemins MIB, version par defaut 3), le
 * `debian/rules` du paquet. Les regles d'agent sont celles des RFC 1157
 * (v1 : noSuchName et varbinds rendus a l'identique) et 3416 (v2c :
 * noError et exceptions par varbind).
 *
 * Discrimination, mesuree sur le commit de base avec ce fichier copie :
 * 13 des 15 cas tombent. Les deux qui passent des deux cotes sont nommes
 * — « WITNESS: the PC reaches the router », qui prouve que le banc est
 * sain ; et « WITNESS: a manager on the same link was already answered »,
 * qui prouve que les cas du gestionnaire derriere une passerelle et de
 * l'adresse interrogee tombent pour la raison qu'ils nomment, pas parce
 * que l'API du gestionnaire serait cassee.
 *
 * Ajout du lot FortiGate : net-snmp apparie une reponse v1/v2c a sa
 * requete par le seul request-id (`_sess_process_packet`, snmp_api.c ;
 * la socket UDP du client n'est pas connectee, elle recoit de n'importe
 * quel port). Le gestionnaire exigeait en plus l'adresse et le port
 * interroges, et perdait une reponse que net-snmp aurait lue. Mesure sur
 * b1e74ce2 : « net-snmp takes a response by its request-id alone » tombe ;
 * « WITNESS: an agent answering from the queried port is heard » passe des
 * deux cotes et prouve que le faux agent du banc est entendu.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import type { IPAddress, IPv4Packet, UDPPacket } from '@/network/core/types';
import { v, vb, type SnmpPacket, type SnmpVarBinding } from '@/network/snmp/types';

const SYS_NAME = '1.3.6.1.2.1.1.5.0';
const IF_PHYS_ADDRESS_1 = '1.3.6.1.2.1.2.2.1.6.1';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<void> {
  for (const command of commands) await device.executeCommand(command);
}

function routerConfig(interfaces: readonly string[], tail: readonly string[]): string[] {
  return ['enable', 'configure terminal', ...interfaces, ...tail, 'end'];
}

async function linuxLab(snmp: readonly string[] = ['snmp-server community public RO']) {
  const router = new CiscoRouter('R1');
  const pc = new LinuxPC('PC1');
  const cable = new Cable('pc-r1');
  cable.connect(router.getPort('GigabitEthernet0/0')!, pc.getPorts()[0]);
  await type(router, routerConfig([
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
  ], snmp));
  await type(pc, ['sudo ip addr add 10.0.0.10/24 dev eth0', 'sudo ip link set eth0 up']);
  return { router, pc, cable };
}

function countSnmp(cable: Cable): { requests: number; responses: number } {
  const bus = new EventBus();
  cable.setEventBus(bus);
  const seen = { requests: 0, responses: 0 };
  bus.subscribe('cable.frame.delivered', (event) => {
    const udp = (event.payload.frame.payload as IPv4Packet | undefined)?.payload as UDPPacket | undefined;
    const snmp = udp?.type === 'udp' ? udp.payload as SnmpPacket | undefined : undefined;
    if (snmp?.type !== 'snmp') return;
    if (snmp.pduType === 'get-response') seen.responses++;
    else seen.requests++;
  });
  return seen;
}

async function answered(query: Promise<SnmpVarBinding[] | null>): Promise<SnmpVarBinding[] | null> {
  let result: SnmpVarBinding[] | null = null;
  void query.then((bindings) => { result = bindings; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  return result;
}

describe('snmpwalk on Linux speaks net-snmp over the wire', () => {
  it('WITNESS: the PC reaches the router', async () => {
    const { pc } = await linuxLab();
    expect(await pc.executeCommand('ping -c 1 10.0.0.1')).toContain(' 0% packet loss');
  });

  it('walks the system group and prints it the way net-snmp does', async () => {
    const { pc } = await linuxLab(['snmp-server community public RO', 'snmp-server location Paris']);
    const lines = (await pc.executeCommand('snmpwalk -v2c -c public 10.0.0.1 1.3.6.1.2.1.1')).split('\n');
    expect(lines).toContain('iso.3.6.1.2.1.1.1.0 = STRING: "Cisco IOS Software, R1"');
    expect(lines).toContain('iso.3.6.1.2.1.1.2.0 = OID: iso.3.6.1.4.1.9.1.222');
    expect(lines.some((line) => /^iso\.3\.6\.1\.2\.1\.1\.3\.0 = Timeticks: \(\d+\) \d+:\d\d:\d\d\.\d\d$/.test(line))).toBe(true);
    expect(lines).toContain('iso.3.6.1.2.1.1.4.0 = ""');
    expect(lines).toContain('iso.3.6.1.2.1.1.5.0 = STRING: "R1"');
    expect(lines).toContain('iso.3.6.1.2.1.1.6.0 = STRING: "Paris"');
    expect(lines).toContain('iso.3.6.1.2.1.1.7.0 = INTEGER: 78');
    expect(lines).toHaveLength(7);
  });

  it('puts one GETNEXT per value on the wire, plus the one that leaves the subtree', async () => {
    const { pc, cable } = await linuxLab();
    const seen = countSnmp(cable);
    const output = await pc.executeCommand('snmpwalk -v2c -c public -Cp 10.0.0.1 1.3.6.1.2.1.1');
    expect(output).toContain('Variables found: 7');
    expect(seen).toEqual({ requests: 8, responses: 8 });
  });

  it('a community the agent does not know times out after 1 + retries requests', async () => {
    const { pc, cable, router } = await linuxLab();
    const seen = countSnmp(cable);
    const output = await pc.executeCommand('snmpwalk -v2c -c wrong -t 0.05 -r 2 10.0.0.1');
    expect(output).toBe('Timeout: No Response from 10.0.0.1');
    expect(await pc.executeCommand('echo $?')).toBe('1');
    expect(seen).toEqual({ requests: 3, responses: 0 });
    expect(await router.executeCommand('show snmp')).toContain('    3 Unknown community name');
  });

  it('the interface physical address is six octets, printed as a Hex-STRING', async () => {
    const { pc } = await linuxLab();
    const output = await pc.executeCommand('snmpwalk -v1 -c public 10.0.0.1 1.3.6.1.2.1.2.2.1.6.1');
    expect(output).toMatch(/^iso\.3\.6\.1\.2\.1\.2\.2\.1\.6\.1 = Hex-STRING: ([0-9A-F]{2} ){6}$/);
  });

  it('past the end of the agent MIB: v2c prints the endOfMibView exception, v1 prints End of MIB', async () => {
    const { pc } = await linuxLab();
    expect(await pc.executeCommand('snmpwalk -v2c -c public 10.0.0.1 1.3.6.1.2.1.99'))
      .toBe('iso.3.6.1.2.1.99 = No more variables left in this MIB View (It is past the end of the MIB tree)');
    expect(await pc.executeCommand('snmpwalk -v1 -c public 10.0.0.1 1.3.6.1.2.1.99')).toBe('End of MIB');
  });

  it('an empty walk falls back to a GET, which v2c answers with a noSuchObject exception', async () => {
    const { pc } = await linuxLab();
    expect(await pc.executeCommand('snmpwalk -v2c -c public 10.0.0.1 1.3.6.1.2.1.1.9'))
      .toBe('iso.3.6.1.2.1.1.9 = No Such Object available on this agent at this OID');
  });

  it('the default version is 3, which is refused naming the missing brick', async () => {
    const { pc, cable } = await linuxLab();
    const seen = countSnmp(cable);
    expect(await pc.executeCommand('snmpwalk -c public 10.0.0.1')).toMatch(/SNMPv3 is not simulated/);
    expect(seen).toEqual({ requests: 0, responses: 0 });
  });

  it('a symbolic name needs MIB files this machine does not have', async () => {
    const { pc } = await linuxLab();
    expect(await pc.executeCommand('snmpwalk -v2c -c public 10.0.0.1 system'))
      .toBe('system: Unknown Object Identifier (Sub-id not found: (top) -> system)');
  });
});

describe('the agent answers the way a real one does', () => {
  it('a Cisco router with no snmp-server community answers nothing, as show snmp says', async () => {
    const { pc, router } = await linuxLab([]);
    expect(await router.executeCommand('show snmp')).toContain('SNMP agent not enabled');
    expect(await pc.executeCommand('snmpwalk -v2c -c public -t 0.05 -r 0 10.0.0.1'))
      .toBe('Timeout: No Response from 10.0.0.1');
  });

  it('WITNESS: a manager on the same link was already answered', async () => {
    const agent = new CiscoRouter('R1');
    const manager = new CiscoRouter('NMS');
    new Cable('link').connect(agent.getPort('GigabitEthernet0/0')!, manager.getPort('GigabitEthernet0/0')!);
    await type(agent, routerConfig(['interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit'],
      ['snmp-server community public RO']));
    await type(manager, routerConfig(['interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit'], []));
    const bindings = await answered(manager.getSnmpAgent().get('10.0.0.1', 'public', [SYS_NAME]));
    expect(bindings?.[0]?.value.value).toBe('R1');
  });

  it('the reply is routed back to a manager behind a gateway that does not proxy ARP', async () => {
    const agent = new CiscoRouter('R1');
    const gateway = new CiscoRouter('GW');
    const manager = new CiscoRouter('NMS');
    new Cable('nms-gw').connect(manager.getPort('GigabitEthernet0/0')!, gateway.getPort('GigabitEthernet0/0')!);
    new Cable('gw-r1').connect(gateway.getPort('GigabitEthernet0/1')!, agent.getPort('GigabitEthernet0/0')!);
    await type(manager, routerConfig(['interface GigabitEthernet0/0', 'ip address 10.0.1.2 255.255.255.0', 'no shutdown', 'exit'],
      ['ip route 0.0.0.0 0.0.0.0 10.0.1.1']));
    await type(gateway, routerConfig([
      'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.0.2.1 255.255.255.0', 'no ip proxy-arp', 'no shutdown', 'exit',
    ], []));
    await type(agent, routerConfig(['interface GigabitEthernet0/0', 'ip address 10.0.2.2 255.255.255.0', 'no shutdown', 'exit'],
      ['ip route 0.0.0.0 0.0.0.0 10.0.2.1', 'snmp-server community public RO']));
    const bindings = await answered(manager.getSnmpAgent().get('10.0.2.2', 'public', [SYS_NAME]));
    expect(bindings?.[0]?.value.value).toBe('R1');
  });

  it('the reply comes from the address that was queried, not from the ingress interface', async () => {
    const agent = new CiscoRouter('R1');
    const manager = new CiscoRouter('NMS');
    new Cable('link').connect(agent.getPort('GigabitEthernet0/0')!, manager.getPort('GigabitEthernet0/0')!);
    await type(agent, routerConfig([
      'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
      'interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    ], ['snmp-server community public RO']));
    await type(manager, routerConfig(['interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit'],
      ['ip route 1.1.1.1 255.255.255.255 10.0.0.1']));
    const bindings = await answered(manager.getSnmpAgent().get('1.1.1.1', 'public', [SYS_NAME]));
    expect(bindings?.[0]?.value.value).toBe('R1');
  });

  it('ifPhysAddress travels as six raw octets', async () => {
    const agent = new CiscoRouter('R1');
    const manager = new CiscoRouter('NMS');
    new Cable('link').connect(agent.getPort('GigabitEthernet0/0')!, manager.getPort('GigabitEthernet0/0')!);
    await type(agent, routerConfig(['interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit'],
      ['snmp-server community public RO']));
    await type(manager, routerConfig(['interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit'], []));
    const value = (await answered(manager.getSnmpAgent().get('10.0.0.1', 'public', [IF_PHYS_ADDRESS_1])))?.[0]?.value.value;
    expect(value).toBeInstanceOf(Uint8Array);
    expect([...(value as Uint8Array)]).toEqual(agent.getPort('GigabitEthernet0/0')!.getMAC().getOctets());
  });

  it('show snmp counts PDUs, variables and responses separately, without an injected bus', async () => {
    const agent = new CiscoRouter('R1');
    const manager = new CiscoRouter('NMS');
    new Cable('link').connect(agent.getPort('GigabitEthernet0/0')!, manager.getPort('GigabitEthernet0/0')!);
    await type(agent, routerConfig(['interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit'],
      ['snmp-server community public RO']));
    await type(manager, routerConfig(['interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit'], []));
    await answered(manager.getSnmpAgent().get('10.0.0.1', 'public', [SYS_NAME, IF_PHYS_ADDRESS_1]));
    await answered(manager.getSnmpAgent().getNext('10.0.0.1', 'public', ['1.3.6.1.2.1.1']));
    await answered(manager.getSnmpAgent().getNext('10.0.0.1', 'public', ['1.3.6.1.2.1.1.1.0']));
    const show = await agent.executeCommand('show snmp');
    expect(show).toContain('3 SNMP packets input');
    expect(show).toContain('    4 Number of requested variables');
    expect(show).toContain('    1 Get-request PDUs');
    expect(show).toContain('    2 Get-next PDUs');
    expect(show).toContain('    0 No such name errors');
    expect(show).toContain('    3 Response PDUs');
  });
});

describe('net-snmp matches a response the way snmp_api.c does', () => {
  async function agentAnsweringFrom(sourcePort: number) {
    const pc = new LinuxPC('PC1');
    const agent = new LinuxPC('AGENT');
    new Cable('pc-agent').connect(pc.getPorts()[0], agent.getPorts()[0]);
    await type(pc, ['sudo ip addr add 10.0.0.10/24 dev eth0', 'sudo ip link set eth0 up']);
    await type(agent, ['sudo ip addr add 10.0.0.1/24 dev eth0', 'sudo ip link set eth0 up']);
    agent.udpBind(161, ({ sourceIP, udp }) => {
      const request = udp.payload as SnmpPacket;
      const answer = request.varBindings[0]?.oid === '1.3.6.1.2.1.1.5'
        ? vb(SYS_NAME, v('octet-string', 'lab-agent'))
        : vb('1.3.6.1.2.1.1.6.0', v('octet-string', 'Paris'));
      const response: SnmpPacket = { ...request, pduType: 'get-response', varBindings: [answer] };
      agent.sendUdpDatagram(sourceIP as IPAddress, udp.sourcePort, sourcePort, response, 64);
    }, 'agent');
    return pc;
  }

  it('WITNESS: an agent answering from the queried port is heard', async () => {
    const pc = await agentAnsweringFrom(161);
    expect(await pc.executeCommand('snmpwalk -v2c -c public -t 1 -r 0 10.0.0.1 1.3.6.1.2.1.1.5'))
      .toBe('iso.3.6.1.2.1.1.5.0 = STRING: "lab-agent"');
  });

  it('net-snmp takes a response by its request-id alone, whatever port it comes from', async () => {
    const pc = await agentAnsweringFrom(1161);
    expect(await pc.executeCommand('snmpwalk -v2c -c public -t 1 -r 0 10.0.0.1 1.3.6.1.2.1.1.5'))
      .toBe('iso.3.6.1.2.1.1.5.0 = STRING: "lab-agent"');
  });
});
