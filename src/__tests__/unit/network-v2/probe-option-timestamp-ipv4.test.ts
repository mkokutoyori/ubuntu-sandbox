/**
 * L'option IP Timestamp (type 68, RFC 791 §3.1) : construite, ecrite par chaque equipement qui relaie ou repond, sur SON
 * horloge, et relue. Mesure de depart : le codec la transportait comme n'importe quelle option mais aucun equipement n'y
 * ecrivait (Router, SwitchSvi et Firewall ecrivaient Record Route et rien d'autre ; buildEchoReply ne reflechissait que
 * Record Route et le routage par la source), si bien qu'une requete d'echo portant l'option arrivait et revenait VIDE.
 * L'ancienne raison du renvoi (« le RTT vaut 0 ms ») est levee : les equipements lisent leur horloge, et deux routeurs
 * regles sur des heures differentes l'etablissent ci-dessous.
 * Les regles suivent le noyau Linux (net/ipv4/ip_options.c, v5.15, `ip_options_compile`) : drapeau 0 ne pose que l'heure,
 * 1 pose l'adresse puis l'heure, 3 (prespecifie) ne pose l'heure que si l'adresse nommee est CELLE de l'equipement, et
 * quand la place manque le compteur de depassement (quartet haut de l'octet 4) croit jusqu'a 15, ou l'option est fautive.
 * L'heure est exprimee en millisecondes depuis minuit UT (RFC 791).
 *
 * Discrimine par `git stash` sur src/network : les 8 cas tombent avant, parce que le module n'exporte pas encore les
 * fonctions de l'option (l'import echoue pour tout le fichier). Mesure isolee des cas de laboratoire, hors import : les
 * equipements n'ecrivaient rien, et le TEMOIN « le datagramme traverse le laboratoire avec l'option » passe des deux
 * cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress, ETHERTYPE_IPV4,
  createIPv4Packet, IP_PROTO_ICMP, IP_OPTION_TIMESTAMP,
  type EthernetFrame, type ICMPPacket, type IPv4Option, type IPv4Packet,
} from '@/network/core/types';
import {
  buildTimestampOption, readTimestamp, recordTimestamp,
  TIMESTAMP_FLAG_ONLY, TIMESTAMP_FLAG_WITH_ADDRESS, TIMESTAMP_FLAG_PRESPECIFIED,
} from '@/network/layers/internet/Ipv4Options';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const ECHO: ICMPPacket = {
  type: 'icmp', icmpType: 'echo-request', code: 0, id: 7, sequence: 1, dataSize: 8,
};

function packetWith(option: IPv4Option): IPv4Packet {
  return createIPv4Packet(
    new IPAddress('10.0.0.10'), new IPAddress('10.0.2.10'), IP_PROTO_ICMP, 64, ECHO, 16, { ipOptions: [option] });
}

function stamper(address: string, msOfDay: number, owned: readonly string[] = [address]) {
  return { address: new IPAddress(address), msOfDay, owns: (named: IPAddress) => owned.includes(named.toString()) };
}

function timestampOf(packet: IPv4Packet): IPv4Option {
  const option = packet.options?.find(o => o.type === IP_OPTION_TIMESTAMP);
  if (!option) throw new Error('no timestamp option');
  return option;
}

describe('recordTimestamp — the kernel rules', () => {
  it('flag 0 writes the time only and advances the pointer by four', () => {
    const outcome = recordTimestamp(packetWith(buildTimestampOption(TIMESTAMP_FLAG_ONLY, 2)), stamper('10.0.1.1', 36_000_000));
    expect(outcome.kind).toBe('recorded');
    if (outcome.kind !== 'recorded') return;
    const reading = readTimestamp(timestampOf(outcome.packet));
    expect(reading.entries).toEqual([{ address: null, msOfDay: 36_000_000, nonStandard: false }]);
    expect(timestampOf(outcome.packet).data[0]).toBe(9);
  });

  it('flag 1 writes the address then the time', () => {
    const outcome = recordTimestamp(packetWith(buildTimestampOption(TIMESTAMP_FLAG_WITH_ADDRESS, 2)), stamper('10.0.1.1', 123));
    if (outcome.kind !== 'recorded') throw new Error('not recorded');
    const [entry] = readTimestamp(timestampOf(outcome.packet)).entries;
    expect(entry.address?.toString()).toBe('10.0.1.1');
    expect(entry.msOfDay).toBe(123);
  });

  it('flag 3 stamps only the entry that names this device, and leaves the others for their owners', () => {
    const named = [new IPAddress('10.0.2.1'), new IPAddress('10.0.1.1')];
    const option = buildTimestampOption(TIMESTAMP_FLAG_PRESPECIFIED, 0, named);
    const elsewhere = recordTimestamp(packetWith(option), stamper('10.0.1.1', 5, ['10.0.1.1']));
    expect(elsewhere.kind).toBe('unchanged');
    const owner = recordTimestamp(packetWith(option), stamper('10.0.2.1', 5, ['10.0.2.1']));
    if (owner.kind !== 'recorded') throw new Error('not recorded');
    expect(readTimestamp(timestampOf(owner.packet)).entries[0]).toEqual({ address: named[0], msOfDay: 5, nonStandard: false });
  });

  it('a full option counts the hops it could not record, up to fifteen, then is faulty', () => {
    let packet = packetWith(buildTimestampOption(TIMESTAMP_FLAG_ONLY, 1));
    const first = recordTimestamp(packet, stamper('10.0.1.1', 1));
    if (first.kind !== 'recorded') throw new Error('not recorded');
    packet = first.packet;
    for (let missed = 1; missed <= 15; missed++) {
      const next = recordTimestamp(packet, stamper('10.0.1.2', 2));
      if (next.kind !== 'recorded') throw new Error(`hop ${missed} not counted`);
      packet = next.packet;
      expect(readTimestamp(timestampOf(packet)).overflow).toBe(missed);
    }
    expect(recordTimestamp(packet, stamper('10.0.1.2', 2)).kind).toBe('error');
  });

  it('a pointer below five is faulty', () => {
    const broken: IPv4Option = { type: IP_OPTION_TIMESTAMP, data: [4, 0, 0, 0, 0, 0] };
    expect(recordTimestamp(packetWith(broken), stamper('10.0.1.1', 1)).kind).toBe('error');
  });
});

function watchIpv4(port: { receiveFrame(f: EthernetFrame): unknown }): () => IPv4Packet[] {
  const seen: IPv4Packet[] = [];
  const original = port.receiveFrame.bind(port);
  (port as unknown as { receiveFrame: unknown }).receiveFrame = (f: EthernetFrame) => {
    if (f.etherType === ETHERTYPE_IPV4) seen.push(f.payload as IPv4Packet);
    return original(f);
  };
  return () => seen;
}

async function type(d: { executeCommand(cmd: string): Promise<string> }, cmds: readonly string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

async function lab() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const a = new LinuxPC('linux-pc', 'A', -200, 0);
  const b = new LinuxPC('linux-pc', 'B', 200, 0);
  new Cable('a-r1').connect(a.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('r1-r2').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('r2-b').connect(r2.getPort('GigabitEthernet0/1')!, b.getPort('eth0')!);
  await type(r1, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 10.0.2.0 255.255.255.0 10.0.1.2', 'end']);
  await type(r2, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.1.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 10.0.0.0 255.255.255.0 10.0.1.1', 'end']);
  await type(a, ['ip link set eth0 up', 'ip addr add 10.0.0.10/24 dev eth0', 'ip route add default via 10.0.0.1']);
  await type(b, ['ip link set eth0 up', 'ip addr add 10.0.2.10/24 dev eth0', 'ip route add default via 10.0.2.1']);
  await a.executeCommand('ping -c 1 10.0.2.10');
  await r1.executeCommand('clock set 10:00:00 5 January 2027');
  await r2.executeCommand('clock set 14:00:00 5 January 2027');
  return { r1, r2, a, b };
}

function send(r1: CiscoRouter, a: LinuxPC, option: IPv4Option): void {
  const packet = createIPv4Packet(
    new IPAddress('10.0.0.10'), new IPAddress('10.0.2.10'), IP_PROTO_ICMP, 64, ECHO, 16, { ipOptions: [option] });
  r1.getPort('GigabitEthernet0/0')!.receiveFrame({
    srcMAC: a.getPort('eth0')!.getMAC(), dstMAC: r1.getPort('GigabitEthernet0/0')!.getMAC(),
    etherType: ETHERTYPE_IPV4, payload: packet,
  });
}

const TEN_HOURS = 10 * 3_600_000;
const FOURTEEN_HOURS = 14 * 3_600_000;
const TOLERANCE_MS = 60_000;

describe('routers stamp on their own clock, and the echo reply comes back stamped', () => {
  it('a datagram carrying the option crosses the lab with the pointer at the start — WITNESS', async () => {
    const { r1, a, b } = await lab();
    const atB = watchIpv4(b.getPort('eth0')!);
    send(r1, a, buildTimestampOption(TIMESTAMP_FLAG_WITH_ADDRESS, 4));
    const arrived = atB().find(p => p.options?.some(o => o.type === IP_OPTION_TIMESTAMP));
    expect(arrived).toBeDefined();
  });

  it('each router writes its egress address and ITS time', async () => {
    const { r1, a, b } = await lab();
    const atB = watchIpv4(b.getPort('eth0')!);
    send(r1, a, buildTimestampOption(TIMESTAMP_FLAG_WITH_ADDRESS, 4));
    const arrived = atB().find(p => p.options?.some(o => o.type === IP_OPTION_TIMESTAMP))!;
    const entries = readTimestamp(timestampOf(arrived)).entries;
    expect(entries.map(e => e.address?.toString())).toEqual(['10.0.1.1', '10.0.2.1']);
    expect(Math.abs(entries[0].msOfDay - TEN_HOURS)).toBeLessThan(TOLERANCE_MS);
    expect(Math.abs(entries[1].msOfDay - FOURTEEN_HOURS)).toBeLessThan(TOLERANCE_MS);
  });

  it('the echo reply carries the route back: a Linux target stamps twice, the routers on the way back find no room, and the hops they miss are counted', async () => {
    const { r1, a } = await lab();
    const atA = watchIpv4(a.getPort('eth0')!);
    send(r1, a, buildTimestampOption(TIMESTAMP_FLAG_WITH_ADDRESS, 4));
    const reply = atA().find(p => p.protocol === IP_PROTO_ICMP
      && (p.payload as ICMPPacket).icmpType === 'echo-reply' && p.options?.some(o => o.type === IP_OPTION_TIMESTAMP))!;
    expect(reply).toBeDefined();
    const reading = readTimestamp(timestampOf(reply));
    expect(reading.entries.map(e => e.address?.toString())).toEqual(['10.0.1.1', '10.0.2.1', '10.0.2.10', '10.0.2.10']);
    expect(reading.overflow).toBe(2);
  });
});
