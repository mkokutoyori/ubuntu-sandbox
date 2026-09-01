import type { IPAddress } from '../../../core/types';
import { renderSecretField } from '../../shells/cisco/ciscoPasswordRender';

export type AaaMethodList = 'default' | string;
export type AaaServiceKind = 'login' | 'enable' | 'ppp' | 'exec' | 'commands' | 'network';
export type AaaPhase = 'authentication' | 'authorization' | 'accounting';

export interface AaaMethodEntry {
  phase: AaaPhase;
  service: AaaServiceKind;
  listName: AaaMethodList;
  privilegeLevel?: number;
  recordType?: 'start-stop' | 'stop-only' | 'wait-start' | 'none';
  methods: string[];
}

export interface RadiusServerStats {
  upSinceMs: number;
  authRequests: number;
  authAccepts: number;
  authRejects: number;
  authTimeouts: number;
  authRetransmits: number;
  acctRequests: number;
  acctResponses: number;
  acctTimeouts: number;
  acctRetransmits: number;
}

export interface TacacsServerStats {
  upSinceMs: number;
  socketOpens: number;
  socketCloses: number;
  socketAborts: number;
  socketErrors: number;
  authRequests: number;
  authAccepts: number;
  authRejects: number;
}

export interface RadiusServer {
  name: string;
  address?: string;
  authPort: number;
  acctPort: number;
  key?: string;
  retransmit?: number;
  timeoutSec?: number;
  /** Voir `TacacsServer.legacySpelling` : `radius-server host <ip>` alimente ce magasin-ci. */
  legacySpelling?: boolean;
  stats: RadiusServerStats;
}

export interface TacacsServer {
  name: string;
  address?: string;
  key?: string;
  port: number;
  timeoutSec?: number;
  singleConnection: boolean;
  stats: TacacsServerStats;
  /**
   * Déclaré par la forme héritée `tacacs-server host <ip> [key K]`.
   *
   * C'est un drapeau de RENDU, pas un second magasin : le serveur est le
   * même objet que celui de `tacacs server <nom>`, donc il authentifie
   * et `show tacacs` le voit. Seule l'orthographe rendue change, parce
   * qu'une configuration doit reproduire ce qui a été tapé — elle est
   * rejouée à l'import d'une topologie.
   *
   * Avant, la forme héritée allait dans un tableau `legacyHosts` que
   * SEUL le rendu de la configuration lisait : la machine décrivait donc
   * un serveur qu'elle n'avait pas, `show tacacs` répondait « No TACACS+
   * servers configured » et l'authentification ne trouvait rien.
   */
  legacySpelling?: boolean;
}

export function newRadiusServerStats(): RadiusServerStats {
  return {
    upSinceMs: Date.now(),
    authRequests: 0, authAccepts: 0, authRejects: 0,
    authTimeouts: 0, authRetransmits: 0,
    acctRequests: 0, acctResponses: 0,
    acctTimeouts: 0, acctRetransmits: 0,
  };
}

export function newTacacsServerStats(): TacacsServerStats {
  return {
    upSinceMs: Date.now(),
    socketOpens: 0, socketCloses: 0, socketAborts: 0, socketErrors: 0,
    authRequests: 0, authAccepts: 0, authRejects: 0,
  };
}

export interface AaaServerGroup {
  name: string;
  kind: 'radius' | 'tacacs+';
  members: string[];
}

export interface AaaLegacyServerHost {
  kind: 'radius' | 'tacacs';
  host: string;
  key?: string;
  authPort?: number;
  acctPort?: number;
  port?: number;
}

export interface SshConfig {
  version: number;
  timeoutSec: number;
  authRetries: number;
  sourceInterface?: string;
  dhMinBits: number;
  loggingEvents: boolean;
  /**
   * Les listes d'algorithmes de `ip ssh server algorithm {mac|encryption
   * |kex}`. Vides = « les valeurs par defaut », ce qu'IOS n'ecrit pas.
   *
   * Ce simulateur ne NEGOCIE pas ces algorithmes — sa pile choisit les
   * siens — mais une commande de durcissement qui disparait de la
   * configuration est pire qu'une commande refusee : au rechargement
   * d'une topologie le durcissement n'est plus la et rien ne le dit.
   */
  macAlgorithms: string[];
  encryptionAlgorithms: string[];
  kexAlgorithms: string[];
  scpServerEnabled: boolean;
}

export interface LoginControl {
  blockFor?: { seconds: number; attempts: number; withinSeconds: number };
  quietModeAcl?: string;
  delay?: number;
  onFailureLog?: boolean;
  onSuccessLog?: boolean;
}

export interface CryptoRsaKey {
  label: string;
  modulus: number;
  general: boolean;
  generatedAtMs: number;
}

export interface PasswordPolicy {
  minLength?: number;
  encrypted: boolean;
}

export interface ClassMap {
  name: string;
  matchAll: boolean;
  kind: 'qos' | 'inspect';
  matches: ClassMapMatch[];
}

export interface ClassMapMatch {
  kind: 'access-group-name' | 'access-group-num' | 'protocol' | 'any';
  value?: string;
}

export interface PolicyMap {
  name: string;
  kind: 'qos' | 'inspect';
  classes: PolicyMapClass[];
}

export interface PolicyMapClass {
  className: string;
  kind: 'class-default' | 'named' | 'inspect';
  actions: PolicyMapAction[];
}

export interface PolicyMapAction {
  kind: 'police' | 'inspect' | 'drop' | 'pass' | 'set-dscp' | 'set-precedence'
    | 'priority' | 'bandwidth' | 'fair-queue' | 'random-detect' | 'shape'
    | 'service-policy' | 'queue-limit' | 'compression';
  args: string[];
}

export interface ControlPlane {
  servicePolicyInput?: string;
  servicePolicyOutput?: string;
}

export interface Zone {
  name: string;
}

export interface ZonePair {
  name: string;
  source: string;
  destination: string;
  servicePolicy?: string;
}

export interface InterfaceUrpf {
  mode: 'strict' | 'loose' | null;
  allowDefault?: boolean;
}

export interface InterfaceSecurityFlags {
  noUnreachables: boolean;
  noRedirects: boolean;
  noProxyArp: boolean;
  maskReply: boolean;
  zoneMember?: string;
  ipv6TrafficFilter?: { name: string; direction: 'in' | 'out' };
  urpf?: InterfaceUrpf;
}

export interface TimeRangeAbsolute {
  start?: { year: number; month: number; day: number; hour: number; minute: number };
  end?: { year: number; month: number; day: number; hour: number; minute: number };
}

export interface TimeRangePeriodic {
  days: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

export interface TimeRange {
  name: string;
  absolute?: TimeRangeAbsolute;
  periodic: TimeRangePeriodic[];
}

/** Cisco day-keyword → JS getDay() (0=Sunday..6=Saturday) set. */
const TIME_RANGE_DAY_SETS: Record<string, ReadonlySet<number>> = {
  monday:    new Set([1]),
  tuesday:   new Set([2]),
  wednesday: new Set([3]),
  thursday:  new Set([4]),
  friday:    new Set([5]),
  saturday:  new Set([6]),
  sunday:    new Set([0]),
  weekdays:  new Set([1, 2, 3, 4, 5]),
  weekend:   new Set([0, 6]),
  daily:     new Set([0, 1, 2, 3, 4, 5, 6]),
};

/**
 * Decide whether a Cisco time-range is "active" at the given instant.
 * An ACE tagged `time-range NAME` only matches when this returns true.
 *
 * - absolute start/end (if set) gate the whole range — outside the
 *   window every periodic clause is inactive.
 * - inside the absolute window, the range is active if AT LEAST ONE
 *   periodic clause covers `now`'s weekday + time of day. A range
 *   with no periodic clauses is treated as "always-active inside the
 *   absolute window" (matches IOS).
 *
 * `now` is interpreted in the device's local timezone (the simulator
 * does not model timezones, so JS `Date.getHours()` / `getDay()` give
 * "device-local"). Cisco's time-range also runs in device-local time
 * by default — fidelity is exact for the educational scenarios.
 */
export function isTimeRangeActive(tr: TimeRange, now: Date): boolean {
  if (tr.absolute) {
    const ts = now.getTime();
    if (tr.absolute.start) {
      const s = Date.UTC(
        tr.absolute.start.year, tr.absolute.start.month - 1,
        tr.absolute.start.day, tr.absolute.start.hour, tr.absolute.start.minute,
      );
      if (ts < s) return false;
    }
    if (tr.absolute.end) {
      const e = Date.UTC(
        tr.absolute.end.year, tr.absolute.end.month - 1,
        tr.absolute.end.day, tr.absolute.end.hour, tr.absolute.end.minute,
      );
      if (ts > e) return false;
    }
  }
  if (tr.periodic.length === 0) return true;
  const day = now.getDay();
  const minOfDay = now.getHours() * 60 + now.getMinutes();
  for (const p of tr.periodic) {
    const set = TIME_RANGE_DAY_SETS[p.days.toLowerCase()];
    if (!set || !set.has(day)) continue;
    const start = p.startHour * 60 + p.startMinute;
    const end   = p.endHour   * 60 + p.endMinute;
    if (minOfDay >= start && minOfDay <= end) return true;
  }
  return false;
}

export interface PkiTrustpoint {
  name: string;
  enrollmentUrl?: string;
  subjectName?: string;
  revocationCheck?: 'crl' | 'none' | 'ocsp' | 'crl-or-ocsp' | 'crl-then-ocsp';
  rsaKeypair?: string;
  fingerprint?: string;
  fqdn?: string;
  ipAddress?: 'none' | string;
  serialNumber?: 'none' | string;
  autoEnroll?: { percent?: number; regenerate?: boolean };
  /**
   * Le mode d'inscription, ECRIT COMME IOS L'ECRIT.
   *
   * Il etait canonicalise en `self-signed` alors qu'IOS ecrit
   * `enrollment selfsigned` en un mot dans sa configuration — verifie
   * sur des `show running-config` reels, ou le POINT DE CONFIANCE
   * s'appelle `TP-self-signed-<n>` avec des traits d'union tandis que le
   * mot-cle n'en porte aucun. Les deux orthographes restent acceptees a
   * la saisie ; c'est le RENDU qui doit etre celui de la machine, la
   * configuration etant rejouee a l'import d'une topologie.
   */
  source?: 'selfsigned' | 'terminal';
  /** `enrollment profile <nom>` — le NOM, que `scep` ne disait pas. */
  enrollmentProfile?: string;
  /** Set by 'crypto pki authenticate': the CA's root cert, this trustpoint's trust anchor. */
  caCert?: import('../../../pki/X509Certificate').X509Certificate;
  /** Set by 'crypto pki enroll': this router's own CA-issued cert + private key. */
  localCert?: import('../../../pki/X509Certificate').X509Certificate;
  localKey?: import('../../../pki/PkiKeyPair').PkiPrivateKey;
}

export interface ParameterMapInspect {
  name: string;
  auditTrail?: boolean;
  alert?: boolean;
  maxIncompleteLow?: number;
  maxIncompleteHigh?: number;
  tcpIdleTimeSec?: number;
  udpIdleTimeSec?: number;
  dnsTimeoutSec?: number;
  oneMinuteLow?: number;
  oneMinuteHigh?: number;
}

/**
 * Une vue CLI (RBAC d'IOS), telle que `parser view <nom>` la declare.
 *
 * Une vue n'est PAS un niveau de privilege : les niveaux ajoutent des
 * commandes au socle du niveau 1, une vue REMPLACE l'arbre visible par
 * ce qu'elle inclut, et rien d'autre. C'est ce qui la rend utilisable
 * pour un role — on decrit ce que le role a le droit de faire, pas ce
 * qu'on lui ajoute par-dessus un socle qu'on n'a pas choisi.
 */
/**
 * Ce qu'une vue autorise dans UN mode d'analyseur.
 *
 * `include` et `include-exclusive` entrent tous deux la commande dans la
 * vue ; ce qui les distingue est ce qu'ils permettent AILLEURS —
 * `include-exclusive` interdit a toute autre vue de revendiquer la meme
 * commande. Les confondre laissait deux vues la reclamer, ce qu'IOS
 * refuse, et le mot-cle produisait donc autre chose que ce qu'il
 * promet.
 *
 * `all` etend l'entree a ce qui COMPLETE la commande, comme le mot-cle
 * homonyme des regles de niveau.
 */
export interface ParserViewCommand {
  readonly command: string;
  readonly all: boolean;
  readonly exclusive: boolean;
}

export interface ParserViewMode {
  include: ParserViewCommand[];
  exclude: ParserViewCommand[];
}

/**
 * Une vue CLI (RBAC d'IOS), telle que `parser view <nom>` la declare.
 *
 * Une vue n'est PAS un niveau de privilege : les niveaux ajoutent des
 * commandes au socle du niveau 1, une vue REMPLACE l'arbre visible par
 * ce qu'elle inclut, et rien d'autre. C'est ce qui la rend utilisable
 * pour un role — on decrit ce que le role a le droit de faire, pas ce
 * qu'on lui ajoute par-dessus un socle qu'on n'a pas choisi.
 *
 * Les commandes sont rangees PAR MODE d'analyseur : une vue qui ne
 * gouvernerait que l'exec ne pourrait decrire aucun role qui configure
 * quoi que ce soit, ce qui est la moitie de l'interet du mecanisme.
 */
export interface ParserView {
  readonly name: string;
  /** `secret …` sous la vue — ce que `enable view <nom>` demande. */
  secret?: string;
  secretAlgo?: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7';
  /** Les commandes autorisees, par mode d'analyseur. */
  modes: Map<string, ParserViewMode>;
  /**
   * `parser view <nom> superview` — une vue COMPOSEE ne porte aucune
   * commande a elle : elle reunit celles des vues qu'on lui ajoute par
   * `view <nom>`. C'est ainsi qu'IOS decrit un role recoupant plusieurs
   * metiers sans dupliquer leurs listes.
   */
  superview?: boolean;
  /** Les vues membres, dans l'ordre d'ajout. */
  members?: string[];
}

/** Le jeu de commandes d'un mode, cree a la demande. */
export function parserViewMode(v: ParserView, mode: string): ParserViewMode {
  let m = v.modes.get(mode);
  if (!m) { m = { include: [], exclude: [] }; v.modes.set(mode, m); }
  return m;
}

/**
 * Le secret d'une vue, rendu comme IOS le rend : hache, jamais en clair.
 * On passe par le rendu PARTAGE des secrets Cisco plutot que d'en ecrire
 * un second — deux facons de hacher un mot de passe sur une meme machine
 * finiraient par ne pas donner le meme resultat pour la meme saisie.
 */
function renderViewSecret(v: ParserView): string {
  return renderSecretField(v.secret ?? '', v.secretAlgo ?? 'md5', `view:${v.name}`);
}

export class CiscoSecurityConfig {
  aaaNewModel = false;
  /**
   * Les vues declarees. Vide = aucune vue, et le dispatch n'en sait rien :
   * la porte ne se ferme que lorsqu'une session EST dans une vue.
   */
  parserViews: Map<string, ParserView> = new Map();
  aaaSessionId?: string;
  /** `aaa local authentication attempts max-fail <n>` — per-account lockout threshold. */
  localAuthMaxFailAttempts?: number;
  aaaMethods: AaaMethodEntry[] = [];
  radiusServers: Map<string, RadiusServer> = new Map();
  tacacsServers: Map<string, TacacsServer> = new Map();
  aaaGroups: Map<string, AaaServerGroup> = new Map();
  legacyHosts: AaaLegacyServerHost[] = [];
  radiusDefaults: { key?: string; timeoutSec?: number; retransmit?: number } = {};
  tacacsDefaults: { key?: string; timeoutSec?: number } = {};

  ssh: SshConfig = {
    version: 1, timeoutSec: 120, authRetries: 3, dhMinBits: 1024, loggingEvents: false,
    macAlgorithms: [], encryptionAlgorithms: [], kexAlgorithms: [], scpServerEnabled: false,
  };
  cryptoKeys: CryptoRsaKey[] = [];
  enableSecret?: string;
  servicePasswordEncryption = false;
  passwords: PasswordPolicy = { encrypted: false };
  login: LoginControl = {};
  ipCef = true;
  ipCefDistributed = false;
  ipSourceRoute = true;
  ipBootpServer = true;
  ipGratuitousArps = true;
  ipFinger = false;
  ipv6Cef = false;
  ipMulticastRouting = false;

  classMaps: Map<string, ClassMap> = new Map();
  policyMaps: Map<string, PolicyMap> = new Map();
  controlPlane: ControlPlane = {};

  zones: Map<string, Zone> = new Map();
  zonePairs: Map<string, ZonePair> = new Map();
  interfaceFlags: Map<string, InterfaceSecurityFlags> = new Map();

  timeRanges: Map<string, TimeRange> = new Map();
  parameterMapsInspect: Map<string, ParameterMapInspect> = new Map();
  pkiTrustpoints: Map<string, PkiTrustpoint> = new Map();

  ensurePkiTrustpoint(name: string): PkiTrustpoint {
    let tp = this.pkiTrustpoints.get(name);
    if (!tp) {
      tp = { name };
      this.pkiTrustpoints.set(name, tp);
    }
    return tp;
  }

  ensureParameterMapInspect(name: string): ParameterMapInspect {
    let pm = this.parameterMapsInspect.get(name);
    if (!pm) {
      pm = { name };
      this.parameterMapsInspect.set(name, pm);
    }
    return pm;
  }

  ifaceFlags(ifName: string): InterfaceSecurityFlags {
    let f = this.interfaceFlags.get(ifName);
    if (!f) {
      f = {
        noUnreachables: false, noRedirects: false, noProxyArp: false,
        maskReply: false,
      };
      this.interfaceFlags.set(ifName, f);
    }
    return f;
  }

  ensureClassMap(name: string, kind: 'qos' | 'inspect', matchAll: boolean): ClassMap {
    let cm = this.classMaps.get(name);
    if (!cm) {
      cm = { name, matchAll, kind, matches: [] };
      this.classMaps.set(name, cm);
    }
    return cm;
  }

  ensurePolicyMap(name: string, kind: 'qos' | 'inspect'): PolicyMap {
    let pm = this.policyMaps.get(name);
    if (!pm) {
      pm = { name, kind, classes: [] };
      this.policyMaps.set(name, pm);
    }
    return pm;
  }

  ensureTimeRange(name: string): TimeRange {
    let tr = this.timeRanges.get(name);
    if (!tr) {
      tr = { name, periodic: [] };
      this.timeRanges.set(name, tr);
    }
    return tr;
  }

  /**
   * Les vues, rendues SEULES et AVANT tout le reste.
   *
   * `username X view NOC` refuse une vue qui n'existe pas — c'est la
   * bonne regle, elle empeche d'attacher un role jamais decrit — mais
   * les lignes `username` sont rendues bien avant ce bloc-ci. La
   * configuration produite par la machine etait donc INREJOUABLE :
   * a l'import d'une topologie le compte perdait sa vue, en silence.
   * Le commentaire qui vivait ici affirmait deja que « les vues viennent
   * en tete » — c'etait vrai DANS ce bloc, et faux dans la configuration
   * entiere.
   *
   * Les vues MEMBRES precedent les composees, pour la meme raison : une
   * superview relue ne peut ajouter que des vues qui existent deja.
   */
  parserViewLines(): string[] {
    const lines: string[] = [];
    const vues = [...this.parserViews.values()]
      .sort((a, b) => Number(a.superview ?? false) - Number(b.superview ?? false));
    for (const v of vues) {
      lines.push(`parser view ${v.name}${v.superview ? ' superview' : ''}`);
      if (v.secret !== undefined) {
        lines.push(` secret ${renderViewSecret(v)}`);
      }
      for (const m of v.members ?? []) lines.push(` view ${m}`);
      for (const [mode, jeu] of v.modes) {
        for (const c of jeu.include) {
          lines.push(` commands ${mode} ${c.exclusive ? 'include-exclusive' : 'include'}`
            + `${c.all ? ' all' : ''} ${c.command}`);
        }
        for (const c of jeu.exclude) {
          lines.push(` commands ${mode} exclude${c.all ? ' all' : ''} ${c.command}`);
        }
      }
      // Le bloc se TERMINE lui-meme. Sans cette ligne, la configuration
      // rendue laisse la session dans `config-view` : tout ce qui suit —
      // les comptes, les interfaces — serait rejoue depuis ce sous-mode
      // a l'import d'une topologie. C'est aussi ce qui permet de
      // confiner le sous-mode : un sous-mode dont on ne sort jamais ne
      // peut pas etre restreint sans rendre la machine irrelisable.
      lines.push(' exit');
      lines.push('!');
    }
    return lines;
  }

  asRunningConfigLines(): string[] {
    const lines: string[] = [];
    if (this.aaaNewModel) {
      lines.push('aaa new-model');
      for (const m of this.aaaMethods) {
        lines.push(this.renderAaaMethod(m));
      }
      if (this.aaaSessionId) lines.push(`aaa session-id ${this.aaaSessionId}`);
      if (this.localAuthMaxFailAttempts) lines.push(`aaa local authentication attempts max-fail ${this.localAuthMaxFailAttempts}`);
    }
    // Les comptes locaux sont rendus par le magasin d'identifiants
    // (`_listLocalUsers`), qui est le seul a les porter. Un second
    // magasin a existe ici : ecrit par une ligne, lu par personne, et
    // destructeur — il ramenait le privilege a 1 quand la commande ne le
    // precisait pas, et perdait la vue et l'algorithme du secret.
    void this.enableSecret;
    void this.servicePasswordEncryption;
    if (this.passwords.minLength) lines.push(`security passwords min-length ${this.passwords.minLength}`);
    if (this.login.blockFor) lines.push(`login block-for ${this.login.blockFor.seconds} attempts ${this.login.blockFor.attempts} within ${this.login.blockFor.withinSeconds}`);
    if (this.login.quietModeAcl) lines.push(`login quiet-mode access-class ${this.login.quietModeAcl}`);
    if (this.login.delay) lines.push(`login delay ${this.login.delay}`);
    if (this.login.onFailureLog) lines.push('login on-failure log');
    if (this.login.onSuccessLog) lines.push('login on-success log');
    if (!this.ipCef) lines.push('no ip cef');
    if (!this.ipSourceRoute) lines.push('no ip source-route');
    if (!this.ipBootpServer) lines.push('no ip bootp server');
    if (!this.ipGratuitousArps) lines.push('no ip gratuitous-arps');
    if (this.ipFinger) lines.push('ip finger');
    if (this.ipv6Cef) lines.push('ipv6 cef');
    if (this.ipMulticastRouting) lines.push('ip multicast-routing');
    if (this.ssh.version !== 1) lines.push(`ip ssh version ${this.ssh.version}`);
    if (this.ssh.timeoutSec !== 120) lines.push(`ip ssh time-out ${this.ssh.timeoutSec}`);
    if (this.ssh.authRetries !== 3) lines.push(`ip ssh authentication-retries ${this.ssh.authRetries}`);
    if (this.ssh.sourceInterface) lines.push(`ip ssh source-interface ${this.ssh.sourceInterface}`);
    if (this.ssh.dhMinBits !== 1024) lines.push(`ip ssh dh min size ${this.ssh.dhMinBits}`);
    if (this.ssh.loggingEvents) lines.push('ip ssh logging events');
    if (this.ssh.macAlgorithms.length) {
      lines.push(`ip ssh server algorithm mac ${this.ssh.macAlgorithms.join(' ')}`);
    }
    if (this.ssh.encryptionAlgorithms.length) {
      lines.push(`ip ssh server algorithm encryption ${this.ssh.encryptionAlgorithms.join(' ')}`);
    }
    if (this.ssh.kexAlgorithms.length) {
      lines.push(`ip ssh server algorithm kex ${this.ssh.kexAlgorithms.join(' ')}`);
    }
    if (this.ssh.scpServerEnabled) lines.push('ip scp server enable');
    for (const k of this.cryptoKeys) {
      if (k.general) lines.push(`crypto key generate rsa general-keys modulus ${k.modulus} label ${k.label}`);
      else lines.push(`crypto key generate rsa modulus ${k.modulus}`);
    }
    if (this.radiusDefaults.key) lines.push(`radius-server key ${this.radiusDefaults.key}`);
    if (this.radiusDefaults.timeoutSec !== undefined) {
      lines.push(`radius-server timeout ${this.radiusDefaults.timeoutSec}`);
    }
    if (this.radiusDefaults.retransmit !== undefined) {
      lines.push(`radius-server retransmit ${this.radiusDefaults.retransmit}`);
    }
    if (this.tacacsDefaults.key) lines.push(`tacacs-server key ${this.tacacsDefaults.key}`);
    if (this.tacacsDefaults.timeoutSec !== undefined) {
      lines.push(`tacacs-server timeout ${this.tacacsDefaults.timeoutSec}`);
    }
    for (const r of this.radiusServers.values()) {
      // Même règle que pour TACACS+ : la forme héritée se rend telle
      // qu'elle a été tapée, sans quoi la configuration déclarerait un
      // nom de serveur que l'opérateur n'a jamais donné.
      if (r.legacySpelling) {
        lines.push(`radius-server host ${r.address ?? r.name}`
          + (r.authPort !== 1645 ? ` auth-port ${r.authPort}` : '')
          + (r.acctPort !== 1646 ? ` acct-port ${r.acctPort}` : '')
          + (r.key ? ` key ${r.key}` : ''));
        continue;
      }
      lines.push(`radius server ${r.name}`);
      if (r.address) lines.push(` address ipv4 ${r.address} auth-port ${r.authPort} acct-port ${r.acctPort}`);
      if (r.key) lines.push(` key ${r.key}`);
    }
    for (const t of this.tacacsServers.values()) {
      // La forme HÉRITÉE se rend telle qu'elle a été tapée : la
      // réécrire en `tacacs server <nom>` produirait une configuration
      // que l'opérateur ne reconnaîtrait pas, et qui déclarerait un nom
      // là où il n'en avait donné aucun.
      if (t.legacySpelling) {
        lines.push(`tacacs-server host ${t.address ?? t.name}`
          + (t.port !== 49 ? ` port ${t.port}` : '')
          + (t.timeoutSec !== undefined && t.timeoutSec !== 5 ? ` timeout ${t.timeoutSec}` : '')
          + (t.key ? ` key ${t.key}` : ''));
        continue;
      }
      lines.push(`tacacs server ${t.name}`);
      if (t.address) lines.push(` address ipv4 ${t.address}`);
      if (t.port !== 49) lines.push(` port ${t.port}`);
      if (t.key) lines.push(` key ${t.key}`);
      if (t.timeoutSec !== undefined && t.timeoutSec !== 5) lines.push(` timeout ${t.timeoutSec}`);
    }
    for (const g of this.aaaGroups.values()) {
      lines.push(`aaa group server ${g.kind} ${g.name}`);
      for (const m of g.members) {
        // Un membre déclaré par son ADRESSE se rend par son adresse :
        // `server name 10.0.0.2` est une ligne qu'IOS ne produit pas et
        // qu'un import rejouerait comme un nom de serveur inexistant.
        const parAdresse = this.tacacsServers.get(m)?.legacySpelling
          || this.radiusServers.get(m)?.legacySpelling;
        lines.push(parAdresse ? ` server ${m}` : ` server name ${m}`);
      }
    }
    // `legacyHosts` n'a plus aucun écrivain : les deux formes héritées
    // alimentent désormais le magasin unique de leur protocole et se
    // rendent plus haut. Le champ subsiste le temps qu'une topologie
    // enregistrée avant ce correctif puisse encore être relue.
    for (const lh of this.legacyHosts) {
      lines.push(`${lh.kind === 'radius' ? 'radius' : 'tacacs'}-server host ${lh.host}`
        + (lh.key ? ` key ${lh.key}` : ''));
    }
    for (const tr of this.timeRanges.values()) {
      lines.push(`time-range ${tr.name}`);
      if (tr.absolute) {
        const a = tr.absolute;
        if (a.start) lines.push(` absolute start ${a.start.hour}:${a.start.minute < 10 ? '0' : ''}${a.start.minute} ${a.start.day} ${this.monthName(a.start.month)} ${a.start.year}${a.end ? ' end ' + a.end.hour + ':' + (a.end.minute < 10 ? '0' : '') + a.end.minute + ' ' + a.end.day + ' ' + this.monthName(a.end.month) + ' ' + a.end.year : ''}`);
      }
      for (const p of tr.periodic) {
        lines.push(` periodic ${p.days} ${p.startHour}:${this.pad2(p.startMinute)} to ${p.endHour}:${this.pad2(p.endMinute)}`);
      }
    }
    for (const cm of this.classMaps.values()) {
      const typ = cm.kind === 'inspect' ? ' type inspect' : '';
      const mode = cm.matchAll ? 'match-all' : 'match-any';
      lines.push(`class-map${typ} ${mode} ${cm.name}`);
      for (const mt of cm.matches) {
        if (mt.kind === 'access-group-name') lines.push(` match access-group name ${mt.value}`);
        else if (mt.kind === 'access-group-num') lines.push(` match access-group ${mt.value}`);
        else if (mt.kind === 'protocol') lines.push(` match protocol ${mt.value}`);
        else if (mt.kind === 'any') lines.push(' match any');
      }
    }
    for (const pm of this.policyMaps.values()) {
      const typ = pm.kind === 'inspect' ? ' type inspect' : '';
      lines.push(`policy-map${typ} ${pm.name}`);
      for (const cls of pm.classes) {
        const cprefix = cls.kind === 'inspect' ? 'class type inspect' : 'class';
        lines.push(` ${cprefix} ${cls.className}`);
        for (const a of cls.actions) {
          if (a.kind === 'police') lines.push(`  police ${a.args.join(' ')}`);
          else if (a.kind === 'inspect') lines.push('  inspect');
          else if (a.kind === 'drop') lines.push(`  drop${a.args.includes('log') ? ' log' : ''}`);
          else if (a.kind === 'pass') lines.push('  pass');
          else if (a.kind === 'set-dscp') lines.push(`  set dscp ${a.args[0]}`);
          else if (a.kind === 'set-precedence') lines.push(`  set precedence ${a.args[0]}`);
        }
      }
    }
    for (const tp of this.pkiTrustpoints.values()) {
      lines.push(`crypto pki trustpoint ${tp.name}`);
      /*
       * L'inscription vient EN PREMIER, comme dans la configuration d'un
       * vrai IOS, et sur UNE ligne : elle etait rendue en deux morceaux
       * aux deux bouts du bloc — `enrollment url` en tete, `enrollment
       * <mode>` en queue — pour une seule et meme commande.
       */
      if (tp.enrollmentUrl) lines.push(` enrollment url ${tp.enrollmentUrl}`);
      else if (tp.enrollmentProfile) lines.push(` enrollment profile ${tp.enrollmentProfile}`);
      else if (tp.source) lines.push(` enrollment ${tp.source}`);
      if (tp.subjectName) lines.push(` subject-name ${tp.subjectName}`);
      if (tp.revocationCheck) lines.push(` revocation-check ${tp.revocationCheck}`);
      if (tp.rsaKeypair) lines.push(` rsakeypair ${tp.rsaKeypair}`);
      if (tp.fqdn) lines.push(` fqdn ${tp.fqdn}`);
      if (tp.ipAddress) lines.push(` ip-address ${tp.ipAddress}`);
      if (tp.serialNumber) lines.push(` serial-number ${tp.serialNumber}`);
      if (tp.autoEnroll) lines.push(` auto-enroll${tp.autoEnroll.percent ? ` ${tp.autoEnroll.percent}` : ''}${tp.autoEnroll.regenerate ? ' regenerate' : ''}`);
      if (tp.fingerprint) lines.push(` fingerprint ${tp.fingerprint}`);
    }
    if (this.controlPlane.servicePolicyInput || this.controlPlane.servicePolicyOutput) {
      lines.push('control-plane');
      if (this.controlPlane.servicePolicyInput) lines.push(` service-policy input ${this.controlPlane.servicePolicyInput}`);
      if (this.controlPlane.servicePolicyOutput) lines.push(` service-policy output ${this.controlPlane.servicePolicyOutput}`);
    }
    for (const z of this.zones.values()) lines.push(`zone security ${z.name}`);
    for (const zp of this.zonePairs.values()) {
      lines.push(`zone-pair security ${zp.name} source ${zp.source} destination ${zp.destination}`);
      if (zp.servicePolicy) lines.push(` service-policy type inspect ${zp.servicePolicy}`);
    }
    return lines;
  }

  asInterfaceRunningConfigLines(ifName: string): string[] {
    const lines: string[] = [];
    const f = this.interfaceFlags.get(ifName);
    if (!f) return lines;
    if (f.noUnreachables) lines.push(' no ip unreachables');
    if (f.noRedirects) lines.push(' no ip redirects');
    if (f.noProxyArp) lines.push(' no ip proxy-arp');
    if (f.maskReply) lines.push(' ip mask-reply');
    if (f.urpf?.mode) {
      const via = f.urpf.mode === 'loose' ? 'any' : 'rx';
      lines.push(` ip verify unicast source reachable-via ${via}`
        + (f.urpf.allowDefault ? ' allow-default' : ''));
    }
    if (f.zoneMember) lines.push(` zone-member security ${f.zoneMember}`);
    if (f.ipv6TrafficFilter) lines.push(` ipv6 traffic-filter ${f.ipv6TrafficFilter.name} ${f.ipv6TrafficFilter.direction}`);
    return lines;
  }

  private renderAaaMethod(m: AaaMethodEntry): string {
    const parts: string[] = ['aaa', m.phase, m.service];
    if (m.service === 'commands' && m.privilegeLevel !== undefined) parts.push(String(m.privilegeLevel));
    parts.push(m.listName);
    if (m.phase === 'accounting' && m.recordType) parts.push(m.recordType);
    parts.push(...m.methods);
    return parts.join(' ');
  }

  private monthName(m: number): string {
    return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1] || '';
  }

  private pad2(n: number): string { return n < 10 ? '0' + n : '' + n; }
}

void (null as IPAddress | null);
