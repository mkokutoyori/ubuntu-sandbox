import { IPAddress } from '@/network/core/types';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { RRType } from '@/network/dns/wire/RRType';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ControlPlaneUdpEndpoint } from '../../udp/ControlPlaneUdpEndpoint';
import { DNS_PORT, type DnsTransport } from './RouterDnsService';

const REPLY_POLLS = 40;

function queryOverTheWire(endpoint: ControlPlaneUdpEndpoint, server: string, name: string, source: IPAddress | null): Promise<string[]> {
  return new Promise((resolve) => {
    const port = endpoint.allocateEphemeralPort();
    let finished = false;
    const finish = (addresses: string[]) => {
      if (finished) return;
      finished = true;
      endpoint.udpClose(port);
      resolve(addresses);
    };
    endpoint.udpBind(port, (datagram) => {
      try {
        const message = decodeDnsMessage(datagram.udp.payload as unknown as Uint8Array);
        const addresses: string[] = [];
        for (const record of message.answers) {
          const data = record.data as { type: number; address?: { toString(): string } };
          if (data.type === RRType.A && data.address) addresses.push(data.address.toString());
        }
        finish(addresses);
      } catch { finish([]); }
    });
    const request: DnsMessage = {
      id: Math.floor(Math.random() * 65535),
      flags: { qr: false, opcode: 0, aa: false, tc: false, rd: true, ra: false, ad: false, cd: false, rcode: 0 },
      questions: [{ qname: `${name}.`, qtype: RRType.A, qclass: 1 }],
      answers: [], authorities: [], additionals: [],
    };
    const bytes = encodeDnsMessage(request);
    if (source === null) endpoint.sendUdpDatagramTo(new IPAddress(server), DNS_PORT, port, bytes);
    else endpoint.sendUdpDatagramFrom(source, new IPAddress(server), DNS_PORT, port, bytes);
    let rounds = 0;
    const wait = () => {
      if (finished) return;
      if (rounds++ > REPLY_POLLS) { finish([]); return; }
      queueMicrotask(wait);
    };
    queueMicrotask(wait);
  });
}

export function controlPlaneDnsTransport(endpoint: () => ControlPlaneUdpEndpoint, sourceAddress: () => IPAddress | null = () => null): DnsTransport {
  return {
    bind: (port, onQuery) => endpoint().udpBind(port, (datagram) => {
      onQuery(datagram.sourceIP.toString(), datagram.udp.sourcePort, datagram.udp.payload);
    }) !== false,
    unbind: (port) => { endpoint().udpClose(port); },
    reply: (destination, destinationPort, payload) => {
      endpoint().sendUdpDatagramTo(new IPAddress(destination), destinationPort, DNS_PORT, payload as Uint8Array);
    },
    sendQuery: (server, name) => queryOverTheWire(endpoint(), server, name, sourceAddress()),
  };
}
