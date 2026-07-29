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
  type ServiceRegistration,
} from './types';

/** RFC 6763 §6.1 recommande un TTL long pour SRV/TXT/PTR de service. */
export const DNSSD_RECORD_TTL = 120;

export interface DnsSdOwner {
  /** Le nom d'hôte qui porte les services — `alpha.local`. */
  hostName(): string;
  /** Ses adresses, pour l'enregistrement additionnel. */
  addresses(): string[];
}

export class DnsSdRegistry {
  private readonly services = new Map<string, ServiceRegistration>();

  constructor(private readonly owner: DnsSdOwner) {}

  private key(reg: { instance: string; type: string }): string {
    return instanceName(reg.instance, reg.type).toLowerCase();
  }

  publish(reg: ServiceRegistration): void {
    this.services.set(this.key(reg), { ...reg, txt: [...reg.txt] });
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

  private srvFor(reg: ServiceRegistration): ResourceRecord<ResourceRecordData> {
    return makeSrvRecord(instanceName(reg.instance, reg.type), DNSSD_RECORD_TTL, {
      priority: 0, weight: 0, port: reg.port, target: this.owner.hostName(),
    });
  }

  private txtFor(reg: ServiceRegistration): ResourceRecord<ResourceRecordData> {
    // §6.1 : un TXT vide s'écrit avec un unique segment nul, jamais avec
    // zéro segment — un enregistrement sans donnée serait mal formé.
    const segments = reg.txt.length > 0 ? reg.txt : [''];
    return makeTxtRecord(instanceName(reg.instance, reg.type), DNSSD_RECORD_TTL, segments);
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
