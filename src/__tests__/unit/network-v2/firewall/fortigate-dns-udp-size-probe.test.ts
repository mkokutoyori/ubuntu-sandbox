/**
 * Sonde de la taille des réponses UDP du serveur DNS FortiGate
 * (RFC 1035 §4.2.1, RFC 6891 §6.2.3).
 *
 * Mesuré AVANT correctif (git stash push -- src/network) : 1 cas sur 3 tombe :
 * une réponse de plus de 512 octets partait telle quelle sur UDP, sans TC.
 * Passent avant et après (témoins) : une petite réponse, et la grande réponse avec EDNS 4096.
 */
import { describe, it, expect } from 'vitest';
import { IPAddress } from '@/network/core/types';
import { FirewallDnsServer, type DnsZone } from '@/network/devices/firewall/l3/FirewallDnsServer';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { makeOptRecord } from '@/network/dns/wire/EdnsOptRecord';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

function rig() {
  const replies: DnsMessage[] = [];
  const server = new FirewallDnsServer({
    resolveExternal: () => [],
    reply: (_iface, _to, _port, payload) => { replies.push(decodeDnsMessage(payload)); },
  });
  server.applyInterface({ iface: 'port2', mode: 'recursive' });
  const zone: DnsZone = {
    name: 'lab', domain: 'lab.test', type: 'primary', authoritative: true,
    entries: Array.from({ length: 60 }, (_, i) => ({ hostname: 'big', ip: `192.0.2.${i + 1}`, ttl: 300 })),
  } as never;
  server.applyZone(zone);
  const ask = (qname: string, additionals: DnsMessage['additionals'] = []): void => {
    const query: DnsMessage = {
      id: 1,
      flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
      questions: [{ qname, qtype: RRType.A, qclass: DnsClass.IN }],
      answers: [], authorities: [], additionals,
    };
    const bytes = encodeDnsMessage(query);
    server.handleUdp('port2', { sourceIP: new IPAddress('192.168.10.50') } as never, {
      type: 'udp', sourcePort: 5300, destinationPort: 53, length: 8 + bytes.length, checksum: 0, payload: bytes,
    } as never);
  };
  return { ask, replies };
}

describe('serveur DNS FortiGate — taille UDP', () => {
  it('témoin : une petite réponse n’est pas tronquée', () => {
    const { ask, replies } = rig();
    ask('missing.lab.test');
    expect(replies[0].flags.tc).toBe(false);
  });

  it('une réponse de plus de 512 octets est tronquée avec TC=1', () => {
    const { ask, replies } = rig();
    ask('big.lab.test');
    expect(encodeDnsMessage(replies[0]).length).toBeLessThanOrEqual(512);
    expect(replies[0].flags.tc).toBe(true);
  });

  it('avec EDNS 4096 la même réponse passe entière', () => {
    const { ask, replies } = rig();
    ask('big.lab.test', [makeOptRecord(4096)]);
    expect(replies[0].flags.tc).toBe(false);
    expect(replies[0].answers).toHaveLength(60);
  });
});
