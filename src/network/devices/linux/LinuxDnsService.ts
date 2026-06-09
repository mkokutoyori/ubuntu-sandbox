/**
 * LinuxDnsService - Simulated DNS server (dnsmasq) and client tools (dig, nslookup, host)
 *
 * Implements:
 *   - dnsmasq config parsing and DNS record storage (`DnsService`)
 *   - dig command (Linux DNS lookup utility)
 *   - nslookup command (cross-platform DNS lookup)
 *   - host command (simple DNS lookup)
 *
 * Resolution goes through the real simulated network: the command layer
 * receives a `DnsLookup` function (backed by `DnsClient`) that sends an
 * actual UDP/53 query through routing + ARP and awaits the server's answer.
 * The server side is `DnsServerEndpoint`, bound to UDP/53 whenever the
 * dnsmasq `DnsService` is running. Unplugged cables, stopped daemons and
 * missing routes now fail name resolution exactly like on real machines.
 */

import { DNS_PORT, type DnsRecord } from '../../dns/types';
import type { DnsLookup } from '../../dns/DnsClient';

// Re-export so existing importers keep working — the wire-level home of
// these types is src/network/dns/types.ts.
export type { DnsRecord, DnsRecordType } from '../../dns/types';

// ─── DNS Service (runs on a LinuxPC acting as DNS server) ─────────

export class DnsService {
  /** All DNS records served by this instance */
  private records: DnsRecord[] = [];
  private running = false;
  private readonly stateListeners: Array<(running: boolean) => void> = [];

  start(): void {
    if (this.running) return;
    this.running = true;
    this.notifyStateChange();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.notifyStateChange();
  }

  isRunning(): boolean { return this.running; }

  /**
   * Observe start/stop transitions — used by the host to open/close the
   * UDP/53 endpoint in step with the daemon lifecycle.
   */
  onStateChange(listener: (running: boolean) => void): () => void {
    this.stateListeners.push(listener);
    return () => {
      const index = this.stateListeners.indexOf(listener);
      if (index !== -1) this.stateListeners.splice(index, 1);
    };
  }

  private notifyStateChange(): void {
    for (const listener of [...this.stateListeners]) {
      try { listener(this.running); } catch { /* listener must not break the daemon */ }
    }
  }

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

// ─── dig command implementation ──────────────────────────────────

export async function executeDig(
  args: string[],
  resolverIP: string | undefined,
  lookup: DnsLookup,
): Promise<string> {
  // Parse dig arguments
  let server = resolverIP || '';
  let domain = '';
  let qtype = 'A';
  let isShort = false;
  let isReverse = false;
  let noAll = false;
  let showAnswer = false;
  let timeout = 5;

  for (const arg of args) {
    if (arg.startsWith('@')) {
      server = arg.slice(1);
    } else if (arg === '+short') {
      isShort = true;
    } else if (arg === '+noall') {
      noAll = true;
    } else if (arg === '+answer') {
      showAnswer = true;
    } else if (arg === '-x') {
      isReverse = true;
    } else if (arg.startsWith('+time=')) {
      timeout = parseInt(arg.slice(6), 10);
    } else if (['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS', 'SOA', 'PTR', 'ANY'].includes(arg.toUpperCase())) {
      qtype = arg.toUpperCase();
    } else if (!arg.startsWith('+') && !arg.startsWith('-') && arg.includes('.')) {
      domain = arg;
    }
  }

  // Handle -x (reverse lookup): the next non-option arg is the IP
  if (isReverse) {
    const ipArg = args.find(a => !a.startsWith('-') && !a.startsWith('+') && !a.startsWith('@') && /^\d/.test(a));
    if (ipArg) domain = ipArg;
    qtype = 'PTR';
  }

  if (!server) {
    return '; <<>> DiG <<>> ' + domain + '\n;; connection timed out; no servers could be reached';
  }

  // Validate server IP
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(server) || server.split('.').some(o => Number(o) > 255)) {
    return '; <<>> DiG <<>> @' + server + ' ' + domain + '\n;; connection timed out; no servers could be reached';
  }

  // Send the query through the simulated network
  const result = await lookup(server, domain, {
    qtype, reverse: isReverse,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout * 1000 : undefined,
  });

  if (result.status === 'timeout') {
    return '; <<>> DiG <<>> ' + domain + '\n;; connection timed out; no servers could be reached';
  }
  if (result.status === 'unreachable') {
    return '; <<>> DiG <<>> ' + domain +
      `\n;; communications error to ${server}#${DNS_PORT}: connection refused` +
      '\n;; no servers could be reached';
  }

  const records = result.answers;
  const status = result.rcode;

  // +short format
  if (isShort) {
    if (records.length === 0) return '';
    return records.map(r => {
      if (r.type === 'MX') return `${r.priority} ${r.value}.`;
      if (r.type === 'PTR' || r.type === 'CNAME' || r.type === 'NS') return r.value + '.';
      if (r.type === 'TXT') return r.value;
      return r.value;
    }).join('\n');
  }

  // +noall +answer format
  if (noAll && showAnswer) {
    if (records.length === 0) return '';
    return records.map(r => formatDigAnswer(r)).join('\n');
  }

  // Full dig output
  const lines: string[] = [];
  lines.push(`; <<>> DiG <<>> ${domain} ${qtype}`);
  lines.push(';; global options: +cmd');

  lines.push(`;; Got answer:`);
  lines.push(`;; ->>HEADER<<- opcode: QUERY, status: ${status}, id: ${Math.floor(Math.random() * 65536)}`);
  lines.push(`;; flags: qr rd ra; QUERY: 1, ANSWER: ${records.length}, AUTHORITY: 0, ADDITIONAL: 0`);
  lines.push('');
  lines.push(';; QUESTION SECTION:');
  if (isReverse) {
    const parts = domain.split('.');
    const arpa = parts.reverse().join('.') + '.in-addr.arpa.';
    lines.push(`;${arpa}\t\tIN\tPTR`);
  } else {
    lines.push(`;${domain}.\t\t\tIN\t${qtype}`);
  }
  lines.push('');

  if (records.length > 0) {
    lines.push(';; ANSWER SECTION:');
    for (const r of records) {
      lines.push(formatDigAnswer(r));
    }
    lines.push('');
  }

  lines.push(`;; Query time: ${Math.floor(Math.random() * 10) + 1} msec`);
  lines.push(`;; SERVER: ${server}#${DNS_PORT}(${server})`);
  lines.push(`;; WHEN: ${new Date().toUTCString()}`);
  lines.push(`;; MSG SIZE  rcvd: ${64 + records.length * 32}`);

  return lines.join('\n');
}

function formatDigAnswer(r: DnsRecord): string {
  const name = r.name.endsWith('.') ? r.name : r.name + '.';
  if (r.type === 'MX') {
    return `${name}\t\t${r.ttl}\tIN\t${r.type}\t${r.priority} ${r.value}.`;
  }
  if (r.type === 'PTR' || r.type === 'CNAME' || r.type === 'NS') {
    return `${name}\t\t${r.ttl}\tIN\t${r.type}\t${r.value}.`;
  }
  if (r.type === 'TXT') {
    return `${name}\t\t${r.ttl}\tIN\t${r.type}\t${r.value}`;
  }
  if (r.type === 'SOA') {
    return `${name}\t\t${r.ttl}\tIN\tSOA\t${r.value}`;
  }
  return `${name}\t\t${r.ttl}\tIN\t${r.type}\t${r.value}`;
}

// ─── nslookup command implementation ─────────────────────────────

export async function executeNslookup(
  args: string[],
  resolverIP: string | undefined,
  lookup: DnsLookup,
): Promise<string> {
  let domain = '';
  let server = resolverIP || '';
  let qtype = 'A';

  // Parse nslookup args: nslookup [-type=TYPE] domain [server]
  let domainSeen = false;
  for (const arg of args) {
    if (arg.startsWith('-type=') || arg.startsWith('-querytype=')) {
      qtype = arg.split('=')[1].toUpperCase();
    } else if (!domainSeen) {
      domain = arg;
      domainSeen = true;
    } else {
      server = arg; // explicit server overrides the configured resolver
    }
  }

  if (!domain) return 'Usage: nslookup [-type=TYPE] domain [server]';

  // Detect reverse lookup (domain is an IP)
  const isReverse = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(domain);

  if (!server) {
    return `** server can't find ${domain}: REFUSED`;
  }

  const result = await lookup(server, domain, { qtype: isReverse ? 'PTR' : qtype, reverse: isReverse });
  if (result.status === 'timeout') {
    return `;; connection timed out; no servers could be reached`;
  }
  if (result.status === 'unreachable') {
    return `;; communications error to ${server}#${DNS_PORT}: connection refused`;
  }

  const lines: string[] = [];
  lines.push(`Server:\t\t${server}`);
  lines.push(`Address:\t${server}#${DNS_PORT}`);
  lines.push('');

  if (isReverse) {
    if (result.answers.length === 0) {
      lines.push(`** server can't find ${domain}: NXDOMAIN`);
    } else {
      for (const r of result.answers) {
        lines.push(`${domain}\tname = ${r.value}.`);
      }
    }
    return lines.join('\n');
  }

  // Forward lookup
  if (result.rcode === 'NXDOMAIN') {
    lines.push(`** server can't find ${domain}: NXDOMAIN`);
    return lines.join('\n');
  }

  if (qtype === 'MX') {
    lines.push(`Non-authoritative answer:`);
    if (result.answers.length === 0) {
      lines.push(`*** Can't find ${domain}: No answer`);
    } else {
      for (const r of result.answers) {
        lines.push(`${domain}\tmail exchanger = ${r.priority} ${r.value}`);
      }
    }
    return lines.join('\n');
  }

  lines.push(`Non-authoritative answer:`);
  if (result.answers.length === 0) {
    lines.push(`*** Can't find ${domain}: No answer`);
  } else {
    lines.push(`Name:\t${domain}`);
    for (const r of result.answers) {
      lines.push(`Address: ${r.value}`);
    }
  }

  return lines.join('\n');
}

// ─── host command implementation ─────────────────────────────────

export async function executeHost(
  args: string[],
  resolverIP: string | undefined,
  lookup: DnsLookup,
): Promise<string> {
  const domain = args[0];
  const server = args[1] || resolverIP || '';

  if (!domain) return 'Usage: host [-t type] name [server]';

  if (!server) {
    return `Host ${domain} not found: 5(REFUSED)`;
  }

  const result = await lookup(server, domain, { qtype: 'A' });
  if (result.status !== 'ok') {
    return `;; connection timed out; no servers could be reached`;
  }
  if (result.rcode === 'NXDOMAIN' || result.answers.length === 0) {
    return `Host ${domain} not found: 3(NXDOMAIN)`;
  }

  return result.answers.map(r => `${domain} has address ${r.value}`).join('\n');
}
