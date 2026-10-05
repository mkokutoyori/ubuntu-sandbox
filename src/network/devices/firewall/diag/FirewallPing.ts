import type { IPv4Packet } from '../../../core/types';
import { buildEchoRequest, echoReplyOf, ECHO_DATA_BYTES } from '../../../icmp/IcmpEcho';
import { isValidIPv4 } from '../../../core/ip';
import type { PingOptions } from './PingOptions';

export interface FirewallPingEgress {
  readonly iface: string;
  readonly gateway: string | undefined;
  readonly source: string;
}

export interface FirewallPingDeps {
  resolve(destination: string): FirewallPingEgress | null;
  resolveName(name: string): string | null;
  send(iface: string, packet: IPv4Packet, gateway: string | undefined): void;
  onReply(payload: { fromIp: string; toIp: string; id: number; seq: number; ttl: number }): void;
  options?(): PingOptions;
}

export interface PingRun {
  readonly header: string;
  step(sequence: number): string | null;
  statistics(sent: number): string;
}

export const PING_NO_ROUTE = 'Unable to send the ICMP packet: No route to destination.';

export interface PingRefusal {
  readonly refusal: string;
}

export function isPingRefusal(outcome: PingRun | PingRefusal): outcome is PingRefusal {
  return 'refusal' in outcome;
}

export function hostAddressOf(target: string, deps: Pick<FirewallPingDeps, 'resolveName'>): string | null {
  return isValidIPv4(target) ? target : deps.resolveName(target);
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

  begin(target: string): PingRun | PingRefusal {
    const address = hostAddressOf(target, this.deps);
    if (address === null) return { refusal: `ping: cannot resolve ${target}: Unknown host` };
    const egress = this.deps.resolve(address);
    if (!egress) return { refusal: PING_NO_ROUTE };

    const settings = this.deps.options?.().current();
    const dataBytes = settings?.dataSize ?? ECHO_DATA_BYTES;
    const source = settings && settings.sourceAddress !== 'auto'
      ? settings.sourceAddress : egress.source;
    const identifier = this.nextIdentifier++;
    const answered: Attente[] = [];

    return {
      header: `PING ${target} (${address}): ${dataBytes} data bytes`,
      step: (sequence: number) => {
        const attente: Attente = { answered: false, ttl: 0 };
        answered.push(attente);
        const cle = `${identifier}:${sequence}`;
        this.pending.set(cle, attente);
        this.deps.send(
          egress.iface,
          buildEchoRequest(source, address, identifier, sequence),
          egress.gateway);
        this.pending.delete(cle);
        if (!attente.answered) return null;
        return `${dataBytes + 8} bytes from ${address}: `
          + `icmp_seq=${sequence} ttl=${attente.ttl} time=0.0 ms`;
      },
      statistics: (sent: number) => {
        const recus = answered.filter(a => a.answered).length;
        const lignes = [
          '',
          `--- ${target} ping statistics ---`,
          `${sent} packets transmitted, ${recus} packets received, `
            + `${sent === 0 ? 0 : Math.round(((sent - recus) / sent) * 100)}% packet loss`,
        ];
        if (recus > 0) lignes.push('round-trip min/avg/max = 0.0/0.0/0.0 ms');
        return lignes.join('\n');
      },
    };
  }

  defaultCount(): number {
    return this.deps.options?.().current().repeatCount ?? PING_DEFAULT_COUNT;
  }

  run(target: string, count = this.defaultCount()): string {
    const session = this.begin(target);
    if (isPingRefusal(session)) return session.refusal;

    const lignes = [session.header];
    for (let sequence = 0; sequence < count; sequence++) {
      const ligne = session.step(sequence);
      if (ligne !== null) lignes.push(ligne);
    }
    lignes.push(session.statistics(count));
    return lignes.join('\n');
  }
}
