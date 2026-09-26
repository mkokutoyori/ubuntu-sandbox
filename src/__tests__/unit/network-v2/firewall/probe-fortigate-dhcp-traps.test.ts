/**
 * La FortiGate signale son service DHCP par fgTrapDhcp et sert l'usage de
 * ses baux en SNMP.
 *
 * Mesure de depart : l'evenement `dhcp` fait partie des evenements par
 * defaut de `config system snmp community`, mais rien ne levait ces faits,
 * et l'arbre fgDhcp (1.3.6.1.4.1.12356.101.23) n'etait pas servi.
 *
 * Autorites :
 * - le guide d'administration FortiOS 7.6.3 (« SNMP traps and query for
 *   monitoring DHCP pool ») : trois traps — l'usage du pool atteint 90 %,
 *   le serveur detecte une adresse deja utilisee, le client DHCP recoit un
 *   NAK — et une requete sur 1.3.6.1.4.1.12356.101.23, dont la
 *   transcription snmpwalk montre fgDhcpServerNumber.0 et
 *   fgDhcpLeaseUsage.<vdom>.<serveur> (deux composantes d'index, la ou
 *   la clause INDEX de la MIB n'en declare qu'une : la transcription
 *   l'emporte) ;
 * - la note technique Fortinet « Identifying the DHCP trap information on
 *   SNMP manager » : fgDhcpTrapType (runOutOfIPPool 1, conflictIP 2,
 *   receivedNAK 3), fgDhcpTrapMessage et fgDhcpServerId, instances `.0` ;
 * - FORTINET-FORTIGATE-MIB : fgTrapDhcp (fgTrapPrefix 1301) et ses objets.
 *   Le texte de fgDhcpTrapMessage n'est atteste nulle part : la trap part
 *   sans lui plutot qu'avec un texte invente ;
 * - Microsoft, « How DHCP Technology Works » : le client DHCP de Windows
 *   verifie par ARP l'adresse que le serveur lui accorde et la refuse par
 *   DHCPDECLINE si un autre hote repond. Le dhclient d'Ubuntu ne fait pas
 *   cette verification ;
 * - RFC 5227 §2.1.1 : la sonde ARP porte l'adresse d'emetteur 0.0.0.0, et
 *   un hote qui la recoit ne la met pas dans son cache ;
 * - RFC 2131 §3.2 et §4.3.2 : un client en INIT-REBOOT redemande son
 *   ancienne adresse ; le serveur repond DHCPNAK si elle n'est pas sur le
 *   bon reseau.
 *
 * Trouve en chemin, et ferme :
 * - le client DHCP partage comptait un NAK et publiait
 *   `dhcp.nak.received` pour un REQUEST reste SANS reponse, et en
 *   INIT-REBOOT il ne distinguait pas le NAK du silence : un vrai refus y
 *   etait invisible. Seul un DHCPNAK recu compte desormais ;
 * - aucun hote ne verifiait par ARP l'adresse accordee, donc aucun
 *   DHCPDECLINE ne partait jamais d'un laboratoire cable ; le client
 *   Windows la verifie par une sonde RFC 5227 posee sur le fil ;
 * - un hote qui recevait une requete ARP d'emetteur 0.0.0.0 mettait
 *   « 0.0.0.0 » dans son cache. Le cas Windows le mesure seul : la
 *   ligne retablie, le squatteur affiche `0.0.0.0 dev eth0 lladdr …`.
 *
 * Discrimination, mesuree sur le commit de base (6987f250) avec ce fichier
 * copie : 5 des 8 cas tombent. Passent des deux cotes : le TEMOIN (un
 * client obtient un bail de la FortiGate) ; « an Ubuntu client … does not
 * check », dont l'absence de trap ne prouve rien sur la base, mais qui
 * garde que le dhclient d'Ubuntu prend l'adresse sans verifier — il
 * discrimine le cas Windows, meme laboratoire au client pres ; et le
 * TEMOIN « a REQUEST the server refuses is one NAK », que l'ancien client
 * comptait deja, et qui prouve que la paire mesure le comptage et non un
 * banc muet.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import type { SnmpMessage } from '@/network/snmp/types';
import { DHCPClient } from '@/network/dhcp/DHCPClient';
import { DHCPServer } from '@/network/dhcp/DHCPServer';
import { EventBus } from '@/events/EventBus';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<void> {
  for (const command of commands) await device.executeCommand(command);
}

interface Received { readonly message: SnmpMessage }

function listen(nms: LinuxPC): Received[] {
  const received: Received[] = [];
  nms.udpBind(162, ({ udp }) => {
    const message = udp.payload as SnmpMessage | undefined;
    if (message?.type === 'snmp') received.push({ message });
  }, 'snmptrapd');
  return received;
}

const FGT_VM64 = '1.3.6.1.4.1.12356.101.1.30';
const FG_TRAP_DHCP = '1.3.6.1.4.1.12356.101.2.0.1301';
const FN_SYS_SERIAL = '1.3.6.1.4.1.12356.100.1.1.1.0';
const SYS_NAME = '1.3.6.1.2.1.1.5.0';
const IF_NAME = '1.3.6.1.2.1.31.1.1.1.1';
const FG_VD_ENT_NAME = '1.3.6.1.4.1.12356.101.3.2.1.1.2';
const FG_DHCP_TRAP_TYPE = '1.3.6.1.4.1.12356.101.23.3.1.0';
const FG_DHCP_SERVER_ID = '1.3.6.1.4.1.12356.101.23.3.3.0';

const dhcpTraps = (traps: readonly Received[]) => traps.filter(({ message }) =>
  message.pduType !== 'trap-v1' && String(message.varBindings[1]?.value.value) === FG_TRAP_DHCP);

const dhcpTrapsV1 = (traps: readonly Received[]) => traps.filter(({ message }) =>
  message.pduType === 'trap-v1' && message.enterprise === FGT_VM64 && message.specificTrap === 1301);

function objects(received: Received): string[] {
  return received.message.varBindings.slice(2).map(({ oid, value }) => `${oid}=${String(value.value)}`);
}

function trapType(received: Received): number {
  return Number(received.message.varBindings.find(({ oid }) => oid === FG_DHCP_TRAP_TYPE)?.value.value);
}

async function managedFirewall() {
  const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const nms = new LinuxPC('linux-pc', 'NMS');
  const lan = new GenericSwitch('switch-generic', 'LAN', 100, 0);
  new Cable('nms-fgt').connect(nms.getPorts()[0], firewall.getPort('port1')!);
  new Cable('fgt-lan').connect(firewall.getPort('port2')!, lan.getPorts()[0]);
  await type(firewall, ['config system interface',
    'edit port1', 'set ip 10.0.0.1 255.255.255.0', 'set allowaccess ping snmp', 'next',
    'edit port2', 'set ip 10.1.0.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config system snmp sysinfo', 'set status enable', 'end',
    'config system snmp community', 'edit 1', 'set name "public"',
    'config hosts', 'edit 1', 'set ip 10.0.0.10 255.255.255.255', 'next', 'end', 'next', 'end',
    'config system dhcp server', 'edit 1', 'set interface "port2"',
    'set default-gateway 10.1.0.1', 'set netmask 255.255.255.0',
    'config ip-range', 'edit 1', 'set start-ip 10.1.0.100', 'set end-ip 10.1.0.109', 'next', 'end',
    'next', 'end']);
  await type(nms, ['sudo ip addr add 10.0.0.10/24 dev eth0', 'sudo ip link set eth0 up']);
  let nextPort = 1;
  const plug = <T extends LinuxPC | WindowsPC>(host: T): T => {
    new Cable(`lan-${nextPort}`).connect(host.getPorts()[0], lan.getPorts()[nextPort]);
    nextPort += 1;
    return host;
  };
  return { firewall, nms, traps: listen(nms), plug };
}

async function leaseClient(plug: (host: LinuxPC) => LinuxPC, name: string): Promise<LinuxPC> {
  const client = plug(new LinuxPC('linux-pc', name));
  await type(client, ['sudo dhclient eth0']);
  return client;
}

describe('a FortiGate reports its DHCP service with fgTrapDhcp', () => {
  it('WITNESS: a client on port2 takes a lease from the FortiGate', async () => {
    const { plug } = await managedFirewall();
    const client = await leaseClient(plug, 'C1');
    expect(await client.executeCommand('ip -4 addr show eth0')).toContain('inet 10.1.0.1');
  });

  it('eight leases out of ten send nothing; the ninth reaches 90 % and sends runOutOfIPPool once', async () => {
    const { traps, plug } = await managedFirewall();
    for (let index = 1; index <= 8; index++) await leaseClient(plug, `C${index}`);
    expect(dhcpTraps(traps)).toEqual([]);
    await leaseClient(plug, 'C9');
    await leaseClient(plug, 'C10');
    const reported = dhcpTraps(traps);
    expect(reported).toHaveLength(1);
    expect(objects(reported[0])).toEqual([
      expect.stringMatching(new RegExp(`^${FN_SYS_SERIAL}=`)),
      `${SYS_NAME}=FGT`,
      `${IF_NAME}.2=port2`,
      `${FG_VD_ENT_NAME}.1=root`,
      `${FG_DHCP_SERVER_ID}=1`,
      `${FG_DHCP_TRAP_TYPE}=1`,
    ]);
    expect(dhcpTrapsV1(traps)).toHaveLength(1);
  });

  it('a Windows client that finds its acknowledged address answering ARP declines it, and the FortiGate reports conflictIP', async () => {
    const { traps, plug } = await managedFirewall();
    const squatter = plug(new LinuxPC('linux-pc', 'SQUATTER'));
    await type(squatter, ['sudo ip addr add 10.1.0.100/24 dev eth0', 'sudo ip link set eth0 up']);
    const windows = plug(new WindowsPC('windows-pc', 'WIN'));
    await windows.executeCommand('ipconfig /renew');
    expect(dhcpTraps(traps).map(trapType)).toEqual([2]);
    expect(await squatter.executeCommand('ip neigh show')).not.toContain('0.0.0.0');
  });

  it('an Ubuntu client in the same situation does not check, and nothing is reported', async () => {
    const { traps, plug } = await managedFirewall();
    const squatter = plug(new LinuxPC('linux-pc', 'SQUATTER'));
    await type(squatter, ['sudo ip addr add 10.1.0.100/24 dev eth0', 'sudo ip link set eth0 up']);
    const ubuntu = await leaseClient(plug, 'UBUNTU');
    expect(await ubuntu.executeCommand('ip -4 addr show eth0')).toContain('inet 10.1.0.100');
    expect(dhcpTraps(traps)).toEqual([]);
  });

  it('the lease usage is served as the guide walks it: the server count, then the usage per VDOM and server', async () => {
    const { nms, plug } = await managedFirewall();
    await leaseClient(plug, 'C1');
    const walk = await nms.executeCommand('snmpwalk -v2c -c public 10.0.0.1 1.3.6.1.4.1.12356.101.23');
    expect(walk.split('\n').slice(0, 2)).toEqual([
      'iso.3.6.1.4.1.12356.101.23.1.1.0 = INTEGER: 1',
      'iso.3.6.1.4.1.12356.101.23.2.1.1.2.1.1 = INTEGER: 10',
    ]);
  });
});

describe('a FortiGate DHCP client interface reports the NAK it receives', () => {
  it('an interface moved to another network asks for its old address, is refused, and reports receivedNAK', async () => {
    const { firewall, traps } = await managedFirewall();
    const upstream = new CiscoRouter('R1', 200, 0);
    new Cable('fgt-r1').connect(firewall.getPort('port3')!, upstream.getPort('GigabitEthernet0/0')!);
    await type(upstream, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 203.0.113.1 255.255.255.0', 'no shutdown', 'exit',
      'ip dhcp excluded-address 203.0.113.1 203.0.113.99',
      'ip dhcp pool WAN', 'network 203.0.113.0 255.255.255.0', 'default-router 203.0.113.1', 'end']);
    await type(firewall, ['config system interface', 'edit "port3"', 'set mode dhcp', 'next', 'end']);
    expect(firewall.getInterfaceTable().get('port3')?.ip).toMatch(/^203\.0\.113\./);
    expect(dhcpTraps(traps)).toEqual([]);

    await type(upstream, ['configure terminal', 'no ip dhcp pool WAN',
      'interface GigabitEthernet0/0', 'ip address 198.51.100.1 255.255.255.0', 'exit',
      'ip dhcp excluded-address 198.51.100.1 198.51.100.99',
      'ip dhcp pool WAN2', 'network 198.51.100.0 255.255.255.0', 'default-router 198.51.100.1', 'end']);
    await firewall.executeCommand('execute interface dhcpclient-renew port3');

    const reported = dhcpTraps(traps);
    expect(reported.map(trapType)).toEqual([3]);
    expect(objects(reported[0])).toContain(`${IF_NAME}.3=port3`);
    expect(objects(reported[0]).some((binding) => binding.startsWith(FG_DHCP_SERVER_ID))).toBe(false);
    expect(firewall.getInterfaceTable().get('port3')?.ip).toMatch(/^198\.51\.100\./);
  });
});

function directLease(betweenOfferAndRequest: (server: DHCPServer, offered: string) => void): number {
  const bus = new EventBus();
  const server = new DHCPServer();
  server.setServerIdentifier('10.1.0.1');
  server.createPool('LAN');
  server.configurePoolNetwork('LAN', '10.1.0.0', '255.255.255.0');
  const client = new DHCPClient(() => 'aa:bb:cc:00:00:01', () => undefined, () => undefined);
  client.setEventBus(bus);
  client.registerServer(server, '10.1.0.1');
  let naks = 0;
  bus.subscribe('dhcp.nak.received', () => { naks += 1; });
  bus.subscribe('dhcp.offer.received', (event) => { betweenOfferAndRequest(server, event.payload.offeredIp); });
  client.requestLease('eth0');
  return naks;
}

describe('a DHCP client counts only the DHCPNAK a server sends', () => {
  it('WITNESS: a REQUEST the server refuses is one NAK', () => {
    expect(directLease((server, offered) => { server.addExcludedRange(offered, offered); })).toBe(1);
  });

  it('a REQUEST no server answers is no NAK', () => {
    expect(directLease((server) => { server.setServerIdentifier('10.9.9.9'); })).toBe(0);
  });
});
