/**
 * HostsFile — domain model of the static hostname table shared by Linux
 * (`/etc/hosts`) and Windows (`%SystemRoot%\System32\drivers\etc\hosts`).
 *
 * Both operating systems use the very same on-disk format — an IP address
 * followed by one or more names, `#` comments and blank lines — so a single
 * parser / resolver / serializer serves both. This replaces the ad-hoc line
 * scanning that was previously duplicated across the Linux resolver, the NSS
 * `files` source, the cross-device lookup and the Windows PC.
 *
 * `HostsFile` is an immutable value object: parse → query / derive →
 * serialize. It owns no I/O; callers bridge it to a filesystem. Mutating
 * helpers (`withEntry`, `without`) return fresh instances and preserve
 * comment / blank lines so a round-trip keeps the file faithful.
 */

/** A single host record: one address bound to one or more names. */
export class HostEntry {
  constructor(
    readonly ip: string,
    readonly hostnames: readonly string[],
  ) {}

  /** The canonical (first) name — what reverse lookups report. */
  get canonicalName(): string {
    return this.hostnames[0] ?? '';
  }

  /** Every name after the canonical one. */
  get aliases(): readonly string[] {
    return this.hostnames.slice(1);
  }

  /** True for IPv6 records (the address carries a colon). */
  get isIPv6(): boolean {
    return this.ip.includes(':');
  }

  /** Case-insensitive match of `name` against any of this record's names. */
  hasName(name: string): boolean {
    const n = name.toLowerCase();
    return this.hostnames.some((h) => h.toLowerCase() === n);
  }

  /** Render as a canonical tab-separated hosts line. */
  toLine(): string {
    return `${this.ip}\t${this.hostnames.join(' ')}`;
  }
}

/** Address family selector for forward resolution. */
export type AddressFamily = 4 | 6;

export class HostsFile {
  private constructor(private readonly lines: readonly string[]) {}

  /** Parse hosts-file content. `null` / `undefined` yields an empty table. */
  static parse(content: string | null | undefined): HostsFile {
    return new HostsFile((content ?? '').split('\n'));
  }

  /** An empty hosts file. */
  static empty(): HostsFile {
    return new HostsFile([]);
  }

  /**
   * The canonical Linux `/etc/hosts`: loopback, the machine's own name on
   * 127.0.1.1 (Debian/Ubuntu convention) and the IPv6 loopback aliases.
   */
  static defaultLinux(hostname: string): HostsFile {
    return new HostsFile([
      '127.0.0.1\tlocalhost',
      `127.0.1.1\t${hostname}`,
      '',
      '# The following lines are desirable for IPv6 capable hosts',
      '::1\tlocalhost ip6-localhost ip6-loopback',
    ]);
  }

  /**
   * The canonical Windows hosts file: the stock Microsoft sample header
   * followed by the loopback entries and the machine's own name.
   */
  static defaultWindows(hostname: string): HostsFile {
    return new HostsFile([
      '# Copyright (c) 1993-2009 Microsoft Corp.',
      '#',
      '# This is a sample HOSTS file used by Microsoft TCP/IP for Windows.',
      '#',
      '# This file contains the mappings of IP addresses to host names. Each',
      '# entry should be kept on an individual line. The IP address should',
      '# be placed in the first column followed by the corresponding host name.',
      '# The IP address and the host name should be separated by at least one',
      '# space.',
      '#',
      '# Additionally, comments (such as these) may be inserted on individual',
      '# lines or following the machine name denoted by a \'#\' symbol.',
      '#',
      '# For example:',
      '#',
      '#      102.54.94.97     rhino.acme.com          # source server',
      '#       38.25.63.10     x.acme.com              # x client host',
      '',
      '# localhost name resolution is handled within DNS itself.',
      '127.0.0.1       localhost',
      '::1             localhost',
      `127.0.0.1       ${hostname}`,
    ]);
  }

  /** Every host record, in file order (comments / blanks excluded). */
  get entries(): HostEntry[] {
    const out: HostEntry[] = [];
    for (const raw of this.lines) {
      const entry = HostsFile.parseLine(raw);
      if (entry) out.push(entry);
    }
    return out;
  }

  /**
   * Forward resolution: hostname → IP. IPv4 is preferred; an IPv6 record
   * is only returned when `family` explicitly asks for it. Returns `null`
   * when the name is absent for the requested family.
   */
  resolve(name: string, family: AddressFamily = 4): string | null {
    let firstV6: string | null = null;
    for (const entry of this.entries) {
      if (!entry.hasName(name)) continue;
      if (entry.isIPv6) {
        if (family === 6) return entry.ip;
        firstV6 ??= entry.ip;
      } else if (family === 4) {
        return entry.ip;
      }
    }
    return family === 6 ? firstV6 : null;
  }

  /** Reverse resolution: IP → the first record bearing that address. */
  reverse(ip: string): HostEntry | null {
    return this.entries.find((e) => e.ip === ip) ?? null;
  }

  /** Whether any record binds `name` (case-insensitive, any family). */
  has(name: string): boolean {
    return this.entries.some((e) => e.hasName(name));
  }

  /** A new HostsFile with one extra record appended. */
  withEntry(ip: string, ...hostnames: string[]): HostsFile {
    const trimmed = [...this.lines];
    while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === '') {
      trimmed.pop();
    }
    return new HostsFile([
      ...trimmed,
      new HostEntry(ip, hostnames).toLine(),
    ]);
  }

  /** A new HostsFile without the records matching `predicate`. */
  without(predicate: (entry: HostEntry) => boolean): HostsFile {
    return new HostsFile(
      this.lines.filter((raw) => {
        const entry = HostsFile.parseLine(raw);
        return !entry || !predicate(entry);
      }),
    );
  }

  /** Serialize back to canonical hosts-file text (trailing newline). */
  serialize(): string {
    const body = this.lines.join('\n');
    return body.endsWith('\n') ? body : body + '\n';
  }

  /** Parse one raw line into a {@link HostEntry}, or `null` if not a record. */
  private static parseLine(raw: string): HostEntry | null {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) return null;
    const parts = line.split(/\s+/);
    if (parts.length < 2) return null;
    return new HostEntry(parts[0], parts.slice(1));
  }
}
