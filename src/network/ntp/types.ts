import { SourceStatistics } from './SourceStatistics';
import type { DelayQuantile } from './DelayQuantile';
import type { SampleFilter } from './SampleFilter';
import type { RateLimit } from './RateLimiter';
import { simulationNowMs } from '@/network/core/SystemClock';

import type { NetworkPdu } from '@/network/core/NetworkPdu';
import type { NtpTimestamp } from './timestamp';
import { NTP_TIMESTAMP_ZERO } from './timestamp';
export const UDP_PORT_NTP = 123;

export type NtpMode = 'client' | 'server' | 'symmetric-active' | 'symmetric-passive' | 'broadcast';
export type NtpLeapIndicator = 0 | 1 | 2 | 3;

/**
 * La SEULE version que cet agent emette (RFC 5905).
 *
 * Elle etait ecrite en litteral a chaque construction de paquet ET
 * recopiee par la colonne `Version` de `show sntp`, qui devenait donc
 * une constante d'affichage a tenir a jour a la main. Une seule
 * ecriture : la vue lit ce que la machine emet.
 */
export const NTP_VERSIONS = [1, 2, 3, 4] as const;

export type NtpVersion = typeof NTP_VERSIONS[number];

export function isNtpVersion(token: string | undefined): token is `${NtpVersion}` {
  return token !== undefined
    && (NTP_VERSIONS as readonly number[]).includes(Number(token))
    && /^\d+$/.test(token);
}

export const NTP_VERSION: NtpVersion = 4;

export interface NtpExtensionField {
  type: number;
  value: Uint8Array;
}

export interface NtpPacket extends NetworkPdu {
  type: 'ntp';
  leapIndicator: NtpLeapIndicator;
  version: NtpVersion;
  mode: NtpMode;
  stratum: number;
  poll: number;
  precision: number;
  rootDelay: number;
  rootDispersion: number;
  refIdentifier: string;
  refTimestamp: NtpTimestamp;
  origTimestamp: NtpTimestamp;
  rxTimestamp: NtpTimestamp;
  txTimestamp: NtpTimestamp;
  keyId?: number;
  extensions?: NtpExtensionField[];
  signedBytes?: Uint8Array;
  /**
   * Le condensé d'authentification (lot N5), `MD5(cle ‖ en-tete)`.
   *
   * Il est distinct de `keyId` parce que les deux repondent a des
   * questions differentes : le numero dit AVEC QUELLE cle signer, le
   * condensé prouve qu'on la CONNAIT. Le moteur ne lisait que le
   * premier, si bien que nommer une cle suffisait a etre accepte.
   */
  mac?: string;
}

export interface NtpFilterStage {
  t: number;
  offsetMs: number;
  delayMs: number;
  dispersionMs: number;
}

export const NTP_STAGES = 8;
export const NTP_MAX_DISPERSION_MS = 16000;
export const NTP_MIN_DISPERSION_MS = 10;
export const NTP_MAX_DISTANCE_MS = 1000;
export const NTP_PHI = 15e-6;
export const NTP_MIN_POLL = 6;
export const NTP_MAX_POLL = 17;
export const NTP_DEFAULT_MAX_POLL = 10;
export const NTP_MAX_STRATUM = 16;
export const NTP_BURST_COUNT = 8;
export const NTP_BURST_INTERVAL_MS = 2000;
export const NTP_UNREACH_LIMIT = 12;
export const NTP_SPIKE_GATE = 3;

export const NTP_DEFAULT_BROADCAST_DELAY_US = 3000;
export const NTP_MULTICAST_ADDRESS = '224.0.1.1';

export interface NtpBroadcastServer {
  readonly destination: string | null;
  readonly version: NtpVersion;
  readonly keyId?: number;
  readonly ttl?: number;
  readonly pollExponent: number;
}

export interface NtpAssociation {
  serverIp: string;
  mode: NtpMode;
  preferred: boolean;
  prefer: boolean;
  stratum: number;
  reach: number;
  pollSec: number;
  delayMs: number;
  offsetMs: number;
  dispersionMs: number;
  lastPollMs: number;
  lastReplyMs: number;
  synced: boolean;
  keyId?: number;
  version?: NtpVersion;
  sourceInterface?: string;
  /**
   * La derniere reponse de ce serveur portait-elle un condensé valide ?
   *
   * C'est ce que `show ntp associations detail` rend par le mot
   * `authenticated`, et c'est la SEULE vue qui le montre — la
   * documentation Cisco et les transcriptions de terrain concordent :
   * « basic `show ntp associations` won't reveal authentication status,
   * you must use the `detail` keyword ». Sans ce champ, un operateur
   * n'avait aucun moyen de distinguer « la cle est bonne » de « la cle
   * n'est pas verifiee ».
   *
   * `undefined` signifie « aucune reponse recue », qui n'est ni
   * authentifie ni non authentifie.
   */
  authenticated?: boolean;
  configuredAs?: 'ntp' | 'sntp';
  leap: NtpLeapIndicator;
  rootDelayMs: number;
  rootDispersionMs: number;
  refId: string;
  refTimestamp: NtpTimestamp;
  org: NtpTimestamp;
  rec: NtpTimestamp;
  xmt: NtpTimestamp;
  updateMs: number;
  filter: NtpFilterStage[];
  jitterMs: number;
  hpoll: number;
  ppoll: number;
  minpoll: number;
  maxpoll: number;
  burst: number;
  unreach: number;
  outdateMs: number;
  nextdateMs: number;
  iburst: boolean;
  burstMode: boolean;
  kiss?: string;
  ephemeral?: boolean;
  localIp?: string;
  selection?: 'sys' | 'candidate' | 'outlier' | 'falseticker' | 'reject';
  online: boolean;
  noselect: boolean;
  trust: boolean;
  require: boolean;
  maxDelayMs?: number;
  maxDelayRatio?: number;
  maxDelayDevRatio?: number;
  minStratum?: number;
  pollTarget?: number;
  fixedOffsetMs?: number;
  fixedPollSec?: number;
  port?: number;
  presend?: number;
  presendDone: number;
  autoOffline: boolean;
  copy: boolean;
  maxDelayQuant?: number;
  filterLength?: number;
  delayQuantile?: DelayQuantile;
  sampleFilter?: SampleFilter;
  filterCount: number;
  fallbackOnly: boolean;
  pollScore: number;
  txCount: number;
  burstGood: number;
  statistics: SourceStatistics;
  sent: number;
  received: number;
  validReceived: number;
  goodReceived: number;
  lastTests: string;
  response: NtpResponseInfo | null;
}

export interface NtpResponseInfo {
  readonly version: number;
  readonly mode: NtpMode;
  readonly precision: number;
  readonly poll: number;
  readonly responseTimeMs: number;
  readonly authenticated: boolean;
  readonly offsetMs: number;
  readonly delayMs: number;
  readonly dispersionMs: number;
}


export interface NtpClientLogEntry {
  ntpHits: number;
  ntpDrops: number;
  firstNtpMs: number;
  lastNtpMs: number;
  intervalExponent: number;
  limitedIntervalExponent: number;
}

export interface NtpAuthKey {
  id: number;
  algo: string;
  key: string;
}

export interface NtpSystemState {
  leap: NtpLeapIndicator;
  poll: number;
  precision: number;
  rootDelayMs: number;
  rootDispersionMs: number;
  refTimestamp: NtpTimestamp;
  updateMs: number;
  offsetMs: number;
  jitterMs: number;
  peerIp: string | null;
  survivors: string[];
  stepCount: number;
  pollCredit: number;
}

export function createSystemState(): NtpSystemState {
  return {
    leap: 3, poll: NTP_MIN_POLL, precision: -20, rootDelayMs: 0, rootDispersionMs: 0,
    refTimestamp: NTP_TIMESTAMP_ZERO, updateMs: 0, offsetMs: 0, jitterMs: 0,
    peerIp: null, survivors: [], stepCount: 0, pollCredit: 0,
  };
}

export type NtpRateLimit = RateLimit;

export interface NtpConfig {
  rateLimit: NtpRateLimit | null;
  enabled: boolean;
  serverMode: boolean;
  associations: Map<string, NtpAssociation>;
  localStratum: number;
  offsetMs: number;
  lastSyncMs: number;
  refIdentifier: string;
  system: NtpSystemState;
  sourceInterface: string;
  authenticate: boolean;
  authKeys: Map<number, NtpAuthKey>;
  trustedKeys: Set<number>;
  accessGroups: Map<string, string>;
  /**
   * Le durcissement du §9 du tutoriel NTP, et l'horloge materielle du §8.
   * `no ntp allow mode control` ferme le mode 6 (celui de `monlist`,
   * CVE-2013-5211) et `ntp update-calendar` recopie l'heure NTP dans le
   * calendrier : les deux etaient acceptees et rangees NULLE PART, donc
   * absentes de la configuration rendue -- une machine durcie revenait
   * ouverte apres un import de topologie.
   */
  allowModeControl: boolean;
  /**
   * Cette machine SAIT-elle repondre aux requetes de mode 6 ?
   *
   * Distinct de `allowModeControl`, qui est le reglage de l'operateur
   * (`no ntp allow mode control`). Ici c'est une propriete de la
   * PLATEFORME : IOS et VRP repondent a `ntpq`, **chronyd non** — il
   * n'implemente pas le mode 6 du tout et cause a `chronyc` par son
   * propre protocole sur UDP/323. Les confondre ferait repondre un poste
   * Linux a une interrogation qu'aucun chronyd reel n'honore.
   */
  modeControlResponder: boolean;
  updateCalendar: boolean;
  /** Les interfaces ou `ntp disable` interdit de servir le temps. */
  disabledInterfaces: Set<string>;
  /** Depuis quand le service tourne : `show ntp status` le rend. */
  startedAtMs: number;
  /**
   * `ntp logging` / `sntp logging` — eteint par defaut sur IOS.
   *
   * Les evenements `%NTP-5-PEERSYNC` et `%NTP-4-PEERUNSYNC` etaient
   * ecrits au journal SANS condition, donc une machine que personne
   * n'avait configuree pour cela les recevait quand meme. Le drapeau
   * n'est pas un decor : c'est la porte que le journal consulte.
   */
  logging: boolean;
  /**
   * Sous quelle ORTHOGRAPHE la journalisation a ete demandee.
   *
   * `ntp logging` et `sntp logging` posent le meme fait, comme
   * `ntp server` et `sntp server` ; rendre l'une pour l'autre decrirait
   * une machine que l'operateur n'a pas configuree, et la configuration
   * rendue est rejouee a l'import d'une topologie.
   */
  loggingSpelling: 'ntp' | 'sntp';
  sntpBroadcastClient: boolean;
  broadcastServers: Map<string, NtpBroadcastServer>;
  broadcastClientInterfaces: Map<string, string | null>;
  broadcastDelayUs: number;
  /** Les compteurs de paquets (lot N8). */
  counters: NtpCounters;
}

/**
 * Ce qu'un equipement compte sur ses paquets NTP.
 *
 * Les noms sont NEUTRES plutot que ceux d'un constructeur : Cisco parle
 * de « Ntp In packets », Huawei de « Received », chrony de « NTP packets
 * received ». Trois vues sur un seul comptage — un compteur par
 * plateforme finirait par donner trois nombres pour un seul fait.
 *
 * Ce qui est compte l'est au point ou l'evenement a lieu, jamais deduit.
 */
export interface NtpCounters {
  /** Paquets recus, tous modes confondus. */
  received: number;
  /** Paquets emis. */
  sent: number;
  /** Recus ET traites jusqu'au bout. */
  processed: number;
  /** Recus et ecartes, pour quelque raison que ce soit. */
  dropped: number;
  /** Ecartes parce que l'authentification a echoue. */
  authFailures: number;
  /**
   * Paquets dont le condensé a ete VERIFIE et reconnu bon.
   *
   * Il est compte plutot que deduit : `recus - echecs` compterait comme
   * authentifie tout paquet qui n'en portait aucune trace, c'est-a-dire
   * l'immense majorite d'entre eux sur une machine sans cle.
   */
  authOk: number;
  /** Ecartes par `ntp access-group`. */
  accessDenied: number;
  /** Messages de CONTROLE (mode 6) recus et emis — lot N11. */
  receivedControl: number;
  sentControl: number;
  /** Refuses par `no ntp allow mode control`, distinct d'un refus d'ACL. */
  controlDenied: number;
  /** Version NTP non prise en charge. */
  badVersion: number;
  kissReceived: number;
  kissSent: number;
  rateLimited: number;
  serverRequests: number;
  serverDropped: number;
  serverReplies: number;
  serverAuthenticated: number;
  /** Paquet mal forme : ni un mode connu, ni une charge utile lisible. */
  protocolError: number;
  /** Recus par mode, pour le filtre `show ntp packets mode <x>`. */
  receivedByMode: Record<NtpMode, number>;
  /** Emis par mode. */
  sentByMode: Record<NtpMode, number>;
}

export function createNtpCounters(): NtpCounters {
  const parMode = (): Record<NtpMode, number> => ({
    client: 0, server: 0, 'symmetric-active': 0, 'symmetric-passive': 0, broadcast: 0,
  });
  return {
    received: 0, sent: 0, processed: 0, dropped: 0,
    authFailures: 0, authOk: 0, accessDenied: 0, badVersion: 0, protocolError: 0, kissReceived: 0, kissSent: 0, rateLimited: 0,
    serverRequests: 0, serverDropped: 0, serverReplies: 0, serverAuthenticated: 0,
    receivedControl: 0, sentControl: 0, controlDenied: 0,
    receivedByMode: parMode(), sentByMode: parMode(),
  };
}

export function createDefaultNtpConfig(): NtpConfig {
  return {
    enabled: true,
    serverMode: false,
    associations: new Map(),
    localStratum: 16,
    offsetMs: 0,
    lastSyncMs: 0,
    refIdentifier: '.INIT.',
    system: createSystemState(),
    rateLimit: null,
    sourceInterface: '',
    authenticate: false,
    authKeys: new Map(),
    trustedKeys: new Set(),
    accessGroups: new Map(),
    allowModeControl: true,
    modeControlResponder: false,
    updateCalendar: false,
    disabledInterfaces: new Set(),
    startedAtMs: simulationNowMs(),
    logging: false,
    loggingSpelling: 'ntp',
    sntpBroadcastClient: false,
    broadcastServers: new Map(),
    broadcastClientInterfaces: new Map(),
    broadcastDelayUs: NTP_DEFAULT_BROADCAST_DELAY_US,
    counters: createNtpCounters(),
  };
}

export function emptyFilter(): NtpFilterStage[] {
  return Array.from({ length: NTP_STAGES }, () => ({ t: 0, offsetMs: 0, delayMs: 0, dispersionMs: NTP_MAX_DISPERSION_MS }));
}

export function defaultAssociation(serverIp: string, prefer = false, mode: NtpMode = 'client'): NtpAssociation {
  return {
    serverIp, mode, preferred: false, prefer,
    stratum: 16, reach: 0, pollSec: 2 ** NTP_MIN_POLL,
    delayMs: 0, offsetMs: 0, dispersionMs: NTP_MAX_DISPERSION_MS,
    lastPollMs: 0, lastReplyMs: 0, synced: false,
    leap: 3, rootDelayMs: 0, rootDispersionMs: 0, refId: '',
    refTimestamp: NTP_TIMESTAMP_ZERO, org: NTP_TIMESTAMP_ZERO, rec: NTP_TIMESTAMP_ZERO, xmt: NTP_TIMESTAMP_ZERO,
    updateMs: 0, filter: emptyFilter(), jitterMs: 0,
    hpoll: NTP_MIN_POLL, ppoll: NTP_MAX_POLL, minpoll: NTP_MIN_POLL, maxpoll: NTP_DEFAULT_MAX_POLL,
    burst: 0, unreach: 0, outdateMs: 0, nextdateMs: 0, iburst: false, burstMode: false,
    online: true, noselect: false, trust: false, require: false, pollScore: 0, txCount: 0, burstGood: 0, fallbackOnly: false,
    presendDone: 0, autoOffline: false, copy: false, filterCount: 0,
    statistics: new SourceStatistics(2 ** -20), sent: 0, received: 0, validReceived: 0, goodReceived: 0, lastTests: '000 000 0000', response: null,
  };
}

export function computeOffsetMs(
  t1: number, t2: number, t3: number, t4: number,
): { offset: number; delay: number } {
  const offset = ((t2 - t1) + (t3 - t4)) / 2;
  const delay = (t4 - t1) - (t3 - t2);
  return { offset, delay };
}
