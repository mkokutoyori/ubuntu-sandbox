/**
 * PRD-NTP-Tutoriel.md §4 / lot N3 — chronyd, et le temps d'une machine
 * Linux.
 *
 * ── Le defaut mesure ────────────────────────────────────────────────
 *
 * Le paquet `chrony` etait declare installe et **rien n'existait** : ni
 * binaire, ni unite, ni fichier de configuration. Pire, sur cette meme
 * machine sans aucun demon de temps :
 *
 * ```
 * $ timedatectl
 * System clock synchronized: yes
 *               NTP service: active
 * ```
 *
 * Deux affirmations que rien ne soutenait — la forme de defaut que ce
 * depot ferme partout ailleurs. Et `timedatectl set-timezone
 * Africa/Douala` etait accepte sans rien changer.
 *
 * ── Ce que ce service decide ────────────────────────────────────────
 *
 * Il n'y a pas de second moteur NTP : chronyd pilote le `NtpAgent`, le
 * meme que Cisco et Huawei. Un simulateur avec deux moteurs finirait par
 * donner deux reponses a la meme question, facture que ce depot a deja
 * payee ailleurs (deux registres Windows, deux piles SSH).
 *
 * Ce que le service apporte est ce que chronyd apporte vraiment : la
 * LECTURE de `/etc/chrony/chrony.conf` — donc quelles sources
 * interroger, lesquelles preferer — et la reponse aux questions de
 * `chronyc`.
 *
 * ── Trois choix, et leur raison ─────────────────────────────────────
 *
 * 1. **L'unite s'appelle `chrony` sur Debian** (`chronyd` sur RHEL, et
 *    le tutoriel montre les deux). Cette image est une Debian ; les deux
 *    noms sont acceptes par le gestionnaire de services, parce qu'un
 *    lecteur qui suit la colonne RHEL du tutoriel ne doit pas tomber sur
 *    un `Unit could not be found` qui ne lui apprendrait rien.
 * 2. **Un fichier de configuration MANQUANT empeche le demarrage**
 *    (`Cannot open configuration file`), un fichier VIDE ne l'empeche
 *    pas : c'est la distinction que `CriticalFiles.ts` tient deja pour
 *    sshd, et elle est vraie de chronyd aussi.
 * 3. **`iburst` est la seule directive dont l'effet est visible ici** :
 *    elle demande une rafale au demarrage, donc une convergence
 *    immediate. Sans elle, la premiere mesure attend le premier
 *    intervalle de scrutation. C'est exactement ce que le tutoriel
 *    annonce (« envoyer 8 paquets au demarrage pour converger
 *    rapidement »), et c'est observable.
 */

import type { NtpAgent } from '../../../ntp/NtpAgent';
import { parseChronyConf, type ChronyConf, CHRONY_CONF_DEBIAN } from './ChronyConfig';
import { isValidIPv4 } from '../../../core/ip';

/** Le chemin Debian, celui que le tutoriel fait editer. */
export const CHRONY_CONF_PATH = '/etc/chrony/chrony.conf';
/** Le chemin RHEL, que le tutoriel cite aussi. */
export const CHRONY_CONF_PATH_RHEL = '/etc/chrony.conf';

export interface ChronyHost {
  /** Lire un fichier du VFS ; `null` quand il n'existe pas. */
  readFile(chemin: string): string | null;
  /** L'agent NTP de la machine — le seul moteur. */
  ntp(): NtpAgent;
}

export class LinuxChronyService {
  private actif = false;
  private conf: ChronyConf = parseChronyConf('');
  private demarreALe = 0;
  /** Le nombre de sauts d'horloge deja consommes sur le quota `makestep`. */
  private sautsFaits = 0;

  constructor(private readonly host: ChronyHost) {}

  isRunning(): boolean { return this.actif; }
  getConf(): ChronyConf { return this.conf; }
  getUptimeSec(): number {
    return this.actif ? Math.max(0, Math.floor((Date.now() - this.demarreALe) / 1000)) : 0;
  }

  /**
   * Le chemin reellement lu. chronyd ne cherche pas : c'est son unite
   * qui le lui passe (`-f`). Debian et RHEL n'ayant pas le meme, les
   * deux sont acceptes — le premier present gagne, et l'ordre est celui
   * de Debian puisque cette image en est une.
   */
  cheminConf(): string | null {
    for (const c of [CHRONY_CONF_PATH, CHRONY_CONF_PATH_RHEL]) {
      if (this.host.readFile(c) !== null) return c;
    }
    return null;
  }

  /**
   * Ce que `systemctl start chrony` execute.
   *
   * Un fichier absent est un echec de demarrage nomme, comme sur une
   * vraie machine ; un fichier vide demarre sur les valeurs par defaut,
   * ce qui est legal et sans source — donc sans synchronisation.
   */
  start(): { ok: true } | { ok: false; erreur: string } {
    const chemin = this.cheminConf();
    if (chemin === null) {
      return {
        ok: false,
        erreur: `Cannot open configuration file ${CHRONY_CONF_PATH}: No such file or directory`,
      };
    }
    this.conf = parseChronyConf(this.host.readFile(chemin) ?? '');
    this.appliquer();
    this.actif = true;
    this.demarreALe = Date.now();
    this.sautsFaits = 0;
    this.host.ntp().start();
    return { ok: true };
  }

  stop(): void {
    if (!this.actif) return;
    this.actif = false;
    const agent = this.host.ntp();
    agent.stop();
    // Un demon arrete ne laisse pas ses associations derriere lui : c'est
    // ce qui fait que `chronyc tracking` ne repond plus, et c'est le
    // sens de `systemctl stop chrony` dans un lab.
    for (const ip of [...agent.getConfig().associations.keys()]) agent.removeServer(ip);
    agent.setLocalStratum(16);
    agent.setServerMode(false);
  }

  /** `systemctl reload` / `chronyc reload sources` : relire le fichier. */
  reload(): { ok: true } | { ok: false; erreur: string } {
    if (!this.actif) return { ok: true };
    const chemin = this.cheminConf();
    if (chemin === null) {
      return { ok: false, erreur: `Cannot open configuration file ${CHRONY_CONF_PATH}` };
    }
    this.conf = parseChronyConf(this.host.readFile(chemin) ?? '');
    this.appliquer();
    return { ok: true };
  }

  /**
   * `chronyc makestep` : corriger l'horloge d'un coup au lieu de la
   * faire glisser. Le quota de `makestep <seuil> <limite>` est REEL —
   * un lab qui en demande un quatrieme apres `makestep 1 3` doit se le
   * voir refuser, sinon la directive ne veut rien dire.
   */
  makestep(): { ok: true } | { ok: false; erreur: string } {
    if (!this.actif) return { ok: false, erreur: '506 Cannot talk to daemon' };
    const m = this.conf.makestep;
    if (m && m.limite >= 0 && this.sautsFaits >= m.limite) {
      return { ok: false, erreur: '505 No such source' };
    }
    this.sautsFaits++;
    // La commande FORCE le saut : sans cela elle ne faisait que compter,
    // et l'ecart restait celui d'avant.
    this.host.ntp().forcerSaut();
    return { ok: true };
  }

  /**
   * Traduit le fichier en associations sur l'agent.
   *
   * Une source est ecartee lorsque son nom n'est pas une adresse : ce
   * simulateur n'a pas de resolveur cote demon, et un `pool
   * 2.debian.pool.ntp.org` ne peut donc PAS etre interroge. Il reste
   * declare dans la configuration — c'est ce que le fichier de Debian
   * contient a l'installation — et `chronyc sources` le montre absent
   * plutot que d'inventer une adresse.
   */
  private appliquer(): void {
    const agent = this.host.ntp();
    const voulues = new Set<string>();
    for (const s of this.conf.sources) {
      if (!isValidIPv4(s.hote)) continue;
      voulues.add(s.hote);
      if (s.genre === 'peer') agent.addPeer(s.hote, s.prefer, s.keyId);
      else agent.addServer(s.hote, s.prefer, s.keyId);
    }
    // Ce que le fichier ne declare plus doit disparaitre : sans cela un
    // `reload` ne serait qu'un ajout, et retirer une ligne du fichier
    // n'aurait aucun effet.
    for (const ip of [...agent.getConfig().associations.keys()]) {
      if (!voulues.has(ip)) agent.removeServer(ip);
    }
    // `makestep <seuil> <limite>` est un reglage de la DISCIPLINE, pas
    // une commande : il decide a quel ecart chronyd saute au lieu de
    // glisser, et combien de fois. Il etait lu et range sans jamais
    // atteindre le moteur (lot N9).
    agent.setReglagesDiscipline(this.conf.makestep
      ? { seuilSautMs: this.conf.makestep.seuilSec * 1000, limiteSauts: this.conf.makestep.limite }
      : {});
    if (this.conf.localStratum !== null) {
      agent.setServerMode(true);
      agent.setLocalStratum(this.conf.localStratum);
    }
    agent.setEnabled(true);
    // `iburst` demande une rafale immediate : la convergence ne doit pas
    // attendre le premier intervalle de scrutation. C'est le seul effet
    // observable de la directive, et le tutoriel l'annonce.
    if (this.conf.sources.some((s) => s.iburst)) agent.pollAll();
  }

  /** Le texte que le paquet Debian depose a l'installation. */
  static confParDefaut(): string { return CHRONY_CONF_DEBIAN; }
}
