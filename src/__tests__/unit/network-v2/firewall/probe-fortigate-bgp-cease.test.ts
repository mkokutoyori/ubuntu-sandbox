/**
 * La FortiGate ferme ses sessions BGP quand on la reconfigure, et chaque
 * NOTIFICATION Cease porte le sous-code de la RFC 4486.
 *
 * Mesure de depart (18727540) : quand `config router bgp` changeait l'AS
 * (ou le router-id), FirewallBgp jetait son moteur sans rien envoyer : le
 * pair Cisco restait « Established » jusqu'a l'echeance de son hold
 * timer, et la FortiGate ne signalait aucun bgpBackwardTransNotification.
 * Un voisin retire de la configuration etait ferme sans que la
 * transition soit publiee, donc sans trap. Toute NOTIFICATION Cease
 * partait avec le sous-code 0, que ce soit pour
 * `execute router clear bgp all` ou pour un voisin retire.
 *
 * Autorites :
 * - RFC 4486 §3 et §4 : Administrative Shutdown (2), Peer De-configured
 *   (3), Administrative Reset (4), Other Configuration Change (6),
 *   Connection Collision Resolution (7) ; un voisin retire SHOULD recevoir
 *   « Peer De-configured », une remise a zero administrative
 *   « Administrative Reset », une remise a zero due a un autre changement
 *   de configuration « Other Configuration Change » ;
 * - RFC 4271 §6.7 : la NOTIFICATION Cease ferme la connexion BGP ;
 * - RFC 4273 : bgpPeerLastError porte le code et le sous-code de la
 *   derniere NOTIFICATION de la session, et
 *   bgpBackwardTransNotification les transporte.
 * Retirer toute la configuration BGP retire chaque voisin : c'est
 * « Peer De-configured », comme pour un voisin retire seul. `set as 0`
 * n'est admis qu'une fois les voisins retires, si bien qu'aucune session
 * ne reste a fermer : ce chemin n'a pas de cas observable.
 *
 * Discrimination, mesuree sur le commit de base (18727540) avec ce
 * fichier copie : 4 des 5 cas tombent. Passe des deux cotes le TEMOIN :
 * le pairage s'etablit sur le cable.
 *
 * probe-fortigate-routing-traps attendait 0600 apres une remise a zero
 * administrative : il encodait le sous-code 0 que le moteur envoyait
 * faute de mieux, et attend desormais 0604.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import type { SnmpMessage } from '@/network/snmp/types';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<void> {
  for (const command of commands) await device.executeCommand(command);
}

const BGP_BACKWARD = '1.3.6.1.2.1.15.0.2';
const BGP_PEER_LAST_ERROR = '1.3.6.1.2.1.15.3.1.14.10.1.0.2';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

function lastErrorsReported(nms: LinuxPC): string[] {
  const reported: string[] = [];
  nms.udpBind(162, ({ udp }) => {
    const message = udp.payload as SnmpMessage | undefined;
    if (message?.type !== 'snmp' || message.pduType === 'trap-v1') return;
    if (String(message.varBindings[1]?.value.value) !== BGP_BACKWARD) return;
    const error = message.varBindings.find(({ oid }) => oid === BGP_PEER_LAST_ERROR)?.value.value;
    if (error instanceof Uint8Array) {
      reported.push([...error].map((byte) => byte.toString(16).padStart(2, '0')).join(''));
    }
  }, 'snmptrapd');
  return reported;
}

async function peering() {
  const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const neighbour = new CiscoRouter('R1', 200, 0);
  const nms = new LinuxPC('linux-pc', 'NMS');
  new Cable('nms-fgt').connect(nms.getPorts()[0], firewall.getPort('port1')!);
  new Cable('transit').connect(firewall.getPort('port2')!, neighbour.getPort('GigabitEthernet0/0')!);
  await type(firewall, ['config system interface',
    'edit port1', 'set ip 10.0.0.1 255.255.255.0', 'set allowaccess ping snmp', 'next',
    'edit port2', 'set ip 10.1.0.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config system snmp sysinfo', 'set status enable', 'end',
    'config system snmp community', 'edit 1', 'set name "public"',
    'config hosts', 'edit 1', 'set ip 10.0.0.10 255.255.255.255', 'next', 'end', 'next', 'end']);
  await type(nms, ['sudo ip addr add 10.0.0.10/24 dev eth0', 'sudo ip link set eth0 up']);
  await type(neighbour, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.1.0.2 255.255.255.0', 'no shutdown', 'exit',
    'router bgp 65002', 'bgp router-id 2.2.2.2', 'neighbor 10.1.0.1 remote-as 65001', 'end']);
  await type(firewall, ['config router bgp', 'set as 65001', 'set router-id 1.1.1.1',
    'config neighbor', 'edit "10.1.0.2"', 'set remote-as 65002', 'next', 'end', 'end']);
  clock.advance(120_000);
  return { firewall, neighbour, errors: lastErrorsReported(nms) };
}

const seenByNeighbour = (neighbour: CiscoRouter) => neighbour.executeCommand('show ip bgp neighbors 10.1.0.1');

describe('reconfiguring the FortiGate\'s BGP closes its sessions', () => {
  it('WITNESS: the peering comes up over the cable', async () => {
    const { neighbour } = await peering();
    expect(await seenByNeighbour(neighbour)).toContain('BGP state = Established');
  });

  it('a new local AS takes the Cisco peer out of Established at once', async () => {
    const { firewall, neighbour } = await peering();
    await type(firewall, ['config router bgp', 'set as 65009', 'end']);
    expect(await seenByNeighbour(neighbour)).not.toContain('BGP state = Established');
  });
});

describe('each Cease carries its RFC 4486 subcode', () => {
  it('a new local AS is Other Configuration Change (6/6)', async () => {
    const { firewall, errors } = await peering();
    await type(firewall, ['config router bgp', 'set as 65009', 'end']);
    expect(errors).toEqual(['0606']);
  });

  it('a hard clear is Administrative Reset (6/4)', async () => {
    const { firewall, errors } = await peering();
    await firewall.executeCommand('execute router clear bgp all');
    expect(errors).toEqual(['0604']);
  });

  it('a neighbour removed from the configuration is Peer De-configured (6/3)', async () => {
    const { firewall, errors } = await peering();
    await type(firewall, ['config router bgp', 'config neighbor', 'delete "10.1.0.2"', 'end', 'end']);
    expect(errors).toEqual(['0603']);
  });
});
