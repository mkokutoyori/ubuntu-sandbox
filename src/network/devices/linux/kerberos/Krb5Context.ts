import { Krb5Profile } from '@/network/kerberos/Krb5Profile';
import type { Krb5Host } from './Krb5Host';
import { parsePrincipalName, type ParseNameResult } from './Krb5Principal';

export const DEFAULT_KRB5_CONFIG = '/etc/krb5.conf';
const DEFAULT_KDC_PORT = 88;

export interface KdcAddress {
  readonly host: string;
  readonly port: number;
}

export type KdcLocation =
  | { readonly kind: 'found'; readonly addresses: readonly KdcAddress[] }
  | { readonly kind: 'none' };

export class Krb5Context {
  private cachedProfile: Krb5Profile | null = null;

  constructor(readonly host: Krb5Host) {}

  profile(): Krb5Profile {
    if (this.cachedProfile !== null) return this.cachedProfile;
    const configured = this.host.environment('KRB5_CONFIG');
    const paths = configured !== null && configured !== '' ? configured.split(':') : [DEFAULT_KRB5_CONFIG];
    const texts: string[] = [];
    for (const path of paths) {
      const text = this.host.readText(path);
      if (text !== null) texts.push(text);
    }
    this.cachedProfile = Krb5Profile.parse(texts, {
      readFile: (path) => this.host.readText(path),
      listDirectory: (path) => this.host.listDirectory(path),
    });
    return this.cachedProfile;
  }

  defaultRealm(): string | null {
    return this.profile().string('libdefaults', 'default_realm');
  }

  parseName(name: string): ParseNameResult {
    return parsePrincipalName(name, this.defaultRealm());
  }

  defaultCcacheName(): string {
    const environment = this.host.environment('KRB5CCNAME');
    if (environment !== null && environment !== '') return environment;
    const configured = this.profile().string('libdefaults', 'default_ccache_name');
    const uid = this.host.uid();
    if (configured !== null) return configured.replace(/%\{(uid|euid)\}/g, String(uid)).replace(/%\{(null)\}/g, '');
    return `FILE:/tmp/krb5cc_${uid}`;
  }

  hostRealm(hostname: string): string | null {
    const lowered = hostname.toLowerCase();
    const profile = this.profile();
    const exact = profile.string('domain_realm', lowered);
    if (exact !== null) return exact;
    let remaining = lowered;
    for (;;) {
      const dot = remaining.indexOf('.');
      if (dot < 0) break;
      remaining = remaining.slice(dot);
      const mapped = profile.string('domain_realm', remaining);
      if (mapped !== null) return mapped;
      remaining = remaining.slice(1);
    }
    return null;
  }

  async locateKdcs(realm: string): Promise<KdcLocation> {
    const profile = this.profile();
    const entries = profile.strings('realms', realm, 'kdc');
    const addresses: KdcAddress[] = [];
    for (const entry of entries) {
      const parsed = parseKdcEntry(entry);
      if (parsed !== null) addresses.push(parsed);
    }
    if (addresses.length > 0) return { kind: 'found', addresses };
    if (!profile.boolean(true, 'libdefaults', 'dns_lookup_kdc')) return { kind: 'none' };
    for (const service of ['_kerberos._udp', '_kerberos._tcp']) {
      const records = await this.host.querySrv(`${service}.${realm}`);
      const ordered = [...records].sort((a, b) => a.priority - b.priority || b.weight - a.weight);
      for (const record of ordered) {
        if (!addresses.some((known) => known.host === record.target && known.port === record.port)) {
          addresses.push({ host: record.target, port: record.port });
        }
      }
    }
    return addresses.length > 0 ? { kind: 'found', addresses } : { kind: 'none' };
  }
}

function parseKdcEntry(entry: string): KdcAddress | null {
  const text = entry.trim().replace(/^(tcp|udp)\//i, '');
  if (text === '') return null;
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(text);
  if (match === null) return null;
  const host = match[1].replace(/^\[|\]$/g, '');
  return { host, port: match[2] === undefined ? DEFAULT_KDC_PORT : Number(match[2]) };
}
