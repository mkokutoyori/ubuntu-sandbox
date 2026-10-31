/**
 * Le pare-feu relaie une option IP Timestamp comme un routeur : il y ecrit l'adresse de son interface de sortie et SON
 * heure (millisecondes depuis minuit UT, RFC 791 §3.1), sur son horloge. Mesure de depart : `recordRouteOnEgress` ecrivait
 * Record Route et rien d'autre, donc une option Timestamp traversait le pare-feu intacte, pointeur au depart.
 * Meme maquette que probe-record-route-pare-feu (FortiGate, routeur, deux postes).
 *
 * Discrimine par `git stash` sur src/network : les 2 cas tombent avant (l'import des fonctions de l'option echoue pour
 * tout le fichier) ; le TEMOIN (l'option arrive, pointeur au depart) ne mesure que la maquette.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress, ETHERTYPE_IPV4, createIPv4Packet, IP_PROTO_ICMP, IP_OPTION_TIMESTAMP,
  type EthernetFrame, type ICMPPacket, type IPv4Option, type IPv4Packet,
} from '@/network/core/types';
import { buildTimestampOption, readTimestamp, TIMESTAMP_FLAG_WITH_ADDRESS } from '@/network/layers/internet/Ipv4Options';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { millisecondsSinceUtcMidnight } from '@/network/core/SystemClock';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function type(d: Cmd, cmds: readonly string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

const ECHO: ICMPPacket = {
  type: 'icmp', icmpType: 'echo-request', code: 0, id: 7, sequence: 1, dataSize: 8,
};

function watchIpv4(port: { receiveFrame(f: EthernetFrame): unknown }): () => IPv4Packet[] {
  const seen: IPv4Packet[] = [];
  const original = port.receiveFrame.bind(port);
  (port as unknown as { receiveFrame: unknown }).receiveFrame = (f: EthernetFrame) => {
    if (f.etherType === ETHERTYPE_IPV4) seen.push(f.payload as IPv4Packet);
    return original(f);
  };
  return () => seen;
}

async function lab() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const a = new LinuxPC('linux-pc', 'A', -200, 0);
  const r2 = new CiscoRouter('R2');
  const b = new LinuxPC('linux-pc', 'B', 400, 0);

  new Cable('a-fgt').connect(a.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('fgt-r2').connect(fgt.getPort('port3')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('r2-b').connect(r2.getPort('GigabitEthernet0/1')!, b.getPort('eth0')!);

  await type(fgt, ['config system interface',
    'edit port2', 'set mode static', 'set ip 10.0.0.1 255.255.255.0',
    'set allowaccess ping', 'next',
    'edit port3', 'set mode static', 'set ip 10.0.1.1 255.255.255.0',
    'set allowaccess ping', 'next', 'end',
    'config router static', 'edit 1', 'set dst 10.0.2.0 255.255.255.0',
    'set gateway 10.0.1.2', 'set device "port3"', 'next', 'end',
    'config firewall policy', 'edit 1',
    'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
    'set action accept', 'next', 'end']);
  await type(r2, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.1.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 10.0.0.0 255.255.255.0 10.0.1.1', 'end']);
  await type(a, ['ip link set eth0 up', 'ip addr add 10.0.0.10/24 dev eth0',
    'ip route add default via 10.0.0.1']);
  await type(b, ['ip link set eth0 up', 'ip addr add 10.0.2.10/24 dev eth0',
    'ip route add default via 10.0.2.1']);

  await a.executeCommand('ping -c 1 10.0.2.10');
  return { fgt, a, b, r2 };
}

function inject(fgt: FortiGate, a: LinuxPC, ipOptions: IPv4Option[]): void {
  const packet = createIPv4Packet(
    new IPAddress('10.0.0.10'), new IPAddress('10.0.2.10'),
    IP_PROTO_ICMP, 64, ECHO, 16, { ipOptions });
  fgt.getPort('port2')!.receiveFrame({
    srcMAC: a.getPort('eth0')!.getMAC(),
    dstMAC: fgt.getPort('port2')!.getMAC(),
    etherType: ETHERTYPE_IPV4,
    payload: packet,
  });
}


describe('the firewall stamps a forwarded timestamp option', () => {
  it('the option reaches the target with the pointer at the start — WITNESS', async () => {
    const { fgt, a, b } = await lab();
    const atB = watchIpv4(b.getPort('eth0')!);
    inject(fgt, a, [buildTimestampOption(TIMESTAMP_FLAG_WITH_ADDRESS, 4)]);
    const arrived = atB().find(p => p.options?.some(o => o.type === IP_OPTION_TIMESTAMP));
    expect(arrived).toBeDefined();
  });

  it('the firewall writes its egress address and its own time of day', async () => {
    const { fgt, a, b } = await lab();
    await fgt.executeCommand('execute time 10:00:00');
    await fgt.executeCommand('execute date 2027-01-05');
    const atB = watchIpv4(b.getPort('eth0')!);
    inject(fgt, a, [buildTimestampOption(TIMESTAMP_FLAG_WITH_ADDRESS, 4)]);
    const arrived = atB().find(p => p.options?.some(o => o.type === IP_OPTION_TIMESTAMP))!;
    const [first, second] = readTimestamp(arrived.options!.find(o => o.type === IP_OPTION_TIMESTAMP)!).entries;
    expect(first.address?.toString()).toBe('10.0.1.1');
    expect(Math.abs(first.msOfDay - millisecondsSinceUtcMidnight(fgt.getSystemClockMs()))).toBeLessThan(120_000);
    expect(second.address?.toString()).toBe('10.0.2.1');
  });
});
