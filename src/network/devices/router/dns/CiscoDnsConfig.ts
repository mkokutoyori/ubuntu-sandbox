import { isValidIPv4 } from '@/network/core/ip';

export const DNS_TIMEOUT_DEFAUT = 3;
export const DNS_RETRY_DEFAUT = 2;
export const DNS_MAX_SERVEURS = 6;

export interface DnsPrimaryZone {
  readonly zone: string;
  readonly primaire: string;
  readonly boite: string;
  readonly refresh: number | null;
  readonly retry: number | null;
  readonly expire: number | null;
  readonly minimum: number | null;
}

export type DnsErreur =
  | { kind: 'incomplete' }
  | { kind: 'invalid'; token: string };

const INCOMPLET: DnsErreur = { kind: 'incomplete' };
const INVALIDE = (t: string): DnsErreur => ({ kind: 'invalid', token: t });

export class CiscoDnsConfig {
  lookupEnabled = true;
  domainName = '';
  readonly domainList: string[] = [];
  readonly nameServers: string[] = [];
  timeout = DNS_TIMEOUT_DEFAUT;
  retry = DNS_RETRY_DEFAUT;
  roundRobin = false;
  lookupSourceInterface: string | null = null;
  serverEnabled = false;
  spoofing = false;
  spoofingAddress: string | null = null;
  readonly primaryZones = new Map<string, DnsPrimaryZone>();
  readonly nsRecords = new Map<string, string[]>();

  setNameServers(adresses: string[]): DnsErreur | null {
    if (adresses.length === 0) return INCOMPLET;
    if (adresses.length > DNS_MAX_SERVEURS) return INVALIDE(adresses[DNS_MAX_SERVEURS]);
    for (const a of adresses) if (!isValidIPv4(a)) return INVALIDE(a);
    for (const a of adresses) if (!this.nameServers.includes(a)) this.nameServers.push(a);
    return null;
  }

  removeNameServers(adresses: string[]): void {
    if (adresses.length === 0) { this.nameServers.length = 0; return; }
    for (const a of adresses) {
      const i = this.nameServers.indexOf(a);
      if (i >= 0) this.nameServers.splice(i, 1);
    }
  }

  addDomainToList(nom: string): DnsErreur | null {
    if (!nom) return INCOMPLET;
    if (!this.domainList.includes(nom)) this.domainList.push(nom);
    return null;
  }

  removeDomainFromList(nom: string): void {
    if (!nom) { this.domainList.length = 0; return; }
    const i = this.domainList.indexOf(nom);
    if (i >= 0) this.domainList.splice(i, 1);
  }

  setPrimaryZone(args: string[]): DnsErreur | null {
    const [zone, mot, primaire, boite, ...reste] = args;
    if (!zone || mot?.toLowerCase() !== 'soa' || !primaire || !boite) return INCOMPLET;
    const nombre = (i: number): number | null => {
      const v = reste[i];
      if (v === undefined) return null;
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    };
    this.primaryZones.set(zone.toLowerCase(), {
      zone, primaire, boite,
      refresh: nombre(0), retry: nombre(1), expire: nombre(2), minimum: nombre(3),
    });
    return null;
  }

  addNsRecord(zone: string, serveur: string): DnsErreur | null {
    if (!zone || !serveur) return INCOMPLET;
    const cle = zone.toLowerCase();
    const liste = this.nsRecords.get(cle) ?? [];
    if (!liste.includes(serveur)) liste.push(serveur);
    this.nsRecords.set(cle, liste);
    return null;
  }

  suffixesDeRecherche(): string[] {
    if (this.domainList.length > 0) return [...this.domainList];
    return this.domainName ? [this.domainName] : [];
  }

  runningConfigLines(): string[] {
    const l: string[] = [];
    if (!this.lookupEnabled) l.push('no ip domain-lookup');
    if (this.lookupSourceInterface) {
      l.push(`ip domain-lookup source-interface ${this.lookupSourceInterface}`);
    }
    if (this.domainName) l.push(`ip domain-name ${this.domainName}`);
    for (const d of this.domainList) l.push(`ip domain list ${d}`);
    if (this.nameServers.length > 0) l.push(`ip name-server ${this.nameServers.join(' ')}`);
    if (this.timeout !== DNS_TIMEOUT_DEFAUT) l.push(`ip domain timeout ${this.timeout}`);
    if (this.retry !== DNS_RETRY_DEFAUT) l.push(`ip domain retry ${this.retry}`);
    if (this.roundRobin) l.push('ip domain round-robin');
    for (const z of this.primaryZones.values()) {
      const opts = [z.refresh, z.retry, z.expire, z.minimum]
        .filter((v): v is number => v !== null).join(' ');
      l.push(`ip dns primary ${z.zone} soa ${z.primaire} ${z.boite}${opts ? ` ${opts}` : ''}`);
    }
    for (const [zone, serveurs] of this.nsRecords) {
      for (const s of serveurs) l.push(`ip host ${zone} ns ${s}`);
    }
    if (this.serverEnabled) l.push('ip dns server');
    if (this.spoofing) {
      l.push(`ip dns spoofing${this.spoofingAddress ? ` ${this.spoofingAddress}` : ''}`);
    }
    return l;
  }
}
