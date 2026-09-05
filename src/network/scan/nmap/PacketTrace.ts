import {
  ETHERTYPE_ARP, ETHERTYPE_IPV4, IP_PROTO_ICMP, IP_PROTO_TCP, IP_PROTO_UDP,
  icmpTypeNumber,
  type ARPPacket, type EthernetFrame, type ICMPPacket, type IPv4Packet,
  type UDPPacket,
} from '@/network/core/types';
import { IPV4_FLAG_MF } from '@/network/core/Ipv4Fragmentation';
import type { TcpSegment, TcpWireOutcome } from '@/network/tcp/types';

/**
 * `--packet-trace` : ce que le balayage met sur le fil, rendu comme
 * `PacketTrace` (`tcpip.cc`) et `ippackethdrinfo`
 * (`libnetutil/packettrace.cc`) le rendent.
 */

export type TraceDirection = 'SENT' | 'RCVD';

function stamp(elapsedSeconds: number): string {
  return `(${elapsedSeconds.toFixed(4)}s)`;
}

/**
 * `tcpflagsinfo` (`packettrace.cc:451`) : six combinaisons par un
 * `switch`, puis un ordre de repli S, F, R, P, A, U, E, C — qui n'est PAS
 * celui de `tcpdump`, ou le FIN precede le SYN.
 */
const TRACE_FLAG_ORDER: ReadonlyArray<[keyof TcpSegment['flags'], string]> = [
  ['syn', 'S'], ['fin', 'F'], ['rst', 'R'], ['psh', 'P'],
  ['ack', 'A'], ['urg', 'U'], ['ece', 'E'], ['cwr', 'C'],
];

export function traceTcpFlags(flags: TcpSegment['flags']): string {
  let letters = '';
  for (const [name, letter] of TRACE_FLAG_ORDER) if (flags[name]) letters += letter;
  return letters;
}

/**
 * `LOW_DETAIL` (`packettrace.cc:556`) : `"ttl=%d id=%hu iplen=%hu%s %s%s%s"`.
 * Les trois derniers champs sont vides tant que l'en-tete ne porte pas
 * d'options, ce qui laisse une ESPACE avant le crochet fermant.
 */
function ipBlock(packet: IPv4Packet): string {
  const more = (packet.flags & IPV4_FLAG_MF) !== 0;
  const frag = packet.fragmentOffset > 0 || more
    ? ` frag offset=${packet.fragmentOffset * 8}${more ? '+' : ''}`
    : '';
  return `IP [ttl=${packet.ttl} id=${packet.identification} `
    + `iplen=${packet.totalLength}${frag} ]`;
}

function tcpBlock(packet: IPv4Packet, seg: TcpSegment): string {
  const flags = traceTcpFlags(seg.flags);
  const ack = seg.flags.ack ? ` ack=${seg.acknowledgement >>> 0}` : '';
  const endpoints = `${packet.sourceIP}:${seg.sourcePort}`
    + ` > ${packet.destinationIP}:${seg.destinationPort}`;
  return `TCP [${endpoints}${flags === '' ? '' : ` ${flags}`}`
    + ` seq=${seg.sequence >>> 0}${ack}]`;
}

function udpBlock(packet: IPv4Packet, udp: UDPPacket): string {
  return `UDP ${packet.sourceIP}:${udp.sourcePort} > `
    + `${packet.destinationIP}:${udp.destinationPort}`;
}

/**
 * `icmppackethdrinfo` (`packettrace.cc:852`) : le libelle du type, puis
 * `(type=%d/code=%d)`, puis les champs propres au message — vides pour
 * tout ce qui n'est pas un echo, d'ou l'espace avant le crochet.
 */
const ICMP_LABEL: Readonly<Record<string, string>> = {
  'echo-reply': 'Echo reply',
  'echo-request': 'Echo request',
  redirect: 'Redirect',
};

function icmpLabel(icmp: ICMPPacket): string {
  if (icmp.icmpType === 'time-exceeded') {
    if (icmp.code === 0) return 'TTL=0 during transit';
    if (icmp.code === 1) return 'TTL=0 during reassembly';
    return 'Time exceeded';
  }
  if (icmp.icmpType === 'destination-unreachable') {
    return DESTINATION_UNREACHABLE[icmp.code] ?? 'Destination unreachable';
  }
  return ICMP_LABEL[icmp.icmpType] ?? 'Unknown type';
}

const DESTINATION_UNREACHABLE: Readonly<Record<number, string>> = {
  2: 'Protocol unreachable',
  3: 'Port unreachable',
  4: 'Fragmentation required',
  13: 'Communication administratively prohibited by filtering',
};

function icmpBlock(packet: IPv4Packet, icmp: ICMPPacket): string {
  const echo = icmp.icmpType === 'echo-request' || icmp.icmpType === 'echo-reply';
  const fields = echo ? `id=${icmp.id} seq=${icmp.sequence}` : '';
  return `ICMP [${packet.sourceIP} > ${packet.destinationIP} ${icmpLabel(icmp)} `
    + `(type=${icmpTypeNumber(icmp.icmpType)}/code=${icmp.code}) ${fields}]`;
}

function protocolBlock(packet: IPv4Packet): string | null {
  const payload = packet.payload as { type?: string } | undefined;
  if (packet.protocol === IP_PROTO_TCP && payload?.type === 'tcp') {
    return tcpBlock(packet, payload as unknown as TcpSegment);
  }
  if (packet.protocol === IP_PROTO_UDP && payload?.type === 'udp') {
    return udpBlock(packet, payload as unknown as UDPPacket);
  }
  if (packet.protocol === IP_PROTO_ICMP && payload?.type === 'icmp') {
    return icmpBlock(packet, payload as unknown as ICMPPacket);
  }
  return null;
}

/**
 * `traceArp` (`tcpip.cc:157`). La MAC est ecrite en `%02X`, donc en
 * majuscules.
 */
function arpLine(direction: TraceDirection, elapsed: number, arp: ARPPacket): string {
  const body = arp.operation === 'request'
    ? `who-has ${arp.targetIP} tell ${arp.senderIP}`
    : `reply ${arp.senderIP} is-at ${arp.senderMAC.toString().toUpperCase()}`;
  return `${direction} ${stamp(elapsed)} ARP ${body}`;
}

/**
 * Rend la ligne d'une trame, ou `null` quand elle ne concerne aucune des
 * cibles : `nmap` n'observe que ce que son propre filtre laisse passer,
 * donc le trafic de fond du poste n'y parait pas.
 */
export function traceFrameLine(
  direction: TraceDirection, elapsed: number,
  frame: EthernetFrame, targets: ReadonlySet<string>,
  connectScan = false,
): string | null {
  if (frame.etherType === ETHERTYPE_ARP) {
    const arp = frame.payload as ARPPacket;
    if (arp?.type !== 'arp') return null;
    const concerns = targets.has(arp.targetIP.toString())
      || targets.has(arp.senderIP.toString());
    return concerns ? arpLine(direction, elapsed, arp) : null;
  }
  if (frame.etherType !== ETHERTYPE_IPV4) return null;
  const packet = frame.payload as IPv4Packet;
  if (packet?.type !== 'ipv4') return null;
  const peer = direction === 'SENT'
    ? packet.destinationIP.toString() : packet.sourceIP.toString();
  if (!targets.has(peer)) return null;
  if (connectScan && packet.protocol === IP_PROTO_TCP) return null;
  const block = protocolBlock(packet);
  // Un fragment NON INITIAL ne porte aucun en-tete de transport a lire,
  // et `ippackethdrinfo` le rend alors par son seul bloc IP — ce que ses
  // trois lecteurs de protocole disent chacun en sortant sur `frag_off`
  // (`packettrace.cc:800`, `:864`, `:1169`).
  if (!block) {
    return packet.fragmentOffset > 0
      ? `${direction} ${stamp(elapsed)} ${ipBlock(packet)}` : null;
  }
  return `${direction} ${stamp(elapsed)} ${block} ${ipBlock(packet)}`;
}

/**
 * `socket_strerror` de l'errno que `connect()` a rendu. Un balayage
 * CONNECTE ne produit que cette ligne : `connect()` laisse le noyau
 * emettre les paquets, donc `nmap` ne les voit jamais passer.
 */
const CONNECT_ERRNO: Readonly<Record<TcpWireOutcome, string>> = {
  open: 'Connected',
  refused: 'Connection refused',
  timeout: 'Connection timed out',
  unreachable: 'Network is unreachable',
  prohibited: 'Permission denied',
};

export function traceConnectLine(
  elapsed: number, proto: 'TCP' | 'UDP', ip: string, port: number,
  outcome: TcpWireOutcome,
): string {
  return `CONN ${stamp(elapsed)} ${proto} localhost > ${ip}:${port}`
    + ` => ${CONNECT_ERRNO[outcome]}`;
}
