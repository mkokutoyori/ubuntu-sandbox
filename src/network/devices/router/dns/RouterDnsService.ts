import type { CiscoDnsConfig } from './CiscoDnsConfig';
import type { RouterHostsTable } from './RouterHostsTable';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { makeARecord, makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { Zone } from '@/network/dns/zone/Zone';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { truncateForUdp, negotiatedUdpSize } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

export interface DnsStats {
  recues: number;
  repondues: number;
  nxdomain: number;
  transferees: number;
}

export interface DnsTransport {
  sendQuery(serveur: string, nom: string): Promise<string[]>;
  bind(port: number, onQuery: (source: string, sourcePort: number, charge: unknown) => void): boolean;
  unbind(port: number): void;
  reply(destination: string, destinationPort: number, charge: unknown): void;
}

export const DNS_PORT = 53;

const HOSTS_RECORD_TTL = 86400;
const HOSTS_ZONE_TTL = 86400;

export class RouterDnsService {
  readonly stats: DnsStats = { recues: 0, repondues: 0, nxdomain: 0, transferees: 0 };
  private lie = false;

  constructor(
    private readonly config: () => CiscoDnsConfig,
    private readonly hosts: () => RouterHostsTable,
    private readonly transport: () => DnsTransport | null,
    private readonly trace: (texte: string) => void = () => {},
  ) {}

  sync(): void {
    const veut = this.config().serverEnabled;
    if (veut === this.lie) return;
    const t = this.transport();
    if (!t) return;
    if (veut) {
      this.lie = t.bind(DNS_PORT, (src, sport, charge) => this.onQuery(src, sport, charge));
    } else {
      t.unbind(DNS_PORT);
      this.lie = false;
    }
  }

  estLie(): boolean { return this.lie; }

  private hostsZone(): Zone {
    const zone = new Zone('', makeSoaRecord('', HOSTS_ZONE_TTL, {
      mname: 'router', rname: 'hostmaster', serial: 1,
      refresh: 3600, retry: 600, expire: 86400, minimum: HOSTS_ZONE_TTL,
    }));
    for (const entry of this.hosts().entries()) {
      for (const ip of entry.ips) {
        try {
          zone.addRecord(makeARecord(entry.name, HOSTS_RECORD_TTL, ip));
        } catch {
          continue;
        }
      }
    }
    return zone;
  }

  private onQuery(source: string, sourcePort: number, charge: unknown): void {
    let requete: DnsMessage;
    try { requete = decodeDnsMessage(charge as Uint8Array); } catch { return; }
    if (requete.flags.qr) return;
    this.stats.recues += 1;
    const store = new ZoneStore();
    store.addZone(this.hostsZone());
    const reponse = new AuthoritativeServer(store).answer(requete);
    if (reponse.answers.length > 0) this.stats.repondues += 1;
    else if (reponse.flags.rcode === DnsRcode.NXDOMAIN) this.stats.nxdomain += 1;
    this.transport()?.reply(
      source, sourcePort, encodeDnsMessage(truncateForUdp(reponse, negotiatedUdpSize(requete))));
  }

  private candidats(nom: string): string[] {
    if (nom.includes('.')) return [nom];
    const suffixes = this.config().suffixesDeRecherche();
    return suffixes.length > 0 ? [...suffixes.map((s) => `${nom}.${s}`), nom] : [nom];
  }

  resolveLocal(nom: string): string | null {
    for (const candidat of this.candidats(nom)) {
      const ip = this.hosts().resolve(candidat);
      if (ip) return ip;
    }
    return null;
  }

  async resolve(nom: string): Promise<string | null> {
    const local = this.resolveLocal(nom);
    if (local) return local;
    const cfg = this.config();
    if (!cfg.lookupEnabled || cfg.nameServers.length === 0) return null;
    const t = this.transport();
    if (!t) return null;
    for (const candidat of this.candidats(nom)) {
      for (const serveur of cfg.nameServers) {
        this.trace(`Domain: query for ${candidat} to ${serveur}`);
        const adresses = await t.sendQuery(serveur, candidat);
        if (adresses.length === 0) continue;
        this.trace(`Domain: reply for ${candidat} is ${adresses.join(', ')}`);
        this.hosts().upsert(candidat, [...adresses], false);
        return adresses[0];
      }
    }
    this.trace(`Domain: no reply for ${nom}`);
    return null;
  }
}
