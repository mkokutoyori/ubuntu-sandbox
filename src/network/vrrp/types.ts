import type { NetworkPdu } from '@/network/core/NetworkPdu';
import { createDefaultFhrpConfig, trackedPriority, type FhrpTrackEntry } from '../fhrp/types';
export const IP_PROTO_VRRP = 112;
export const VRRP_MULTICAST_IP = '224.0.0.18';
export const VRRP_MULTICAST_MAC = '01:00:5e:00:00:12';

export type VrrpState = 'init' | 'backup' | 'master';

export interface VrrpPacket extends NetworkPdu {
  type: 'vrrp';
  version: 2;
  vrid: number;
  priority: number;
  advertiseSec: number;
  vips: string[];
  senderIp: string;
  /**
   * Le type et les donnees d'authentification de VRRPv2.
   *
   * Ils sont portes par le PAQUET et non deduits de la configuration du
   * recepteur : c'est toute la difference entre authentifier et se
   * croire authentifie. Un emetteur annonce ce qu'il emploie, le
   * recepteur compare, et un desaccord fait ECARTER l'annonce.
   *
   * VRRPv2 (RFC 2338 §5.3.6) numerote les types : 0 aucune, 1 mot de
   * passe simple, 2 en-tete AH. **RFC 3768 les a RETIRES** — « VRRP does
   * not currently support authentication » — donc ce qu'implementent
   * Huawei et Cisco aujourd'hui est une extension de constructeur
   * heritee de VRRPv2, et non une fonction normalisee. Le dire vaut
   * mieux que de laisser croire l'inverse.
   */
  authType?: number;
  authData?: string;
}

export type VrrpTrackEntry = FhrpTrackEntry;

export type VrrpAuthMode = 'simple' | 'md5' | 'none';

/**
 * Ce qu'un groupe VRRP compte, aux noms de `display vrrp statistics`.
 *
 * Les noms sont ceux de la VRAIE sortie, releves sur la documentation de
 * VRP, et non ceux qu'on aurait devines : la vue de ce depot annoncait
 * `Advertisement sent`, `Become master` et `Track interfaces`, dont
 * **aucun** ne figure dans la sortie d'une vraie machine — c'etait un
 * format invente, en plus d'etre a zero.
 *
 * Chaque champ ci-dessous est soit COMPTE au point ou l'evenement a
 * lieu, soit nul pour une raison ecrite dans `VrrpAgent`. Les deux se
 * distinguent : un zero mesure et un zero faute de mesure ne veulent pas
 * dire la meme chose a un operateur.
 */
export interface VrrpStats {
  transitedToMaster: number;
  transitedToBackup: number;
  transitedToInitialize: number;
  receivedAdvertisements: number;
  sentAdvertisements: number;
  advertisementIntervalErrors: number;
  failedAuthCheck: number;
  receivedIpTtlErrors: number;
  receivedPriorityZero: number;
  sentPriorityZero: number;
  receivedInvalidType: number;
  receivedUnmatchedAddressList: number;
  unknownAuthType: number;
  mismatchedAuthType: number;
  packetLengthErrors: number;
  discardedTrackAdminVrrp: number;
  receivedAttacking: number;
  receivedSelfsend: number;
  sentGratuitousArp: number;
}

export function createVrrpStats(): VrrpStats {
  return {
    transitedToMaster: 0, transitedToBackup: 0, transitedToInitialize: 0,
    receivedAdvertisements: 0, sentAdvertisements: 0,
    advertisementIntervalErrors: 0, failedAuthCheck: 0, receivedIpTtlErrors: 0,
    receivedPriorityZero: 0, sentPriorityZero: 0,
    receivedInvalidType: 0, receivedUnmatchedAddressList: 0,
    unknownAuthType: 0, mismatchedAuthType: 0, packetLengthErrors: 0,
    discardedTrackAdminVrrp: 0, receivedAttacking: 0, receivedSelfsend: 0,
    sentGratuitousArp: 0,
  };
}

/**
 * Les quatre compteurs que VRP tient pour la MACHINE et non par groupe.
 *
 * Ils sont globaux parce qu'ils portent sur des paquets qu'on n'a pas pu
 * rattacher a un groupe : une somme de controle fausse ou un VRID
 * inconnu, justement, ne designe aucun groupe.
 */
export interface VrrpGlobalStats {
  checksumErrors: number;
  versionErrors: number;
  vridErrors: number;
  otherErrors: number;
}

export function createVrrpGlobalStats(): VrrpGlobalStats {
  return { checksumErrors: 0, versionErrors: 0, vridErrors: 0, otherErrors: 0 };
}

export interface VrrpGroupRuntime {
  iface: string;
  vrid: number;
  state: VrrpState;
  vip: string | null;
  priority: number;
  preempt: boolean;
  advertiseSec: number;
  masterIp: string | null;
  masterPriority: number;
  lastHeardMasterMs: number;
  lastTransitionMs: number;
  tracks: VrrpTrackEntry[];
  /**
   * Les trois champs que VRP configure, rend et rejoue sans que ce
   * moteur les fasse agir : il ne differe aucune prise de role et
   * n'authentifie rien. Ils vivent ICI plutot que dans la facade
   * separee du routeur (`HuaweiVrrpService`, lot V15) parce qu'un
   * second magasin donne deux reponses a une question — le
   * commutateur, lui, les PERDAIT. Les porter est un progres sur les
   * perdre ; les faire agir reste un travail de protocole.
   */
  preemptDelaySec: number;
  /**
   * Depuis quand ce routeur est ELIGIBLE a preempter le maitre courant.
   *
   * `null` quand il ne l'est pas. C'est ce qui rend le delai reel plutot
   * que decoratif : sans cette date, `preempt-mode timer delay` ne
   * pourrait que se rendre dans une vue.
   */
  preemptEligibleSinceMs?: number | null;
  /** Les compteurs de `display vrrp statistics`, mesures. */
  stats?: VrrpStats;
  description: string;
  authMode: VrrpAuthMode;
  authKey?: string;
}

export function effectivePriority(g: VrrpGroupRuntime): number {
  return trackedPriority(g.priority, g.tracks, 1, 254);
}

export interface VrrpConfig {
  enabled: boolean;
  groups: Map<string, VrrpGroupRuntime>;
}

export { makeFhrpKey as makeKey } from '../fhrp/types';

export function createDefaultVrrpConfig(): VrrpConfig {
  return createDefaultFhrpConfig<VrrpGroupRuntime>();
}

export function defaultGroupRuntime(iface: string, vrid: number): VrrpGroupRuntime {
  return {
    iface, vrid, state: 'init', vip: null, priority: 100, preempt: true,
    advertiseSec: 1,
    masterIp: null, masterPriority: 0,
    lastHeardMasterMs: 0, lastTransitionMs: Date.now(),
    tracks: [],
    preemptDelaySec: 0, description: '', authMode: 'none',
  };
}

export function vrrpVirtualMac(vrid: number): string {
  return `00:00:5e:00:01:${vrid.toString(16).padStart(2, '0')}`;
}

// Election comparison is shared across the FHRP family.
export { compareFhrpCandidates as compareCandidate } from '../fhrp/types';

export function masterDownIntervalMs(advertiseSec: number, priority: number): number {
  const skewSec = (256 - priority) / 256;
  return (3 * advertiseSec + skewSec) * 1000;
}
