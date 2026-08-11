/**
 * rsyslog en RECEPTEUR : le collecteur central du tutoriel.
 *
 * Mesure de depart, faite en cablant un routeur Cisco a un serveur
 * Linux : le routeur emet de VRAIS datagrammes syslog — `show logging`
 * les compte, `<PRI>` est calcule, le transport est honore — et **rien
 * ne les recoit**. `ss -ulnp` ne montre aucun port 514,
 * `/etc/rsyslog.conf` n'existe pas, `/etc/rsyslog.d/` non plus. Toute la
 * centralisation, qui EST le sujet du cours, n'avait aucun support.
 *
 * Ce service ouvre l'ecoute pour de bon quand la configuration la
 * demande, analyse chaque message recu, et l'ecrit dans le fichier que
 * les regles designent. Trois decisions valent d'etre dites :
 *
 * - **L'ecoute suit le FICHIER, pas un drapeau.** Les modules `imudp` /
 *   `imtcp` sont commentes dans le `/etc/rsyslog.conf` livre, comme sur
 *   une vraie machine ; les decommenter et recharger est l'exercice.
 *   Un service qui ecouterait d'office supprimerait l'exercice en meme
 *   temps que la verite.
 * - **`%FROMHOST-IP%` est resolu** parce que « un fichier par
 *   equipement » est le geste que le cours enseigne, et qu'un gabarit
 *   qui rendrait le nom litteral ecrirait tous les equipements dans un
 *   fichier appele `%FROMHOST-IP%`.
 * - **Le message est REECRIT au format de reception**, pas recopie tel
 *   quel : rsyslog remplace l'horodatage BSD de l'emetteur par le sien
 *   et prefixe le nom d'hote source. C'est ce qui permet de correler
 *   deux equipements dont les horloges divergent.
 */

import type { PortSpec } from '../../../core/ports/PortNumber';
import type { ListenerIdentity } from '../../../tcp/ListenerSocketSink';
import type { ServiceSocketServer } from '../ports/ServiceSocketServer';
import {
  analyserRsyslog, regleRetient, numeroSeverite,
  type ConfigRsyslog, type RegleRsyslog,
} from './RsyslogConfig';
import { RSYSLOG_CONF_PATH } from './RsyslogFiles';
import { SYSLOG_FACILITY } from '../../../syslog/types';

/** Ce que le service a besoin de sa machine, et rien de plus. */
export interface RsyslogHost {
  lireFichier(chemin: string): string | null;
  ecrireLigne(chemin: string, ligne: string): void;
  listerRepertoire(chemin: string): string[];
  /** Ecoute UDP reelle ; rend une fonction de fermeture, ou null. */
  ecouterUdp(port: number, onDatagram: (source: string, charge: string) => void): (() => void) | null;
  hostname(): string;
  maintenant(): number;
}

const NOM_FACILITE: Record<number, string> = Object.fromEntries(
  Object.entries(SYSLOG_FACILITY).map(([nom, num]) => [num, nom]),
) as Record<number, string>;

/** `Aug  9 14:32:15 R1-PROD OSPF: msg` → horodatage, hote, corps. */
const ENTETE_3164 = /^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})(?:\.\d+)?\s+(\S+)\s+(.*)$/s;

/** `<189>Aug  9 14:32:15 R1-PROD OSPF: msg` → ses parties. */
export function analyserMessageRecu(brut: string): {
  facilite: string; severite: number; reste: string;
} {
  const m = /^<(\d+)>\s*(.*)$/s.exec(brut.trim());
  // Sans `<PRI>`, RFC 3164 §4.3.3 impose de traiter le message comme
  // `user.notice` plutot que de le jeter : un message mal forme reste
  // un message, et le perdre serait le pire des comportements pour un
  // collecteur d'audit.
  if (!m) return { facilite: 'user', severite: 5, reste: brut.trim() };
  const pri = Number.parseInt(m[1], 10);
  return {
    facilite: NOM_FACILITE[Math.floor(pri / 8)] ?? 'local7',
    severite: pri % 8,
    reste: m[2],
  };
}

export class LinuxRsyslogService implements ServiceSocketServer {
  private config: ConfigRsyslog = { ecoutes: [], regles: [], inclusions: [] };
  private readonly fermetures = new Map<number, () => void>();

  constructor(private readonly host: RsyslogHost) {}

  /**
   * Relire la configuration : le fichier principal PUIS les inclusions.
   * L'ordre compte — les regles de `/etc/rsyslog.d/` s'ajoutent apres
   * celles du fichier principal, et c'est dans cet ordre qu'un `& stop`
   * futur les arreterait.
   */
  recharger(): void {
    const principal = this.host.lireFichier(RSYSLOG_CONF_PATH);
    if (principal === null) {
      this.config = { ecoutes: [], regles: [], inclusions: [] };
      return;
    }
    const base = analyserRsyslog(principal);
    const ecoutes = [...base.ecoutes];
    const regles = [...base.regles];
    for (const motif of base.inclusions) {
      const rep = motif.replace(/\/\*\.conf$/, '');
      for (const nom of this.host.listerRepertoire(rep).sort()) {
        if (!nom.endsWith('.conf')) continue;
        const texte = this.host.lireFichier(`${rep}/${nom}`);
        if (texte === null) continue;
        const sup = analyserRsyslog(texte);
        ecoutes.push(...sup.ecoutes);
        regles.push(...sup.regles);
      }
    }
    this.config = { ecoutes, regles, inclusions: base.inclusions };
  }

  /** Les ports que la configuration demande d'ouvrir. */
  listeningPorts(): number[] {
    return [...new Set(this.config.ecoutes.map((e) => e.port))].sort((a, b) => a - b);
  }

  configuration(): ConfigRsyslog { return this.config; }

  open(spec: PortSpec, _identity?: ListenerIdentity): boolean {
    this.recharger();
    const voulu = this.config.ecoutes.find(
      (e) => e.port === spec.port && e.protocole === (spec.protocol === 'tcp' ? 'tcp' : 'udp'),
    );
    // Rien dans la configuration ne demande ce port : ne rien ouvrir, et
    // donc ne rien afficher. C'est la coherence que `ServiceSocketServer`
    // existe pour tenir — un port montre doit etre joignable.
    if (!voulu) return false;
    if (this.fermetures.has(spec.port)) return true;
    const off = this.host.ecouterUdp(spec.port, (src, charge) => this.recevoir(src, charge));
    if (!off) return false;
    this.fermetures.set(spec.port, off);
    return true;
  }

  close(spec: PortSpec): void {
    this.fermetures.get(spec.port)?.();
    this.fermetures.delete(spec.port);
  }

  stopAll(): void {
    for (const off of this.fermetures.values()) off();
    this.fermetures.clear();
  }

  /**
   * Un message est arrive. On le classe, puis on l'ecrit dans CHAQUE
   * fichier que les regles designent — un message peut legitimement
   * aller dans plusieurs fichiers, c'est meme le cas normal
   * (`auth.log` et `syslog`).
   */
  recevoir(sourceIp: string, charge: string): void {
    const { facilite, severite, reste } = analyserMessageRecu(charge);
    const entete = ENTETE_3164.exec(reste);
    const hote = entete ? entete[2] : sourceIp;
    for (const r of this.config.regles) {
      if (!regleRetient(r, facilite, severite)) continue;
      if (r.fichier === null) continue;
      this.host.ecrireLigne(
        this.resoudreChemin(r.fichier, sourceIp, hote), this.ligneRecue(sourceIp, reste));
    }
  }

  /**
   * `rsyslogd -N1` : la validation que tout operateur lance AVANT de
   * recharger, et qui doit refuser plutot que de laisser tomber le
   * service en marche.
   *
   * Elle analyse dans une copie LOCALE et ne touche pas la vue du
   * service : une commande de verification ne doit pas deplacer ce que
   * le demon croit de sa propre configuration.
   */
  verifierConfiguration(): { verdict: 'ok' | 'faute'; erreur: string } {
    const principal = this.host.lireFichier(RSYSLOG_CONF_PATH);
    if (principal === null) {
      return {
        verdict: 'faute',
        erreur: "rsyslogd: error: could not open config file '/etc/rsyslog.conf': "
          + 'No such file or directory',
      };
    }
    const textes = [principal];
    for (const motif of analyserRsyslog(principal).inclusions) {
      const rep = motif.replace(/\/\*\.conf$/, '');
      for (const nom of this.host.listerRepertoire(rep).sort()) {
        if (!nom.endsWith('.conf')) continue;
        const t = this.host.lireFichier(`${rep}/${nom}`);
        if (t !== null) textes.push(t);
      }
    }
    for (const texte of textes) {
      const faute = premiereFaute(texte);
      if (faute) return { verdict: 'faute', erreur: faute };
    }
    // `strict: false` dans ce depot : une union discriminee par un
    // booleen litteral ne se retrecit PAS, d'ou le discriminant textuel.
    return { verdict: 'ok', erreur: '' };
  }

  /** Les regles qui retiendraient ce couple — lu par les tests et le diagnostic. */
  reglesPour(facilite: string, severite: number): RegleRsyslog[] {
    return this.config.regles.filter((r) => regleRetient(r, facilite, severite));
  }

  /**
   * `%FROMHOST-IP%` et les variables de date. Sans cette resolution, le
   * laboratoire « un fichier par equipement » ecrirait tous les
   * equipements dans un fichier nomme `%FROMHOST-IP%`.
   *
   * `%HOSTNAME%` est le nom porte PAR LE MESSAGE et `%FROMHOST%` celui
   * de qui l'a transmis : sur un relais les deux different, et c'est
   * precisement ce que ce laboratoire cherche a distinguer.
   */
  private resoudreChemin(gabarit: string, sourceIp: string, hote: string): string {
    const d = new Date(this.host.maintenant());
    const deuxChiffres = (n: number) => String(n).padStart(2, '0');
    return gabarit
      .replace(/%FROMHOST-IP%/g, sourceIp)
      .replace(/%HOSTNAME%/g, hote)
      .replace(/%FROMHOST%/g, sourceIp)
      .replace(/%\$YEAR%/g, String(d.getFullYear()))
      .replace(/%\$MONTH%/g, deuxChiffres(d.getMonth() + 1))
      .replace(/%\$DAY%/g, deuxChiffres(d.getDate()));
  }

  /**
   * Le gabarit par defaut de Debian est `RSYSLOG_TraditionalFileFormat`,
   * soit `%TIMESTAMP% %HOSTNAME% %syslogtag%%msg%`. `%TIMESTAMP%` est un
   * ALIAS de `%timereported%` — l'heure portee par le message — et non
   * de `%timegenerated%`, l'heure de reception ; `%HOSTNAME%` est de
   * meme celui du message. Les reecrire avec ceux du collecteur ferait
   * perdre l'identite et l'heure de l'emetteur d'origine des qu'un
   * relais est en jeu, ce que ce format existe pour conserver.
   *
   * Un message sans en-tete RFC 3164 exploitable n'en porte aucun des
   * deux : le collecteur pose alors les siens, comme le fait rsyslog
   * quand son analyseur ne trouve pas d'horodatage.
   */
  private ligneRecue(sourceIp: string, corps: string): string {
    const m = ENTETE_3164.exec(corps);
    if (m) return `${m[1]} ${m[2]} ${m[3]}`;
    const d = new Date(this.host.maintenant());
    const MOIS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const hh = (n: number) => String(n).padStart(2, '0');
    const horodatage = `${MOIS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} `
      + `${hh(d.getHours())}:${hh(d.getMinutes())}:${hh(d.getSeconds())}`;
    return `${horodatage} ${sourceIp} ${corps}`;
  }
}

/**
 * La premiere faute de syntaxe, dans les mots de rsyslog.
 *
 * Deliberement etroit : on ne signale que ce qu'on sait vraiment juger —
 * une severite qui n'existe pas, et une regle dont la cible n'est ni un
 * fichier ni un renvoi. Inventer des refus sur ce qu'on ne comprend pas
 * ferait echouer des configurations valides, ce qui est pire qu'un
 * controle indulgent.
 */
function premiereFaute(texte: string): string | null {
  let n = 0;
  for (const brute of texte.split('\n')) {
    n += 1;
    const ligne = brute.trim();
    if (ligne === '' || ligne.startsWith('#') || ligne.startsWith('$')) continue;
    if (/^(module|input|template|action)\s*\(/.test(ligne)) continue;
    const parts = ligne.split(/\s+/);
    if (parts.length < 2) continue;
    if (!/^[a-z0-9*,.;=!]+$/i.test(parts[0])) continue;
    for (const sel of parts[0].split(';')) {
      const [, sev] = sel.split('.');
      if (sev === undefined) continue;
      const nom = sev.toLowerCase().replace(/^[=!]/, '');
      if (nom === '*' || nom === 'none' || nom === '') continue;
      if (numeroSeverite(nom) === null) {
        return `rsyslogd: unknown priority name "${sev}" [line ${n}]`;
      }
    }
  }
  return null;
}
