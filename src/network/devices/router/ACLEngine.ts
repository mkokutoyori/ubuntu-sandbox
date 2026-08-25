/**
 * ACLEngine - Access Control List evaluation engine
 *
 * Extracted from Router to follow Single Responsibility Principle.
 * Manages numbered/named ACLs and interface bindings.
 */

import { protocolKeywordFor } from './acl/AclSyntax';
import type { SubnetMask, IPv4Packet, UDPPacket, ICMPPacket, TCPPacket } from '../../core/types';
import { IPAddress } from '../../core/types';
import { IP_PROTO_TCP } from '../../core/types';
import { ReflexiveSessions } from './acl/ReflexiveSessions';

export const DSCP_KEYWORD_TO_VALUE: Record<string, number> = {
  default: 0, cs0: 0, cs1: 8, cs2: 16, cs3: 24, cs4: 32, cs5: 40, cs6: 48, cs7: 56,
  af11: 10, af12: 12, af13: 14, af21: 18, af22: 20, af23: 22,
  af31: 26, af32: 28, af33: 30, af41: 34, af42: 36, af43: 38, ef: 46,
};

const PRECEDENCE_KEYWORD_TO_VALUE: Record<string, number> = {
  routine: 0, priority: 1, immediate: 2, flash: 3,
  'flash-override': 4, critical: 5, internet: 6, network: 7,
};

/**
 * Les mots-clés ICMP que ce simulateur sait ÉVALUER.
 *
 * `ICMPType` ne modélise que cinq types (echo-request, echo-reply,
 * destination-unreachable, redirect, time-exceeded) ; le CODE affine les
 * variantes d'`unreachable` et de `time-exceeded`. Les mots-clés qu'IOS
 * accepte et qui restent hors de portée — `source-quench`,
 * `parameter-problem`, `traceroute`, `router-advertisement/solicitation`,
 * `mask-*`, `timestamp-*`, `information-*` — décrivent des paquets
 * qu'aucun équipement d'ici ne produit.
 *
 * Un mot-clé absent de cette table fait donc échouer la correspondance
 * (voir `aclEntryMatches`) : c'est le seul choix sûr. Le faire réussir
 * revenait à ce qu'une ACE portant un critère inconnu corresponde à TOUT
 * le trafic ICMP, donc à ouvrir la liste au lieu de la restreindre.
 */
const ACL_ICMP_KEYWORDS: Record<string, { type: string; code?: number }> = {
  'echo': { type: 'echo-request' },
  'echo-request': { type: 'echo-request' },
  'echo-reply': { type: 'echo-reply' },
  // `unreachable` nu couvre toutes les variantes ; les mots-clés précis
  // se distinguent par le CODE ICMP, qui n'était pas lu — de sorte que
  // `host-unreachable` bloquait aussi les `port-unreachable`.
  'unreachable': { type: 'destination-unreachable' },
  'net-unreachable': { type: 'destination-unreachable', code: 0 },
  'host-unreachable': { type: 'destination-unreachable', code: 1 },
  'protocol-unreachable': { type: 'destination-unreachable', code: 2 },
  'port-unreachable': { type: 'destination-unreachable', code: 3 },
  'packet-too-big': { type: 'destination-unreachable', code: 4 },
  'administratively-prohibited': { type: 'destination-unreachable', code: 13 },
  'time-exceeded': { type: 'time-exceeded' },
  'ttl-exceeded': { type: 'time-exceeded', code: 0 },
  'redirect': { type: 'redirect' },
};

// ─── Drapeaux TCP ───────────────────────────────────────────────

const TCP_FLAG_NAMES = ['ack', 'fin', 'psh', 'rst', 'syn', 'urg'] as const;
type TcpFlagName = typeof TCP_FLAG_NAMES[number];

/**
 * Un jeton de `match-any` / `match-all` : `+syn` exige le drapeau posé,
 * `-syn` l'exige absent, `syn` nu vaut `+syn`. Rend `null` sur un nom
 * inconnu — l'appelant fait alors échouer la correspondance.
 */
function parseTcpFlagToken(token: string): { flag: TcpFlagName; mustBeSet: boolean } | null {
  const tok = token.toLowerCase();
  const signed = tok.startsWith('+') || tok.startsWith('-');
  const name = signed ? tok.slice(1) : tok;
  if (!(TCP_FLAG_NAMES as readonly string[]).includes(name)) return null;
  return { flag: name as TcpFlagName, mustBeSet: !tok.startsWith('-') };
}

// ─── Numérotation des listes, par vendeur ───────────────────────

/** Quel type de liste porte ce numéro ? La réponse dépend du vendeur. */
export type AclNumbering = (id: number) => 'standard' | 'extended';

/** IOS : 1-99 et 1300-1999 standard ; 100-199 et 2000-2699 étendues. */
export const IOS_ACL_NUMBERING: AclNumbering = (id) =>
  ((id >= 1 && id <= 99) || (id >= 1300 && id <= 1999)) ? 'standard' : 'extended';

/** VRP : 2000-2999 « basic » (source seule) ; 3000-3999 « advanced ». */
export const VRP_ACL_NUMBERING: AclNumbering = (id) =>
  (id >= 2000 && id <= 2999) ? 'standard' : 'extended';

// ─── Numérotation des ENTRÉES, par vendeur ──────────────────────

/**
 * Quel numéro attribuer à une entrée que l'opérateur n'a pas numérotée ?
 * `maxSeq` est le plus grand numéro déjà pris, `null` si la liste est vide.
 */
export type AclSequencing = (maxSeq: number | null, step: number) => number;

/** IOS : « le dernier + 10 », en partant de 10. */
export const IOS_SEQUENCING: AclSequencing = (maxSeq) => (maxSeq === null ? 10 : maxSeq + 10);

/**
 * VRP : le MULTIPLE DU PAS suivant, en partant du pas lui-même. Une liste
 * contenant les règles 5 et 7 avec un pas de 5 numérote la suivante 10,
 * et non 17 — ce n'est pas la formule d'IOS.
 */
export const VRP_SEQUENCING: AclSequencing = (maxSeq, step) =>
  maxSeq === null ? step : Math.floor(maxSeq / step) * step + step;

/** Le pas par défaut de chaque plateforme. VRP l'expose par `step`. */
export const IOS_DEFAULT_STEP = 10;
export const VRP_DEFAULT_STEP = 5;

// ─── Sonde « adresse source » ───────────────────────────────────

/**
 * Un paquet-sonde COMPLET, pour les questions qui ne portent que sur une
 * adresse source : `access-class` sur une vty, `ntp access-group`,
 * `ip nat inside source list`.
 *
 * Ces appelants passaient un objet ne portant que `sourceIP`, transtypé
 * pour faire taire le vérificateur. Sur une liste ÉTENDUE, la
 * correspondance cherchait alors la destination et lisait `.getOctets()`
 * sur `undefined` : le routeur plantait. Une sonde bien formée supprime
 * la cause ; les critères qu'elle ne peut pas renseigner (ports,
 * drapeaux) ne correspondent pas, conformément à la règle d'échec.
 */
export function sourceProbePacket(src: IPAddress, dst?: IPAddress): IPv4Packet {
  return {
    type: 'ipv4',
    version: 4, ihl: 5, tos: 0, dscp: 0, ecn: 0,
    totalLength: 20, identification: 0, flags: 0, fragmentOffset: 0,
    ttl: 255, protocol: IP_PROTO_TCP, headerChecksum: 0,
    sourceIP: src,
    destinationIP: dst ?? new IPAddress('0.0.0.0'),
    payload: undefined,
  } as unknown as IPv4Packet;
}

// ─── ACL Types ──────────────────────────────────────────────────

export type PortOperator = 'eq' | 'neq' | 'gt' | 'lt' | 'range';

export interface PortSpec {
  op: PortOperator;
  port: number;
  endPort?: number;
}

/**
 * Un critere NUMERIQUE compare par un operateur : c'est la grammaire du
 * port, et `ttl` la reprend mot pour mot. Un seul type pour les deux
 * evite que l'un accepte `range` et l'autre non.
 */
export interface RangeSpec {
  op: PortOperator;
  value: number;
  endValue?: number;
}

/** Le verdict d'un `RangeSpec` sur une valeur. */
export function rangeSpecMatches(spec: RangeSpec, value: number): boolean {
  switch (spec.op) {
    case 'eq': return value === spec.value;
    case 'neq': return value !== spec.value;
    case 'lt': return value < spec.value;
    case 'gt': return value > spec.value;
    case 'range':
      return value >= spec.value && value <= (spec.endValue ?? spec.value);
  }
}

/** Un groupe nomme d'adresses, reutilisable dans plusieurs ACE. */
export interface ObjectGroupMember {
  ip: IPAddress;
  /** Masque GENERIQUE, deja converti depuis le masque reseau saisi. */
  wildcard: SubnetMask;
}

export interface ObjectGroup {
  name: string;
  kind: 'network';
  description?: string;
  members: ObjectGroupMember[];
}

export interface ACLEntry {
  sequence?: number;
  /** L'opérateur a-t-il ÉCRIT ce numéro ? IOS ne le rend en configuration que dans ce cas. */
  sequenceConfigured?: boolean;
  action: 'permit' | 'deny';
  protocol?: string;
  srcIP: IPAddress;
  srcWildcard: SubnetMask;
  dstIP?: IPAddress;
  dstWildcard?: SubnetMask;
  srcPort?: number;
  dstPort?: number;
  srcPortSpec?: PortSpec;
  dstPortSpec?: PortSpec;
  icmpType?: string;
  icmpCode?: number;
  tcpEstablished?: boolean;
  tcpFlags?: string[];
  /** `match-all` exige tous les drapeaux, `match-any` un seul. Défaut : `any`. */
  tcpFlagsMatch?: 'any' | 'all';
  dscp?: string;
  precedence?: string;
  tos?: string;
  log?: boolean;
  logInput?: boolean;
  timeRange?: string;
  /**
   * `reflect NAME` — l'ACE qui le porte filtre normalement sur ses autres
   * critères, et DÉPOSE en plus la session miroir quand elle permet le
   * paquet. `evaluate NAME` consulte cette table (`ReflexiveSessions`).
   */
  reflect?: string;
  reflectTimeout?: number;
  evaluate?: string;
  fragments?: boolean;
  optionName?: string;
  remark?: string;
  /** `ttl <operateur> <valeur>` — la duree de vie du paquet. */
  ttl?: RangeSpec;
  /** `object-group <nom>` a la place d'une adresse source. */
  srcObjectGroup?: string;
  /** `object-group <nom>` a la place d'une adresse destination. */
  dstObjectGroup?: string;
  matchCount: number;
}

export interface ACLEntryOptions {
  sequence?: number;
  /** L'opérateur a-t-il ÉCRIT ce numéro ? IOS ne le rend en configuration que dans ce cas. */
  sequenceConfigured?: boolean;
  protocol?: string;
  srcIP: IPAddress;
  srcWildcard: SubnetMask;
  dstIP?: IPAddress;
  dstWildcard?: SubnetMask;
  srcPort?: number;
  dstPort?: number;
  srcPortSpec?: PortSpec;
  dstPortSpec?: PortSpec;
  icmpType?: string;
  icmpCode?: number;
  tcpEstablished?: boolean;
  tcpFlags?: string[];
  /** `match-all` exige tous les drapeaux, `match-any` un seul. Défaut : `any`. */
  tcpFlagsMatch?: 'any' | 'all';
  dscp?: string;
  precedence?: string;
  tos?: string;
  log?: boolean;
  logInput?: boolean;
  timeRange?: string;
  reflect?: string;
  reflectTimeout?: number;
  evaluate?: string;
  fragments?: boolean;
  optionName?: string;
  remark?: string;
  ttl?: RangeSpec;
  srcObjectGroup?: string;
  dstObjectGroup?: string;
}

export interface AccessList {
  /** Numeric ID (1-99 standard, 100-199 extended) or undefined for named ACLs */
  id?: number;
  /** Name for named ACLs */
  name?: string;
  /** ACL type */
  type: 'standard' | 'extended';
  /**
   * Le pas de renumérotation (`step` sur VRP). Il décide du numéro
   * attribué aux règles suivantes, et il est AFFICHÉ — il était stocké
   * dans une propriété ad hoc du routeur que personne ne lisait, pendant
   * que la vue annonçait « ACL's step is 5 » en dur.
   */
  step?: number;
  /** `description` — VRP la rend dans la vue et dans la configuration. */
  description?: string;
  /** Ordered list of entries (first match wins) */
  entries: ACLEntry[];
}

/** Une correspondance sur une ACE marquée `log` ou `log-input`. */
export interface AclLogEvent {
  /** Nom de la liste, ou son numéro à défaut. */
  aclLabel: string;
  action: 'permit' | 'deny';
  entry: ACLEntry;
  packet: IPv4Packet;
  /** `log-input` : IOS ajoute l'interface et la MAC d'entrée. */
  wantsInput: boolean;
}

/**
 * Le corps d'un `%SEC-6-IPACCESSLOGP`, tel qu'IOS l'écrit :
 * `list 100 denied tcp 10.0.0.1(1234) -> 10.0.0.2(22), 1 packet`.
 */
export function formatAclLogMessage(e: AclLogEvent): string {
  const proto = e.entry.protocol && e.entry.protocol !== 'ip' ? e.entry.protocol : 'ip';
  const l4 = e.packet.payload as Partial<UDPPacket> | undefined;
  const sPort = typeof l4?.sourcePort === 'number' ? `(${l4.sourcePort})` : '';
  const dPort = typeof l4?.destinationPort === 'number' ? `(${l4.destinationPort})` : '';
  const verb = e.action === 'permit' ? 'permitted' : 'denied';
  return `list ${e.aclLabel} ${verb} ${proto} `
    + `${e.packet.sourceIP}${sPort} -> ${e.packet.destinationIP}${dPort}, 1 packet`;
}

/** Interface ACL binding: which ACL is applied in which direction */
export interface InterfaceACLBinding {
  /** ACL ID (number) or name (string) */
  inbound: number | string | null;
  outbound: number | string | null;
}

// ─── ACL Engine ─────────────────────────────────────────────────

export class ACLEngine {
  private accessLists: AccessList[] = [];
  private interfaceACLBindings: Map<string, InterfaceACLBinding> = new Map();

  /**
   * Le moteur sert plusieurs vendeurs, et leurs plages de numéros se
   * contredisent : 2000-2699 est ÉTENDU sur IOS et « basic » sur VRP.
   * Le vendeur pose donc sa règle ; le moteur n'en devine aucune.
   * Défaut IOS, ce module étant la surface Cisco.
   */
  private numbering: AclNumbering = IOS_ACL_NUMBERING;
  setNumberingPolicy(fn: AclNumbering): void { this.numbering = fn; }

  private sequencing: AclSequencing = IOS_SEQUENCING;
  private defaultStep: number = IOS_DEFAULT_STEP;
  /** Comment numéroter une entrée non numérotée, et quel pas par défaut. */
  setSequencingPolicy(fn: AclSequencing, step: number): void {
    this.sequencing = fn;
    this.defaultStep = step;
  }
  getDefaultStep(): number { return this.defaultStep; }

  /**
   * Que devient, DANS LE PLAN DE DONNÉES, un paquet qu'aucune règle
   * n'apparie ?
   *
   * IOS répond « refusé » : c'est le deny implicite. **VRP répond
   * autrement, et la réponse dépend du service qui applique la liste** —
   * `traffic-filter` laisse passer un paquet non apparié, là où le
   * contrôle d'accès d'une vty le refuse. Le moteur imposait la réponse
   * d'IOS à tout le monde, de sorte qu'une ACL VRP ne contenant qu'un
   * `deny` bloquait TOUT le reste du trafic au lieu de ce qu'elle nomme.
   *
   * Seul le plan de données lit ce réglage (`evaluateForDataPlane`). NAT,
   * vty et IPSec continuent d'exiger un `permit` explicite, ce qui est
   * juste pour eux sur les deux plateformes.
   */
  private unmatchedDataPlaneAction: 'permit' | 'deny' = 'deny';
  setUnmatchedDataPlaneAction(a: 'permit' | 'deny'): void { this.unmatchedDataPlaneAction = a; }

  /**
   * Puits de journalisation des ACE marquées `log` / `log-input`.
   *
   * Ces deux mots-clés étaient analysés, stockés, rendus par `show` et par
   * `running-config` — et n'émettaient rien. Une fonctionnalité qui a
   * toute l'apparence de l'existence sauf l'effet. Le moteur signale
   * désormais chaque correspondance marquée ; c'est l'équipement qui
   * décide de la mise en forme et de la destination.
   */
  private logSink: ((e: AclLogEvent) => void) | null = null;
  setLogSink(fn: ((e: AclLogEvent) => void) | null): void { this.logSink = fn; }

  getAccessLists(): AccessList[] {
    return this.accessLists.map(acl => ({
      ...acl,
      entries: acl.entries.map(e => ({ ...e })),
    }));
  }

  addAccessListEntry(
    id: number,
    action: 'permit' | 'deny',
    opts: ACLEntryOptions,
  ): void {
    const type: 'standard' | 'extended' = this.numbering(id);
    let acl = this.accessLists.find(a => a.id === id);
    if (!acl) {
      acl = { id, type, entries: [] };
      this.accessLists.push(acl);
    }
    const seq = opts.sequence ?? this.nextSequence(acl);
    acl.entries.push({
      action, ...opts, sequence: seq, sequenceConfigured: opts.sequence !== undefined,
      matchCount: 0,
    });
    ACLEngine.sortBySequence(acl);
  }

  /** Rend `false` si le numéro de séquence demandé est déjà pris (IOS refuse). */
  addNamedAccessListEntry(
    name: string,
    type: 'standard' | 'extended',
    action: 'permit' | 'deny',
    opts: ACLEntryOptions,
  ): boolean {
    let acl = this.accessLists.find(a => a.name === name);
    if (!acl) {
      acl = { name, type, entries: [] };
      this.accessLists.push(acl);
    }
    if (opts.sequence !== undefined
        && acl.entries.some(e => e.remark === undefined && e.sequence === opts.sequence)) {
      return false;
    }
    const seq = opts.sequence ?? this.nextSequence(acl);
    acl.entries.push({
      action, ...opts, sequence: seq, sequenceConfigured: opts.sequence !== undefined,
      matchCount: 0,
    });
    ACLEngine.sortBySequence(acl);
    return true;
  }

  removeNamedACLEntryBySequence(name: string, seq: number): boolean {
    const acl = this.accessLists.find(a => a.name === name);
    if (!acl) return false;
    const before = acl.entries.length;
    acl.entries = acl.entries.filter(e => e.remark !== undefined || e.sequence !== seq);
    return acl.entries.length !== before;
  }

  /**
   * `ip access-list resequence` renumérote les RÈGLES.
   *
   * Un commentaire n'a pas de numéro sur IOS 15 : il en prend celui de la
   * règle qu'il précède, ce qui le garde à sa place sans jamais consommer
   * un cran ni s'afficher. Un commentaire en fin de liste garde celui de
   * la dernière règle — il n'y a plus de suivante à désigner.
   */
  resequenceNamedACL(name: string, start: number, step: number): boolean {
    const acl = this.accessLists.find(a => a.name === name);
    if (!acl) return false;
    ACLEngine.sortBySequence(acl);
    let n = start;
    for (const e of acl.entries) {
      if (e.remark !== undefined) continue;
      e.sequence = n;
      n += step;
    }
    ACLEngine.alignRemarksOnFollowingRule(acl, Math.max(start, n - step));
    return true;
  }

  /**
   * Un commentaire suit la règle qui vient APRÈS lui, jamais celle d'avant.
   *
   * Sans cet alignement, un tri par numéro de séquence remonterait tout
   * commentaire au-dessus des règles qui portent le même numéro ou le
   * laisserait derrière elles selon l'ordre d'insertion, et le
   * commentaire cesserait de désigner la règle qu'il commente.
   */
  private static alignRemarksOnFollowingRule(acl: AccessList, fallback: number): void {
    let suivante = fallback;
    for (let i = acl.entries.length - 1; i >= 0; i--) {
      const e = acl.entries[i];
      if (e.remark === undefined) suivante = e.sequence ?? suivante;
      else e.sequence = suivante;
    }
  }

  findByName(name: string): AccessList | undefined {
    return this.accessLists.find(a => a.name === name);
  }

  findById(id: number): AccessList | undefined {
    return this.accessLists.find(a => a.id === id);
  }

  /** Zero every entry's match counter for one ACL (`reset acl counter <N>`). */
  resetCounters(aclRef: number | string): boolean {
    const acl = typeof aclRef === 'number'
      ? this.accessLists.find(a => a.id === aclRef)
      : this.accessLists.find(a => a.name === aclRef);
    if (!acl) return false;
    for (const entry of acl.entries) entry.matchCount = 0;
    return true;
  }

  /** Zero every entry's match counter across all ACLs (`reset acl counter all`). */
  resetAllCounters(): void {
    for (const acl of this.accessLists) {
      for (const entry of acl.entries) entry.matchCount = 0;
    }
  }

  /**
   * Le numéro d'une entrée que l'opérateur n'a pas numérotée. La règle
   * appartient au vendeur : IOS fait « dernier + 10 », VRP « multiple du
   * pas suivant ». Le pas est celui de la liste quand `step` l'a posé.
   */
  private nextSequence(acl: AccessList): number {
    const step = acl.step ?? this.defaultStep;
    const regles = acl.entries.filter(e => e.remark === undefined);
    if (regles.length === 0) return this.sequencing(null, step);
    const maxSeq = regles.reduce((m, e) => Math.max(m, e.sequence ?? 0), 0);
    return this.sequencing(maxSeq, step);
  }

  /** `step <n>` — le pas de renumérotation de cette liste. */
  setStep(ref: number | string, step: number): boolean {
    const acl = this.findRef(ref);
    if (!acl) return false;
    acl.step = step;
    return true;
  }

  /** `description <texte>` sur une liste. */
  setDescription(ref: number | string, text: string): boolean {
    const acl = this.findRef(ref);
    if (!acl) return false;
    acl.description = text;
    return true;
  }

  /**
   * La liste designee par `ref`. Une chaine est d'abord cherchee comme
   * NOM, puis comme numero — une liaison d'interface peut porter l'un ou
   * l'autre, et `evaluateACLByName` fait deja cette normalisation.
   */
  findRef(ref: number | string): AccessList | undefined {
    if (typeof ref === 'number') return this.accessLists.find(a => a.id === ref);
    const parNom = this.accessLists.find(a => a.name === ref);
    if (parNom) return parNom;
    return /^\d+$/.test(ref)
      ? this.accessLists.find(a => a.id === parseInt(ref, 10))
      : undefined;
  }

  /** Crée la liste numérotée si elle n'existe pas, sans y mettre d'entrée. */
  ensureAccessList(id: number): void {
    if (!this.accessLists.some(a => a.id === id)) {
      this.accessLists.push({ id, type: this.numbering(id), entries: [] });
    }
  }

  /** `undo rule <id>` / suppression d'une entrée numérotée d'une liste. */
  removeEntryBySequence(ref: number | string, seq: number): boolean {
    const acl = this.findRef(ref);
    if (!acl) return false;
    const before = acl.entries.length;
    acl.entries = acl.entries.filter(e => e.sequence !== seq);
    return acl.entries.length !== before;
  }

  /**
   * Le verdict du PLAN DE DONNÉES, qui applique la règle du vendeur pour
   * un paquet qu'aucune entrée n'apparie. `null` quand aucune liste ne
   * s'applique.
   */
  evaluateForDataPlane(
    aclRef: number | string | null, ipPkt: IPv4Packet, now?: Date,
  ): 'permit' | 'deny' | null {
    if (aclRef === null) return null;
    const acl = this.findRef(aclRef);
    if (!acl || acl.entries.length === 0) return null;
    const when = now ?? this.nowFromDevice();
    for (const entry of acl.entries) {
      if (entry.timeRange && this.timeRangeResolver
          && !this.timeRangeResolver(entry.timeRange, when)) continue;
      if (!this.entryMatchesWithReflexive(acl.type, entry, ipPkt, when)) continue;
      entry.matchCount++;
      if (entry.action === 'permit' && entry.reflect) {
        this.reflexive.record(entry.reflect, ipPkt, entry.reflectTimeout, when.getTime());
      }
      if (this.logSink && (entry.log || entry.logInput)) {
        this.logSink({
          aclLabel: acl.name ?? String(acl.id ?? ''),
          action: entry.action, entry, packet: ipPkt, wantsInput: !!entry.logInput,
        });
      }
      return entry.action;
    }
    return this.unmatchedDataPlaneAction;
  }

  /**
   * `evaluate NOM` n'est pas un critère d'adresse mais un renvoi à la
   * table des sessions miroir : l'ACE correspond si ce paquet est le
   * retour d'un flux qu'une ACE `reflect NOM` a déjà laissé sortir.
   */
  private entryMatchesWithReflexive(
    type: 'standard' | 'extended', entry: ACLEntry, ipPkt: IPv4Packet, now: Date,
  ): boolean {
    if (entry.evaluate !== undefined) {
      return this.reflexive.matches(entry.evaluate, ipPkt, now.getTime());
    }
    return this.aclEntryMatches(type, entry, ipPkt);
  }

  /** Ce numéro de séquence est-il déjà pris ? IOS refuse les doublons. */
  hasSequence(name: string, seq: number): boolean {
    const acl = this.accessLists.find(a => a.name === name);
    return !!acl && acl.entries.some(e => e.remark === undefined && e.sequence === seq);
  }

  /**
   * Crée la liste nommée si elle n'existe pas encore, sans y mettre
   * d'entrée. `ip access-list extended FOO` doit produire une liste VIDE
   * mais RÉELLE : sur IOS elle figure dans `running-config` dès sa
   * création, et ce moteur ne la matérialisait qu'au premier ACE.
   */
  ensureNamedAccessList(name: string, type: 'standard' | 'extended'): void {
    if (!this.accessLists.some(a => a.name === name)) {
      this.accessLists.push({ name, type, entries: [] });
    }
  }

  private static sortBySequence(acl: AccessList): void {
    acl.entries.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  }

  removeAccessList(id: number): void {
    this.accessLists = this.accessLists.filter(a => a.id !== id);
    for (const [, binding] of this.interfaceACLBindings) {
      if (binding.inbound === id) binding.inbound = null;
      if (binding.outbound === id) binding.outbound = null;
    }
  }

  removeNamedAccessList(name: string): void {
    this.accessLists = this.accessLists.filter(a => a.name !== name);
    for (const [, binding] of this.interfaceACLBindings) {
      if (binding.inbound === name) binding.inbound = null;
      if (binding.outbound === name) binding.outbound = null;
    }
  }

  setInterfaceACL(ifName: string, direction: 'in' | 'out', aclRef: number | string): void {
    let binding = this.interfaceACLBindings.get(ifName);
    if (!binding) {
      binding = { inbound: null, outbound: null };
      this.interfaceACLBindings.set(ifName, binding);
    }
    if (direction === 'in') binding.inbound = aclRef;
    else binding.outbound = aclRef;
  }

  removeInterfaceACL(ifName: string, direction: 'in' | 'out'): void {
    const binding = this.interfaceACLBindings.get(ifName);
    if (!binding) return;
    if (direction === 'in') binding.inbound = null;
    else binding.outbound = null;
  }

  getInterfaceACL(ifName: string, direction: 'in' | 'out'): number | string | null {
    const binding = this.interfaceACLBindings.get(ifName);
    if (!binding) return null;
    return direction === 'in' ? binding.inbound : binding.outbound;
  }

  /**
   * Optional resolver for time-range references on individual ACEs. When
   * set, an entry tagged `time-range NAME` only matches if the resolver
   * returns true for `(name, now)`. When unset (default), time-range
   * entries are treated as always-active — the historical behaviour.
   */
  private timeRangeResolver: ((name: string, now: Date) => boolean) | null = null;
  setTimeRangeResolver(fn: ((name: string, now: Date) => boolean) | null): void {
    this.timeRangeResolver = fn;
  }

  /**
   * L'horloge de l'ÉQUIPEMENT, pas celle de la machine hôte.
   *
   * Le plan de données lisait `new Date()` là où `show time-range` lit
   * l'horloge posée par `clock set` : deux horloges pour une question, de
   * sorte qu'une ACE `time-range` se déclarait active dans la vue et
   * filtrait selon une autre heure. Le défaut n'était pas à un point
   * d'appel mais dans la valeur par défaut, qu'ils héritaient tous ; c'est
   * donc ici qu'il se referme, et non en passant l'heure à chaque appel —
   * un point d'appel oublié rouvrirait l'écart en silence.
   */
  private clockSource: (() => number) | null = null;
  setClockSource(fn: (() => number) | null): void { this.clockSource = fn; }
  private nowFromDevice(): Date {
    return new Date(this.clockSource ? this.clockSource() : Date.now());
  }

  private readonly reflexive = new ReflexiveSessions();
  getReflexiveSessions(): ReflexiveSessions { return this.reflexive; }

  /** Evaluate a named/numbered ACL by name — used by IPSecEngine for crypto ACL matching. */
  evaluateACLByName(
    name: string, ipPkt: IPv4Packet, now?: Date, countMatches = true,
  ): 'permit' | 'deny' | null {
    const ref: number | string = /^\d+$/.test(name) ? parseInt(name, 10) : name;
    return this.evaluateACL(ref, ipPkt, now, countMatches);
  }

  /**
   * Le verdict d'une liste sur un paquet : `permit`, `deny`, ou `null`
   * quand aucune liste ne s'applique.
   *
   * `countMatches` à `false` évalue SANS toucher aux compteurs. Toute
   * évaluation les incrémentait, y compris celle du filtre d'affichage de
   * `debug ip packet` : taper `debug ip packet 101` faisait monter les
   * compteurs de l'ACL 101, et `show access-lists` cessait de mesurer le
   * trafic pour mesurer l'activité de l'observateur.
   */
  evaluateACL(
    aclRef: number | string | null, ipPkt: IPv4Packet,
    now?: Date, countMatches = true,
  ): 'permit' | 'deny' | null {
    if (aclRef === null) return null;

    const acl = typeof aclRef === 'number'
      ? this.accessLists.find(a => a.id === aclRef)
      : this.accessLists.find(a => a.name === aclRef);

    // Undefined or empty ACL = no ACL applied (real IOS), not deny-all.
    if (!acl || acl.entries.length === 0) {
      return null;
    }

    const when = now ?? this.nowFromDevice();
    for (const entry of acl.entries) {
      if (entry.timeRange && this.timeRangeResolver
          && !this.timeRangeResolver(entry.timeRange, when)) {
        continue; // inactive time-range → skip ACE (next-rule semantics)
      }
      if (this.entryMatchesWithReflexive(acl.type, entry, ipPkt, when)) {
        if (!countMatches) return entry.action;
        entry.matchCount++;
        if (entry.action === 'permit' && entry.reflect) {
          this.reflexive.record(entry.reflect, ipPkt, entry.reflectTimeout, when.getTime());
        }
        if (this.logSink && (entry.log || entry.logInput)) {
          this.logSink({
            aclLabel: acl.name ?? String(acl.id ?? ''),
            action: entry.action,
            entry,
            packet: ipPkt,
            wantsInput: !!entry.logInput,
          });
        }
        return entry.action;
      }
    }

    return 'deny';
  }

  /**
   * Cette entrée correspond-elle à ce paquet ?
   *
   * RÈGLE D'ÉCHEC, valable pour tout ce qui suit : **un critère que le
   * moteur ne sait pas trancher fait échouer la correspondance.** Jamais
   * réussir, jamais « sauter le critère ». Une ACE dont un critère est
   * abandonné devient plus permissive que ce que l'opérateur a écrit,
   * c'est-à-dire un trou silencieux dans la liste. C'est la règle que
   * `Ipv6AclEngine` applique déjà, et qui vaut ici aussi.
   */
  private aclEntryMatches(aclType: 'standard' | 'extended', entry: ACLEntry, ipPkt: IPv4Packet): boolean {
    // Sans adresse source, aucune ACE ne peut se prononcer.
    if (!ipPkt?.sourceIP) return false;

    // Un commentaire n'est pas une règle. Sans ce test il correspondait à
    // tout — étant stocké comme un `permit` de source `any` — et toute
    // liste commentée devenait une liste ouverte.
    if (entry.remark !== undefined) return false;

    if (entry.srcObjectGroup !== undefined) {
      if (!this.objectGroupMatches(entry.srcObjectGroup, ipPkt.sourceIP)) return false;
    } else if (!this.wildcardMatch(ipPkt.sourceIP, entry.srcIP, entry.srcWildcard)) {
      return false;
    }

    if (aclType === 'standard') {
      return true;
    }

    if (entry.dstObjectGroup !== undefined) {
      if (!ipPkt.destinationIP) return false;
      if (!this.objectGroupMatches(entry.dstObjectGroup, ipPkt.destinationIP)) return false;
    } else if (entry.dstIP && entry.dstWildcard) {
      // Une sonde peut ne pas porter de destination. Le critère est alors
      // intranchable — il échoue, il ne fait pas planter l'évaluation.
      if (!ipPkt.destinationIP) return false;
      if (!this.wildcardMatch(ipPkt.destinationIP, entry.dstIP, entry.dstWildcard)) {
        return false;
      }
    }

    /*
     * `ttl` se compare comme un port : meme grammaire, meme evaluateur.
     * Un paquet sans champ `ttl` rend le critere intranchable, donc il
     * echoue — la regle de ce moteur pour tout critere indecidable.
     */
    if (entry.ttl) {
      if (typeof ipPkt.ttl !== 'number') return false;
      if (!rangeSpecMatches(entry.ttl, ipPkt.ttl)) return false;
    }

    if (entry.protocol && entry.protocol !== 'ip') {
      const pktProto = this.getProtocolName(ipPkt.protocol);
      if (pktProto !== entry.protocol) return false;

      if (entry.protocol === 'tcp' || entry.protocol === 'udp') {
        if (!this.portCriteriaMatch(entry, ipPkt)) return false;
      }

      if (entry.protocol === 'tcp' && entry.tcpEstablished) {
        const tcp = ipPkt.payload as TCPPacket | undefined;
        const flags = tcp && tcp.type === 'tcp' ? tcp.flags : undefined;
        if (!flags || (!flags.ack && !flags.rst)) return false;
      }

      if (entry.protocol === 'tcp' && entry.tcpFlags && entry.tcpFlags.length > 0) {
        if (!ACLEngine.tcpFlagsMatch(entry, ipPkt)) return false;
      }

      if (entry.protocol === 'icmp' && (entry.icmpType || entry.icmpCode !== undefined)) {
        const icmp = ipPkt.payload as ICMPPacket | undefined;
        const pkt = icmp && icmp.type === 'icmp' ? icmp : undefined;
        if (!pkt) return false;
        if (entry.icmpType) {
          const spec = ACL_ICMP_KEYWORDS[entry.icmpType];
          // Mot-clé qu'on ne sait pas traduire : critère non tranchable.
          if (spec === undefined) return false;
          if (spec.type !== pkt.icmpType) return false;
          if (spec.code !== undefined && pkt.code !== spec.code) return false;
        }
        // `deny icmp any any 3 13` — code écrit à la main par l'opérateur.
        if (entry.icmpCode !== undefined && pkt.code !== entry.icmpCode) return false;
      }
    }

    if (entry.dscp !== undefined) {
      const want = /^\d+$/.test(entry.dscp)
        ? parseInt(entry.dscp, 10)
        : DSCP_KEYWORD_TO_VALUE[entry.dscp.toLowerCase()];
      if (!ACLEngine.tosFieldMatches(ipPkt, want, 2, 0x3f)) return false;
    }

    if (entry.precedence !== undefined) {
      const want = /^\d+$/.test(entry.precedence)
        ? parseInt(entry.precedence, 10)
        : PRECEDENCE_KEYWORD_TO_VALUE[entry.precedence.toLowerCase()];
      if (!ACLEngine.tosFieldMatches(ipPkt, want, 5, 0x7)) return false;
    }

    if (entry.tos !== undefined) {
      const want = /^\d+$/.test(entry.tos) ? parseInt(entry.tos, 10) : undefined;
      if (!ACLEngine.tosFieldMatches(ipPkt, want, 0, 0xff)) return false;
    }

    if (entry.fragments) {
      const isFragment = (ipPkt.fragmentOffset > 0) || ((ipPkt.flags & 0x1) !== 0);
      if (!isFragment) return false;
    }

    // `match ip options` : `IPv4Packet` ne porte aucune option d'en-tête,
    // le critère n'est donc jamais vérifiable. Il échoue — il était
    // simplement sauté, ce qui rendait `permit ip any any option
    // any-options` équivalent à `permit ip any any`.
    if (entry.optionName !== undefined) return false;

    return true;
  }

  /**
   * Les critères de port de cette ACE sont-ils satisfaits ?
   *
   * Une ACE SANS critère de port correspond quelle que soit la charge
   * utile — `permit tcp any any` ne regarde pas les ports. Mais dès qu'un
   * critère est posé et que la couche 4 manque, il n'est pas vérifiable :
   * on échoue. L'ancienne version sautait tout le bloc quand la charge
   * utile était absente, de sorte qu'un paquet sans couche 4 satisfaisait
   * `permit tcp any any eq 22`.
   */
  private portCriteriaMatch(entry: ACLEntry, ipPkt: IPv4Packet): boolean {
    const wantsSrc = entry.srcPort !== undefined || entry.srcPortSpec !== undefined;
    const wantsDst = entry.dstPort !== undefined || entry.dstPortSpec !== undefined;
    if (!wantsSrc && !wantsDst) return true;

    const l4 = ipPkt.payload as Partial<UDPPacket> | undefined;
    if (wantsSrc) {
      if (typeof l4?.sourcePort !== 'number') return false;
      if (!this.portMatches(l4.sourcePort, entry.srcPort, entry.srcPortSpec)) return false;
    }
    if (wantsDst) {
      if (typeof l4?.destinationPort !== 'number') return false;
      if (!this.portMatches(l4.destinationPort, entry.dstPort, entry.dstPortSpec)) return false;
    }
    return true;
  }

  /**
   * `match-any` / `match-all` sur les drapeaux TCP. Les jetons étaient
   * analysés, stockés et réaffichés sans jamais être évalués : le critère
   * disparaissait, et `deny tcp any any match-any rst` refusait un SYN.
   */
  private static tcpFlagsMatch(entry: ACLEntry, ipPkt: IPv4Packet): boolean {
    const tcp = ipPkt.payload as TCPPacket | undefined;
    const flags = tcp && tcp.type === 'tcp' ? tcp.flags : undefined;
    if (!flags) return false;

    const conditions = entry.tcpFlags!.map(parseTcpFlagToken);
    // Un nom de drapeau inconnu rend le critère intranchable.
    if (conditions.some(c => c === null)) return false;

    const holds = (c: { flag: TcpFlagName; mustBeSet: boolean }) => flags[c.flag] === c.mustBeSet;
    return entry.tcpFlagsMatch === 'all'
      ? conditions.every(c => holds(c!))
      : conditions.some(c => holds(c!));
  }

  /** Un champ du ToS, décalé et masqué. `want` indéfini ⇒ critère intranchable. */
  private static tosFieldMatches(ipPkt: IPv4Packet, want: number | undefined, shift: number, mask: number): boolean {
    if (want === undefined || Number.isNaN(want)) return false;
    if (typeof ipPkt.tos !== 'number') return false;
    return ((ipPkt.tos >> shift) & mask) === want;
  }

  private portMatches(pktPort: number, exact: number | undefined, spec: PortSpec | undefined): boolean {
    if (spec) {
      switch (spec.op) {
        case 'eq': return pktPort === spec.port;
        case 'neq': return pktPort !== spec.port;
        case 'gt': return pktPort > spec.port;
        case 'lt': return pktPort < spec.port;
        case 'range': return pktPort >= spec.port && pktPort <= (spec.endPort ?? spec.port);
      }
    }
    if (exact !== undefined) return pktPort === exact;
    return true;
  }

  private wildcardMatch(packetIP: IPAddress, aclIP: IPAddress, wildcard: SubnetMask): boolean {
    const pktOctets = packetIP.getOctets();
    const aclOctets = aclIP.getOctets();
    const wcOctets = wildcard.getOctets();
    for (let i = 0; i < 4; i++) {
      if ((pktOctets[i] & ~wcOctets[i]) !== (aclOctets[i] & ~wcOctets[i])) {
        return false;
      }
    }
    return true;
  }

  /*
   * Les groupes d'objets vivent dans le moteur qui les LIT.
   *
   * Les ranger ailleurs demanderait un port de resolution, donc un
   * second endroit ou la meme question se pose ; ici la declaration et
   * la comparaison lisent la meme table.
   */
  private objectGroups = new Map<string, ObjectGroup>();

  ensureObjectGroup(name: string, kind: 'network' = 'network'): ObjectGroup {
    const existant = this.objectGroups.get(name);
    if (existant) return existant;
    const cree: ObjectGroup = { name, kind, members: [] };
    this.objectGroups.set(name, cree);
    return cree;
  }

  getObjectGroup(name: string): ObjectGroup | undefined {
    return this.objectGroups.get(name);
  }

  listObjectGroups(): ObjectGroup[] {
    return [...this.objectGroups.values()];
  }

  removeObjectGroup(name: string): boolean {
    return this.objectGroups.delete(name);
  }

  addObjectGroupMember(name: string, ip: IPAddress, wildcard: SubnetMask): void {
    this.ensureObjectGroup(name).members.push({ ip, wildcard });
  }

  removeObjectGroupMember(name: string, ip: IPAddress, wildcard: SubnetMask): boolean {
    const groupe = this.objectGroups.get(name);
    if (!groupe) return false;
    const avant = groupe.members.length;
    groupe.members = groupe.members.filter(
      m => !(m.ip.toString() === ip.toString()
        && m.wildcard.toString() === wildcard.toString()));
    return groupe.members.length !== avant;
  }

  /**
   * Un groupe ABSENT ne correspond a rien.
   *
   * C'est la regle d'echec ferme de ce moteur : un critere que
   * l'evaluation ne peut pas trancher fait echouer la correspondance.
   * Le faire reussir ferait qu'une ACE citant un groupe mal orthographie
   * s'appliquerait a TOUT le trafic — un trou que la CLI ne montre pas.
   */
  private objectGroupMatches(name: string, address: IPAddress): boolean {
    const groupe = this.objectGroups.get(name);
    if (!groupe || groupe.members.length === 0) return false;
    return groupe.members.some(m => this.wildcardMatch(address, m.ip, m.wildcard));
  }

  private getProtocolName(proto: number): string {
    return protocolKeywordFor(proto);
  }

  /** @internal Direct access to ACL list for CLI shells */
  getAccessListsInternal(): AccessList[] { return this.accessLists; }

  /** @internal Direct access to bindings for CLI shells */
  getInterfaceACLBindingsInternal(): Map<string, InterfaceACLBinding> { return this.interfaceACLBindings; }
}
