import type { NetworkPdu } from '@/network/core/NetworkPdu';
export const UDP_PORT_NTP = 123;

export type NtpMode = 'client' | 'server' | 'symmetric-active' | 'symmetric-passive';
export type NtpLeapIndicator = 0 | 1 | 2 | 3;

/**
 * La SEULE version que cet agent emette (RFC 5905).
 *
 * Elle etait ecrite en litteral a chaque construction de paquet ET
 * recopiee par la colonne `Version` de `show sntp`, qui devenait donc
 * une constante d'affichage a tenir a jour a la main. Une seule
 * ecriture : la vue lit ce que la machine emet.
 */
export const NTP_VERSION = 4;

export interface NtpPacket extends NetworkPdu {
  type: 'ntp';
  leapIndicator: NtpLeapIndicator;
  version: typeof NTP_VERSION;
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
  configuredAs?: 'ntp' | 'sntp';
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
  /**
   * `sntp broadcast client` — accepte les annonces de mode 5.
   *
   * Range et RENDU, jamais evalue : ce moteur ne connait pas le mode
   * diffusion (aucun `broadcast` dans `NtpAgent`), donc la commande ne
   * fait rien d'observable. Elle est acceptee parce que la refuser
   * ferait disparaitre a l'import d'une topologie une ligne qu'une vraie
   * machine accepte ; le manquement est inscrit au `TODO.md`.
   */
  sntpBroadcastClient: boolean;
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
  /** Paquet mal forme : ni un mode connu, ni une charge utile lisible. */
  protocolError: number;
  /** Recus par mode, pour le filtre `show ntp packets mode <x>`. */
  receivedByMode: Record<NtpMode, number>;
  /** Emis par mode. */
  sentByMode: Record<NtpMode, number>;
}

export function createNtpCounters(): NtpCounters {
  const parMode = (): Record<NtpMode, number> => ({
    client: 0, server: 0, 'symmetric-active': 0, 'symmetric-passive': 0,
  });
  return {
    received: 0, sent: 0, processed: 0, dropped: 0,
    authFailures: 0, authOk: 0, accessDenied: 0, badVersion: 0, protocolError: 0,
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
    sourceInterface: '',
    authenticate: false,
    authKeys: new Map(),
    trustedKeys: new Set(),
    accessGroups: new Map(),
    allowModeControl: true,
    modeControlResponder: false,
    updateCalendar: false,
    disabledInterfaces: new Set(),
    startedAtMs: Date.now(),
    logging: false,
    loggingSpelling: 'ntp',
    sntpBroadcastClient: false,
    counters: createNtpCounters(),
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
