/**
 * La FortiGate signale ses pairs BGP et ses voisins OSPF par les
 * notifications des MIB standard, sur le fil.
 *
 * Mesure de depart : `set events bgp-established bgp-backward-transition
 * ospf-nbr-state-change` etait accepte (et fait partie des evenements par
 * defaut), mais aucun moteur ne levait ces faits : un pairage BGP qui
 * montait ou tombait, une adjacence OSPF qui atteignait Full ou la
 * perdait, ne produisaient rien.
 *
 * Autorites :
 * - « Supported RFCs » de FortiOS 7.6 range la RFC 4273 (BGP-4 MIB) sous
 *   SNMP : bgpEstablishedNotification (bgp 0 1) quand le FSM entre en
 *   Established, bgpBackwardTransNotification (bgp 0 2) quand il passe a
 *   un etat de numero inferieur, objets bgpPeerRemoteAddr, bgpPeerLastError
 *   (code et sous-code de la derniere NOTIFICATION, zero sinon) et
 *   bgpPeerState. La note technique Fortinet « BGP SNMP Trap » confirme
 *   le declenchement sur ESTABLISHED/OPENSENT/OPENCONFIRM vers IDLE.
 * - La RFC 4750 (OSPF-TRAP-MIB) pour ospfNbrStateChange (ospfTraps 2) :
 *   emise quand l'etat du voisin regresse ou atteint un etat terminal
 *   (2-Way ou Full) ; sur un reseau a acces multiple, un passage par Full
 *   n'est signale que par le routeur designe. Objets : ospfRouterId,
 *   ospfNbrIpAddr, ospfNbrAddressLessIndex (0 sur une interface
 *   numerotee), ospfNbrRtrId, ospfNbrState. L'OSPF ne figure pas dans la
 *   liste des RFC de MIB de FortiOS ; le texte de l'evenement
 *   `ospf-nbr-state-change` est celui de la RFC.
 * - Ces notifications standard partent avec leurs seuls objets ; en SNMPv1
 *   elles portent, comme toute trap d'entreprise de la FortiGate, le
 *   sysObjectID du modele comme entreprise.
 * - « Network Type POINTOPOINT » et « State Point-To-Point » : la
 *   transcription de `get router info ospf interface` de la note technique
 *   Fortinet « Dynamic dial-up VPN with OSPF ».
 *
 * Trouve en chemin : `set network-type point-to-point` etait stocke et
 * rendu par `show router ospf`, mais jamais transmis au moteur —
 * l'interface restait broadcast et elisait un DR. Le cas « reaches the
 * OSPF engine » mesure ce defaut seul, sans trap.
 *
 * Discrimination, mesuree sur le commit de base (88a145b3) avec ce fichier
 * copie : 7 des 11 cas tombent. Passent des deux cotes les deux TEMOINS
 * (le pairage BGP s'etablit, l'adjacence OSPF atteint Full) et deux cas
 * d'ABSENCE qui passent sur la base pour une raison qui ne prouve rien —
 * aucune de ces traps n'existait : « events without the BGP keywords »,
 * dont le laboratoire porte le temoin linkDown, et « a router that is not
 * the designated router », discrimine par le cas du DR, meme laboratoire
 * aux priorites pres.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import type { SnmpMessage } from '@/network/snmp/types';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<void> {
  for (const command of commands) await device.executeCommand(command);
}

interface Received {
  readonly source: string;
  readonly message: SnmpMessage;
}

function listen(nms: LinuxPC): Received[] {
  const received: Received[] = [];
  nms.udpBind(162, ({ sourceIP, udp }) => {
    const message = udp.payload as SnmpMessage | undefined;
    if (message?.type !== 'snmp') return;
    received.push({ source: sourceIP.toString(), message });
  }, 'snmptrapd');
  return received;
}

function summary(received: Received): string {
  const { message } = received;
  if (message.pduType === 'trap-v1') {
    return `v1 ${message.enterprise} ${message.genericTrap}/${message.specificTrap}`;
  }
  return `v2c ${String(message.varBindings[1]?.value.value)}`;
}

function objects(received: Received): string[] {
  const bindings = received.message.pduType === 'trap-v1'
    ? received.message.varBindings : received.message.varBindings.slice(2);
  return bindings.map(({ oid, value }) => `${oid}=${value.value instanceof Uint8Array
    ? [...value.value].map((byte) => byte.toString(16).padStart(2, '0')).join('') : String(value.value)}`);
}

const FGT_VM64 = '1.3.6.1.4.1.12356.101.1.30';
const BGP_ESTABLISHED = '1.3.6.1.2.1.15.0.1';
const BGP_BACKWARD = '1.3.6.1.2.1.15.0.2';
const OSPF_NBR_STATE_CHANGE = '1.3.6.1.2.1.14.16.2.2';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

async function managedFirewall(events: readonly string[] = []) {
  const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const nms = new LinuxPC('linux-pc', 'NMS');
  new Cable('nms-fgt').connect(nms.getPorts()[0], firewall.getPort('port1')!);
  await type(firewall, ['config system interface',
    'edit port1', 'set ip 10.0.0.1 255.255.255.0', 'set allowaccess ping snmp', 'next',
    'edit port2', 'set ip 10.1.0.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config system snmp sysinfo', 'set status enable', 'end',
    'config system snmp community', 'edit 1', 'set name "public"', ...events,
    'config hosts', 'edit 1', 'set ip 10.0.0.10 255.255.255.255', 'next', 'end', 'next', 'end']);
  await type(nms, ['sudo ip addr add 10.0.0.10/24 dev eth0', 'sudo ip link set eth0 up']);
  return { firewall, traps: listen(nms) };
}

async function bgpLab(events: readonly string[] = []) {
  const { firewall, traps } = await managedFirewall(events);
  const neighbour = new CiscoRouter('R1', 200, 0);
  new Cable('transit').connect(firewall.getPort('port2')!, neighbour.getPort('GigabitEthernet0/0')!);
  await type(neighbour, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.1.0.2 255.255.255.0', 'no shutdown', 'exit',
    'router bgp 65002', 'bgp router-id 2.2.2.2', 'neighbor 10.1.0.1 remote-as 65001', 'end']);
  await type(firewall, ['config router bgp', 'set as 65001', 'set router-id 1.1.1.1',
    'config neighbor', 'edit "10.1.0.2"', 'set remote-as 65002', 'next', 'end', 'end']);
  clock.advance(120_000);
  return { firewall, neighbour, traps };
}

const livePeers = (firewall: FortiGate) =>
  firewall.getRouting().getBgp().neighbours().filter((peer) => peer.isUp).length;

describe('a FortiGate reports its BGP peers with BGP4-MIB notifications', () => {
  it('WITNESS: the peering comes up over the cable', async () => {
    const { firewall } = await bgpLab();
    expect(livePeers(firewall)).toBe(1);
  });

  it('a peering reaching Established sends bgpEstablishedNotification in SNMPv1 then SNMPv2c', async () => {
    const { traps } = await bgpLab();
    const bgp = traps.filter((trap) => summary(trap).includes('1.3.6.1.2.1.15')
      || (trap.message.pduType === 'trap-v1' && trap.message.specificTrap === 1));
    expect(bgp.map(summary)).toEqual([`v1 ${FGT_VM64} 6/1`, `v2c ${BGP_ESTABLISHED}`]);
    expect(bgp.every((trap) => trap.source === '10.0.0.1')).toBe(true);
  });

  it('bgpEstablishedNotification names the peer, carries no error yet and the state established(6)', async () => {
    const { traps } = await bgpLab();
    const established = traps.find((trap) => summary(trap) === `v2c ${BGP_ESTABLISHED}`)!;
    expect(objects(established)).toEqual([
      '1.3.6.1.2.1.15.3.1.7.10.1.0.2=10.1.0.2',
      '1.3.6.1.2.1.15.3.1.14.10.1.0.2=0000',
      '1.3.6.1.2.1.15.3.1.2.10.1.0.2=6',
    ]);
  });

  it('a hard clear sends bgpBackwardTransNotification with the Cease the FortiGate sent', async () => {
    const { firewall, traps } = await bgpLab();
    traps.length = 0;
    await firewall.executeCommand('execute router clear bgp all');
    expect(livePeers(firewall)).toBe(0);
    const backward = traps.filter((trap) => summary(trap) === `v2c ${BGP_BACKWARD}`);
    expect(backward).toHaveLength(1);
    const [remote, lastError, state] = objects(backward[0]);
    expect(remote).toBe('1.3.6.1.2.1.15.3.1.7.10.1.0.2=10.1.0.2');
    expect(lastError).toBe('1.3.6.1.2.1.15.3.1.14.10.1.0.2=0600');
    expect(Number(state.split('=')[1])).toBeLessThan(6);
  });

  it('events without the BGP keywords sends nothing for the peering, while linkDown still leaves', async () => {
    const { firewall, traps } = await bgpLab(['set events cpu-high']);
    expect(traps.map(summary).filter((line) => line.includes('1.3.6.1.2.1.15'))).toEqual([]);
    expect(livePeers(firewall)).toBe(1);
    await type(firewall, ['config system interface', 'edit port2', 'set status down', 'next', 'end']);
    expect(traps.map(summary)).toContain('v2c 1.3.6.1.6.3.1.1.5.3');
  });
});

async function ospfLab(firewallInterface: readonly string[], neighbourInterface: readonly string[]) {
  const { firewall, traps } = await managedFirewall();
  const neighbour = new CiscoRouter('R1', 200, 0);
  const segment = new GenericSwitch('switch-generic', 'SW', 100, 0);
  new Cable('fgt-sw').connect(firewall.getPort('port2')!, segment.getPorts()[0]);
  const neighbourCable = new Cable('sw-r1');
  neighbourCable.connect(segment.getPorts()[1], neighbour.getPort('GigabitEthernet0/0')!);
  await type(neighbour, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.1.0.2 255.255.255.0',
    ...neighbourInterface, 'no shutdown', 'exit',
    'router ospf 1', 'router-id 2.2.2.2', 'network 10.1.0.0 0.0.0.255 area 0', 'end']);
  await type(firewall, ['config router ospf', 'set router-id 1.1.1.1',
    'config area', 'edit 0.0.0.0', 'next', 'end',
    'config ospf-interface', 'edit "transit"', 'set interface "port2"', ...firewallInterface, 'next', 'end',
    'config network', 'edit 1', 'set prefix 10.1.0.0 255.255.255.0', 'set area 0.0.0.0', 'next', 'end',
    'end']);
  clock.advance(60_000);
  return { firewall, neighbour, neighbourCable, traps };
}

const ospfTraps = (traps: readonly Received[]) => traps.filter((trap) =>
  summary(trap) === `v2c ${OSPF_NBR_STATE_CHANGE}`);

const reportedStates = (traps: readonly Received[]) =>
  ospfTraps(traps).map((trap) => Number(objects(trap)[4].split('=')[1]));

const FIREWALL_ELECTED = ['set priority 255'];
const NEIGHBOUR_INELIGIBLE = ['ip ospf priority 0'];
const POINT_TO_POINT_FIREWALL = ['set priority 0', 'set network-type point-to-point'];
const POINT_TO_POINT_NEIGHBOUR = ['ip ospf priority 255', 'ip ospf network point-to-point'];

describe('a FortiGate reports its OSPF neighbours with ospfNbrStateChange', () => {
  it('WITNESS: the adjacency reaches Full over the segment', async () => {
    const { firewall } = await ospfLab(FIREWALL_ELECTED, NEIGHBOUR_INELIGIBLE);
    expect(await firewall.executeCommand('get router info ospf neighbor')).toMatch(/2\.2\.2\.2\s+0\s+Full/);
  });

  it('the designated router reports the 2-Way the Wait period leaves, then Full', async () => {
    const { traps } = await ospfLab(FIREWALL_ELECTED, NEIGHBOUR_INELIGIBLE);
    expect(reportedStates(traps)).toEqual([4, 8]);
    const full = ospfTraps(traps)[1];
    expect(objects(full)).toEqual([
      '1.3.6.1.2.1.14.1.1.0=1.1.1.1',
      '1.3.6.1.2.1.14.10.1.1.10.1.0.2.0=10.1.0.2',
      '1.3.6.1.2.1.14.10.1.2.10.1.0.2.0=0',
      '1.3.6.1.2.1.14.10.1.3.10.1.0.2.0=2.2.2.2',
      '1.3.6.1.2.1.14.10.1.6.10.1.0.2.0=8',
    ]);
    expect(traps.map(summary)).toContain(`v1 ${FGT_VM64} 6/2`);
  });

  it('a router that is not the designated router leaves the Full adjacency to the DR', async () => {
    const { firewall, traps } = await ospfLab(['set priority 0'], ['ip ospf priority 255']);
    expect(await firewall.executeCommand('get router info ospf neighbor')).toMatch(/2\.2\.2\.2\s+255\s+Full/);
    expect(reportedStates(traps)).toEqual([]);
  });

  it('set network-type point-to-point reaches the OSPF engine that the stored configuration names', async () => {
    const { firewall } = await ospfLab(POINT_TO_POINT_FIREWALL, POINT_TO_POINT_NEIGHBOUR);
    expect(await firewall.executeCommand('show router ospf')).toContain('set network-type point-to-point');
    const view = await firewall.executeCommand('get router info ospf interface port2');
    expect(view).toContain('Network Type POINTOPOINT,');
    expect(view).toContain('State Point-To-Point,');
  });

  it('on a point-to-point network the Full adjacency is reported without a designated router', async () => {
    const { traps } = await ospfLab(POINT_TO_POINT_FIREWALL, POINT_TO_POINT_NEIGHBOUR);
    expect(reportedStates(traps)).toEqual([8]);
  });

  it('the designated router reports the neighbour it loses when the dead interval runs out', async () => {
    const { neighbourCable, traps } = await ospfLab(FIREWALL_ELECTED, NEIGHBOUR_INELIGIBLE);
    traps.length = 0;
    neighbourCable.disconnect();
    clock.advance(60_000);
    expect(reportedStates(traps)).toEqual([1]);
  });
});
