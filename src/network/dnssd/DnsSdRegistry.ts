/**
 * Le registre des services que cet hôte publie, et la synthèse des
 * enregistrements qui les décrivent (RFC 6763).
 *
 * Le registre ne connaît ni le fil ni mDNS : il répond à « quels
 * enregistrements pour cette question ? ». C'est ce qui permet de le
 * tester sans réseau, et à `MdnsAgent` de rester le seul à savoir
 * comment on parle à un groupe.
 */
import { RRType } from '@/network/dns/wire/RRType';
import {
  makePtrRecord, makeSrvRecord, makeTxtRecord, makeARecord,
} from '@/network/dns/wire/ResourceRecord';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';
import {
  DNSSD_DOMAIN, DNSSD_ENUM_NAME, instanceName, serviceTypeName,
  parseSubtypeName, subtypeName, type ServiceRegistration,
} from './types';

/** RFC 6763 §6.1 recommande un TTL long pour SRV/TXT/PTR de service. */
export const DNSSD_RECORD_TTL = 120;

export interface DnsSdOwner {
  /** Le nom d'hôte qui porte les services — `alpha.local`. */
  hostName(): string;
  /** Ses adresses, pour l'enregistrement additionnel. */
  addresses(): string[];
}

function normalizeSubtype(s: string): string {
  return s.toLowerCase().startsWith('_') ? s.toLowerCase() : `_${s.toLowerCase()}`;
}

/** Deux déclarations décrivent-elles le même service, champ pour champ ? */
function sameRegistration(a: ServiceRegistration, b: ServiceRegistration): boolean {
  return a.port === b.port
    && (a.priority ?? 0) === (b.priority ?? 0)
    && (a.weight ?? 0) === (b.weight ?? 0)
    && a.txt.join('\u0000') === b.txt.join('\u0000')
    && [...(a.subtypes ?? [])].sort().join(',') === [...(b.subtypes ?? [])].sort().join(',');
}

export class DnsSdRegistry {
  private readonly services = new Map<string, ServiceRegistration>();

  constructor(private readonly owner: DnsSdOwner) {}

  private key(reg: { instance: string; type: string }): string {
    return instanceName(reg.instance, reg.type).toLowerCase();
  }

  /**
   * Ajoute ou remplace. Rend `true` quand quelque chose a réellement
   * changé — c'est ce qui décide s'il faut réannoncer : republier à
   * l'identique n'apprend rien à personne.
   */
  publish(reg: ServiceRegistration): boolean {
    const key = this.key(reg);
    const before = this.services.get(key);
    const stored: ServiceRegistration = {
      ...reg, txt: [...reg.txt], subtypes: [...(reg.subtypes ?? [])],
    };
    this.services.set(key, stored);
    return before === undefined || !sameRegistration(before, stored);
  }

  get(instance: string, type: string): ServiceRegistration | undefined {
    return this.services.get(this.key({ instance, type }));
  }

  unpublish(instance: string, type: string): boolean {
    return this.services.delete(this.key({ instance, type }));
  }

  clear(): void { this.services.clear(); }

  list(): ServiceRegistration[] { return [...this.services.values()]; }

  /** Les types distincts publiés, pour l'énumération de §9. */
  types(): string[] {
    return [...new Set([...this.services.values()].map((s) => s.type.toLowerCase()))];
  }

  /**
   * Ce que cet hôte a à dire sur une question. Rend un tableau vide
   * quand il n'a rien — sur un groupe multicast, se taire est la seule
   * réponse honnête à une question qui ne nous concerne pas.
   *
   * `additionals` porte ce que le demandeur voudra de toute façon
   * ensuite (§12) : le SRV et le TXT d'une instance nommée par un PTR,
   * l'adresse de l'hôte nommé par un SRV. Un client bien fait n'a alors
   * qu'un aller-retour à faire.
   */
  answer(qname: string, qtype: number): {
    answers: ResourceRecord<ResourceRecordData>[];
    additionals: ResourceRecord<ResourceRecordData>[];
  } {
    const name = qname.toLowerCase().replace(/\.$/, '');
    const wants = (t: number): boolean => qtype === t || qtype === RRType.ANY;
    const answers: ResourceRecord<ResourceRecordData>[] = [];
    const additionals: ResourceRecord<ResourceRecordData>[] = [];

    // §9 — « quels types de services y a-t-il ici ? »
    if (name === DNSSD_ENUM_NAME && wants(RRType.PTR)) {
      for (const type of this.types()) {
        answers.push(makePtrRecord(DNSSD_ENUM_NAME, DNSSD_RECORD_TTL, serviceTypeName(type)));
      }
      return { answers, additionals };
    }

    // §7.1 — « quelles instances de ce sous-type ? ». Le PTR pointe vers
    // la même instance : un sous-type restreint la découverte, il ne
    // crée pas un second service.
    const sub = parseSubtypeName(name);
    if (sub && wants(RRType.PTR)) {
      for (const reg of this.services.values()) {
        if (serviceTypeName(reg.type) !== serviceTypeName(sub.type)) continue;
        if (!(reg.subtypes ?? []).some((s) => normalizeSubtype(s) === sub.subtype)) continue;
        answers.push(makePtrRecord(name, DNSSD_RECORD_TTL, instanceName(reg.instance, reg.type)));
        additionals.push(...this.instanceRecords(reg));
      }
      return { answers, additionals };
    }

    // §4.1 — « quelles instances de ce type ? »
    for (const reg of this.services.values()) {
      if (serviceTypeName(reg.type) !== name || !wants(RRType.PTR)) continue;
      const fqdn = instanceName(reg.instance, reg.type);
      answers.push(makePtrRecord(name, DNSSD_RECORD_TTL, fqdn));
      additionals.push(...this.instanceRecords(reg));
    }
    if (answers.length > 0) return { answers, additionals };

    // §5 — « où est cette instance, et que dit-elle d'elle-même ? »
    for (const reg of this.services.values()) {
      const fqdn = instanceName(reg.instance, reg.type).toLowerCase();
      if (fqdn !== name) continue;
      if (wants(RRType.SRV)) answers.push(this.srvFor(reg));
      if (wants(RRType.TXT)) answers.push(this.txtFor(reg));
      if (answers.length > 0) additionals.push(...this.hostRecords());
    }
    return { answers, additionals };
  }

  private srvFor(
    reg: ServiceRegistration, ttl: number = DNSSD_RECORD_TTL,
  ): ResourceRecord<ResourceRecordData> {
    return makeSrvRecord(instanceName(reg.instance, reg.type), ttl, {
      priority: reg.priority ?? 0,
      weight: reg.weight ?? 0,
      port: reg.port,
      target: this.owner.hostName(),
    });
  }

  /**
   * Tout ce qui décrit un service sur le fil : son PTR de type, ses
   * PTR de sous-type, son SRV et son TXT. C'est ce jeu qu'une annonce
   * de mise à jour republie et qu'un adieu retire (§8.4, §10.1).
   */
  announcementRecords(
    reg: ServiceRegistration, ttl: number = DNSSD_RECORD_TTL,
  ): ResourceRecord<ResourceRecordData>[] {
    const fqdn = instanceName(reg.instance, reg.type);
    const records: ResourceRecord<ResourceRecordData>[] = [
      makePtrRecord(serviceTypeName(reg.type), ttl, fqdn),
      this.srvFor(reg, ttl),
      this.txtFor(reg, ttl),
    ];
    for (const s of reg.subtypes ?? []) {
      records.push(makePtrRecord(subtypeName(s, reg.type), ttl, fqdn));
    }
    return records;
  }

  private txtFor(
    reg: ServiceRegistration, ttl: number = DNSSD_RECORD_TTL,
  ): ResourceRecord<ResourceRecordData> {
    // §6.1 : un TXT vide s'écrit avec un unique segment nul, jamais avec
    // zéro segment — un enregistrement sans donnée serait mal formé.
    const segments = reg.txt.length > 0 ? reg.txt : [''];
    return makeTxtRecord(instanceName(reg.instance, reg.type), ttl, segments);
  }

  private instanceRecords(reg: ServiceRegistration): ResourceRecord<ResourceRecordData>[] {
    return [this.srvFor(reg), this.txtFor(reg), ...this.hostRecords()];
  }

  private hostRecords(): ResourceRecord<ResourceRecordData>[] {
    return this.owner.addresses().map(
      (ip) => makeARecord(this.owner.hostName(), DNSSD_RECORD_TTL, ip));
  }
}

export { DNSSD_DOMAIN };
