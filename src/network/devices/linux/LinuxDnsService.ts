import type { DnsMessage } from '../../dns/wire/DnsMessage';
import {
  type DnsRecord,
  type DnsRcodeName,
  type DnsQueryFn,
  resourceRecordToLegacyRecord,
  rcodeFromWire,
} from '../../dns/compat/DnsWireCompat';

export type { DnsRecord, DnsQueryFn };

interface DecodedResponse {
  rcode: DnsRcodeName;
  answers: DnsRecord[];
}

function toDecodedResponse(message: DnsMessage): DecodedResponse {
  return {
    rcode: rcodeFromWire(message.flags.rcode),
    answers: message.answers
      .map(resourceRecordToLegacyRecord)
      .filter((record): record is DnsRecord => record !== null),
  };
}

// ─── DNS Service (runs on a LinuxPC acting as DNS server) ─────────

export class DnsService {
  /** All DNS records served by this instance */
  private records: DnsRecord[] = [];
  private running = false;
  /** Lifecycle observers — the owning host binds/unbinds UDP 53 on these. */
  private startListeners: Array<() => void> = [];
  private stopListeners: Array<() => void> = [];

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const cb of this.startListeners) cb();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const cb of this.stopListeners) cb();
  }

  isRunning(): boolean { return this.running; }

  /** Register a callback fired when the service transitions to running. */
  onStart(cb: () => void): void { this.startListeners.push(cb); }

  /** Register a callback fired when the service is stopped. */
  onStop(cb: () => void): void { this.stopListeners.push(cb); }

  addRecord(record: DnsRecord): void {
    this.records.push(record);
  }

  /** Parse a dnsmasq-style config and populate records */
  parseConfig(config: string): void {
    for (const rawLine of config.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      // address=/domain/ip  →  A record
      const addrMatch = line.match(/^address=\/([^/]+)\/(.+)$/);
      if (addrMatch) {
        const ip = addrMatch[2];
        const type = ip.includes(':') ? 'AAAA' : 'A';
        this.records.push({ name: addrMatch[1], type, value: ip, ttl: 3600 });
        continue;
      }

      // ptr-record=reversed.in-addr.arpa,hostname  →  PTR record
      const ptrMatch = line.match(/^ptr-record=([^,]+),(.+)$/);
      if (ptrMatch) {
        this.records.push({ name: ptrMatch[1], type: 'PTR', value: ptrMatch[2], ttl: 3600 });
        continue;
      }

      // mx-host=domain,mail-server,priority  →  MX record
      const mxMatch = line.match(/^mx-host=([^,]+),([^,]+),(\d+)$/);
      if (mxMatch) {
        this.records.push({
          name: mxMatch[1], type: 'MX', value: mxMatch[2],
          ttl: 3600, priority: parseInt(mxMatch[3], 10),
        });
        continue;
      }

      // txt-record=domain,"text"  →  TXT record
      const txtMatch = line.match(/^txt-record=([^,]+),(.+)$/);
      if (txtMatch) {
        this.records.push({ name: txtMatch[1], type: 'TXT', value: txtMatch[2], ttl: 3600 });
        continue;
      }

      // cname=alias,target  →  CNAME record
      const cnameMatch = line.match(/^cname=([^,]+),(.+)$/);
      if (cnameMatch) {
        this.records.push({ name: cnameMatch[1], type: 'CNAME', value: cnameMatch[2], ttl: 3600 });
        continue;
      }
    }
  }

  /** Parse an /etc/hosts-style zone file (addn-hosts) */
  parseHostsFile(content: string): void {
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const ip = parts[0];
      const type = ip.includes(':') ? 'AAAA' : 'A';
      for (let i = 1; i < parts.length; i++) {
        this.records.push({ name: parts[i], type, value: ip, ttl: 3600 });
      }
    }
  }

  /** Query records by name and type */
  query(name: string, type: string): DnsRecord[] {
    if (!this.running) return [];
    const t = type.toUpperCase();

    if (t === 'ANY') {
      return this.records.filter(r => r.name === name);
    }

    // For A/AAAA queries, follow CNAMEs
    if (t === 'A' || t === 'AAAA') {
      const direct = this.records.filter(r => r.name === name && r.type === t);
      if (direct.length > 0) return direct;

      // Check CNAME
      const cname = this.records.find(r => r.name === name && r.type === 'CNAME');
      if (cname) {
        const resolved = this.records.filter(r => r.name === cname.value && r.type === t);
        return resolved;
      }
      return [];
    }

    return this.records.filter(r => r.name === name && r.type === t);
  }

  /** Reverse lookup: convert IP to in-addr.arpa and find PTR */
  reverseQuery(ip: string): DnsRecord[] {
    if (!this.running) return [];
    // Build reverse name
    const parts = ip.split('.');
    const arpa = parts.reverse().join('.') + '.in-addr.arpa';
    return this.records.filter(r => r.type === 'PTR' && r.name === arpa);
  }

  /** Check if a domain has ANY records (for NXDOMAIN detection) */
  hasDomain(name: string): boolean {
    return this.records.some(r => r.name === name || r.name.endsWith('.' + name));
  }

  getAllRecords(): DnsRecord[] { return [...this.records]; }
}

export { executeDig } from './commands/dns/DigRunner';
export { executeNslookup } from './commands/dns/NslookupRunner';

// ─── host command implementation ─────────────────────────────────

export async function executeHost(args: string[], query: DnsQueryFn, resolverIP?: string): Promise<string> {
  const domain = args[0];
  const server = args[1] || resolverIP || '';

  if (!domain) return 'Usage: host [-t type] name [server]';

  if (!server) {
    return `Host ${domain} not found: 5(REFUSED)`;
  }

  const message = await query(server, domain, 'A');
  if (!message) {
    return `;; connection timed out; no servers could be reached`;
  }
  const response = toDecodedResponse(message);

  if (response.answers.length === 0) {
    return `Host ${domain} not found: 3(NXDOMAIN)`;
  }

  return response.answers.map(r => `${domain} has address ${r.value}`).join('\n');
}
