import type { IPv4Packet } from '../../../core/types';
import { buildEchoRequest, echoReplyOf, ECHO_DATA_BYTES } from '../l3/IcmpEcho';

export interface FirewallPingEgress {
  readonly iface: string;
  readonly gateway: string | undefined;
  readonly source: string;
}

export interface FirewallPingDeps {
  resolve(destination: string): FirewallPingEgress | null;
  send(iface: string, packet: IPv4Packet, gateway: string | undefined): void;
  onReply(payload: { fromIp: string; toIp: string; id: number; seq: number; ttl: number }): void;
}

export const PING_DEFAULT_COUNT = 5;

interface Attente { answered: boolean; ttl: number }

export class FirewallPing {
  private readonly pending = new Map<string, Attente>();
  private nextIdentifier = 1;

  constructor(private readonly deps: FirewallPingDeps) {}

  observeReply(packet: IPv4Packet): boolean {
    const icmp = echoReplyOf(packet);
    if (!icmp) return false;
    const attente = this.pending.get(`${icmp.id}:${icmp.sequence}`);
    if (!attente) return false;
    attente.answered = true;
    attente.ttl = packet.ttl;
    this.deps.onReply({
      fromIp: packet.sourceIP.toString(), toIp: packet.destinationIP.toString(),
      id: icmp.id, seq: icmp.sequence, ttl: packet.ttl,
    });
    return true;
  }

  run(target: string, count = PING_DEFAULT_COUNT): string {
    const egress = this.deps.resolve(target);
    if (!egress) return `Unable to send the ICMP packet: No route to destination.`;

    const identifier = this.nextIdentifier++;
    const lignes = [`PING ${target} (${target}): ${ECHO_DATA_BYTES} data bytes`];
    const attentes: Attente[] = [];

    for (let sequence = 0; sequence < count; sequence++) {
      const attente: Attente = { answered: false, ttl: 0 };
      attentes.push(attente);
      const cle = `${identifier}:${sequence}`;
      this.pending.set(cle, attente);
      this.deps.send(
        egress.iface,
        buildEchoRequest(egress.source, target, identifier, sequence),
        egress.gateway);
      this.pending.delete(cle);
      if (attente.answered) {
        lignes.push(`${ECHO_DATA_BYTES + 8} bytes from ${target}: `
          + `icmp_seq=${sequence} ttl=${attente.ttl} time=0.0 ms`);
      }
    }

    const recus = attentes.filter(a => a.answered).length;
    lignes.push('');
    lignes.push(`--- ${target} ping statistics ---`);
    lignes.push(`${count} packets transmitted, ${recus} packets received, `
      + `${Math.round(((count - recus) / count) * 100)}% packet loss`);
    if (recus > 0) lignes.push('round-trip min/avg/max = 0.0/0.0/0.0 ms');
    return lignes.join('\n');
  }
}
