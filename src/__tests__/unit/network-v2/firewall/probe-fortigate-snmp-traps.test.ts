/**
 * La FortiGate envoie les traps que `config system snmp` demande, sur le
 * fil, en SNMPv1 et en SNMPv2c.
 *
 * Mesure de depart : aucune trap ne partait. `trap-v1-status`,
 * `trap-v2c-status`, les ports `lport`/`rport`, `events`, et pour chaque
 * hote `source-ip`, `interface-select-method`, `interface` et `vrf-select`
 * etaient refuses (« unknown attribute ») ; les seuils de `sysinfo`
 * aussi. L'agent partage ne savait emettre qu'une trap v2c, depuis le
 * port 161, sans PDU de trap v1.
 *
 * Autorites :
 * - la reference CLI FortiOS 7.6.3 pour les attributs, leurs bornes, les
 *   evenements et leurs valeurs par defaut ; « No traps will be sent when
 *   IP type is subnet » ;
 * - le guide d'administration 7.6.3, dont les transcriptions snmptrapd
 *   fixent la forme : linkDown/linkUp portent ifIndex, ifAdminStatus,
 *   ifOperStatus, fnSysSerial et sysName, partent de 162 vers 162, en v1
 *   (« SNMPv2-MIB::snmpTraps Link Down Trap (0) ») puis en v2c ; une trap
 *   d'entreprise v1 porte le modele comme entreprise (« fgt140P Enterprise
 *   Specific Trap (602) », « fgModel.1001 … (102) ») ; les deux messages
 *   de fnTrapMemThreshold (« free memory percentage is too low »,
 *   « freeable memory percentage is too high ») ;
 * - FORTINET-CORE-MIB et FORTINET-FORTIGATE-MIB (revision 202504040000Z)
 *   pour les OID des notifications et de leurs objets ; des traps reelles
 *   (donnees de test LibreNMS) pour le suffixe `.0` des objets VPN et IPS
 *   et fgIpsTrapSigId = rang de l'anomalie (tcp_src_session = 2) ;
 * - RFC 3416 §4.2.6 (sysUpTime.0 et snmpTrapOID.0 en tete d'une trap v2) et
 *   RFC 3584 §3.2 (conversion v2 → v1 des traps generiques).
 * Le libelle de fnGenTrapMsg pour la memoire UTILISEE n'est atteste nulle
 * part : la trap part sans lui plutot qu'avec un texte invente.
 *
 * Discrimination, mesuree sur le commit de base (02777570) avec ce fichier
 * copie : 22 des 23 cas tombent. « WITNESS: the manager reaches the
 * firewall » passe des deux cotes et prouve que le banc est sain ; chaque
 * cas qui attend l'ABSENCE d'une trap porte dans le meme laboratoire un
 * temoin qui, lui, en recoit une.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Cable } from '@/network/hardware/Cable';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EICAR_SIGNATURE } from '@/network/devices/firewall/inspection/ContentInspector';
import type { SnmpMessage } from '@/network/snmp/types';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<void> {
  for (const command of commands) await device.executeCommand(command);
}

interface Received {
  readonly source: string;
  readonly sourcePort: number;
  readonly destinationPort: number;
  readonly message: SnmpMessage;
}

function listen(nms: LinuxPC, port = 162): Received[] {
  const received: Received[] = [];
  nms.udpBind(port, ({ sourceIP, udp }) => {
    const message = udp.payload as SnmpMessage | undefined;
    if (message?.type !== 'snmp') return;
    received.push({
      source: sourceIP.toString(), sourcePort: udp.sourcePort, destinationPort: udp.destinationPort, message,
    });
  }, 'snmptrapd');
  return received;
}

function summary(received: Received): string {
  const { message } = received;
  if (message.pduType === 'trap-v1') {
    return `v1 ${message.community} ${message.enterprise} ${message.genericTrap}/${message.specificTrap}`;
  }
  return `v2c ${message.community} ${String(message.varBindings[1]?.value.value)}`;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const LINK_DOWN = '1.3.6.1.6.3.1.1.5.3';
const LINK_UP = '1.3.6.1.6.3.1.1.5.4';
const SNMP_TRAPS = '1.3.6.1.6.3.1.1.5';
const FGT_VM64 = '1.3.6.1.4.1.12356.101.1.30';
const FN_SYS_SERIAL = '1.3.6.1.4.1.12356.100.1.1.1.0';
const SYS_NAME = '1.3.6.1.2.1.1.5.0';
const MEMORY_THRESHOLD = '1.3.6.1.4.1.12356.100.1.3.0.102';
const FN_GEN_TRAP_MSG = '1.3.6.1.4.1.12356.100.1.3.1.1';
const NMS_HOST = ['set ip 10.0.0.10 255.255.255.255'];

function community(
  id: number, name: string, hosts: readonly (readonly string[])[], settings: readonly string[] = [],
): string[] {
  return ['config system snmp community', `edit ${id}`, `set name "${name}"`, ...settings, 'config hosts',
    ...hosts.flatMap((host, index) => [`edit ${index + 1}`, ...host, 'next']), 'end', 'next', 'end'];
}

async function lab(snmp: readonly string[] = community(1, 'public', [NMS_HOST])) {
  const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const nms = new LinuxPC('linux-pc', 'NMS');
  const peer = new LinuxPC('linux-pc', 'PEER');
  new Cable('nms-fgt').connect(nms.getPorts()[0], firewall.getPort('port1')!);
  new Cable('peer-fgt').connect(peer.getPorts()[0], firewall.getPort('port2')!);
  await type(firewall, ['config system interface',
    'edit port1', 'set ip 10.0.0.1 255.255.255.0', 'set allowaccess ping snmp', 'next',
    'edit port2', 'set ip 10.1.0.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port3', 'set ip 10.2.0.1 255.255.255.0', 'next', 'end',
    'config system snmp sysinfo', 'set status enable', 'end', ...snmp]);
  await type(nms, ['sudo ip addr add 10.0.0.10/24 dev eth0', 'sudo ip link set eth0 up',
    'sudo ip route add default via 10.0.0.1']);
  await type(peer, ['sudo ip addr add 10.1.0.10/24 dev eth0', 'sudo ip link set eth0 up',
    'sudo ip route add default via 10.1.0.1']);
  return { firewall, nms, peer, traps: listen(nms) };
}

async function takeDown(firewall: Shell, port: string): Promise<void> {
  await type(firewall, ['config system interface', `edit ${port}`, 'set status down', 'next', 'end']);
  await settle();
}

describe('a FortiGate sends the traps config system snmp asks for', () => {
  it('WITNESS: the manager reaches the firewall', async () => {
    const { nms } = await lab();
    expect(await nms.executeCommand('ping -c 1 10.0.0.1')).toContain(' 0% packet loss');
  });

  it('an interface taken down sends linkDown as an SNMPv1 then an SNMPv2c trap, from 162 to 162', async () => {
    const { firewall, traps } = await lab();
    await takeDown(firewall, 'port2');
    expect(traps.map(summary)).toEqual([`v1 public ${SNMP_TRAPS} 2/0`, `v2c public ${LINK_DOWN}`]);
    for (const trap of traps) {
      expect([trap.source, trap.sourcePort, trap.destinationPort]).toEqual(['10.0.0.1', 162, 162]);
    }
    const [v1] = traps;
    expect(v1.message.pduType === 'trap-v1' && v1.message.agentAddress.toString()).toBe('10.0.0.1');
  });

  it('linkDown names the interface, its states, the serial and the hostname the device reports', async () => {
    const { firewall, traps } = await lab();
    const serial = /^Serial-Number: (\S+)$/m.exec(await firewall.executeCommand('get system status'))?.[1];
    await takeDown(firewall, 'port2');
    const objects = traps[0].message.varBindings.map((binding) => `${binding.oid}=${String(binding.value.value)}`);
    expect(objects).toEqual([
      '1.3.6.1.2.1.2.2.1.1.2=2', '1.3.6.1.2.1.2.2.1.7.2=2', '1.3.6.1.2.1.2.2.1.8.2=2',
      `${FN_SYS_SERIAL}=${serial}`, `${SYS_NAME}=FGT`,
    ]);
    const v2 = traps[1].message.varBindings.map((binding) => binding.oid);
    expect(v2.slice(0, 2)).toEqual(['1.3.6.1.2.1.1.3.0', '1.3.6.1.6.3.1.1.4.1.0']);
  });

  it('bringing the interface back up sends linkUp with both states up', async () => {
    const { firewall, traps } = await lab();
    await takeDown(firewall, 'port2');
    traps.length = 0;
    await type(firewall, ['config system interface', 'edit port2', 'set status up', 'next', 'end']);
    await settle();
    expect(traps.map(summary)).toEqual([`v1 public ${SNMP_TRAPS} 3/0`, `v2c public ${LINK_UP}`]);
    expect(traps[0].message.varBindings.slice(1, 3).map((binding) => binding.value.value)).toEqual([1, 1]);
  });

  it('an address change sends fnTrapIpChange, fgFmTrapIfChange and entConfigChange, with the model as SNMPv1 enterprise', async () => {
    const { firewall, traps } = await lab();
    await type(firewall, ['config system interface', 'edit port3', 'set ip 10.3.0.1 255.255.255.0', 'next', 'end']);
    await settle();
    expect(traps.map(summary)).toEqual([
      `v1 public ${FGT_VM64} 6/201`, 'v2c public 1.3.6.1.4.1.12356.100.1.3.0.201',
      `v1 public ${FGT_VM64} 6/1004`, 'v2c public 1.3.6.1.4.1.12356.101.6.0.1004',
      `v1 public ${FGT_VM64} 6/1`, 'v2c public 1.3.6.1.2.1.47.2.0.1',
    ]);
    const fmObjects = traps[2].message.varBindings.map((binding) => `${binding.oid}=${String(binding.value.value)}`);
    expect(fmObjects).toContain('1.3.6.1.2.1.31.1.1.1.1.3=port3');
    expect(fmObjects).toContain('1.3.6.1.4.1.12356.101.6.2.1.0=10.3.0.1');
    expect(fmObjects).toContain('1.3.6.1.4.1.12356.101.6.2.2.0=255.255.255.0');
  });

  it('events decides which enterprise traps leave, while linkDown still does', async () => {
    const { firewall, traps } = await lab(community(1, 'public', [NMS_HOST], ['set events cpu-high']));
    await type(firewall, ['config system interface', 'edit port3', 'set ip 10.3.0.1 255.255.255.0', 'next', 'end']);
    await settle();
    expect(traps).toEqual([]);
    await takeDown(firewall, 'port2');
    expect(traps.map(summary)).toEqual([`v1 public ${SNMP_TRAPS} 2/0`, `v2c public ${LINK_DOWN}`]);
  });

  it('trap-v1-status disable leaves only the SNMPv2c trap', async () => {
    const { firewall, traps } = await lab(community(1, 'public', [NMS_HOST], ['set trap-v1-status disable']));
    await takeDown(firewall, 'port2');
    expect(traps.map(summary)).toEqual([`v2c public ${LINK_DOWN}`]);
  });

  it('trap-v2c-lport and trap-v2c-rport move the SNMPv2c trap, not the SNMPv1 one', async () => {
    const { firewall, nms, traps } = await lab(community(1, 'public', [NMS_HOST],
      ['set trap-v2c-lport 2162', 'set trap-v2c-rport 1162']));
    const moved = listen(nms, 1162);
    await takeDown(firewall, 'port2');
    expect(traps.map(summary)).toEqual([`v1 public ${SNMP_TRAPS} 2/0`]);
    expect(moved.map((trap) => `${summary(trap)} ${trap.sourcePort}>${trap.destinationPort}`))
      .toEqual([`v2c public ${LINK_DOWN} 2162>1162`]);
  });

  it('a host that only queries receives no trap, a trap host does', async () => {
    const { firewall, traps } = await lab([
      ...community(1, 'queries', [[...NMS_HOST, 'set host-type query']]),
      ...community(2, 'traps', [[...NMS_HOST, 'set host-type trap']]),
    ]);
    await takeDown(firewall, 'port2');
    expect(traps.map(summary)).toEqual([`v1 traps ${SNMP_TRAPS} 2/0`, `v2c traps ${LINK_DOWN}`]);
  });

  it('a host given as a subnet receives no trap, as the reference says', async () => {
    const { firewall, traps } = await lab([
      ...community(1, 'subnet', [['set ip 10.0.0.0 255.255.255.0']]),
      ...community(2, 'single', [NMS_HOST]),
    ]);
    await takeDown(firewall, 'port2');
    expect(traps.map(summary)).toEqual([`v1 single ${SNMP_TRAPS} 2/0`, `v2c single ${LINK_DOWN}`]);
  });

  it('source-ip is the trap source address and the SNMPv1 agent address', async () => {
    const { firewall, traps } = await lab(community(1, 'public', [[...NMS_HOST, 'set source-ip 10.2.0.1']]));
    await takeDown(firewall, 'port2');
    expect(traps.map((trap) => trap.source)).toEqual(['10.2.0.1', '10.2.0.1']);
    const [v1] = traps;
    expect(v1.message.pduType === 'trap-v1' && v1.message.agentAddress.toString()).toBe('10.2.0.1');
  });

  it('interface-select-method specify sends through the named interface only', async () => {
    const { firewall, traps } = await lab([
      ...community(1, 'pinned', [[...NMS_HOST, 'set interface-select-method specify', 'set interface port3']]),
      ...community(2, 'routed', [NMS_HOST]),
    ]);
    await takeDown(firewall, 'port2');
    expect(traps.map(summary)).toEqual([`v1 routed ${SNMP_TRAPS} 2/0`, `v2c routed ${LINK_DOWN}`]);
  });

  it('a VRF that owns no interface has no route to the manager', async () => {
    const { firewall, traps } = await lab([
      ...community(1, 'vrf5', [[...NMS_HOST, 'set vrf-select 5']]),
      ...community(2, 'vrf0', [NMS_HOST]),
    ]);
    await takeDown(firewall, 'port2');
    expect(traps.map(summary)).toEqual([`v1 vrf0 ${SNMP_TRAPS} 2/0`, `v2c vrf0 ${LINK_DOWN}`]);
  });

  it('SNMP disabled in sysinfo sends no trap until it is enabled', async () => {
    const { firewall, traps } = await lab();
    await type(firewall, ['config system snmp sysinfo', 'set status disable', 'end']);
    await takeDown(firewall, 'port2');
    expect(traps).toEqual([]);
    await type(firewall, ['config system snmp sysinfo', 'set status enable', 'end']);
    await takeDown(firewall, 'port3');
    expect(traps.map(summary)).toEqual([`v1 public ${SNMP_TRAPS} 2/0`, `v2c public ${LINK_DOWN}`]);
  });

  it('free memory under trap-free-memory-threshold sends fnTrapMemThreshold once, with the guide message', async () => {
    const { firewall, nms, traps } = await lab();
    await type(firewall, ['config system snmp sysinfo', 'set trap-free-memory-threshold 100', 'end']);
    await nms.executeCommand('ping -c 2 10.0.0.1');
    await settle();
    const memory = traps.filter((trap) => summary(trap) === `v2c public ${MEMORY_THRESHOLD}`);
    expect(memory).toHaveLength(1);
    expect(memory[0].message.varBindings.map((binding) => `${binding.oid}=${String(binding.value.value)}`))
      .toContain(`${FN_GEN_TRAP_MSG}=free memory percentage is too low`);
  });

  it('used memory over trap-low-memory-threshold sends fnTrapMemThreshold without an unattested message', async () => {
    const { firewall, nms, traps } = await lab();
    await type(firewall, ['config system snmp sysinfo', 'set trap-low-memory-threshold 1', 'end']);
    await nms.executeCommand('ping -c 1 10.0.0.1');
    await settle();
    const memory = traps.filter((trap) => summary(trap) === `v2c public ${MEMORY_THRESHOLD}`);
    expect(memory).toHaveLength(1);
    expect(memory[0].message.varBindings.map((binding) => binding.oid)).not.toContain(FN_GEN_TRAP_MSG);
    expect(traps.map(summary)).toContain(`v1 public ${FGT_VM64} 6/102`);
  });

  it('an ICMP flood over the DoS threshold sends fgTrapIpsAnomaly with the anomaly, its rank and the source', async () => {
    const { firewall, nms, traps } = await lab();
    await type(firewall, [
      'config firewall policy', 'edit 1', 'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set schedule "always"',
      'set action accept', 'next', 'end',
      'config firewall DoS-policy', 'edit 1', 'set interface "port1"', 'set srcaddr "all"',
      'set dstaddr "all"', 'set service "ALL"', 'config anomaly', 'edit "icmp_flood"',
      'set status enable', 'set action pass', 'set threshold 3', 'next', 'end', 'next', 'end',
    ]);
    await nms.executeCommand('ping -c 5 -i 0.2 10.1.0.10');
    await settle();
    const anomaly = traps.find((trap) => summary(trap) === 'v2c public 1.3.6.1.4.1.12356.101.2.0.504');
    expect(anomaly?.message.varBindings.slice(2).map((binding) => `${binding.oid}=${String(binding.value.value)}`))
      .toEqual([
        expect.stringMatching(new RegExp(`^${FN_SYS_SERIAL.replace(/\./g, '\\.')}=`)),
        `${SYS_NAME}=FGT`,
        '1.3.6.1.4.1.12356.101.9.3.1.0=8',
        '1.3.6.1.4.1.12356.101.9.3.2.0=10.0.0.10',
        '1.3.6.1.4.1.12356.101.9.3.3.0=icmp_flood',
      ]);
  });
});

describe('a FortiGate reports its memory conserve mode and its cluster by trap', () => {
  it('entering conserve mode sends fgTrapAvEnterConserve', async () => {
    const { firewall, traps } = await lab();
    const performance = await firewall.executeCommand('get system performance status');
    const totalKib = Number(/Memory: (\d+)k total/.exec(performance)?.[1]);
    const usedKib = Number(/(\d+)k used/.exec(performance)?.[1]);
    await type(firewall, ['config system global', 'set memory-use-threshold-extreme 95',
      'set memory-use-threshold-red 80', 'set memory-use-threshold-green 70', 'end',
      'config log memory global-setting',
      `set max-size ${Math.max(98304, (Math.round(totalKib * 0.85) - usedKib) * 1024)}`, 'end']);
    expect(await firewall.executeCommand('diagnose hardware sysinfo conserve')).toMatch(/memory conserve mode:\s+on$/m);
    await settle();
    expect(traps.map(summary)).toContain('v2c public 1.3.6.1.4.1.12356.101.2.0.605');
  });

  it('a unit that loses its primary reports the heartbeat loss, the member down, then its takeover', async () => {
    const survivor = new FortiGate('firewall-fortinet', 'FGT-A', 0, 0);
    const primary = new FortiGate('firewall-fortinet', 'FGT-B', 0, 0);
    const nms = new LinuxPC('linux-pc', 'NMS');
    const lan = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
    new Cable('nms').connect(nms.getPorts()[0], lan.getPorts()[0]);
    new Cable('a').connect(survivor.getPort('port1')!, lan.getPorts()[1]);
    new Cable('b').connect(primary.getPort('port1')!, lan.getPorts()[2]);
    const heartbeat = new Cable('heartbeat');
    heartbeat.connect(survivor.getPort('port7')!, primary.getPort('port7')!);
    for (const [unit, priority] of [[survivor, 100], [primary, 200]] as const) {
      await type(unit, ['config system interface', 'edit port1', 'set ip 10.0.0.1 255.255.255.0',
        'set allowaccess ping snmp', 'next', 'end',
        'config system snmp sysinfo', 'set status enable', 'end', ...community(1, 'public', [NMS_HOST]),
        'config system ha', 'set group-name "cluster"', 'set group-id 10', 'set mode a-p',
        'set password "SecretHA"', 'set hbdev "port7" 50', `set priority ${priority}`, 'end']);
    }
    await type(nms, ['sudo ip addr add 10.0.0.10/24 dev eth0', 'sudo ip link set eth0 up']);
    const traps = listen(nms);
    for (let round = 0; round < 3; round++) { survivor.getHa().tick(); primary.getHa().tick(); }
    expect([survivor.getHa().role(), primary.getHa().role()]).toEqual(['slave', 'master']);
    expect(traps.map(summary)).toContain('v2c public 1.3.6.1.4.1.12356.101.2.0.405');
    traps.length = 0;
    heartbeat.disconnect();
    for (let round = 0; round < 10; round++) survivor.getHa().tick();
    await settle();
    const fromSurvivor = traps.filter((trap) => trap.message.pduType === 'trap-v2'
      && trap.message.varBindings.some((binding) => binding.oid === FN_SYS_SERIAL
        && [survivor.serialNumber(), primary.serialNumber()].includes(String(binding.value.value)))
      && String(trap.message.varBindings[1].value.value).startsWith('1.3.6.1.4.1.12356.101.2.0.40'));
    expect(fromSurvivor.map((trap) => {
      const oid = String(trap.message.varBindings[1].value.value);
      const serial = trap.message.varBindings.find((binding) => binding.oid === FN_SYS_SERIAL)?.value.value;
      return `${oid.slice(oid.lastIndexOf('.') + 1)} ${serial === survivor.serialNumber() ? 'survivor' : 'primary'}`;
    })).toEqual(['403 survivor', '404 primary', '401 survivor']);
  });
});

describe('a FortiGate reports what its inspection finds and skips by trap', () => {
  async function inspectionLab(inspectionMode: 'proxy' | 'flow') {
    const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    const nms = new LinuxPC('linux-pc', 'NMS');
    const web = new LinuxServer('linux-server', 'WEB', 0, 0);
    new Cable('nms-fgt').connect(nms.getPorts()[0], firewall.getPort('port1')!);
    new Cable('web-fgt').connect(web.getPort('eth0')!, firewall.getPort('port2')!);
    await type(firewall, ['config system interface',
      'edit port1', 'set ip 10.0.0.1 255.255.255.0', 'set allowaccess ping snmp', 'next',
      'edit port2', 'set ip 10.1.0.1 255.255.255.0', 'next', 'end',
      'config system snmp sysinfo', 'set status enable', 'end', ...community(1, 'public', [NMS_HOST]),
      'config antivirus profile', 'edit "AV"', 'config http', 'set av-scan block', 'end', 'next', 'end',
      'config firewall policy', 'edit 1', 'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set schedule "always"',
      'set service "ALL"', `set inspection-mode ${inspectionMode}`, 'set utm-status enable',
      'set av-profile "AV"', 'next', 'end']);
    await type(nms, ['sudo ip addr add 10.0.0.10/24 dev eth0', 'sudo ip link set eth0 up',
      'sudo ip route add default via 10.0.0.1']);
    await type(web, ['ip link set eth0 up', 'ip addr add 10.1.0.10/24 dev eth0',
      'ip route add default via 10.1.0.1', 'systemctl start nginx']);
    return { firewall, nms, traps: listen(nms) };
  }

  async function conserve(firewall: Shell): Promise<void> {
    const performance = await firewall.executeCommand('get system performance status');
    const totalKib = Number(/Memory: (\d+)k total/.exec(performance)?.[1]);
    const usedKib = Number(/(\d+)k used/.exec(performance)?.[1]);
    await type(firewall, ['config system global', 'set memory-use-threshold-extreme 95',
      'set memory-use-threshold-red 80', 'set memory-use-threshold-green 70', 'end',
      'config log memory global-setting',
      `set max-size ${Math.max(98304, (Math.round(totalKib * 0.85) - usedKib) * 1024)}`, 'end']);
  }

  it('a virus caught in HTTP sends fgTrapAvVirus once, naming the virus', async () => {
    const { nms, traps } = await inspectionLab('proxy');
    expect(await nms.executeCommand(`curl -sS -d '${EICAR_SIGNATURE}' http://10.1.0.10/`))
      .not.toContain('Welcome to nginx!');
    await settle();
    const virus = traps.filter((trap) => summary(trap) === 'v2c public 1.3.6.1.4.1.12356.101.2.0.601');
    expect(virus).toHaveLength(1);
    expect(virus[0].message.varBindings.map((binding) => `${binding.oid}=${String(binding.value.value)}`))
      .toContain('1.3.6.1.4.1.12356.101.8.3.1.0=EICAR_TEST_FILE');
    expect(traps.map(summary)).toContain(`v1 public ${FGT_VM64} 6/601`);
  });

  it('proxy inspection passed through in conserve mode sends fgTrapAvBypass once', async () => {
    const { firewall, nms, traps } = await inspectionLab('proxy');
    await conserve(firewall);
    expect(await nms.executeCommand('curl -sS http://10.1.0.10/')).toContain('Welcome to nginx!');
    expect(await nms.executeCommand('curl -sS http://10.1.0.10/')).toContain('Welcome to nginx!');
    await settle();
    expect(traps.map(summary).filter((line) => line === 'v2c public 1.3.6.1.4.1.12356.101.2.0.606'))
      .toHaveLength(1);
  });

  it('flow inspection failing open in conserve mode sends fgTrapIpsFailOpen once', async () => {
    const { firewall, nms, traps } = await inspectionLab('flow');
    await conserve(firewall);
    await type(firewall, ['config ips global', 'set fail-open enable', 'end']);
    expect(await nms.executeCommand('curl -sS http://10.1.0.10/')).toContain('Welcome to nginx!');
    await settle();
    expect(traps.map(summary).filter((line) => line === 'v2c public 1.3.6.1.4.1.12356.101.2.0.506'))
      .toHaveLength(1);
  });
});

describe('a FortiGate reports its VPN tunnels by trap', () => {
  async function tunnelLab() {
    const near = new FortiGate('firewall-fortinet', 'FGT-A', 0, 0);
    const far = new FortiGate('firewall-fortinet', 'FGT-B', 0, 0);
    const nms = new LinuxPC('linux-pc', 'NMS');
    new Cable('nms-a').connect(nms.getPorts()[0], near.getPort('port1')!);
    new Cable('a-b').connect(near.getPort('port2')!, far.getPort('port2')!);
    for (const [device, lan, wan, peer, remoteLan] of [
      [near, '10.0.0.1', '203.0.113.1', '203.0.113.2', '192.168.2'],
      [far, '192.168.2.1', '203.0.113.2', '203.0.113.1', '10.0.0'],
    ] as const) {
      await type(device, ['config system interface',
        'edit port1', `set ip ${lan} 255.255.255.0`, 'set allowaccess ping snmp', 'next',
        'edit port2', `set ip ${wan} 255.255.255.0`, 'set allowaccess ping', 'next', 'end',
        'config vpn ipsec phase1-interface', 'edit "to-peer"', 'set interface "port2"', 'set ike-version 2',
        `set remote-gw ${peer}`, 'set psksecret "SecretPartage2026"', 'set proposal aes256-sha256',
        'set dhgrp 14', 'next', 'end',
        'config vpn ipsec phase2-interface', 'edit "to-peer-p2"', 'set phase1name "to-peer"',
        `set src-subnet ${lan.replace(/\.1$/, '.0')} 255.255.255.0`,
        `set dst-subnet ${remoteLan}.0 255.255.255.0`, 'next', 'end']);
    }
    await type(near, ['config system snmp sysinfo', 'set status enable', 'end', ...community(1, 'public', [NMS_HOST])]);
    await type(nms, ['sudo ip addr add 10.0.0.10/24 dev eth0', 'sudo ip link set eth0 up']);
    return { near, traps: listen(nms) };
  }

  it('a tunnel coming up then going down sends fgTrapVpnTunUp then fgTrapVpnTunDown with both gateways', async () => {
    const { near, traps } = await tunnelLab();
    await near.executeCommand('execute vpn ipsec tunnel up to-peer');
    await settle();
    await near.executeCommand('execute vpn ipsec tunnel down to-peer');
    await settle();
    const vpn = traps.filter((trap) => trap.message.pduType === 'trap-v2')
      .filter((trap) => String(trap.message.varBindings[1]?.value.value).startsWith('1.3.6.1.4.1.12356.101.2.0.30'));
    expect(vpn.map((trap) => String(trap.message.varBindings[1].value.value))).toEqual([
      '1.3.6.1.4.1.12356.101.2.0.301', '1.3.6.1.4.1.12356.101.2.0.302',
    ]);
    expect(vpn[0].message.varBindings.slice(4).map((binding) => `${binding.oid}=${String(binding.value.value)}`))
      .toEqual([
        '1.3.6.1.4.1.12356.101.12.3.2.0=203.0.113.1',
        '1.3.6.1.4.1.12356.101.12.3.3.0=203.0.113.2',
        '1.3.6.1.4.1.12356.101.12.3.4.0=to-peer',
      ]);
  });
});
