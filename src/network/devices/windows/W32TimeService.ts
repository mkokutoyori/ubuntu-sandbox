/**
 * PRD-NTP-Tutoriel.md §5 / lot N4 — le service de temps Windows.
 *
 * ── Le defaut mesure ────────────────────────────────────────────────
 *
 * `w32tm` etait un talon d'une seule branche : toute sous-commande
 * autre que `/query /status` renvoyait **la chaine litterale
 * `w32tm /query /status`**.
 *
 * ```
 * C:\> w32tm /query /peers
 * w32tm /query /status
 * C:\> w32tm /resync /force
 * w32tm /query /status
 * ```
 *
 * Et `/query /status` lui-meme etait un bloc fixe de quatre lignes :
 * `Stratum: 3` etait ecrit en dur sur une machine qui n'interrogeait
 * personne, `Source` valait le PDC du domaine quel que soit ce que
 * l'operateur avait configure — donc `w32tm /config /manualpeerlist`
 * n'avait aucun effet observable.
 *
 * ── Ce que ce service decide ────────────────────────────────────────
 *
 * Comme chronyd sous Linux, W32Time ne fabrique pas un second moteur :
 * il pilote le `NtpAgent`, celui des routeurs. Ce qu'il apporte est ce
 * que W32Time apporte vraiment — la liste de pairs, les drapeaux de
 * synchronisation, et l'idee de « source fiable » qui structure toute
 * la hierarchie Active Directory du §6.1 du tutoriel.
 *
 * ── Les drapeaux, et pourquoi ils ne sont pas decoratifs ────────────
 *
 * `0x8` (client NTP) et `0x1` (pair symetrique) sont les deux formes du
 * tutoriel, et ils choisissent VRAIMENT le mode de l'association : un
 * `0x1` cree un pair symetrique, un `0x8` un client. `0x2` (broadcast)
 * est refuse plutot que rangé sans effet — ce simulateur n'a pas de
 * mode broadcast NTP, et l'accepter ferait croire a une ecoute qui
 * n'existe pas.
 *
 * `/syncfromflags:domhier` est la valeur par defaut d'une machine
 * membre : elle se synchronise sur la hierarchie du domaine et **ignore
 * la liste manuelle**. C'est la regle que le §6.1 enonce, et la faire
 * agir est ce qui rend le lab « seul le PDC Emulator pointe vers
 * l'exterieur » verifiable au lieu d'etre une phrase.
 */

import type { NtpAgent } from '../../ntp/NtpAgent';
import { isValidIPv4 } from '../../core/ip';

export type SyncFromFlags = 'manual' | 'domhier' | 'no' | 'all';

export interface W32Peer {
  readonly hote: string;
  /** Le drapeau tel qu'il a ete ecrit : `0x8`, `0x1`. */
  readonly drapeau: string;
  readonly mode: 'client' | 'peer';
}

export interface W32TimeHost {
  ntp(): NtpAgent;
  /** Le nom de la source de la hierarchie AD, quand la machine en a une. */
  sourceDomaine(): string | null;
}

/** Un drapeau `w32tm` vers le mode d'association qu'il demande. */
function modeDuDrapeau(d: string): 'client' | 'peer' | null {
  const n = parseInt(d.replace(/^0x/i, ''), 16);
  if (Number.isNaN(n)) return null;
  // Les bits se cumulent (`0x9` = SpecialInterval|Client) : c'est le bit
  // de mode qui compte, pas la valeur entiere.
  if (n & 0x1) return 'peer';
  if (n & 0x8) return 'client';
  return null;
}

export class W32TimeService {
  private peers: W32Peer[] = [];
  private flags: SyncFromFlags = 'domhier';
  private reliable = false;
  private demarreALe = Date.now();

  constructor(private readonly host: W32TimeHost) {}

  getPeers(): readonly W32Peer[] { return this.peers; }
  getFlags(): SyncFromFlags { return this.flags; }
  isReliable(): boolean { return this.reliable; }
  getUptimeSec(): number { return Math.max(0, Math.floor((Date.now() - this.demarreALe) / 1000)); }

  /**
   * `w32tm /config /manualpeerlist:"..." /syncfromflags:... /reliable:...`
   *
   * Sans `/update`, la vraie commande ENREGISTRE sans appliquer : c'est
   * la raison d'etre du drapeau, et l'ignorer ferait croire qu'un
   * `w32tm /config` sans `/update` a pris effet.
   */
  configure(opts: {
    manualpeerlist?: string;
    syncfromflags?: string;
    reliable?: string;
    update: boolean;
  }): { ok: true } | { ok: false; erreur: string } {
    if (opts.manualpeerlist !== undefined) {
      const nouveaux: W32Peer[] = [];
      for (const brut of opts.manualpeerlist.trim().split(/\s+/).filter(Boolean)) {
        const [hote, drapeau = '0x8'] = brut.split(',');
        const mode = modeDuDrapeau(drapeau);
        if (mode === null) {
          return { ok: false, erreur: `The following flag is not supported: ${drapeau}` };
        }
        nouveaux.push({ hote, drapeau, mode });
      }
      this.peers = nouveaux;
    }
    if (opts.syncfromflags !== undefined) {
      const f = opts.syncfromflags.toLowerCase();
      if (!['manual', 'domhier', 'no', 'all'].includes(f)) {
        return { ok: false, erreur: `The parameter is incorrect. (0x80070057)` };
      }
      this.flags = f as SyncFromFlags;
    }
    if (opts.reliable !== undefined) {
      this.reliable = /^(yes|true|1)$/i.test(opts.reliable);
    }
    if (opts.update) this.appliquer();
    return { ok: true };
  }

  /** `w32tm /resync` : reinterroger tout de suite. */
  resync(): { ok: true } | { ok: false; erreur: string } {
    const agent = this.host.ntp();
    if (agent.getConfig().associations.size === 0) {
      // Le vrai message, et il est utile : il dit que la machine n'a
      // aucune source, pas que le reseau a echoue.
      return {
        ok: false,
        erreur: 'The computer did not resync because no time data was available.',
      };
    }
    agent.pollAll();
    return { ok: true };
  }

  /**
   * Traduit la configuration en associations sur l'agent.
   *
   * `domhier` IGNORE la liste manuelle et suit la hierarchie du domaine :
   * c'est la regle du §6.1 du tutoriel — seul le PDC Emulator pointe
   * vers l'exterieur — et la faire agir est ce qui la rend verifiable.
   */
  private appliquer(): void {
    const agent = this.host.ntp();
    for (const ip of [...agent.getConfig().associations.keys()]) agent.removeServer(ip);
    if (this.flags === 'no') return;
    const voulues = this.flags === 'domhier'
      ? [{ hote: this.host.sourceDomaine() ?? '', drapeau: '0x9', mode: 'client' as const }]
        .filter((p) => p.hote)
      : this.peers;
    for (const p of voulues) {
      if (!isValidIPv4(p.hote)) continue;
      if (p.mode === 'peer') agent.addPeer(p.hote);
      else agent.addServer(p.hote);
    }
    agent.setEnabled(true);
    agent.pollAll();
  }
}
