import type { IPAddress } from '@/network/core/types';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { RRType } from '@/network/dns/wire/RRType';
import type { DnsLookup, MxTarget } from '@/network/smtp/relay';

export interface DnsQueryHost {
  queryDnsServer(serverIP: IPAddress, name: string, qtype: string): Promise<DnsMessage | null>;
}

export function createDnsLookupAdapter(host: DnsQueryHost, dnsServerIp: IPAddress): DnsLookup {
  return {
    async resolveMx(domain: string): Promise<readonly MxTarget[]> {
      const message = await host.queryDnsServer(dnsServerIp, domain, 'MX');
      if (!message) return [];
      const targets: MxTarget[] = [];
      for (const rr of message.answers) {
        if (rr.data.type === RRType.MX) targets.push({ preference: rr.data.preference, exchange: rr.data.exchange });
      }
      return targets;
    },

    async resolveAddress(hostname: string): Promise<string | null> {
      const message = await host.queryDnsServer(dnsServerIp, hostname, 'A');
      if (!message) return null;
      for (const rr of message.answers) {
        if (rr.data.type === RRType.A) return rr.data.address.toString();
      }
      return null;
    },
  };
}
