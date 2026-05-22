/**
 * IanaServiceRegistry — the port ⇄ service-name database.
 *
 * This is the in-memory model of `/etc/services` (POSIX) and
 * `%SystemRoot%\System32\drivers\etc\services` (Windows): the IANA Service
 * Name and Transport Protocol Port Number Registry. `netstat`, `ss`,
 * `getent services` and the Windows `netstat` all resolve numeric ports to
 * names through this same table.
 *
 * Modelled as a class — not a bare map — because the simulator renders it
 * back to disk: the on-disk `services` file is a pure projection of this
 * registry, so the two never drift.
 *
 * Every entry carries the full record a real `/etc/services` line holds —
 * canonical name, port, protocol, aliases and a trailing comment — even
 * though some consumers only read the name today.
 */

import type { TransportProtocol } from './PortNumber';

/** One assignment in the registry — a single `/etc/services` line. */
export interface ServicePortDefinition {
  /** Canonical IANA service name (field 1). */
  readonly name: string;
  /** Port number (field 2, before the slash). */
  readonly port: number;
  /** Transport protocol (field 2, after the slash). */
  readonly protocol: TransportProtocol;
  /** Alternative names the service is also known by. */
  readonly aliases: readonly string[];
  /** Human-readable description rendered as the trailing `#` comment. */
  readonly comment?: string;
}

/**
 * The stock assignment table. Deliberately broad — it carries more
 * services than the simulator binds today so that `getent services` and
 * `/etc/services` stay realistic and future daemons resolve out of the box.
 */
const STANDARD_DEFINITIONS: ReadonlyArray<Omit<ServicePortDefinition, 'aliases'> & { aliases?: string[] }> = [
  { name: 'ftp-data', port: 20, protocol: 'tcp', comment: 'File Transfer [Default Data]' },
  { name: 'ftp', port: 21, protocol: 'tcp', comment: 'File Transfer [Control]' },
  { name: 'ssh', port: 22, protocol: 'tcp', comment: 'Secure Shell' },
  { name: 'telnet', port: 23, protocol: 'tcp', comment: 'Telnet' },
  { name: 'smtp', port: 25, protocol: 'tcp', aliases: ['mail'], comment: 'Simple Mail Transfer' },
  { name: 'time', port: 37, protocol: 'tcp', aliases: ['timserver'], comment: 'Time' },
  { name: 'whois', port: 43, protocol: 'tcp', aliases: ['nicname'], comment: 'WHOIS directory service' },
  { name: 'domain', port: 53, protocol: 'tcp', comment: 'Domain Name Server' },
  { name: 'domain', port: 53, protocol: 'udp', comment: 'Domain Name Server' },
  { name: 'bootps', port: 67, protocol: 'udp', comment: 'DHCP/BOOTP Server' },
  { name: 'bootpc', port: 68, protocol: 'udp', comment: 'DHCP/BOOTP Client' },
  { name: 'tftp', port: 69, protocol: 'udp', comment: 'Trivial File Transfer' },
  { name: 'http', port: 80, protocol: 'tcp', aliases: ['www', 'www-http'], comment: 'World Wide Web HTTP' },
  { name: 'kerberos', port: 88, protocol: 'tcp', aliases: ['kerberos5', 'krb5'], comment: 'Kerberos' },
  { name: 'pop3', port: 110, protocol: 'tcp', aliases: ['pop-3'], comment: 'Post Office Protocol - Version 3' },
  { name: 'nntp', port: 119, protocol: 'tcp', aliases: ['usenet'], comment: 'Network News Transfer Protocol' },
  { name: 'ntp', port: 123, protocol: 'udp', comment: 'Network Time Protocol' },
  { name: 'netbios-ns', port: 137, protocol: 'udp', comment: 'NETBIOS Name Service' },
  { name: 'netbios-ssn', port: 139, protocol: 'tcp', comment: 'NETBIOS Session Service' },
  { name: 'imap', port: 143, protocol: 'tcp', aliases: ['imap2', 'imap4'], comment: 'Internet Message Access Protocol' },
  { name: 'snmp', port: 161, protocol: 'udp', comment: 'SNMP' },
  { name: 'snmp-trap', port: 162, protocol: 'udp', aliases: ['snmptrap'], comment: 'SNMP Trap' },
  { name: 'bgp', port: 179, protocol: 'tcp', comment: 'Border Gateway Protocol' },
  { name: 'ldap', port: 389, protocol: 'tcp', comment: 'Lightweight Directory Access Protocol' },
  { name: 'https', port: 443, protocol: 'tcp', comment: 'HTTP protocol over TLS/SSL' },
  { name: 'microsoft-ds', port: 445, protocol: 'tcp', comment: 'Microsoft Directory Services (SMB)' },
  { name: 'isakmp', port: 500, protocol: 'udp', comment: 'IPsec ISAKMP / IKE' },
  { name: 'syslog', port: 514, protocol: 'udp', comment: 'Syslog' },
  { name: 'submission', port: 587, protocol: 'tcp', comment: 'Mail Message Submission' },
  { name: 'ldaps', port: 636, protocol: 'tcp', aliases: ['ldap-ssl'], comment: 'LDAP over TLS/SSL' },
  { name: 'imaps', port: 993, protocol: 'tcp', comment: 'IMAP over TLS/SSL' },
  { name: 'pop3s', port: 995, protocol: 'tcp', comment: 'POP3 over TLS/SSL' },
  { name: 'ms-sql-s', port: 1433, protocol: 'tcp', comment: 'Microsoft SQL Server' },
  { name: 'ms-sql-m', port: 1434, protocol: 'udp', comment: 'Microsoft SQL Monitor' },
  { name: 'ms-sql-s', port: 1521, protocol: 'tcp', aliases: ['oracle', 'oracle-tns', 'ncube-lm'], comment: 'Oracle TNS Listener' },
  { name: 'pptp', port: 1723, protocol: 'tcp', comment: 'Point-to-Point Tunnelling Protocol' },
  { name: 'ipsec-nat-t', port: 4500, protocol: 'udp', comment: 'IPsec NAT-Traversal' },
  { name: 'mysql', port: 3306, protocol: 'tcp', comment: 'MySQL Database' },
  { name: 'ms-wbt-server', port: 3389, protocol: 'tcp', aliases: ['rdp'], comment: 'Remote Desktop Protocol' },
  { name: 'postgresql', port: 5432, protocol: 'tcp', aliases: ['postgres'], comment: 'PostgreSQL Database' },
  { name: 'vnc-server', port: 5900, protocol: 'tcp', aliases: ['vnc'], comment: 'Virtual Network Computing' },
  { name: 'redis', port: 6379, protocol: 'tcp', comment: 'Redis key-value store' },
  { name: 'http-alt', port: 8080, protocol: 'tcp', aliases: ['webcache'], comment: 'HTTP Alternate' },
  { name: 'https-alt', port: 8443, protocol: 'tcp', comment: 'HTTPS Alternate' },
];

export class IanaServiceRegistry {
  /** Keyed by `port/protocol` for O(1) numeric resolution. */
  private readonly byEndpoint = new Map<string, ServicePortDefinition>();
  /** Keyed by lower-cased name/alias for O(1) name resolution. */
  private readonly byName = new Map<string, ServicePortDefinition[]>();
  private readonly definitions: ServicePortDefinition[] = [];

  constructor(definitions: ReadonlyArray<ServicePortDefinition> = []) {
    for (const def of definitions) this.register(def);
  }

  /** The stock IANA assignment table shipped on every host. */
  static standard(): IanaServiceRegistry {
    const registry = new IanaServiceRegistry();
    for (const raw of STANDARD_DEFINITIONS) {
      registry.register({ ...raw, aliases: raw.aliases ?? [] });
    }
    return registry;
  }

  /** Add (or replace) an assignment. Idempotent on the `port/protocol` key. */
  register(def: ServicePortDefinition): void {
    const key = endpointKey(def.port, def.protocol);
    if (this.byEndpoint.has(key)) {
      const stale = this.byEndpoint.get(key)!;
      const idx = this.definitions.indexOf(stale);
      if (idx >= 0) this.definitions.splice(idx, 1);
    }
    this.byEndpoint.set(key, def);
    this.definitions.push(def);
    for (const alias of [def.name, ...def.aliases]) {
      const lower = alias.toLowerCase();
      const list = this.byName.get(lower) ?? [];
      list.push(def);
      this.byName.set(lower, list);
    }
  }

  /** Look up the assignment for a numeric `port/protocol` pair. */
  lookup(port: number, protocol: TransportProtocol): ServicePortDefinition | undefined {
    return this.byEndpoint.get(endpointKey(port, protocol));
  }

  /**
   * Resolve a numeric port to its IANA service name. Falls back to the
   * port number as a string when the port is unassigned — exactly what
   * `getservbyport(3)` / `netstat` do.
   */
  resolveName(port: number, protocol: TransportProtocol): string {
    return this.lookup(port, protocol)?.name ?? String(port);
  }

  /** Resolve a service name (or alias) to its port, optionally protocol-scoped. */
  resolvePort(name: string, protocol?: TransportProtocol): number | undefined {
    const matches = this.byName.get(name.toLowerCase());
    if (!matches || matches.length === 0) return undefined;
    const match = protocol ? matches.find((d) => d.protocol === protocol) : matches[0];
    return match?.port;
  }

  /** Every assignment, in insertion order. */
  all(): readonly ServicePortDefinition[] {
    return this.definitions;
  }

  /**
   * Render the canonical `services` file. The format is shared by POSIX
   * `/etc/services` and the Windows `drivers\etc\services` file:
   *   `name<TAB>port/proto<TAB>[aliases]<TAB># comment`
   */
  render(): string {
    const lines = [
      '# /etc/services — port-to-service name mappings (IANA registry).',
      '# Kept coherent with the simulator IanaServiceRegistry.',
      '#',
      '# <service name>  <port>/<protocol>  [aliases ...]   [# comment]',
      '',
    ];
    for (const def of this.definitions) {
      const portProto = `${def.port}/${def.protocol}`;
      const aliases = def.aliases.length > 0 ? `\t${def.aliases.join(' ')}` : '';
      const comment = def.comment ? `\t# ${def.comment}` : '';
      lines.push(`${def.name.padEnd(15)} ${portProto.padEnd(11)}${aliases}${comment}`);
    }
    lines.push('');
    return lines.join('\n');
  }
}

/** Compose the `port/protocol` map key. */
function endpointKey(port: number, protocol: TransportProtocol): string {
  return `${port}/${protocol}`;
}
