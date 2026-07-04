/**
 * WindowsDnsServerRole — hosts the real DNS engine (`src/network/dns/`) as
 * the "DNS Server" Windows role (PRD-Windows-Server.md §5 P7): genuine
 * authoritative zones answered over real UDP/TCP port 53, with optional
 * forwarders (recursion) — reusing the wire/zone/resolver/transport stack
 * wholesale, the same engine the Linux BIND9 service (`Bind9Service.ts`)
 * already hosts. No DNS logic is reimplemented here; this is a thin
 * Windows-flavored façade (zone/record CRUD surface + forwarder wiring)
 * around that engine.
 *
 * Scope, matching the PRD's explicit `DnsServer` cmdlet surface: primary
 * zones only — no secondary zones / zone-transfer serving (not in the
 * PRD's cmdlet list; that machinery exists in `transfer/` if a later phase
 * wants it). Dynamic updates (DHCP lease grant, domain join) are applied
 * in-process via direct `Zone.addRecord`/`removeRecord` calls — mirroring
 * how the engine's own canonical DDNS mechanism (`PrimaryZoneAgent.
 * applyUpdate`) already works — rather than a wire-level RFC 2136 UPDATE
 * handler, which the underlying engine doesn't implement at any layer yet.
 */

import type { EndHost } from '@/network/devices/EndHost';
import { Zone, ZoneError } from '@/network/dns/zone/Zone';
import { ZoneStore, ZoneStoreError } from '@/network/dns/zone/ZoneStore';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { RecursiveResolver } from '@/network/dns/resolver/RecursiveResolver';
import { DnsCache } from '@/network/dns/resolver/DnsCache';
import { bindDnsUdpServer, unbindDnsUdpServer } from '@/network/dns/transport/DnsUdpTransport';
import { bindDnsTcpServer, unbindDnsTcpServer } from '@/network/dns/transport/DnsTcpTransport';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { RRType } from '@/network/dns/wire/RRType';
import {
  makeARecord, makeAaaaRecord, makeCnameRecord, makePtrRecord, makeMxRecord, makeSrvRecord, makeSoaRecord,
  type ResourceRecord, type ResourceRecordData, type SoaRecordData,
  type ARecordData, type AaaaRecordData, type CnameRecordData, type PtrRecordData, type MxRecordData,
  type SrvRecordData, type NsRecordData,
} from '@/network/dns/wire/ResourceRecord';
import { IPAddress } from '@/network/core/types';

export interface DnsOpResult { ok: boolean; message: string }

export interface DnsZoneInfo { name: string; recordCount: number }

export interface DnsRecordInfo { name: string; type: string; ttl: number; text: string }

const DNS_PORT = 53;

const RR_TYPE_NAME = new Map<number, string>(
  Object.entries(RRType).map(([name, code]) => [code, name]),
);

function formatRecordData(rr: ResourceRecord<ResourceRecordData>): string {
  switch (rr.data.type) {
    case RRType.A: return (rr.data as ARecordData).address.toString();
    case RRType.AAAA: return (rr.data as AaaaRecordData).address.toString();
    case RRType.CNAME: return (rr.data as CnameRecordData).cname;
    case RRType.PTR: return (rr.data as PtrRecordData).ptrdname;
    case RRType.NS: return (rr.data as NsRecordData).nsdname;
    case RRType.MX: {
      const d = rr.data as MxRecordData;
      return `[${d.preference}] ${d.exchange}`;
    }
    case RRType.SRV: {
      const d = rr.data as SrvRecordData;
      return `[${d.priority}][${d.weight}] ${d.port} ${d.target}`;
    }
    case RRType.SOA: {
      const d = rr.data as SoaRecordData;
      return `${d.mname} ${d.rname} ${d.serial}`;
    }
    default: return JSON.stringify(rr.data);
  }
}

function bumpSerial(zone: Zone): void {
  const d = zone.soa.data;
  zone.updateSoa(makeSoaRecord(zone.soa.name, zone.soa.ttl, {
    mname: d.mname, rname: d.rname, serial: d.serial + 1,
    refresh: d.refresh, retry: d.retry, expire: d.expire, minimum: d.minimum,
  }));
}

export class WindowsDnsServerRole {
  private readonly store = new ZoneStore();
  private readonly authoritative = new AuthoritativeServer(this.store);
  private resolver: RecursiveResolver | null = null;
  private forwarderAddresses: string[] = [];
  private running = false;

  constructor(private readonly host: EndHost) {}

  isRunning(): boolean { return this.running; }

  start(): void {
    if (this.running) return;
    bindDnsUdpServer(this.host, this.handleQuery, DNS_PORT, 'dns');
    bindDnsTcpServer(this.host, this.handleQuery, DNS_PORT);
    this.running = true;
  }

  stop(): void {
    if (!this.running) return;
    unbindDnsUdpServer(this.host, DNS_PORT);
    unbindDnsTcpServer(this.host, DNS_PORT);
    this.running = false;
  }

  private readonly handleQuery = (query: DnsMessage): DnsMessage | Promise<DnsMessage> => {
    const response = this.authoritative.answer(query);
    const question = query.questions[0];
    const outsideAuthority = !response.flags.aa && response.flags.rcode === DnsRcode.REFUSED;
    if (outsideAuthority && question && query.flags.rd && this.resolver) {
      return this.recurse(query);
    }
    return response;
  };

  private async recurse(query: DnsMessage): Promise<DnsMessage> {
    const question = query.questions[0];
    const result = await this.resolver!.resolve(question.qname, question.qtype);
    const rcode =
      result.status === 'NOERROR' ? DnsRcode.NOERROR :
      result.status === 'NXDOMAIN' ? DnsRcode.NXDOMAIN : DnsRcode.SERVFAIL;
    return {
      id: query.id,
      flags: {
        qr: true, opcode: DnsOpcode.QUERY, aa: false, tc: false,
        rd: query.flags.rd, ra: true, ad: false, cd: false, rcode,
      },
      questions: [question],
      answers: [...result.answers],
      authorities: [],
      additionals: [],
    };
  }

  // ─── Forwarders (Set-DnsServerForwarder) ────────────────────────────

  setForwarders(addresses: readonly string[]): DnsOpResult {
    const parsed: IPAddress[] = [];
    for (const a of addresses) {
      const ip = IPAddress.tryParse(a);
      if (!ip) return { ok: false, message: `"${a}" is not a valid IPv4 address.` };
      parsed.push(ip);
    }
    this.forwarderAddresses = [...addresses];
    this.resolver = parsed.length > 0 ? new RecursiveResolver(this.host, parsed, new DnsCache()) : null;
    return { ok: true, message: '' };
  }

  getForwarders(): string[] { return [...this.forwarderAddresses]; }

  // ─── Zones (Add-DnsServerPrimaryZone / Get-DnsServerZone) ───────────

  addPrimaryZone(name: string, opts: { adminEmail?: string; ttl?: number } = {}): DnsOpResult {
    const origin = name.toLowerCase();
    if (this.store.getZone(origin)) {
      return { ok: false, message: `A zone named "${name}" is already configured on this server.` };
    }
    const ttl = opts.ttl ?? 3600;
    const mname = `ns1.${origin}`;
    const rname = (opts.adminEmail ?? `hostmaster.${origin}`).replace('@', '.');
    try {
      const soa = makeSoaRecord(origin, ttl, {
        mname, rname, serial: 1, refresh: 900, retry: 600, expire: 86400, minimum: ttl,
      });
      const zone = new Zone(origin, soa);
      this.store.addZone(zone);
      return { ok: true, message: '' };
    } catch (e) {
      if (e instanceof ZoneError || e instanceof ZoneStoreError) return { ok: false, message: e.message };
      throw e;
    }
  }

  removeZone(name: string): DnsOpResult {
    if (!this.store.removeZone(name)) return { ok: false, message: `Zone "${name}" does not exist.` };
    return { ok: true, message: '' };
  }

  getZone(name: string): DnsZoneInfo | null {
    const zone = this.store.getZone(name);
    return zone ? { name: zone.origin, recordCount: zone.allRecords().length } : null;
  }

  listZones(): DnsZoneInfo[] {
    return this.store.listZones().map(z => ({ name: z.origin, recordCount: z.allRecords().length }));
  }

  // ─── Records (Add/Get/Remove-DnsServerResourceRecord*) ──────────────

  private zoneFor(zoneName: string, cmdletName: string): Zone | { error: DnsOpResult } {
    const zone = this.store.getZone(zoneName);
    if (!zone) return { error: { ok: false, message: `${cmdletName} : Zone "${zoneName}" does not exist on this server.` } };
    return zone;
  }

  private fqdn(recordName: string, zone: Zone): string {
    return recordName === '@' || recordName === '' ? zone.origin : `${recordName}.${zone.origin}`;
  }

  addARecord(zoneName: string, recordName: string, ipv4: string, ttl = 3600): DnsOpResult {
    const zone = this.zoneFor(zoneName, 'Add-DnsServerResourceRecordA');
    if ('error' in zone) return zone.error;
    try {
      zone.addRecord(makeARecord(this.fqdn(recordName, zone), ttl, ipv4));
      bumpSerial(zone);
      return { ok: true, message: '' };
    } catch (e) { return { ok: false, message: (e as Error).message }; }
  }

  addAaaaRecord(zoneName: string, recordName: string, ipv6: string, ttl = 3600): DnsOpResult {
    const zone = this.zoneFor(zoneName, 'Add-DnsServerResourceRecordAAAA');
    if ('error' in zone) return zone.error;
    try {
      zone.addRecord(makeAaaaRecord(this.fqdn(recordName, zone), ttl, ipv6));
      bumpSerial(zone);
      return { ok: true, message: '' };
    } catch (e) { return { ok: false, message: (e as Error).message }; }
  }

  addCnameRecord(zoneName: string, recordName: string, hostNameAlias: string, ttl = 3600): DnsOpResult {
    const zone = this.zoneFor(zoneName, 'Add-DnsServerResourceRecordCName');
    if ('error' in zone) return zone.error;
    try {
      zone.addRecord(makeCnameRecord(this.fqdn(recordName, zone), ttl, hostNameAlias));
      bumpSerial(zone);
      return { ok: true, message: '' };
    } catch (e) { return { ok: false, message: (e as Error).message }; }
  }

  addPtrRecord(zoneName: string, recordName: string, ptrDomainName: string, ttl = 3600): DnsOpResult {
    const zone = this.zoneFor(zoneName, 'Add-DnsServerResourceRecordPtr');
    if ('error' in zone) return zone.error;
    try {
      zone.addRecord(makePtrRecord(this.fqdn(recordName, zone), ttl, ptrDomainName));
      bumpSerial(zone);
      return { ok: true, message: '' };
    } catch (e) { return { ok: false, message: (e as Error).message }; }
  }

  addMxRecord(zoneName: string, recordName: string, preference: number, mailExchange: string, ttl = 3600): DnsOpResult {
    const zone = this.zoneFor(zoneName, 'Add-DnsServerResourceRecordMX');
    if ('error' in zone) return zone.error;
    try {
      zone.addRecord(makeMxRecord(this.fqdn(recordName, zone), ttl, preference, mailExchange));
      bumpSerial(zone);
      return { ok: true, message: '' };
    } catch (e) { return { ok: false, message: (e as Error).message }; }
  }

  addSrvRecord(
    zoneName: string, recordName: string, target: { priority: number; weight: number; port: number; target: string }, ttl = 3600,
  ): DnsOpResult {
    const zone = this.zoneFor(zoneName, 'Add-DnsServerResourceRecord -Srv');
    if ('error' in zone) return zone.error;
    try {
      zone.addRecord(makeSrvRecord(this.fqdn(recordName, zone), ttl, target));
      bumpSerial(zone);
      return { ok: true, message: '' };
    } catch (e) { return { ok: false, message: (e as Error).message }; }
  }

  removeRecord(zoneName: string, recordName: string, type: string): DnsOpResult {
    const zone = this.zoneFor(zoneName, 'Remove-DnsServerResourceRecord');
    if ('error' in zone) return zone.error;
    const rrType = RRType[type.toUpperCase() as keyof typeof RRType];
    if (rrType === undefined) return { ok: false, message: `Unknown record type "${type}".` };
    const fqdn = this.fqdn(recordName, zone);
    const existing = zone.getRRSet(fqdn, rrType) ?? [];
    if (existing.length === 0) return { ok: false, message: `Cannot find "${fqdn}" of type ${type} in zone "${zoneName}".` };
    for (const rr of [...existing]) zone.removeRecord(rr);
    bumpSerial(zone);
    return { ok: true, message: '' };
  }

  /** `Get-DnsServerResourceRecord` — all records in a zone, or only those under one name when given. */
  getRecords(zoneName: string, recordName?: string): DnsRecordInfo[] | null {
    const zone = this.store.getZone(zoneName);
    if (!zone) return null;
    const all = zone.allRecords();
    const filtered = recordName ? all.filter(rr => rr.name.toLowerCase() === this.fqdn(recordName, zone).toLowerCase()) : all;
    return filtered.map(rr => ({
      name: rr.name, type: RR_TYPE_NAME.get(rr.data.type) ?? String(rr.data.type), ttl: rr.ttl, text: formatRecordData(rr),
    }));
  }

  /** Direct in-process zone mutation for dynamic updates (DHCP lease grant, domain join) — see file header. */
  applyDynamicARecord(zoneName: string, fqdnName: string, ipv4: string, ttl = 3600): DnsOpResult {
    const zone = this.store.getZone(zoneName);
    if (!zone) return { ok: false, message: `Zone "${zoneName}" does not exist on this server.` };
    for (const rr of zone.getRRSet(fqdnName, RRType.A) ?? []) zone.removeRecord(rr);
    zone.addRecord(makeARecord(fqdnName, ttl, ipv4));
    bumpSerial(zone);
    return { ok: true, message: '' };
  }
}
