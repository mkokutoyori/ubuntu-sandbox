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
