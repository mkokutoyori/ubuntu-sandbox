export type SshHostKeyType =
  | 'ssh-ed25519' | 'ssh-rsa'
  | 'ecdsa-sha2-nistp256' | 'ecdsa-sha2-nistp384' | 'ecdsa-sha2-nistp521'
  | 'sk-ssh-ed25519@openssh.com' | 'sk-ecdsa-sha2-nistp256@openssh.com';

export interface SshKnownHostEntryInit {
  hostnames: string[];
  keyType: SshHostKeyType | string;
  publicKey: string;
  comment?: string;
  markedCa?: boolean;
  revoked?: boolean;
  hashed?: boolean;
  hashSalt?: string;
  hashDigest?: string;
}

export class SshKnownHostEntry {
  readonly hostnames: readonly string[];
  readonly keyType: SshHostKeyType | string;
  readonly publicKey: string;
  readonly comment: string;
  readonly markedCa: boolean;
  readonly revoked: boolean;
  readonly hashed: boolean;
  readonly hashSalt: string | null;
  readonly hashDigest: string | null;

  constructor(init: SshKnownHostEntryInit) {
    this.hostnames = Object.freeze([...init.hostnames]);
    this.keyType = init.keyType;
    this.publicKey = init.publicKey;
    this.comment = init.comment ?? '';
    this.markedCa = init.markedCa ?? false;
    this.revoked = init.revoked ?? false;
    this.hashed = init.hashed ?? false;
    this.hashSalt = init.hashSalt ?? null;
    this.hashDigest = init.hashDigest ?? null;
  }

  matches(host: string): boolean {
    if (this.hashed) return false;
    return this.hostnames.some(h => h === host || stripBrackets(h) === host);
  }

  matchesHostPort(host: string, port: number): boolean {
    const wanted = `[${host}]:${port}`;
    return this.hostnames.includes(wanted) || (port === 22 && this.matches(host));
  }

  serialize(): string {
    const prefix = this.revoked ? '@revoked ' : this.markedCa ? '@cert-authority ' : '';
    const hosts = this.hashed && this.hashSalt && this.hashDigest
      ? `|1|${this.hashSalt}|${this.hashDigest}`
      : this.hostnames.join(',');
    const tail = this.comment ? ` ${this.comment}` : '';
    return `${prefix}${hosts} ${this.keyType} ${this.publicKey}${tail}`;
  }
}

function stripBrackets(host: string): string {
  return host.startsWith('[') ? host.replace(/^\[(.*?)\](:\d+)?$/, '$1') : host;
}

export class SshKnownHostsFile {
  readonly entries: readonly SshKnownHostEntry[];

  private constructor(entries: readonly SshKnownHostEntry[]) {
    this.entries = entries;
  }

  static empty(): SshKnownHostsFile { return new SshKnownHostsFile([]); }

  static parse(content: string): SshKnownHostsFile {
    const out: SshKnownHostEntry[] = [];
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      let rest = line;
      let markedCa = false;
      let revoked = false;
      if (rest.startsWith('@cert-authority ')) { markedCa = true; rest = rest.slice('@cert-authority '.length).trim(); }
      else if (rest.startsWith('@revoked ')) { revoked = true; rest = rest.slice('@revoked '.length).trim(); }
      const tokens = rest.split(/\s+/);
      if (tokens.length < 3) continue;
      const hostField = tokens[0];
      const keyType = tokens[1];
      const publicKey = tokens[2];
      const comment = tokens.slice(3).join(' ');
      let hashed = false;
      let hashSalt: string | undefined;
      let hashDigest: string | undefined;
      let hostnames: string[];
      if (hostField.startsWith('|1|')) {
        const m = /^\|1\|([^|]+)\|(.+)$/.exec(hostField);
        if (m) { hashed = true; hashSalt = m[1]; hashDigest = m[2]; hostnames = []; }
        else hostnames = [];
      } else {
        hostnames = hostField.split(',');
      }
      out.push(new SshKnownHostEntry({
        hostnames, keyType, publicKey, comment,
        markedCa, revoked, hashed, hashSalt, hashDigest,
      }));
    }
    return new SshKnownHostsFile(out);
  }

  add(init: SshKnownHostEntryInit): SshKnownHostsFile {
    return new SshKnownHostsFile([...this.entries, new SshKnownHostEntry(init)]);
  }

  remove(host: string): SshKnownHostsFile {
    return new SshKnownHostsFile(this.entries.filter(e => !e.matches(host)));
  }

  find(host: string, keyType?: string): SshKnownHostEntry | undefined {
    return this.entries.find(e => e.matches(host) && (!keyType || e.keyType === keyType));
  }

  hostKeyChanged(host: string, keyType: string, publicKey: string): boolean {
    const e = this.find(host, keyType);
    if (!e) return false;
    return e.publicKey !== publicKey;
  }

  isRevoked(host: string, keyType: string, publicKey: string): boolean {
    return this.entries.some(e => e.revoked && e.matches(host) && e.keyType === keyType && e.publicKey === publicKey);
  }

  serialize(): string {
    return this.entries.map(e => e.serialize()).join('\n') + '\n';
  }
}
