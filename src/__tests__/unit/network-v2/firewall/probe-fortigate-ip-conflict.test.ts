/**
 * La FortiGate detecte les doublons de ses adresses IPv4, les journalise
 * sous 0100032701 et les signale par fgTrapInterface.
 *
 * Mesure de depart (115bb3c7) : `set ip-conflict-detection` n'existait
 * pas dans `config system global` ; l'ArpService reconnaissait deja une
 * trame ARP portant une adresse de la FortiGate sous une autre MAC, mais
 * personne n'ecoutait ce constat ; l'evenement `interface` des
 * communautes SNMP n'etait leve par rien ; `diagnose test application
 * miglogd 54|55` repondait que seul `dnsproxy` etait modele ; et toute
 * ligne de journal imprimait `vd="root"`, quel que soit le VDOM qui la
 * portait.
 *
 * Autorites :
 * - FortiOS 7.6.0, nouveautes, « Logging detection of duplicate IPv4
 *   addresses » (repris au guide d'administration 7.6) : l'option
 *   `ip-conflict-detection` ; la detection ACTIVE au demarrage, quand
 *   une interface monte, quand sa configuration change et par
 *   `diagnose test app miglogd 55` ; la detection PASSIVE sur l'ARP
 *   gratuit dont l'adresse source est dans le cache sous une autre MAC ;
 *   les deux journaux bruts (logid 0100032701, `vd="vdom1"`, le texte de
 *   `msg`) ; l'evenement SNMP `interface` et la trace `snmpd` qui tente
 *   une trap v1 puis une v2c `interface(1601)` ; les sorties de
 *   `miglogd 54` et `55`. La table de `miglogd 54` y est imprimee avec
 *   des tabulations developpees tous les huit caracteres (colonnes 0, 8,
 *   24, 32, 40 ; `dmzVLAN` finit en 55 et `50` part en 56) : la machine
 *   ecrit des tabulations ;
 * - reference CLI FortiOS 7.6.3 : `ip-conflict-detection`, `disable` par
 *   defaut ;
 * - FORTINET-FORTIGATE-MIB : fgTrapInterface ::= { fgTrapPrefix 1601 },
 *   OBJECTS { fnSysSerial, sysName, fgIntfTrapType, ifName,
 *   fnGenTrapMsg } ; fgIntfTrapType ::= { fgIntfTrapObjects 1 },
 *   ipConflict(1). Le texte de fnGenTrapMsg « depend de la nature de la
 *   trap » et n'est atteste nulle part : la trap part sans lui, comme
 *   fgTrapDhcp part sans fgDhcpTrapMessage ;
 * - RFC 5227 §2.1.1 : la sonde ARP porte l'adresse d'emetteur 0.0.0.0
 *   et une adresse materielle cible nulle.
 *
 * Discrimination, mesuree sur le commit de base (115bb3c7) avec ce
 * fichier copie : 10 des 12 cas tombent. Passent des deux cotes : le
 * TEMOIN (la FortiGate entend l'annonce d'un hote du LAN, sans quoi rien
 * ici ne serait mesurable) ; et « off by default », dont le silence ne
 * prouve rien sur la base, mais qui garde que le defaut reste muet — il
 * discrimine avec le cas suivant, meme laboratoire a l'option pres.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import type { SnmpMessage } from '@/network/snmp/types';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<string[]> {
  const outputs: string[] = [];
  for (const command of commands) outputs.push(await device.executeCommand(command));
  return outputs;
}

const FGT_VM64 = '1.3.6.1.4.1.12356.101.1.30';
const FG_TRAP_INTERFACE = '1.3.6.1.4.1.12356.101.2.0.1601';
const FN_SYS_SERIAL = '1.3.6.1.4.1.12356.100.1.1.1.0';
const SYS_NAME = '1.3.6.1.2.1.1.5.0';
const FG_INTF_TRAP_TYPE = '1.3.6.1.4.1.12356.101.7.6.1.0';
const IF_NAME = '1.3.6.1.2.1.31.1.1.1.1';
const ENABLE_DETECTION = ['config system global', 'set ip-conflict-detection enable', 'end'];

function listen(nms: LinuxPC): SnmpMessage[] {
  const received: SnmpMessage[] = [];
  nms.udpBind(162, ({ udp }) => {
    const message = udp.payload as SnmpMessage | undefined;
    if (message?.type === 'snmp') received.push(message);
  }, 'snmptrapd');
  return received;
}

const interfaceTraps = (traps: readonly SnmpMessage[]) => traps.filter((message) =>
  message.pduType !== 'trap-v1' && String(message.varBindings[1]?.value.value) === FG_TRAP_INTERFACE);

const interfaceTrapsV1 = (traps: readonly SnmpMessage[]) => traps.filter((message) =>
  message.pduType === 'trap-v1' && message.enterprise === FGT_VM64 && message.specificTrap === 1601);

async function conflictLogs(firewall: FortiGate): Promise<string[]> {
  const [, display] = await type(firewall, ['execute log filter category 1', 'execute log display']);
  return display.split('\n').filter((line) => line.includes('logid="0100032701"'));
}

async function managedFirewall(global: readonly string[] = []) {
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
    ...global]);
  await type(nms, ['sudo ip addr add 10.0.0.10/24 dev eth0', 'sudo ip link set eth0 up']);
  let nextPort = 1;
  const plug = (name: string): LinuxPC => {
    const host = new LinuxPC('linux-pc', name);
    new Cable(`lan-${nextPort}`).connect(host.getPorts()[0], lan.getPorts()[nextPort]);
    nextPort += 1;
    return host;
  };
  return { firewall, traps: listen(nms), plug };
}

async function announce(host: LinuxPC, address: string): Promise<void> {
  await type(host, ['sudo ip link set eth0 up', `sudo ip addr add ${address}/24 dev eth0`]);
}

function macOf(host: LinuxPC): string {
  return host.getPorts()[0].getMAC().toString();
}

describe('passive detection: a host announcing an address of the FortiGate', () => {
  it('WITNESS: the FortiGate hears the announcement of a LAN host', async () => {
    const { firewall, plug } = await managedFirewall();
    await announce(plug('H1'), '10.1.0.50');
    expect(await firewall.executeCommand('get system arp')).toMatch(/^10\.1\.0\.50\s.*\sport2$/m);
  });

  it('the option lives in system global and is off by default', async () => {
    const { firewall } = await managedFirewall();
    expect(await firewall.executeCommand('get system global')).toMatch(/^ip-conflict-detection\s*: disable$/m);
  });

  it('off by default: the squatter is neither logged nor trapped', async () => {
    const { firewall, traps, plug } = await managedFirewall();
    await announce(plug('SQUATTER'), '10.1.0.1');
    expect(await conflictLogs(firewall)).toEqual([]);
    expect(interfaceTraps(traps)).toEqual([]);
  });

  it('enabled: the announcement is logged as the guide prints it', async () => {
    const { firewall, plug } = await managedFirewall(ENABLE_DETECTION);
    const squatter = plug('SQUATTER');
    await announce(squatter, '10.1.0.1');
    const port2 = firewall.getPort('port2')!.getMAC().toString();
    const logs = await conflictLogs(firewall);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('logid="0100032701" type="event" subtype="system" level="error" vd="root"');
    expect(logs[0]).toContain('logdesc="Detected IP conflicts on FGT interfaces."'
      + ` msg="Duplicate IP address 10.1.0.1 of MAC ${macOf(squatter)} was detected on interface port2,`
      + ` also in use by port2 (${port2})"`);
  });

  it('and fgTrapInterface leaves in v2c and in v1, with ipConflict(1) and the ifName of port2', async () => {
    const { traps, plug } = await managedFirewall(ENABLE_DETECTION);
    await announce(plug('SQUATTER'), '10.1.0.1');
    const reported = interfaceTraps(traps);
    expect(reported).toHaveLength(1);
    expect(reported[0].varBindings.slice(2).map(({ oid, value }) => `${oid}=${String(value.value)}`)).toEqual([
      expect.stringMatching(new RegExp(`^${FN_SYS_SERIAL}=`)),
      `${SYS_NAME}=FGT`,
      `${FG_INTF_TRAP_TYPE}=1`,
      `${IF_NAME}.2=port2`,
    ]);
    expect(interfaceTrapsV1(traps)).toHaveLength(1);
  });

  it('only a gratuitous ARP is a passive detection: an ordinary request from the squatter adds nothing', async () => {
    const { firewall, plug } = await managedFirewall(ENABLE_DETECTION);
    const squatter = plug('SQUATTER');
    await announce(squatter, '10.1.0.1');
    await squatter.executeCommand('ping -c 1 10.1.0.60');
    expect(await conflictLogs(firewall)).toHaveLength(1);
  });
});

describe('active detection: the FortiGate probes its own addresses', () => {
  async function directHost(firewall: FortiGate): Promise<LinuxPC> {
    const host = new LinuxPC('linux-pc', 'H3');
    new Cable('fgt-h3').connect(firewall.getPort('port3')!, host.getPorts()[0]);
    return host;
  }

  it('giving port3 an address a host already holds is detected on port3', async () => {
    const { firewall } = await managedFirewall(ENABLE_DETECTION);
    const host = await directHost(firewall);
    await announce(host, '10.3.0.5');
    await type(firewall, ['config system interface', 'edit port3', 'set ip 10.3.0.5 255.255.255.0', 'next', 'end']);
    const port3 = firewall.getPort('port3')!.getMAC().toString();
    expect((await conflictLogs(firewall)).map((line) => line.replace(/^.* msg=/, ''))).toEqual([
      `"Duplicate IP address 10.3.0.5 of MAC ${macOf(host)} was detected on interface port3,`
        + ` also in use by port3 (${port3})"`,
    ]);
  });

  it('an interface coming up probes its address', async () => {
    const { firewall } = await managedFirewall(ENABLE_DETECTION);
    const host = await directHost(firewall);
    await type(firewall, ['config system interface', 'edit port3', 'set ip 10.3.0.1 255.255.255.0',
      'set status down', 'next', 'end']);
    await announce(host, '10.3.0.1');
    expect(await conflictLogs(firewall)).toEqual([]);
    await type(firewall, ['config system interface', 'edit port3', 'set status up', 'next', 'end']);
    expect(await conflictLogs(firewall)).toHaveLength(1);
  });

  it('FortiOS starting probes every address', async () => {
    const { firewall } = await managedFirewall(ENABLE_DETECTION);
    const host = await directHost(firewall);
    await type(firewall, ['config system interface', 'edit port3', 'set ip 10.3.0.1 255.255.255.0', 'next', 'end']);
    firewall.powerOff();
    await announce(host, '10.3.0.1');
    firewall.powerOn();
    expect(await conflictLogs(firewall)).toHaveLength(1);
  });

  it('diagnose test application miglogd 55 probes every address and finds a squatter older than the option', async () => {
    const { firewall, plug } = await managedFirewall();
    await announce(plug('SQUATTER'), '10.1.0.1');
    await type(firewall, ENABLE_DETECTION);
    expect(await conflictLogs(firewall)).toEqual([]);
    expect(await firewall.executeCommand('diagnose test application miglogd 55')).toBe(
      'Sending probe for 10.0.0.1 via port1.\nSending probe for 10.1.0.1 via port2.');
    expect(await conflictLogs(firewall)).toHaveLength(1);
  });

  it('diagnose test application miglogd 54 prints the cache, one tab-separated row per address', async () => {
    const { firewall } = await managedFirewall([...ENABLE_DETECTION, 'config system interface',
      'edit lo1', 'set type loopback', 'set ip 10.9.9.9 255.255.255.255', 'next',
      'edit VLAN-100', 'set interface "port2"', 'set vlanid 100', 'set ip 10.100.0.1 255.255.255.0', 'next', 'end']);
    const rows = (await firewall.executeCommand('diagnose test application miglogd 54')).split('\n');
    const port1 = firewall.getPort('port1')!.getMAC().toString();
    const port2 = firewall.getPort('port2')!.getMAC().toString();
    expect(rows.slice(0, 3)).toEqual([
      'index\tIPv4 address\tMAC\tdev\tvlanid',
      `1\t10.0.0.1\t${port1}\tport1`,
      `2\t10.1.0.1\t${port2}\tport2`,
    ]);
    expect(rows.find((row) => row.endsWith('\tlo1'))).toMatch(/^\d+\t10\.9\.9\.9\t00:00:00:00:00:00\tlo1$/);
    const vlan = rows.find((row) => row.includes('\tVLAN-100'))?.split('\t');
    expect([vlan?.[1], vlan?.[3], vlan?.[4]]).toEqual(['10.100.0.1', 'VLAN-100', '100']);
  });
});

describe('the conflict belongs to the VDOM that owns the address', () => {
  it('logged in that VDOM, whose name the vd field carries', async () => {
    const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    const lan = new GenericSwitch('switch-generic', 'LAN', 100, 0);
    new Cable('fgt-lan').connect(firewall.getPort('port2')!, lan.getPorts()[0]);
    await type(firewall, ['config system global', 'set vdom-mode multi-vdom', 'end',
      'config vdom', 'edit customer', 'next', 'end', 'config global',
      'config system interface', 'edit port2', 'set vdom customer', 'set ip 10.1.0.1 255.255.255.0', 'next', 'end',
      ...ENABLE_DETECTION, 'end']);
    const squatter = new LinuxPC('linux-pc', 'SQUATTER');
    new Cable('lan-sq').connect(squatter.getPorts()[0], lan.getPorts()[1]);
    await announce(squatter, '10.1.0.1');
    await firewall.executeCommand('execute enter customer');
    const customer = await conflictLogs(firewall);
    expect(customer).toHaveLength(1);
    expect(customer[0]).toContain('vd="customer"');
    await firewall.executeCommand('execute enter root');
    expect(await conflictLogs(firewall)).toEqual([]);
  });
});
