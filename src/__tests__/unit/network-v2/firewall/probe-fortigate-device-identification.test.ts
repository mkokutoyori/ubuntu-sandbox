/**
 * La FortiGate identifie les equipements qu'elle entend sur une interface
 * `set device-identification enable`, les liste dans `diagnose user device
 * list`, et signale un nouvel equipement par fgTrapDeviceNew.
 *
 * Mesure de depart (7fdba473) : `set device-identification enable`
 * repondait « command parse error before 'device-identification' /
 * Command fail. Return code -61 » (attribut inconnu sous `config system
 * interface`) ; `diagnose user device list` repondait « Unknown action 0 /
 * Command fail. Return code -61 » ; l'evenement `device-new` se
 * configurait (`set events device-new`) et rien ne l'emettait — le
 * mot-cle filtrait des traps qui n'existaient pas.
 *
 * Autorites :
 * - reference CLI FortiOS 7.6.3, `config system interface` :
 *   device-identification « Enable/disable passively gathering of device
 *   identity information about the devices on the network connected to
 *   this interface », defaut `disable` ;
 * - guide d'administration FortiOS 7.6.0 (IoT detection service), sortie de
 *   `diagnose user device list` : `vd root/0  f8:87:f1:1f:ab:95  gen 26
 *   req OUA/34`, `created 503s  gen 23  seen 102s  lan  gen 7`,
 *   `ip 192.168.1.110  src arp`, `host 'Jasons-iPhone6'  src dhcp`. Les
 *   compteurs `gen` et le drapeau `req` sont internes au demon et leur sens
 *   n'est atteste nulle part : ils ne sont pas rendus ;
 * - guide d'administration FortiOS 7.6.5 (Important SNMP traps), trap
 *   capturee : fgTrapDeviceNew porte fnSysSerial.0, sysName.0,
 *   ifIndex.0 = 0, fgVdEntIndex.0 = 0 (l'index noyau que `vd root/0`
 *   montre), fgDeviceCreated.0 et fgDeviceLastSeen.0 en secondes ecoulees
 *   (Gauge32), fgDeviceMacAddress.0 en `90:6c:ac:f9:97:a0` ;
 * - FORTINET-FORTIGATE-MIB : fgTrapDeviceNew = fgTrapPrefix 1201,
 *   fgDeviceTrapObjects = fnFortiGateMib.18.1 ;
 * - RFC 5227 §2.1.1 : une sonde ARP porte une adresse d'emetteur nulle
 *   pour ne pas polluer les caches des autres hotes ; elle n'annonce donc
 *   aucune adresse (la detection de conflit d'une autre FortiGate, `diagnose
 *   test application miglogd 55`, en emet).
 *
 * Discrimination, mesuree sur le commit de base (7fdba473) avec ce fichier
 * copie : 8 des 9 cas tombent. Passe des deux cotes le TEMOIN : le
 * gestionnaire atteint le pare-feu. Le cas de la sonde ARP tombe aussi sur
 * la branche quand on retire le filtre de l'adresse nulle (`ip 0.0.0.0
 * src arp` s'affichait).
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Cable } from '@/network/hardware/Cable';
import type { SnmpMessage } from '@/network/snmp/types';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<void> {
  for (const command of commands) await device.executeCommand(command);
}

const DEVICE_NEW = '1.3.6.1.4.1.12356.101.2.0.1201';
const FN_SYS_SERIAL = '1.3.6.1.4.1.12356.100.1.1.1.0';
const SYS_NAME = '1.3.6.1.2.1.1.5.0';
const IF_INDEX = '1.3.6.1.2.1.2.2.1.1.0';
const FG_VD_ENT_INDEX = '1.3.6.1.4.1.12356.101.3.2.1.1.1.0';
const FG_DEVICE_CREATED = '1.3.6.1.4.1.12356.101.18.1.2.0';
const FG_DEVICE_LAST_SEEN = '1.3.6.1.4.1.12356.101.18.1.3.0';
const FG_DEVICE_MAC = '1.3.6.1.4.1.12356.101.18.1.1.0';

function listen(nms: LinuxPC): SnmpMessage[] {
  const received: SnmpMessage[] = [];
  nms.udpBind(162, ({ udp }) => {
    const message = udp.payload as SnmpMessage | undefined;
    if (message?.type === 'snmp') received.push(message);
  }, 'snmptrapd');
  return received;
}

const deviceNewV2c = (traps: readonly SnmpMessage[]) => traps.filter((message) =>
  message.pduType !== 'trap-v1' && String(message.varBindings[1]?.value.value) === DEVICE_NEW);

async function lab(events = 'device-new', identified: readonly string[] = ['port2']) {
  const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const nms = new LinuxPC('linux-pc', 'NMS');
  const peer = new LinuxPC('linux-pc', 'PEER');
  new Cable('nms-fgt').connect(nms.getPorts()[0], firewall.getPort('port1')!);
  new Cable('peer-fgt').connect(peer.getPorts()[0], firewall.getPort('port2')!);
  await type(firewall, ['config system interface',
    'edit port1', 'set ip 10.0.0.1 255.255.255.0', 'set allowaccess ping snmp',
    ...(identified.includes('port1') ? ['set device-identification enable'] : []), 'next',
    'edit port2', 'set ip 10.1.0.1 255.255.255.0', 'set allowaccess ping',
    ...(identified.includes('port2') ? ['set device-identification enable'] : []), 'next',
    ...(identified.includes('port3') ? ['edit port3', 'set device-identification enable', 'next'] : []), 'end',
    'config system snmp sysinfo', 'set status enable', 'end',
    'config system snmp community', 'edit 1', 'set name "public"', `set events ${events}`,
    'config hosts', 'edit 1', 'set ip 10.0.0.10 255.255.255.255', 'next', 'end', 'next', 'end']);
  await type(nms, ['sudo ip addr add 10.0.0.10/24 dev eth0', 'sudo ip link set eth0 up']);
  const traps = listen(nms);
  await type(peer, ['sudo ip addr add 10.1.0.10/24 dev eth0', 'sudo ip link set eth0 up']);
  return { firewall, nms, peer, traps };
}

describe('device identification on a FortiGate interface', () => {
  it('WITNESS: the manager reaches the firewall', async () => {
    const { nms } = await lab();
    expect(await nms.executeCommand('ping -c 1 10.0.0.1')).toContain(' 0% packet loss');
  });

  it('device-identification is accepted, defaults to disable, and shows once enabled', async () => {
    const { firewall } = await lab();
    const shown = await firewall.executeCommand('show system interface port2');
    expect(shown).toContain('set device-identification enable');
    expect(await firewall.executeCommand('show system interface port1')).not.toContain('device-identification');
  });

  it('a device heard on an identifying interface is listed with its VDOM, MAC, age, interface and ARP address', async () => {
    const { firewall, peer } = await lab();
    await peer.executeCommand('ping -c 1 10.1.0.1');
    const mac = peer.getPorts()[0].getMAC().toString();
    expect(await firewall.executeCommand('diagnose user device list')).toMatch(new RegExp(
      `^ {4}vd root/0  ${mac}\\n {8}created \\d+s  seen \\d+s  port2\\n {8}ip 10\\.1\\.0\\.10  src arp$`, 'm'));
  });

  it('only interfaces with identification enabled feed the list', async () => {
    const { firewall, nms, peer } = await lab();
    await nms.executeCommand('ping -c 1 10.0.0.1');
    await peer.executeCommand('ping -c 1 10.1.0.1');
    const list = await firewall.executeCommand('diagnose user device list');
    expect(list).toContain(peer.getPorts()[0].getMAC().toString());
    expect(list).not.toContain(nms.getPorts()[0].getMAC().toString());
  });

  it('an ARP probe announces no address: its all-zero sender is not taken for the device address', async () => {
    const { firewall } = await lab('device-new', ['port2', 'port3']);
    const prober = new FortiGate('firewall-fortinet', 'PROBER', 0, 0);
    new Cable('prober-fgt').connect(prober.getPort('port1')!, firewall.getPort('port3')!);
    await type(firewall, ['config system interface', 'edit port3', 'set ip 10.2.0.1 255.255.255.0', 'next', 'end']);
    await type(prober, ['config system interface', 'edit port1', 'set ip 10.2.0.2 255.255.255.0', 'next', 'end']);
    await prober.executeCommand('diagnose test application miglogd 55');
    const list = await firewall.executeCommand('diagnose user device list');
    expect(list).toContain(prober.getPort('port1')!.getMAC().toString());
    expect(list).not.toContain('ip 0.0.0.0');
  });

  it('a DHCP client is listed under the host name it gave', async () => {
    const { firewall, peer } = await lab();
    await type(firewall, ['config system dhcp server', 'edit 1', 'set interface "port2"',
      'set default-gateway 10.1.0.1', 'set netmask 255.255.255.0',
      'config ip-range', 'edit 1', 'set start-ip 10.1.0.100', 'set end-ip 10.1.0.109', 'next', 'end',
      'next', 'end']);
    await peer.executeCommand('sudo ip addr flush dev eth0');
    await peer.executeCommand('sudo dhclient eth0');
    expect(await firewall.executeCommand('diagnose user device list')).toContain("host 'PEER'  src dhcp");
  });
});

describe('fgTrapDeviceNew', () => {
  it('a new device raises the trap with the objects the captured trap carries, in its order', async () => {
    const { peer, traps } = await lab();
    await peer.executeCommand('ping -c 1 10.1.0.1');
    const [trap] = deviceNewV2c(traps);
    expect(trap.varBindings.slice(2).map(({ oid, value }) => `${oid}=${value.type}`)).toEqual([
      `${FN_SYS_SERIAL}=octet-string`, `${SYS_NAME}=octet-string`, `${IF_INDEX}=integer`,
      `${FG_VD_ENT_INDEX}=integer`, `${FG_DEVICE_CREATED}=gauge32`, `${FG_DEVICE_LAST_SEEN}=gauge32`,
      `${FG_DEVICE_MAC}=octet-string`,
    ]);
    const value = (oid: string) => trap.varBindings.find((binding) => binding.oid === oid)?.value.value;
    expect(value(FG_DEVICE_MAC)).toBe(peer.getPorts()[0].getMAC().toString());
    expect(value(FG_VD_ENT_INDEX)).toBe(0);
    expect(value(IF_INDEX)).toBe(0);
  });

  it('a device already known raises no second trap', async () => {
    const { peer, traps } = await lab();
    await peer.executeCommand('ping -c 1 10.1.0.1');
    await peer.executeCommand('ping -c 1 10.1.0.1');
    expect(deviceNewV2c(traps)).toHaveLength(1);
  });

  it('a community that does not ask for device-new receives none, while the device is still listed', async () => {
    const { firewall, peer, traps } = await lab('cpu-high');
    await peer.executeCommand('ping -c 1 10.1.0.1');
    expect(await firewall.executeCommand('diagnose user device list'))
      .toContain(peer.getPorts()[0].getMAC().toString());
    expect(deviceNewV2c(traps)).toEqual([]);
  });
});
