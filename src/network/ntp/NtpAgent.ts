import { simulationNowMs } from '@/network/core/SystemClock';

import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  type NtpAssociation, type NtpConfig, type NtpPacket, type NtpMode,
  type NtpCounters, type NtpVersion, type NtpRateLimit, type NtpClientLogEntry, createNtpCounters,
  createDefaultNtpConfig, defaultAssociation, emptyFilter,
  UDP_PORT_NTP, NTP_VERSION, NTP_MAX_STRATUM, NTP_DEFAULT_MAX_POLL, NTP_MIN_POLL, NTP_MAX_POLL, NTP_PHI,
  NTP_MAX_DISPERSION_MS, NTP_MIN_DISPERSION_MS, NTP_MAX_DISTANCE_MS
} from './types';
import { ReferenceTracking } from './ReferenceTracking';
import { adjustPoll, pollAdjustment, startBurst, startInitialBurst, chronyTransmitTick, chronyValidResponse } from './chronyPoll';
import { SourceStatistics, type MeasurementSample } from './SourceStatistics';
import { evaluateSampleTests } from './chronySampleTests';
import { DelayQuantile } from './DelayQuantile';
import { SampleFilter } from './SampleFilter';
import {
  ChronySelector, DEFAULT_SELECTION_PARAMETERS, type CombinedReference, type SelectionInput,
  type SelectionParameters, type SourceVerdict,
} from './ChronySelection';
import { timestampFromMs, timestampDifferenceMs, NTP_TIMESTAMP_ZERO, type NtpTimestamp } from './timestamp';
import {
  clockFilter, isFit, pollTick, pollUpdate, resetPeer, rootDistanceMs, PRECISION_FLOOR_MS,
} from './peerProcess';
import { selectSources, combineOffsets, chooseSystemPeer } from './systemProcess';
import {
  IPAddress,
  type EthernetFrame, type UDPPacket,
} from '../core/types';
import { Logger } from '../core/Logger';
import { isValidIPv4, tryIpToUint32 } from '../core/ip';
import { calculerMacNtp, verifierMacNtp } from './auth';
import { decodeNtpPacket, encodeNtpPacket, isCryptoNak, isKissOfDeath } from './wire';
import { verdictAccesNtp, type ActionNtp } from './accessGroups';
import {
  type NtpControlPacket, OPCODES_SERVIS, ERREURS_CONTROLE,
  motEtatSysteme, motEtatPair, SELECT, MODE_CONTROLE, encodeControlPacket, decodeControlPacket,
  formaterVariables, formaterListeAssociations,
} from './control';
import {
  disciplinerHorloge, appliquerDecision, creerEtatHorloge,
  type EtatHorloge, type DecisionDiscipline, type ReglagesDiscipline,
} from './discipline';
import type { UdpSendRequest } from '../layers/transport/UdpEgress';

export interface NtpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  sendUdpDatagram(request: UdpSendRequest): boolean;
}

interface UdpPorts { readonly source: number; readonly destination: number }

export interface LocalReference { readonly stratum: number; readonly distance: number; readonly orphan: boolean }

export interface NtpPlatformProfile {
  respondsWhenUnsynchronized: boolean;
  unsynchronizedRootBoundMs: number;
  silentOnBadAuthentication: boolean;
  acceptsExtensionFields: boolean;
  statelessSymmetricReply: boolean;
  enforcesRootDistance: boolean;
  localReferenceIsAddress: boolean;
  pollModel: 'ntpd' | 'chrony';
}

export const NTP_DEFAULT_PROFILE: NtpPlatformProfile = {
  respondsWhenUnsynchronized: false,
  unsynchronizedRootBoundMs: 0,
  silentOnBadAuthentication: false,
  acceptsExtensionFields: true,
  statelessSymmetricReply: false,
  enforcesRootDistance: true,
  localReferenceIsAddress: false,
  pollModel: 'ntpd',
};

export interface NtpAssociationOptions {
  readonly version?: NtpVersion;
  readonly sourceInterface?: string;
  readonly iburst?: boolean;
  readonly burst?: boolean;
  readonly minpoll?: number;
  readonly maxpoll?: number;
  readonly online?: boolean;
}

function applyAssociationOptions(
  association: NtpAssociation, options: NtpAssociationOptions,
): void {
  if (options.version !== undefined) association.version = options.version;
  if (options.sourceInterface !== undefined) {
    association.sourceInterface = options.sourceInterface;
  }
  if (options.iburst !== undefined) association.iburst = options.iburst;
  if (options.burst !== undefined) association.burstMode = options.burst;
  if (options.minpoll !== undefined) association.minpoll = options.minpoll;
  if (options.maxpoll !== undefined) association.maxpoll = Math.max(options.maxpoll, association.minpoll);
  if (options.online !== undefined) association.online = options.online;
  association.hpoll = Math.max(Math.min(association.hpoll, association.maxpoll), association.minpoll);
}

export class NtpAgent {
  private config: NtpConfig = createDefaultNtpConfig();
  private readonly emitting = new Set<string>();
  private readonly peerTimers = new Map<string, TimerHandle>();
  private scheduler: IScheduler | null = null;
  private running = false;
  private profile: NtpPlatformProfile = { ...NTP_DEFAULT_PROFILE };

  constructor(
    private readonly host: NtpHost,
    private readonly getBus: () => IEventBus,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.config.enabled) this.armAll();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.disarmAll();
  }

  getConfig(): Readonly<NtpConfig> { return this.config; }

  setRateLimit(limit: NtpRateLimit | null): void {
    this.config.rateLimit = limit;
    this.buckets.clear();
  }

  private readonly buckets = new Map<string, { tokens: number; at: number; excess: number }>();

  private allowedByRate(ip: string): 'serve' | 'kod' | 'drop' {
    const limit = this.config.rateLimit;
    if (limit === null) return 'serve';
    const now = simulationNowMs();
    const bucket = this.buckets.get(ip) ?? { tokens: limit.burst, at: now, excess: 0 };
    const refill = ((now - bucket.at) / 1000) / 2 ** limit.intervalExponent;
    bucket.tokens = Math.min(limit.burst, bucket.tokens + refill);
    bucket.at = now;
    this.buckets.set(ip, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 'serve';
    }
    this.config.counters.rateLimited++;
    bucket.excess++;
    if (limit.kod) return 'kod';
    return bucket.excess % 2 ** limit.leakExponent === 0 ? 'serve' : 'drop';
  }

  setProfile(profile: Partial<NtpPlatformProfile>): void { this.profile = { ...this.profile, ...profile }; }
  getProfile(): Readonly<NtpPlatformProfile> { return this.profile; }

  setEnabled(on: boolean): void {
    if (this.config.enabled === on) return;
    this.config.enabled = on;
    if (on) this.armAll();
    else this.disarmAll();
    if (!on) {
      this.getBus().publish({
        topic: 'ntp.unsynced',
        payload: { deviceId: this.host.id, hostname: this.host.getHostname(), reason: 'admin-disabled' },
      });
      this.becomeUnsynchronized();
    }
  }

  setServerMode(on: boolean, advertiseLocalClock = true): void {
    this.config.serverMode = on;
    if (on && advertiseLocalClock && this.config.localStratum === 16) {
      this.config.localStratum = 8;
      this.config.refIdentifier = 'LOCL';
      this.config.system.leap = 0;
      this.config.system.refTimestamp = timestampFromMs(this.now());
    }
  }

  private becomeUnsynchronized(): void {
    this.config.localStratum = NTP_MAX_STRATUM;
    this.config.lastSyncMs = 0;
    this.config.refIdentifier = '.INIT.';
    this.config.system.leap = 3;
    this.config.system.peerIp = null;
    this.config.system.survivors = [];
    for (const association of this.config.associations.values()) association.preferred = false;
  }

  addServer(
    serverIp: string, prefer = false, keyId?: number,
    configuredAs: 'ntp' | 'sntp' = 'ntp', options: NtpAssociationOptions = {},
  ): void {
    let a = this.config.associations.get(serverIp);
    if (!a) {
      a = defaultAssociation(serverIp, prefer);
      if (keyId !== undefined) a.keyId = keyId;
      a.configuredAs = configuredAs;
      applyAssociationOptions(a, options);
      this.config.associations.set(serverIp, a);
      this.beginAssociation(a);
    } else {
      if (prefer) a.prefer = true;
      if (keyId !== undefined) a.keyId = keyId;
      a.configuredAs = configuredAs;
      applyAssociationOptions(a, options);
    }
  }

  removeServer(serverIp: string): void {
    this.disarm(serverIp);
    this.config.associations.delete(serverIp);
    if (this.config.system.peerIp === serverIp) this.reselect();
  }

  addPeer(
    peerIp: string, prefer = false, keyId?: number,
    options: NtpAssociationOptions = {},
  ): void {
    let a = this.config.associations.get(peerIp);
    if (!a) {
      a = defaultAssociation(peerIp, prefer, 'symmetric-active');
      if (keyId !== undefined) a.keyId = keyId;
      applyAssociationOptions(a, options);
      this.config.associations.set(peerIp, a);
      this.beginAssociation(a);
    } else {
      a.mode = 'symmetric-active';
      a.ephemeral = false;
      if (prefer) a.prefer = true;
      if (keyId !== undefined) a.keyId = keyId;
      applyAssociationOptions(a, options);
    }
  }

  private beginAssociation(a: NtpAssociation): void {
    if (!this.config.enabled) return;
    const now = simulationNowMs();
    resetPeer(a, this.config.system, now);
    a.hpoll = Math.max(Math.min(a.maxpoll, a.minpoll), a.minpoll);
    if (a.iburst && a.online && this.profile.pollModel === 'chrony') startInitialBurst(a);
    this.pollDue(a.serverIp);
  }

  private armAll(): void {
    for (const a of this.config.associations.values()) this.arm(a);
  }

  private disarmAll(): void {
    for (const ip of [...this.peerTimers.keys()]) this.disarm(ip);
  }

  private disarm(ip: string): void {
    const handle = this.peerTimers.get(ip);
    if (handle === undefined) return;
    (this.scheduler ?? this.getScheduler()).clear(handle);
    this.peerTimers.delete(ip);
  }

  private arm(a: NtpAssociation): void {
    this.disarm(a.serverIp);
    if (!this.config.enabled || !a.online || a.kiss === 'DENY' || a.kiss === 'RSTR') return;
    const scheduler = this.getScheduler();
    this.scheduler = scheduler;
    const delay = Math.max(0, a.nextdateMs - simulationNowMs());
    this.peerTimers.set(a.serverIp, scheduler.setTimeout(() => {
      this.peerTimers.delete(a.serverIp);
      this.pollDue(a.serverIp);
    }, delay));
  }

  setSourceInterface(name: string): void { this.config.sourceInterface = name; }

  /**
   * Comment cette machine evalue une liste d'acces (lot N6).
   *
   * L'agent ne connait pas les ACL — elles vivent sur l'equipement — et
   * ce port etroit est le meme motif que `NATEngine.setACLMatchFn`.
   * Sans lui, `ntp access-group` restait une commande rangee que rien
   * ne consultait.
   */
  private aclMatch: ((acl: string, srcIp: string) => boolean) | null = null;
  setAclMatchFn(fn: (acl: string, srcIp: string) => boolean): void {
    this.aclMatch = fn;
  }

  /**
   * Ce paquet a-t-il le droit de faire ce qu'il demande ?
   *
   * Sans evaluateur d'ACL branche, tout passe : une machine sans notion
   * de liste d'acces ne peut pas filtrer, et refuser par defaut
   * couperait NTP sur tout equipement qui n'en a pas.
   */
  private accesAutorise(action: ActionNtp, srcIp: string): boolean {
    if (this.config.accessGroups.size === 0) return true;
    const fn = this.aclMatch;
    if (!fn) return true;
    return verdictAccesNtp(this.config.accessGroups, action, (acl) => fn(acl, srcIp));
  }
  private clientAdmission: ((srcIp: string) => boolean) | null = null;
  setClientAdmission(fn: ((srcIp: string) => boolean) | null): void { this.clientAdmission = fn; }
  private admitted(srcIp: string): boolean { return this.clientAdmission === null || this.clientAdmission(srcIp); }

  setSourceOnline(serverIp: string, online: boolean): boolean {
    const a = this.config.associations.get(serverIp);
    if (!a) return false;
    if (a.online === online) return true;
    a.online = online;
    if (!online) {
      this.disarm(serverIp);
      if (this.profile.pollModel !== 'chrony') {
        a.reach = 0;
        this.reselect();
      }
      return true;
    }
    if (a.iburst && this.profile.pollModel === 'chrony') startInitialBurst(a);
    if (this.config.enabled) this.pollDue(serverIp);
    return true;
  }

  setSourceCriteria(
    serverIp: string,
    criteria: Partial<Pick<NtpAssociation, 'noselect' | 'trust' | 'require' | 'prefer' | 'maxDelayMs'
    | 'maxDelayRatio' | 'maxDelayDevRatio' | 'minStratum' | 'pollTarget' | 'minpoll' | 'maxpoll' | 'fixedOffsetMs' | 'fixedPollSec' | 'fallbackOnly' | 'port' | 'presend' | 'autoOffline' | 'copy'>>
    & {
      statistics?: { minSamples?: number; maxSamples?: number; minDelay?: number; asymmetry?: number };
      maxDelayQuant?: number;
      filterLength?: number;
    },
  ): boolean {
    const a = this.config.associations.get(serverIp);
    if (!a) return false;
    const { statistics, maxDelayQuant, filterLength, ...rest } = criteria;
    Object.assign(a, rest);
    const quantum = 2 ** this.config.system.precision;
    if (statistics !== undefined && (statistics.minSamples !== undefined || statistics.maxSamples !== undefined
      || statistics.minDelay !== undefined || statistics.asymmetry !== undefined)) {
      a.statistics = new SourceStatistics(quantum, statistics.minSamples, statistics.maxSamples, statistics.minDelay, statistics.asymmetry);
    }
    if (maxDelayQuant !== undefined && maxDelayQuant > 0) {
      a.maxDelayQuant = maxDelayQuant;
      a.delayQuantile = DelayQuantile.fromFraction(maxDelayQuant, quantum / 2);
    }
    if (filterLength !== undefined && filterLength >= 1) {
      a.filterLength = filterLength;
      a.sampleFilter = new SampleFilter(1, filterLength, NTP_MAX_DISPERSION_MS / 1000, 0.0, quantum);
      a.filterCount = 0;
    }
    if (a.maxpoll < a.minpoll) a.maxpoll = a.minpoll;
    a.hpoll = Math.max(Math.min(a.maxpoll, a.hpoll), a.minpoll);
    const selectionChanged = criteria.noselect !== undefined || criteria.prefer !== undefined
      || criteria.trust !== undefined || criteria.require !== undefined;
    if (selectionChanged && this.profile.pollModel !== 'chrony') this.reselect();
    return true;
  }

  private setClockOffset(offsetMs: number): void {
    const delta = offsetMs - this.config.offsetMs;
    if (delta !== 0) for (const a of this.config.associations.values()) a.statistics.correctOffset(delta / 1000);
    this.config.offsetMs = offsetMs;
  }

  reselectSources(): void {
    if (this.profile.pollModel === 'chrony') this.selector.unselect();
    this.reselect();
  }

  bestMeasuredOffsetMs(): number | null {
    const now = simulationNowMs();
    const reachable = [...this.config.associations.values()].filter((a) => a.reach !== 0 && a.stratum < NTP_MAX_STRATUM);
    if (reachable.length === 0) return null;
    const best = reachable.find((a) => a.preferred)
      ?? reachable.sort((x, y) => rootDistanceMs(x, now) - rootDistanceMs(y, now))[0];
    return best.offsetMs;
  }

  resetSources(): void {
    for (const a of this.config.associations.values()) {
      a.statistics.reset();
      a.delayQuantile?.reset();
      a.sampleFilter?.drop();
      a.filterCount = 0;
      a.presendDone = 0;
      a.filter = emptyFilter();
      a.synced = false;
      a.preferred = false;
      a.selection = undefined;
      a.txCount = 0;
      a.pollScore = 0;
      if (a.hpoll !== a.minpoll) {
        a.hpoll = a.minpoll;
        a.pollSec = 2 ** a.hpoll;
        a.nextdateMs = Math.min(a.nextdateMs, a.outdateMs + a.pollSec * 1000);
        this.arm(a);
      }
    }
    this.reference.reset();
    const wasSelected = this.selector.selected() !== null;
    this.selector.clear();
    if (wasSelected || this.profile.pollModel !== 'chrony') this.reselect();
  }

  stepClockBy(deltaMs: number): void {
    this.horloge.etat = appliquerDecision(
      this.horloge.etat, { quoi: 'step', nouvelOffset: this.config.offsetMs + deltaMs }, 0);
    this.horloge.derniereDecision = 'step';
    this.setClockOffset(this.horloge.etat.offsetApplique);
    for (const a of this.config.associations.values()) {
      a.offsetMs -= deltaMs;
      a.filter = a.filter.map((stage) => ({ ...stage, offsetMs: stage.offsetMs - deltaMs }));
    }
  }

  startBurst(serverIp: string, goodSamples: number, totalSamples: number): boolean {
    const a = this.config.associations.get(serverIp);
    if (!a) return false;
    startBurst(a, goodSamples, totalSamples);
    if (a.online && this.config.enabled) {
      a.nextdateMs = simulationNowMs();
      this.pollDue(serverIp);
    }
    return true;
  }

  setAllowModeControl(on: boolean): void { this.config.allowModeControl = on; }
  /** La plateforme sait-elle repondre au mode 6 ? Voir `NtpConfig`. */
  setModeControlResponder(on: boolean): void { this.config.modeControlResponder = on; }
  setUpdateCalendar(on: boolean): void { this.config.updateCalendar = on; }
  setInterfaceDisabled(iface: string, off: boolean): void {
    if (off) this.config.disabledInterfaces.add(iface);
    else this.config.disabledInterfaces.delete(iface);
  }
  isInterfaceDisabled(iface: string): boolean {
    return this.config.disabledInterfaces.has(iface);
  }
  /**
   * L'etat de la discipline d'horloge (lot N9).
   *
   * Il vit a cote de la configuration plutot que dedans : c'est un etat
   * de FONCTIONNEMENT, pas un reglage, et `show running-config` n'a
   * aucune raison de le rendre.
   */
  private horloge: {
    etat: EtatHorloge;
    dernierReglageMs: number;
    derniereDecision: DecisionDiscipline['quoi'] | null;
  } = { etat: creerEtatHorloge(), dernierReglageMs: 0, derniereDecision: null };

  private reglagesDiscipline: ReglagesDiscipline = {};

  /** `makestep <seuil> <limite>` de chrony, et l'equivalent d'un `-g`. */
  setReglagesDiscipline(r: ReglagesDiscipline): void { this.reglagesDiscipline = r; }
  getEtatHorloge(): Readonly<EtatHorloge> { return this.horloge.etat; }
  getDerniereDecision(): DecisionDiscipline['quoi'] | null {
    return this.horloge.derniereDecision;
  }

  /**
   * Forcer un saut : `chronyc makestep`, `w32tm /resync /force`.
   *
   * Elle existe parce qu'un operateur doit pouvoir passer outre la
   * discipline — c'est tout l'objet de la commande — et elle n'a d'effet
   * que s'il y a un ecart a rattraper.
   */
  forcerSaut(): boolean {
    const now = simulationNowMs();
    const reachable = [...this.config.associations.values()].filter((a) => a.reach !== 0 && a.stratum < NTP_MAX_STRATUM);
    const best = reachable.find((a) => a.preferred)
      ?? reachable.sort((x, y) => rootDistanceMs(x, now) - rootDistanceMs(y, now))[0];
    if (!best) return false;
    this.stepClockBy(best.offsetMs);
    return true;
  }

  /** Les compteurs, en lecture — ce que les trois vues lisent. */
  getCounters(): Readonly<NtpCounters> { return this.config.counters; }

  /** `clear ntp statistics` / `reset ntp-service statistics packet`. */
  clearCounters(): void { this.config.counters = createNtpCounters(); }

  getUptimeSec(): number {
    return Math.max(0, Math.floor((simulationNowMs() - this.config.startedAtMs) / 1000));
  }
  removeAuthKey(id: number): void { this.config.authKeys.delete(id); }
  removeTrustedKey(id: number): void { this.config.trustedKeys.delete(id); }
  removeAccessGroup(kind: string): void { this.config.accessGroups.delete(kind); }
  getAssociation(ip: string): NtpAssociation | undefined {
    return this.config.associations.get(ip);
  }
  /**
   * L'ecart de frequence mesure, en parties par million. Il se DEDUIT de
   * l'offset et de l'intervalle de scrutation plutot que d'etre invente :
   * corriger un offset de 64 ms sur une periode de 64 s demande 1000 ppm.
   * Sans synchronisation il n'y a rien a mesurer, donc zero.
   */
  getDriftPpm(): number {
    if (!this.isSynced()) return 0;
    const best = [...this.config.associations.values()].find((a) => a.preferred);
    if (!best || best.pollSec <= 0) return 0;
    return (best.offsetMs / 1000 / best.pollSec) * 1e6;
  }
  setAuthenticate(on: boolean): void { this.config.authenticate = on; }
  addAuthKey(id: number, algo: string, key: string): void { this.config.authKeys.set(id, { id, algo, key }); }
  addTrustedKey(id: number): void { this.config.trustedKeys.add(id); }
  setAccessGroup(kind: string, acl: string): void { this.config.accessGroups.set(kind, acl); }
  setLogging(on: boolean, spelling: 'ntp' | 'sntp' = 'ntp'): void {
    this.config.logging = on;
    if (on) this.config.loggingSpelling = spelling;
  }
  isLogging(): boolean { return this.config.logging; }
  setSntpBroadcastClient(on: boolean): void { this.config.sntpBroadcastClient = on; }

  asRunningConfigLines(): string[] {
    const lines: string[] = [];
    if (this.config.serverMode) {
      lines.push(`ntp master${this.config.localStratum !== 8 ? ' ' + this.config.localStratum : ''}`);
    }
    for (const [ip, a] of this.config.associations) {
      const kind = a.mode === 'symmetric-active' ? 'peer' : 'server';
      // `sntp server` est une AUTRE commande, pas un synonyme
      // d'affichage : la rendre en `ntp server` decrit une machine
      // qu'on n'a pas configuree, et la configuration est rejouee.
      const famille = a.configuredAs === 'sntp' ? 'sntp' : 'ntp';
      const options = [
        a.version !== undefined ? ` version ${a.version}` : '',
        a.sourceInterface ? ` source ${a.sourceInterface}` : '',
        a.keyId !== undefined ? ` key ${a.keyId}` : '',
        a.prefer ? ' prefer' : '',
        a.maxpoll !== NTP_DEFAULT_MAX_POLL ? ` maxpoll ${a.maxpoll}` : '',
        a.minpoll !== NTP_MIN_POLL ? ` minpoll ${a.minpoll}` : '',
        a.burstMode ? ' burst' : '',
        a.iburst ? ' iburst' : '',
      ].join('');
      lines.push(`${famille} ${kind} ${ip}${options}`);
    }
    if (this.config.sntpBroadcastClient) lines.push('sntp broadcast client');
    if (this.config.logging) lines.push(`${this.config.loggingSpelling} logging`);
    if (this.config.sourceInterface) lines.push(`ntp source ${this.config.sourceInterface}`);
    if (this.config.updateCalendar) lines.push('ntp update-calendar');
    if (!this.config.allowModeControl) lines.push('no ntp allow mode control');
    if (this.config.authenticate) lines.push('ntp authenticate');
    for (const k of this.config.authKeys.values()) {
      lines.push(`ntp authentication-key ${k.id} ${k.algo} ${k.key}`);
    }
    for (const id of this.config.trustedKeys) lines.push(`ntp trusted-key ${id}`);
    for (const [kind, acl] of this.config.accessGroups) {
      lines.push(`ntp access-group ${kind} ${acl}`);
    }
    return lines;
  }

  setLocalReference(reference: LocalReference | null): void {
    this.localReference = reference;
    this.selectionParameters = {
      ...this.selectionParameters,
      orphanStratum: reference?.orphan ? reference.stratum : NTP_MAX_STRATUM,
    };
  }

  private localReference: LocalReference | null = null;

  private localReferenceServing(): LocalReference | null {
    const reference = this.localReference;
    if (reference === null || this.config.system.peerIp === null || !this.isSynced()) return null;
    const distanceMs = this.config.system.rootDelayMs / 2 + this.currentRootDispersionMs();
    return distanceMs / 1000 > reference.distance ? reference : null;
  }

  setLocalStratum(stratum: number): void {
    if (stratum < 0 || stratum > 16) return;
    this.config.localStratum = stratum;
  }

  getOffsetMs(): number { return this.config.offsetMs; }
  getStratum(): number { return this.config.localStratum; }
  isSynced(): boolean { return this.config.localStratum < NTP_MAX_STRATUM && this.config.system.leap !== 3; }

  now(): number {
    return simulationNowMs() + this.config.offsetMs;
  }

  handleUdp(inPort: string, srcIp: IPAddress, udp: UDPPacket): void {
    if (!this.config.enabled) return;
    if (udp.destinationPort !== UDP_PORT_NTP && udp.sourcePort !== UDP_PORT_NTP && udp.destinationPort !== this.serverPort) return;
    this.requestSourcePort = udp.sourcePort;
    const destination = timestampFromMs(this.now());
    const c = this.config.counters;
    if (!(udp.payload instanceof Uint8Array)) {
      c.protocolError++;
      return;
    }
    if ((udp.payload[0] & 0x7) === MODE_CONTROLE) {
      const control = decodeControlPacket(udp.payload);
      if (control === null) c.protocolError++;
      else this.handleControl(inPort, srcIp, control);
      return;
    }
    const decoded = decodeNtpPacket(udp.payload);
    if ('reason' in decoded) {
      if (decoded.reason === 'version') {
        c.received++;
        c.badVersion++;
        c.dropped++;
      } else {
        c.protocolError++;
      }
      return;
    }
    const payload = decoded.packet;
    if (!this.profile.acceptsExtensionFields && payload.extensions !== undefined) {
      c.protocolError++;
      return;
    }
    if ((payload.mode === 'client' || payload.mode === 'symmetric-active') && udp.destinationPort !== this.serverPort) return;
    c.received++;
    if (payload.mode in c.receivedByMode) c.receivedByMode[payload.mode]++;
    this.getBus().publish({
      topic: 'ntp.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp: srcIp.toString(), mode: payload.mode, stratum: payload.stratum,
      },
    });
    this.receive(inPort, srcIp, payload, destination);
  }

  private discard(): void {
    this.config.counters.dropped++;
  }

  private receive(inPort: string, srcIp: IPAddress, packet: NtpPacket, destination: NtpTimestamp): void {
    const c = this.config.counters;
    const ip = srcIp.toString();
    const requestKind = packet.mode === 'client' || packet.mode === 'symmetric-active';
    if (requestKind && packet.keyId !== undefined && packet.keyId !== 0) {
      const auth = this.checkAuthentication(packet);
      if (!auth.ok) {
        if (this.config.serverMode && !this.profile.silentOnBadAuthentication) this.envoyerCryptoNak(inPort, srcIp, packet, destination);
        c.authFailures++;
        this.discard();
        this.getBus().publish({
          topic: 'ntp.auth.rejected',
          payload: { deviceId: this.host.id, hostname: this.host.getHostname(), fromIp: ip, reason: auth.reason },
        });
        return;
      }
      c.authOk++;
    }
    c.processed++;
    const association = this.config.associations.get(ip);
    if ((packet.mode === 'client' || (packet.mode === 'symmetric-active' && !association)) && !this.admitted(ip)) {
      c.processed--;
      return;
    }
    if (packet.mode === 'client') {
      if (!this.accesAutorise('serve-time', ip)) { this.refuserAcces(srcIp, 'serve-time'); return; }
      if (!this.mayServe()) return;
      const rate = this.allowedByRate(ip);
      this.logClient(ip, rate !== 'serve', packet.keyId !== undefined);
      if (rate === 'drop') { c.processed--; this.discard(); return; }
      if (rate === 'kod') { this.kissOfDeath(inPort, srcIp, packet, destination, 'RATE'); return; }
      this.fastTransmit(inPort, srcIp, packet, 'server', destination);
      return;
    }
    if (packet.mode === 'symmetric-active') {
      if (!association) {
        if (!this.accesAutorise('sync-from', ip)) { this.refuserAcces(srcIp, 'sync-from'); return; }
        if (this.profile.statelessSymmetricReply) {
          this.fastTransmit(inPort, srcIp, packet, 'symmetric-passive', destination);
          return;
        }
        const passive = defaultAssociation(ip, false, 'symmetric-passive');
        passive.ephemeral = true;
        passive.version = packet.version;
        resetPeer(passive, this.config.system, simulationNowMs());
        this.config.associations.set(ip, passive);
        this.processPacket(passive, packet, destination, inPort);
        this.transmit(passive, inPort);
        return;
      }
      if (association.mode === 'symmetric-passive' || association.mode === 'symmetric-active') {
        if (!this.accesAutorise('sync-from', ip)) { this.refuserAcces(srcIp, 'sync-from'); return; }
        this.processPacket(association, packet, destination, inPort);
        if (association.mode === 'symmetric-passive') this.transmit(association, inPort);
        return;
      }
      c.processed--;
      this.discard();
      return;
    }
    if (packet.mode === 'server') {
      if (!association || association.mode !== 'client') { c.processed--; this.discard(); return; }
      this.processPacket(association, packet, destination, inPort);
      return;
    }
    if (packet.mode === 'symmetric-passive') {
      if (!association || association.mode !== 'symmetric-active') { c.processed--; this.discard(); return; }
      this.processPacket(association, packet, destination, inPort);
      return;
    }
    c.processed--;
    this.discard();
  }

  private mayServe(): boolean {
    return this.config.serverMode || this.isSynced() || this.profile.respondsWhenUnsynchronized;
  }

  private processPacket(a: NtpAssociation, packet: NtpPacket, destination: NtpTimestamp, inPort: string): void {
    const c = this.config.counters;
    const retract = (): void => { c.processed--; this.discard(); };
    if (!this.accesAutorise('sync-from', a.serverIp)) {
      this.refuserAcces(new IPAddress(a.serverIp), 'sync-from');
      return;
    }
    if (packet.txTimestamp === NTP_TIMESTAMP_ZERO) { retract(); return; }
    if (packet.txTimestamp === a.org) { retract(); return; }
    const synchronized = packet.origTimestamp !== NTP_TIMESTAMP_ZERO && packet.origTimestamp === a.xmt;
    a.org = packet.txTimestamp;
    a.rec = destination;
    if (!synchronized) { retract(); return; }
    if (isCryptoNak(packet)) {
      c.processed--;
      c.dropped++;
      c.authFailures++;
      if (a.keyId !== undefined) a.authenticated = false;
      this.getBus().publish({
        topic: 'ntp.auth.rejected',
        payload: { deviceId: this.host.id, hostname: this.host.getHostname(), fromIp: a.serverIp, reason: 'bad-mac' },
      });
      return;
    }
    if (!this.authRequise(a)) {
      a.authenticated = undefined;
    } else {
      const authentic = this.replyIsAuthentic(a, packet);
      a.authenticated = authentic;
      if (authentic) c.authOk++;
      else {
        retract();
        c.authFailures++;
        this.getBus().publish({
          topic: 'ntp.auth.rejected',
          payload: { deviceId: this.host.id, hostname: this.host.getHostname(), fromIp: a.serverIp, reason: 'bad-mac' },
        });
        return;
      }
    }
    a.localIp = this.host.getPort(inPort)?.getIPAddress()?.toString();
    a.received++;
    a.validReceived++;
    if (isKissOfDeath(packet)) { this.handleKiss(a, packet.refIdentifier); return; }
    this.applyPacket(a, packet, destination);
  }

  private handleKiss(a: NtpAssociation, code: string): void {
    const c = this.config.counters;
    c.processed--;
    c.dropped++;
    c.kissReceived++;
    a.kiss = code;
    a.synced = false;
    a.stratum = NTP_MAX_STRATUM;
    a.leap = 3;
    if (code === 'DENY' || code === 'RSTR') {
      a.reach = 0;
      this.disarm(a.serverIp);
      this.reselect();
    } else if (code === 'RATE') {
      a.minpoll = Math.min(a.minpoll + 1, NTP_MAX_POLL);
      a.maxpoll = Math.max(a.maxpoll, a.minpoll);
      a.hpoll = Math.max(a.hpoll, a.minpoll);
      pollUpdate(a, a.hpoll, simulationNowMs());
    }
  }

  private applyPacket(a: NtpAssociation, packet: NtpPacket, destination: NtpTimestamp): void {
    const system = this.config.system;
    const now = simulationNowMs();
    a.leap = packet.leapIndicator;
    a.stratum = packet.stratum === 0 ? NTP_MAX_STRATUM : Math.max(packet.stratum, a.minStratum ?? 0);
    a.ppoll = packet.poll;
    a.rootDelayMs = packet.rootDelay;
    a.rootDispersionMs = packet.rootDispersion;
    a.refId = packet.refIdentifier;
    a.refTimestamp = packet.refTimestamp;
    a.lastReplyMs = now;
    if (a.leap === 3 || a.stratum >= NTP_MAX_STRATUM) {
      a.synced = false;
      return;
    }
    if (packet.rootDelay / 2 + packet.rootDispersion >= NTP_MAX_DISPERSION_MS
      || timestampDifferenceMs(packet.refTimestamp, packet.txTimestamp) > 0) return;
    if (this.profile.pollModel === 'chrony') {
      chronyValidResponse(a);
    } else {
      pollUpdate(a, a.hpoll, now);
      a.reach |= 1;
    }
    const precision = PRECISION_FLOOR_MS(system.precision);
    const peerPrecision = 1000 * 2 ** packet.precision;
    const roundTrip = timestampDifferenceMs(destination, packet.origTimestamp);
    const serverHold = timestampDifferenceMs(packet.txTimestamp, packet.rxTimestamp);
    const offset = (timestampDifferenceMs(packet.rxTimestamp, packet.origTimestamp)
      + timestampDifferenceMs(packet.txTimestamp, destination)) / 2 + (a.fixedOffsetMs ?? 0);
    if (this.profile.pollModel === 'chrony') {
      this.processChronyResponse(a, packet, { offsetMs: offset, roundTripMs: roundTrip, serverHoldMs: serverHold, nowMs: now });
      return;
    }
    const delay = Math.max(roundTrip - serverHold, precision);
    const dispersion = peerPrecision + precision + NTP_PHI * roundTrip;
    a.synced = true;
    a.response = {
      version: packet.version, mode: packet.mode, precision: packet.precision, poll: packet.poll,
      responseTimeMs: serverHold, authenticated: a.authenticated === true,
      offsetMs: offset, delayMs: delay, dispersionMs: dispersion,
    };
    a.lastTests = '111 111 1111';
    a.goodReceived++;
    a.statistics.accumulate({
      time: now / 1000, offset: offset / 1000, peerDelay: delay / 1000, peerDispersion: dispersion / 1000,
      rootDelay: (packet.rootDelay + delay) / 1000, rootDispersion: (packet.rootDispersion + dispersion) / 1000,
    });
    const outcome = clockFilter(a, offset, delay, dispersion, now, system);
    if (outcome.accepted && a.burst === 0) this.reselect(a);
  }

  private processChronyResponse(
    a: NtpAssociation,
    packet: NtpPacket,
    measured: { offsetMs: number; roundTripMs: number; serverHoldMs: number; nowMs: number },
  ): void {
    const system = this.config.system;
    const precision = 2 ** system.precision + 2 ** packet.precision;
    const roundTrip = measured.roundTripMs / 1000;
    const hold = measured.serverHoldMs / 1000;
    const peerDelay = Math.max(Math.abs(roundTrip - hold), precision);
    const range = a.statistics.frequencyRange();
    const peerDispersion = precision + ((range.high - range.low) / 2) * Math.abs(roundTrip);
    const sample: MeasurementSample = {
      time: measured.nowMs / 1000 - roundTrip / 2,
      offset: measured.offsetMs / 1000,
      peerDelay,
      peerDispersion,
      rootDelay: packet.rootDelay / 1000 + peerDelay,
      rootDispersion: packet.rootDispersion / 1000 + peerDispersion,
    };
    a.synced = true;
    a.response = {
      version: packet.version, mode: packet.mode, precision: packet.precision, poll: packet.poll,
      responseTimeMs: measured.serverHoldMs, authenticated: a.authenticated === true,
      offsetMs: measured.offsetMs, delayMs: peerDelay * 1000, dispersionMs: peerDispersion * 1000,
    };
    const tests = evaluateSampleTests({
      peerDelay, peerDispersion, offset: sample.offset, sampleTime: sample.time, precision,
      responseTime: Math.abs(hold), presendDone: a.presendDone,
      maxDelay: a.maxDelayMs === undefined ? undefined : a.maxDelayMs / 1000,
      maxDelayRatio: a.maxDelayRatio, maxDelayDevRatio: a.maxDelayDevRatio,
      statistics: a.statistics, quantile: a.delayQuantile,
    });
    const loopFree = this.sourceIsNotUs(a, packet);
    const bit = (ok: boolean): string => (ok ? '1' : '0');
    a.lastTests = `111 111 ${bit(tests.a)}${bit(tests.b)}${bit(tests.c)}${bit(loopFree)}`;
    a.delayQuantile?.accumulate(peerDelay);
    if (a.copy && a.stratum > 0) a.stratum--;
    if (!(tests.a && tests.b && tests.c && loopFree)) {
      adjustPoll(a, loopFree ? 0.1 : 0.02, a.reach !== 0, 0);
      this.processChronySample(a, null);
      return;
    }
    a.goodReceived++;
    clockFilter(a, measured.offsetMs, peerDelay * 1000, peerDispersion * 1000, measured.nowMs, system);
    this.processChronySample(a, sample);
  }

  private sourceIsNotUs(a: NtpAssociation, packet: NtpPacket): boolean {
    if (this.serverPort === 0) return true;
    const system = this.config.system;
    const localRefId = this.chronyLocalRefId(a);
    if (packet.stratum > 1 && isValidIPv4(packet.refIdentifier) && tryIpToUint32(packet.refIdentifier) === localRefId) return false;
    return !(packet.stratum === this.config.localStratum
      && packet.refIdentifier === this.referenceForWire()
      && packet.rootDelay === system.rootDelayMs
      && packet.refTimestamp !== NTP_TIMESTAMP_ZERO
      && packet.refTimestamp === system.refTimestamp);
  }

  private processChronySample(a: NtpAssociation, measurement: MeasurementSample | null): void {
    let sample = measurement;
    if (a.sampleFilter !== undefined) {
      if (sample !== null) a.sampleFilter.accumulate(sample);
      a.filterCount++;
      if (a.filterCount < a.sampleFilter.getMaxSamples()) return;
      sample = a.sampleFilter.filtered();
      if (sample === null) return;
      a.filterCount = 0;
    }
    if (sample === null) return;
    const predicted = a.statistics.predictOffset(sample.time);
    const errorInEstimate = Math.abs(-sample.offset - predicted);
    a.statistics.accumulate(sample);
    this.reselect(a);
    const delays = a.statistics.peerDelays();
    adjustPoll(a, pollAdjustment(a, errorInEstimate, sample.peerDispersion + 0.5 * sample.peerDelay), a.reach !== 0, Math.min(...delays));
  }

  private referenceForWire(): string {
    if (!this.isSynced()) return '';
    if (this.config.refIdentifier === 'LOCL' && (this.config.localStratum >= 2 || this.profile.localReferenceIsAddress)) return '127.127.1.1';
    return this.config.refIdentifier;
  }

  private currentRootDispersionMs(): number {
    const system = this.config.system;
    const elapsed = system.updateMs ? simulationNowMs() - system.updateMs : 0;
    return system.rootDispersionMs + NTP_PHI * elapsed;
  }

  private systemHeader(): Pick<NtpPacket, 'leapIndicator' | 'stratum' | 'precision' | 'rootDelay' | 'rootDispersion' | 'refIdentifier' | 'refTimestamp'> {
    const system = this.config.system;
    const local = this.localReferenceServing();
    if (local !== null) {
      return {
        leapIndicator: 0, stratum: local.stratum, precision: system.precision, rootDelay: 0, rootDispersion: 0,
        refIdentifier: '127.127.1.1', refTimestamp: timestampFromMs(this.now()),
      };
    }
    const synced = this.isSynced();
    return {
      leapIndicator: synced ? system.leap : 3,
      stratum: synced ? this.config.localStratum : 0,
      precision: system.precision,
      rootDelay: synced ? system.rootDelayMs : this.profile.unsynchronizedRootBoundMs,
      rootDispersion: synced ? this.currentRootDispersionMs() : this.profile.unsynchronizedRootBoundMs,
      refIdentifier: this.referenceForWire(),
      refTimestamp: synced ? system.refTimestamp : NTP_TIMESTAMP_ZERO,
    };
  }

  private kissOfDeath(inPort: string, clientIp: IPAddress, request: NtpPacket, destination: NtpTimestamp, code: string): void {
    const srcIp = this.host.getPort(inPort)?.getIPAddress();
    if (!srcIp) return;
    const kiss: NtpPacket = {
      type: 'ntp', ...this.systemHeader(), version: request.version, mode: 'server', poll: request.poll,
      leapIndicator: 3, stratum: 0, refIdentifier: code,
      origTimestamp: request.txTimestamp, rxTimestamp: destination, txTimestamp: timestampFromMs(this.now()),
      keyId: request.keyId,
    };
    this.sendNtp(srcIp, clientIp, kiss, this.replyPorts());
    this.config.counters.kissSent++;
  }

  private readonly clientLog = new Map<string, NtpClientLogEntry>();

  getClientLog(): ReadonlyMap<string, NtpClientLogEntry> { return this.clientLog; }

  clearClientLog(): void { this.clientLog.clear(); }

  private logClient(ip: string, dropped: boolean, authenticated: boolean): void {
    const now = simulationNowMs();
    const c = this.config.counters;
    c.serverRequests++;
    if (dropped) c.serverDropped++;
    if (authenticated) c.serverAuthenticated++;
    const entry = this.clientLog.get(ip)
      ?? { ntpHits: 0, ntpDrops: 0, firstNtpMs: now, lastNtpMs: 0, intervalExponent: 127, limitedIntervalExponent: 127 };
    if (entry.ntpHits > 0 && now > entry.lastNtpMs) {
      entry.intervalExponent = Math.round(Math.log2((now - entry.lastNtpMs) / 1000));
    }
    entry.ntpHits++;
    if (dropped) entry.ntpDrops++;
    entry.lastNtpMs = now;
    this.clientLog.set(ip, entry);
  }

  private fastTransmit(inPort: string, clientIp: IPAddress, request: NtpPacket, mode: NtpMode, destination: NtpTimestamp): void {
    const srcIp = this.host.getPort(inPort)?.getIPAddress();
    if (!srcIp) return;
    const reply: NtpPacket = {
      type: 'ntp', ...this.systemHeader(), version: request.version, mode, poll: request.poll,
      origTimestamp: request.txTimestamp, rxTimestamp: destination,
      txTimestamp: timestampFromMs(this.now()),
      keyId: request.keyId,
    };
    this.sendNtp(srcIp, clientIp, reply, this.replyPorts());
    this.config.counters.serverReplies++;
    this.getBus().publish({
      topic: 'ntp.server.responded',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        clientIp: clientIp.toString(), stratum: this.config.localStratum,
      },
    });
  }

  /**
   * Authentifier un paquet recu (lot N5).
   *
   * Elle ne regardait que le NUMERO de clé : nommer `key 1` suffisait a
   * etre accepte, sans jamais connaitre le secret. Elle verifie
   * desormais le condensé, qui est la seule chose qu'un usurpateur ne
   * peut pas fabriquer.
   *
   * Les quatre refus sont DISTINCTS parce qu'ils envoient l'operateur a
   * quatre endroits differents : pas de clé du tout (le pair n'est pas
   * configure), une clé inconnue (le numero ne correspond a rien ici),
   * une clé connue mais non declaree fiable (`trusted-key` manque), et
   * un condensé faux (les secrets different) — le seul qui denonce une
   * usurpation plutot qu'une faute de configuration.
   */
  /**
   * Le crypto-NAK : une reponse dont l'identifiant de cle vaut ZERO et
   * qui ne porte aucun condensé.
   *
   * Zero est reserve a cet usage — RFC 5905 autorise 65 535 cles « a
   * l'exclusion de zero » — ce qui rend le message reconnaissable sans
   * ambiguite : aucune cle legitime ne peut porter ce numero.
   */
  private envoyerCryptoNak(inPort: string, clientIp: IPAddress, request: NtpPacket, destination: NtpTimestamp): void {
    const srcIp = this.host.getPort(inPort)?.getIPAddress();
    if (!srcIp) return;
    const nak: NtpPacket = {
      type: 'ntp', ...this.systemHeader(), version: request.version, mode: 'server', poll: request.poll,
      origTimestamp: request.txTimestamp, rxTimestamp: destination,
      txTimestamp: timestampFromMs(this.now()),
      keyId: 0,
    };
    this.sendNtp(srcIp, clientIp, nak, this.replyPorts());
  }

  /**
   * Un paquet ecarte par une liste d'acces.
   *
   * Le refus est SILENCIEUX sur le fil — un routeur qui repondrait
   * « tu n'as pas le droit » confirmerait son existence a qui le sonde,
   * ce qui est l'inverse d'un durcissement. L'evenement, lui, est
   * publie : c'est ce qui rend le refus observable depuis un test ou une
   * capture, sans rien emettre vers l'exterieur.
   */
  private refuserAcces(srcIp: IPAddress, action: ActionNtp): void {
    // Le paquet avait ete compte TRAITE — les portes d'acces sont
    // franchies apres l'aiguillage, une fois le mode connu — donc le
    // comptage est repris ici pour que l'identite
    // `recus = traites + ecartes` reste vraie. C'est le meme geste que
    // pour le crypto-NAK, et il vit a un seul endroit par motif.
    this.config.counters.processed--;
    this.config.counters.accessDenied++;
    this.config.counters.dropped++;
    this.getBus().publish({
      topic: 'ntp.access.denied',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp: srcIp.toString(), action,
      },
    });
  }

  private checkAuthentication(
    payload: NtpPacket,
  ): { ok: boolean; reason: 'no-key' | 'untrusted-key' | 'unconfigured' | 'bad-mac' } {
    if (payload.keyId === undefined) return { ok: false, reason: 'no-key' };
    const cle = this.config.authKeys.get(payload.keyId);
    if (!cle) return { ok: false, reason: 'unconfigured' };
    if (!this.config.trustedKeys.has(payload.keyId)) return { ok: false, reason: 'untrusted-key' };
    if (!verifierMacNtp(cle.key, payload, payload.mac, cle.algo)) return { ok: false, reason: 'bad-mac' };
    return { ok: true, reason: 'no-key' };
  }

  /**
   * Signer un paquet sortant, quand l'association nomme une clé que
   * cette machine connait.
   *
   * Le condensé est pose EN DERNIER, une fois tous les champs remplis :
   * il couvre l'en-tete, donc tout champ ecrit apres lui l'invaliderait.
   */
  private signer(pkt: NtpPacket): NtpPacket {
    if (pkt.keyId === undefined) return pkt;
    const cle = this.config.authKeys.get(pkt.keyId);
    if (!cle) return pkt;
    return { ...pkt, mac: calculerMacNtp(cle.key, pkt, cle.algo) };
  }

  /**
   * Le verdict d'authentification sur une REPONSE de serveur.
   *
   * Il est separe du precedent parce que la question n'est pas la meme :
   * un serveur decide s'il ACCEPTE une requete, un client decide s'il
   * CROIT une reponse. Le client ne verifiait rien du tout — donc une
   * machine configuree pour n'accepter que des serveurs authentifies
   * acceptait n'importe quelle reponse, ce que la commande existe
   * precisement pour empecher.
   */
  private replyIsAuthentic(a: NtpAssociation, reply: NtpPacket): boolean {
    const cle = a.keyId !== undefined ? this.config.authKeys.get(a.keyId) : undefined;
    if (!cle) return false;
    if (!this.config.trustedKeys.has(a.keyId!)) return false;
    return verifierMacNtp(cle.key, reply, reply.mac, cle.algo);
  }

  /**
   * Cette association exige-t-elle une authentification ?
   *
   * Elle l'exige quand `ntp authenticate` arme le mecanisme ET que
   * `ntp server X key N` le rattache a ce serveur : les deux commandes
   * sont necessaires, ce que toutes les sources consultees soulignent
   * comme la premiere cause de « je croyais authentifier » — des cles
   * declarees mais aucun `ntp authenticate`.
   */
  private authRequise(a: NtpAssociation): boolean {
    return this.config.authenticate && a.keyId !== undefined;
  }

  pollAll(): void {
    if (!this.config.enabled) return;
    for (const a of [...this.config.associations.values()]) {
      if (a.kiss === 'DENY' || a.kiss === 'RSTR') continue;
      this.transmit(a);
    }
  }

  private pollDue(serverIp: string): void {
    const a = this.config.associations.get(serverIp);
    if (!a || !this.config.enabled || !a.online) return;
    const now = simulationNowMs();
    const system = this.config.system;
    if (this.profile.pollModel === 'chrony') {
      const tick = chronyTransmitTick(a, now, system.peerIp === a.serverIp);
      if (tick.missedSample && a.preferred) this.reselect();
      if (tick.missedSample) this.processChronySample(a, null);
      const sent = this.transmit(a);
      if (!sent && a.autoOffline) {
        this.setSourceOnline(a.serverIp, false);
        return;
      }
      this.arm(a);
      this.refreshSynchronization();
      return;
    }
    const decision = pollTick(a, now, system, (peer) => this.fits(peer, now));
    if (decision.agedSample) {
      const outcome = clockFilter(a, 0, 0, NTP_MAX_DISPERSION_MS, now, system);
      if (outcome.accepted && a.burst === 0) this.reselect();
    }
    if (a.ephemeral && a.reach === 0 && a.unreach >= 2) {
      this.config.associations.delete(a.serverIp);
      return;
    }
    this.transmit(a);
    if (a.fixedPollSec !== undefined && a.burst === 0) {
      a.nextdateMs = simulationNowMs() + a.fixedPollSec * 1000;
      a.pollSec = a.fixedPollSec;
    }
    this.arm(a);
    this.refreshSynchronization();
  }

  private fits(a: NtpAssociation, now: number): boolean {
    return isFit(a, now, this.config.system, a.localIp ?? null, this.config.refIdentifier, this.profile.enforcesRootDistance);
  }

  private transmit(a: NtpAssociation, inPort?: string): boolean {
    const now = simulationNowMs();
    const timestamp = timestampFromMs(this.now());
    a.xmt = timestamp;
    a.lastPollMs = now;
    const mode: NtpMode = a.mode === 'symmetric-active' ? 'symmetric-active'
      : a.mode === 'symmetric-passive' ? 'symmetric-passive' : 'client';
    const request: NtpPacket = {
      type: 'ntp', ...this.systemHeader(), version: a.version ?? NTP_VERSION, mode, poll: a.hpoll,
      origTimestamp: a.org, rxTimestamp: a.rec, txTimestamp: timestamp, keyId: a.keyId,
    };
    const source = inPort !== undefined
      ? this.host.getPort(inPort)?.getIPAddress() ?? undefined
      : this.namedSource(a);
    if (!isValidIPv4(a.serverIp)) return false;
    a.sent++;
    const sent = this.sendNtp(source, new IPAddress(a.serverIp), request, { source: UDP_PORT_NTP, destination: a.port ?? UDP_PORT_NTP });
    this.getBus().publish({
      topic: 'ntp.packet.sent',
      payload: { deviceId: this.host.id, hostname: this.host.getHostname(), serverIp: a.serverIp, mode },
    });
    if (mode === 'symmetric-passive') {
      this.getBus().publish({
        topic: 'ntp.peer.responded',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          peerIp: a.serverIp, mode, stratum: this.config.localStratum,
        },
      });
    }
    return sent;
  }

  private readonly selector = new ChronySelector();
  private selectionParameters: SelectionParameters = { ...DEFAULT_SELECTION_PARAMETERS };

  setSelectionParameters(parameters: Partial<SelectionParameters>): void {
    this.selectionParameters = { ...this.selectionParameters, ...parameters };
  }

  getSelectionParameters(): SelectionParameters { return { ...this.selectionParameters }; }

  selectionVerdict(serverIp: string): SourceVerdict | null { return this.selector.verdict(serverIp); }

  private chronyLocalRefId(a: NtpAssociation): number {
    const declared = a.localIp ?? this.namedSource(a)?.toString();
    if (declared !== undefined && isValidIPv4(declared)) return tryIpToUint32(declared) ?? 0;
    for (const port of this.host.getPorts()) {
      const address = port.getIPAddress()?.toString();
      if (address !== undefined && isValidIPv4(address) && address !== '127.0.0.1') return tryIpToUint32(address) ?? 0;
    }
    return 0;
  }

  private chronyReselect(updated?: NtpAssociation): void {
    const now = simulationNowMs();
    const system = this.config.system;
    const associations = [...this.config.associations.values()];
    const inputs: SelectionInput[] = associations.map((a) => ({
      key: a.serverIp, noselect: a.noselect, prefer: a.prefer, trust: a.trust, require: a.require,
      unsynchronised: a.received === 0 || a.leap === 3 || a.stratum >= NTP_MAX_STRATUM,
      stratum: a.stratum, reachability: a.reach & 0xff, reachabilitySize: Math.min(8, a.sent),
      refId: tryIpToUint32(a.serverIp) ?? 0, statistics: a.statistics, isNtp: true,
      localRefId: this.chronyLocalRefId(a),
    }));
    const outcome = this.selector.select(inputs, now / 1000, this.selectionParameters, updated?.serverIp ?? null);
    system.survivors = [];
    for (const a of associations) {
      const status = this.selector.verdict(a.serverIp)?.status;
      a.preferred = status === 'SELECTED' && outcome.selectedKey === a.serverIp;
      a.selection = status === 'SELECTED' ? 'sys'
        : status === 'UNSELECTED' ? 'candidate'
          : status === 'FALSETICKER' ? 'falseticker'
            : status === 'DISTANT' || status === 'WAITS_SOURCES' || status === 'NONPREFERRED' || status === 'WAITS_UPDATE'
              ? 'outlier' : 'reject';
      if (status === 'SELECTED' || status === 'UNSELECTED') system.survivors.push(a.serverIp);
    }
    if (outcome.noMajority && system.peerIp !== null) {
      system.peerIp = null;
      this.becomeUnsynchronized();
      this.getBus().publish({
        topic: 'ntp.unsynced',
        payload: { deviceId: this.host.id, hostname: this.host.getHostname(), reason: 'unreachable' },
      });
      return;
    }
    const reference = outcome.reference;
    if (reference === null) return;
    const best = this.config.associations.get(reference.key);
    if (best === undefined) return;
    const survivors = associations.filter((a) => system.survivors.includes(a.serverIp));
    this.clockUpdate(best, survivors, system.peerIp !== best.serverIp, reference);
  }

  private reselect(updated?: NtpAssociation): void {
    if (this.profile.pollModel === 'chrony') { this.chronyReselect(updated); return; }
    const now = simulationNowMs();
    const system = this.config.system;
    const associations = [...this.config.associations.values()];
    const usable = associations.filter((a) => !a.noselect && this.fits(a, now));
    const primary = usable.filter((a) => !a.fallbackOnly);
    const fitPeers = primary.length > 0 ? primary : usable;
    const selection = selectSources(fitPeers, now);
    for (const a of associations) {
      a.preferred = false;
      a.selection = !fitPeers.includes(a) ? 'reject'
        : selection.falsetickers.includes(a) ? 'falseticker'
          : selection.survivors.includes(a) ? 'candidate' : 'outlier';
    }
    system.survivors = selection.survivors.map((a) => a.serverIp);
    if (selection.survivors.length === 0) {
      if (system.peerIp !== null) {
        system.peerIp = null;
        this.becomeUnsynchronized();
        this.getBus().publish({
          topic: 'ntp.unsynced',
          payload: { deviceId: this.host.id, hostname: this.host.getHostname(), reason: 'unreachable' },
        });
      }
      return;
    }
    const previous = system.peerIp ? this.config.associations.get(system.peerIp) : undefined;
    const best = chooseSystemPeer(selection.survivors, previous);
    best.preferred = true;
    best.selection = 'sys';
    this.clockUpdate(best, selection.survivors, previous?.serverIp !== best.serverIp);
  }

  private clockUpdate(
    best: NtpAssociation,
    survivors: NtpAssociation[],
    peerChanged: boolean,
    reference?: CombinedReference,
  ): void {
    const system = this.config.system;
    const now = simulationNowMs();
    if (reference === undefined && system.updateMs >= best.updateMs && system.peerIp === best.serverIp) return;
    const combined = reference !== undefined
      ? { offsetMs: -reference.offset * 1000, jitterMs: reference.offsetDeviation * 1000 }
      : best.prefer ? { offsetMs: best.offsetMs, jitterMs: best.jitterMs } : combineOffsets(survivors, now);
    const elapsed = this.horloge.dernierReglageMs
      ? now - this.horloge.dernierReglageMs
      : best.hpoll > 0 ? 2 ** best.hpoll * 1000 : 64000;
    if (reference !== undefined) {
      const verdict = this.reference.checkOffset(combined.offsetMs / 1000);
      if (verdict === 'exit') { this.fatalHandler?.(); return; }
      if (verdict === 'ignored') return;
    }
    const target = this.config.offsetMs + combined.offsetMs;
    const decision = disciplinerHorloge(this.horloge.etat, target, elapsed, this.reglagesDiscipline);
    this.horloge.etat = appliquerDecision(this.horloge.etat, decision, elapsed);
    this.horloge.dernierReglageMs = now;
    this.horloge.derniereDecision = decision.quoi;
    if (decision.quoi === 'spike' || decision.quoi === 'panic') return;
    system.updateMs = best.updateMs;
    system.offsetMs = combined.offsetMs;
    system.jitterMs = combined.jitterMs;
    this.setClockOffset(this.horloge.etat.offsetApplique);
    if (decision.quoi === 'step') {
      system.stepCount++;
      system.poll = NTP_MIN_POLL;
      if (this.reglagesDiscipline.reinitialiserAssociationsAuSaut !== false) {
        this.selector.clear();
        for (const a of this.config.associations.values()) {
          resetPeer(a, system, now);
          this.arm(a);
        }
        system.peerIp = null;
        this.config.localStratum = NTP_MAX_STRATUM;
        system.leap = 3;
        return;
      }
    }
    const wasSynchronized = this.isSynced();
    system.leap = best.leap;
    this.config.localStratum = best.stratum + 1;
    this.config.refIdentifier = best.copy && best.refId !== '' ? best.refId : best.serverIp;
    system.refTimestamp = timestampFromMs(this.now());
    if (reference !== undefined) {
      system.rootDelayMs = reference.rootDelay * 1000;
      system.rootDispersionMs = reference.rootDispersion * 1000;
    } else {
      system.rootDelayMs = best.rootDelayMs + best.delayMs;
      system.rootDispersionMs = best.rootDispersionMs
        + Math.sqrt(best.jitterMs ** 2 + combined.jitterMs ** 2)
        + Math.max(best.dispersionMs + NTP_PHI * (now - best.updateMs) + Math.abs(best.offsetMs), NTP_MIN_DISPERSION_MS);
    }
    system.peerIp = best.serverIp;
    this.config.lastSyncMs = now;
    this.recordReference(best, now, reference);
    this.adjustSystemPoll(combined.offsetMs);
    if (!wasSynchronized || peerChanged) {
      this.getBus().publish({
        topic: 'ntp.synced',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          serverIp: best.serverIp, offsetMs: best.offsetMs, delayMs: best.delayMs,
          newStratum: this.config.localStratum,
        },
      });
      Logger.info(this.host.id, 'ntp:synced',
        `${this.host.name}: NTP synced with ${best.serverIp} stratum ${this.config.localStratum} offset ${best.offsetMs}ms`);
    }
  }

  private readonly reference = new ReferenceTracking();

  getReference(): ReferenceTracking { return this.reference; }

  getRootDispersionMs(): number { return this.currentRootDispersionMs(); }

  getPrecisionExponent(): number { return this.config.system.precision; }

  private recordReference(best: NtpAssociation, nowMs: number, reference?: CombinedReference): void {
    const track = best.statistics.tracking();
    if (track === null) return;
    const nowSeconds = nowMs / 1000;
    const measuredFrequency = reference?.frequency ?? track.frequency;
    const measuredSkew = reference?.skew ?? track.skew;
    const estimate = this.reference.estimate(false, measuredFrequency, measuredSkew);
    this.reference.record({
      offset: (reference?.offset ?? track.averageOffset) + (nowSeconds - (reference?.referenceTime ?? track.referenceTime)) * measuredFrequency,
      nowSeconds,
      referenceTime: reference?.referenceTime ?? track.referenceTime,
      residualFrequency: estimate.residualFrequency,
      skew: estimate.skew,
      frequency: estimate.frequency,
    });
  }

  setFatalHandler(handler: (() => void) | null): void { this.fatalHandler = handler; }

  private fatalHandler: (() => void) | null = null;

  private adjustSystemPoll(offsetMs: number): void {
    const system = this.config.system;
    const previousJitter = this.clockJitterMs;
    const deviation = Math.max(Math.abs(offsetMs - this.lastCombinedOffsetMs), PRECISION_FLOOR_MS(system.precision));
    this.clockJitterMs = Math.sqrt(previousJitter ** 2 + (deviation ** 2 - previousJitter ** 2) / 4);
    this.lastCombinedOffsetMs = offsetMs;
    if (Math.abs(offsetMs) < 4 * this.clockJitterMs) {
      system.pollCredit += system.poll;
      if (system.pollCredit > 30) {
        system.pollCredit = 30;
        if (system.poll < NTP_MAX_POLL) { system.pollCredit = 0; system.poll++; }
      }
    } else {
      system.pollCredit -= system.poll * 2;
      if (system.pollCredit < -30) {
        system.pollCredit = -30;
        if (system.poll > NTP_MIN_POLL) { system.pollCredit = 0; system.poll--; }
      }
    }
  }

  private clockJitterMs = 0;
  private lastCombinedOffsetMs = 0;

  private refreshSynchronization(): void {
    if (this.config.serverMode && this.config.system.peerIp === null) return;
    if (!this.isSynced() || this.config.system.peerIp === null) return;
    const now = simulationNowMs();
    const peer = this.config.associations.get(this.config.system.peerIp);
    if (peer && this.fits(peer, now)) return;
    this.reselect();
  }

  private namedSource(association?: NtpAssociation): IPAddress | undefined {
    const declared = association?.sourceInterface || this.config.sourceInterface;
    return declared ? this.host.getPort(declared)?.getIPAddress() ?? undefined : undefined;
  }

  private serverPort = UDP_PORT_NTP;
  private requestSourcePort = UDP_PORT_NTP;

  setServerPort(port: number): void { this.serverPort = port; }

  getServerPort(): number { return this.serverPort; }

  private replyPorts(): UdpPorts { return { source: this.serverPort, destination: this.requestSourcePort }; }

  private sendNtp(srcIp: IPAddress | undefined, dstIp: IPAddress, brut: NtpPacket, ports?: UdpPorts): boolean {
    const payload = encodeNtpPacket(this.signer(brut));
    if (!this.emettreUdp(srcIp, dstIp, payload, payload.length, dstIp.toString(), ports)) return false;
    this.config.counters.sent++;
    if (brut.mode in this.config.counters.sentByMode) {
      this.config.counters.sentByMode[brut.mode]++;
    }
    return true;
  }

  private emettreUdp(
    srcIp: IPAddress | undefined, dstIp: IPAddress,
    payload: unknown, payloadBytes: number, key: string, ports?: UdpPorts,
  ): boolean {
    if (this.emitting.has(key)) return false;
    this.emitting.add(key);
    try {
      return this.host.sendUdpDatagram({
        destination: dstIp, destinationPort: ports?.destination ?? UDP_PORT_NTP, sourcePort: ports?.source ?? UDP_PORT_NTP,
        payload, payloadBytes, ...(srcIp ? { source: srcIp } : {}),
      });
    } finally { this.emitting.delete(key); }
  }

  // ── Mode 6 : les messages de controle (lot N11) ───────────────────

  /**
   * Un identifiant d'association est un entier de 16 bits que le serveur
   * attribue, pas une adresse : c'est ce que `ntpq -p` affiche et ce
   * qu'on repasse a `rv <id>`. Il est stable pour la duree de vie de
   * l'association, et jamais zero — zero designe la machine elle-meme.
   */
  private prochainIdAssoc = 1;
  private idsAssoc = new Map<string, number>();

  private idAssoc(serverIp: string): number {
    let id = this.idsAssoc.get(serverIp);
    if (id === undefined) { id = ++this.prochainIdAssoc; this.idsAssoc.set(serverIp, id); }
    return id;
  }

  private assocParId(id: number): NtpAssociation | undefined {
    for (const [ip, n] of this.idsAssoc) {
      if (n === id) return this.config.associations.get(ip);
    }
    return undefined;
  }

  /** Le champ `select` d'un pair, d'ou decoule le pointage de `ntpq -p`. */
  private selectDe(a: NtpAssociation): number {
    if (a.reach === 0) return SELECT.REJECT;
    if (a.preferred) return SELECT.SYSPEER;
    return a.synced ? SELECT.CANDIDATE : SELECT.OUTLIER;
  }

  /** Les variables systeme, celles que rend `rv 0`. */
  private variablesSysteme(): Record<string, string> {
    const cfg = this.config;
    const best = [...cfg.associations.values()].find((a) => a.preferred);
    return {
      version: 'ntpd 4.2.8p15',
      leap: String(cfg.localStratum < 16 ? 0 : 3),
      stratum: String(cfg.localStratum),
      precision: '-20',
      rootdelay: (best ? Math.abs(best.delayMs) : 0).toFixed(3),
      rootdisp: (best ? best.dispersionMs : 0).toFixed(3),
      refid: cfg.refIdentifier,
      offset: cfg.offsetMs.toFixed(3),
      frequency: this.getDriftPpm().toFixed(3),
      sys_jitter: '0.000',
      clk_jitter: '0.000',
      clk_wander: '0.000',
    };
  }

  /** Les variables d'un pair, celles que rend `rv <id>`. */
  private variablesPair(a: NtpAssociation): Record<string, string> {
    return {
      srcadr: a.serverIp,
      srcport: String(UDP_PORT_NTP),
      stratum: String(a.stratum),
      precision: '-20',
      reach: a.reach.toString(8).padStart(3, '0'),
      hpoll: String(Math.max(0, Math.round(Math.log2(a.pollSec)))),
      ppoll: String(Math.max(0, Math.round(Math.log2(a.pollSec)))),
      delay: a.delayMs.toFixed(3),
      offset: a.offsetMs.toFixed(3),
      jitter: a.dispersionMs.toFixed(3),
      dispersion: a.dispersionMs.toFixed(3),
    };
  }

  /**
   * Repondre — ou refuser — une requete de controle.
   *
   * Trois portes, dans cet ordre, et l'ordre est celui du sens :
   *
   * 1. **`no ntp allow mode control`** ferme la fonction entiere. Le
   *    refus est SILENCIEUX, comme celui d'une liste d'acces : une
   *    machine qui repondrait « je ne reponds pas aux requetes de
   *    controle » confirmerait son existence a qui la sonde, l'inverse
   *    d'un durcissement. C'est le reglage que CVE-2013-5211 a rendu
   *    obligatoire.
   * 2. **La liste d'acces**, action `control-query` — donc `peer`,
   *    `serve` et `query-only` l'autorisent, `serve-only` non. C'est
   *    exactement ce que `query-only` existe pour dire, et ce qui etait
   *    jusqu'ici inobservable.
   * 3. **L'opcode**, refuse par le bit E et le code de la RFC quand il
   *    n'est pas servi — nommer le refus vaut mieux que se taire, et
   *    c'est ce qui distingue « cette machine ne sait pas » de « cette
   *    machine ne repond pas ».
   */
  private handleControl(inPort: string, srcIp: IPAddress, req: NtpControlPacket): void {
    const c = this.config.counters;
    c.received++;
    c.receivedControl++;
    // Une REPONSE qui nous revient est pour le client, pas pour le
    // serveur : sans ce partage, une machine repondrait a sa propre
    // reponse, les deux portant le meme opcode.
    if (req.response) { this.derniereReponseControle = req; c.processed++; return; }
    // Une plateforme qui n'implemente pas le mode 6 ne le refuse pas :
    // elle ne le connait pas. Le paquet est compte et abandonne, sans
    // etre porte au compteur du DURCISSEMENT — confondre « la machine
    // ne sait pas » et « l'operateur a ferme » enverrait un diagnostic
    // au mauvais endroit.
    if (!this.config.modeControlResponder) { c.dropped++; return; }
    if (!this.config.allowModeControl) { c.dropped++; c.controlDenied++; return; }
    if (!this.accesAutorise('control-query', srcIp.toString())) {
      c.dropped++;
      this.getBus().publish({
        topic: 'ntp.access.denied',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          fromIp: srcIp.toString(), action: 'control-query',
        },
      });
      c.accessDenied++;
      return;
    }
    c.processed++;
    if (!OPCODES_SERVIS.includes(req.opcode)) {
      this.repondreControle(inPort, srcIp, req, '', 0, ERREURS_CONTROLE.INVALID_OPCODE);
      return;
    }
    if (req.opcode === 1) {
      const entrees = [...this.config.associations.entries()].map(([ip, a]) => ({
        id: this.idAssoc(ip),
        status: motEtatPair(true, a.reach !== 0, this.selectDe(a), 0, 0),
      }));
      this.repondreControle(
        inPort, srcIp, req, formaterListeAssociations(entrees), this.motSysteme());
      return;
    }
    // Opcode 2. L'association 0 designe la machine elle-meme.
    if (req.associationId === 0) {
      this.repondreControle(
        inPort, srcIp, req, formaterVariables(this.variablesSysteme()), this.motSysteme());
      return;
    }
    const a = this.assocParId(req.associationId);
    if (!a) {
      this.repondreControle(
        inPort, srcIp, req, '', 0, ERREURS_CONTROLE.INVALID_ASSOCIATION);
      return;
    }
    this.repondreControle(
      inPort, srcIp, req, formaterVariables(this.variablesPair(a)),
      motEtatPair(true, a.reach !== 0, this.selectDe(a), 0, 0));
  }

  private motSysteme(): number {
    // La source d'horloge : 0 quand rien ne la discipline, 6 quand c'est
    // NTP — les deux seules valeurs que cette machine puisse atteindre.
    return motEtatSysteme(
      this.config.localStratum < 16 ? 0 : 3,
      this.config.localStratum < 16 ? 6 : 0, 0, 0);
  }

  private repondreControle(
    inPort: string, dstIp: IPAddress, req: NtpControlPacket,
    data: string, status = 0, erreur?: number,
  ): void {
    const srcIp = this.host.getPort(inPort)?.getIPAddress();
    if (!srcIp) return;
    const reponse: NtpControlPacket = {
      type: 'ntp-control', leapIndicator: 0, version: req.version,
      response: true, error: erreur !== undefined, more: false,
      opcode: req.opcode, sequence: req.sequence,
      // Le code d'erreur occupe l'octet de POIDS FORT du champ d'etat
      // (RFC 9327 §3.2) : c'est le meme champ que l'etat normal, ce qui
      // est precisement pourquoi le bit E doit exister pour les separer.
      status: erreur !== undefined ? (erreur & 0xff) << 8 : status,
      associationId: req.associationId, offset: 0,
      count: data.length, data,
    };
    this.envoyerControle(srcIp, dstIp, reponse);
  }

  /** La derniere reponse de controle recue — ce que lit `ntpq`. */
  private derniereReponseControle: NtpControlPacket | null = null;

  /**
   * Emettre une requete de controle et rendre la reponse.
   *
   * La livraison des trames est SYNCHRONE dans ce simulateur, donc la
   * reponse est deja arrivee quand l'emission rend la main. C'est la
   * meme hypothese que tout le reste du moteur NTP, et elle est ecrite
   * ici plutot que supposee.
   */
  controlQuery(
    cibleIp: string, opcode: number, associationId = 0,
  ): NtpControlPacket | null {
    this.derniereReponseControle = null;
    const req: NtpControlPacket = {
      type: 'ntp-control', leapIndicator: 0, version: 4,
      response: false, error: false, more: false,
      opcode, sequence: ++this.sequenceControle, status: 0,
      associationId, offset: 0, count: 0, data: '',
    };
    this.envoyerControle(this.namedSource(), new IPAddress(cibleIp), req);
    const rep = this.derniereReponseControle;
    // Une reponse qui ne repond pas a CETTE requete n'en est pas une :
    // sans ce controle, une reponse en retard serait prise pour celle-ci.
    if (rep && rep.sequence !== req.sequence) return null;
    return rep;
  }

  private sequenceControle = 0;

  private envoyerControle(
    srcIp: IPAddress | undefined, dstIp: IPAddress, pkt: NtpControlPacket,
  ): void {
    const payload = encodeControlPacket(pkt);
    if (!this.emettreUdp(srcIp, dstIp, payload, payload.length, `ctl|${dstIp.toString()}`)) return;
    this.config.counters.sent++;
    this.config.counters.sentControl++;
  }

  /** L'identifiant qu'une vue doit afficher pour une association. */
  associationId(serverIp: string): number { return this.idAssoc(serverIp); }
  /** Le mot d'etat d'une association, pour la vue locale. */
  peerStatus(a: NtpAssociation): number {
    return motEtatPair(true, a.reach !== 0, this.selectDe(a), 0, 0);
  }
}

