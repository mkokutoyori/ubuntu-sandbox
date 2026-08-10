import type { NetworkPdu } from '@/network/core/NetworkPdu';
export const UDP_PORT_NTP = 123;

export type NtpMode = 'client' | 'server' | 'symmetric-active' | 'symmetric-passive';
export type NtpLeapIndicator = 0 | 1 | 2 | 3;

export interface NtpPacket extends NetworkPdu {
  type: 'ntp';
  leapIndicator: NtpLeapIndicator;
  version: 4;
  mode: NtpMode;
  stratum: number;
  poll: number;
  precision: number;
  rootDelay: number;
  rootDispersion: number;
  refIdentifier: string;
  refTimestampMs: number;
  origTimestampMs: number;
  rxTimestampMs: number;
  txTimestampMs: number;
  keyId?: number;
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
}

export interface NtpAuthKey {
  id: number;
  algo: string;
  key: string;
}

export interface NtpConfig {
  enabled: boolean;
  serverMode: boolean;
  associations: Map<string, NtpAssociation>;
  localStratum: number;
  offsetMs: number;
  lastSyncMs: number;
  refIdentifier: string;
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
  updateCalendar: boolean;
  /** Les interfaces ou `ntp disable` interdit de servir le temps. */
  disabledInterfaces: Set<string>;
  /** Depuis quand le service tourne : `show ntp status` le rend. */
  startedAtMs: number;
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
    sourceInterface: '',
    authenticate: false,
    authKeys: new Map(),
    trustedKeys: new Set(),
    accessGroups: new Map(),
    allowModeControl: true,
    updateCalendar: false,
    disabledInterfaces: new Set(),
    startedAtMs: Date.now(),
  };
}

export function defaultAssociation(serverIp: string, prefer = false, mode: NtpMode = 'client'): NtpAssociation {
  return {
    serverIp, mode, preferred: false, prefer,
    stratum: 16, reach: 0, pollSec: 64,
    delayMs: 0, offsetMs: 0, dispersionMs: 16000,
    lastPollMs: 0, lastReplyMs: 0, synced: false,
  };
}

export function computeOffsetMs(
  t1: number, t2: number, t3: number, t4: number,
): { offset: number; delay: number } {
  const offset = ((t2 - t1) + (t3 - t4)) / 2;
  const delay = (t4 - t1) - (t3 - t2);
  return { offset, delay };
}
