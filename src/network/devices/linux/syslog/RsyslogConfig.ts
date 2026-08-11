/**
 * Lire `/etc/rsyslog.conf` — les deux choses que le fichier decide.
 *
 * 1. **Ce que le demon ECOUTE** : `module(load="imudp")` +
 *    `input(type="imudp" port="514")`. Les deux lignes comptent, et
 *    c'est le point que le tutoriel fait decommenter : un rsyslog
 *    fraichement installe n'ecoute pas, donc les datagrammes d'un
 *    routeur arrivent sur une machine ou rien ne les attend.
 * 2. **Ou va chaque message** : les regles `<selecteur> <cible>`, ou le
 *    selecteur est une liste `facility.severite` et la cible un fichier
 *    ou un serveur distant.
 *
 * Ce qui est lu est ce qui a un effet, et rien de plus. Les directives
 * de permissions (`$FileOwner`, `$Umask`), les gabarits et les modules
 * de sortie exotiques sont ignores sans erreur : les inventorier
 * donnerait l'illusion qu'ils gouvernent quelque chose.
 */

export type SelecteurFacilite = string; // 'local7', '*', 'auth', ...
export type SelecteurSeverite = string; // 'info', '*', 'none', ...

export interface RegleRsyslog {
  /** Les couples facilite/severite que la regle retient. */
  readonly selecteurs: ReadonlyArray<{ facilite: SelecteurFacilite; severite: SelecteurSeverite }>;
  /** Fichier destinataire, ou null si la cible n'est pas un fichier. */
  readonly fichier: string | null;
  /** `@host` (UDP) ou `@@host` (TCP) — le renvoi vers un autre collecteur. */
  readonly renvoi: { hote: string; port: number; tcp: boolean } | null;
  /** La ligne telle qu'ecrite, pour les diagnostics. */
  readonly source: string;
}

export interface EcouteRsyslog {
  readonly protocole: 'udp' | 'tcp';
  readonly port: number;
}

export interface ConfigRsyslog {
  readonly ecoutes: readonly EcouteRsyslog[];
  readonly regles: readonly RegleRsyslog[];
  /** Les `$IncludeConfig` rencontres, dans l'ordre. */
  readonly inclusions: readonly string[];
}

const SEVERITES: Record<string, number> = {
  emerg: 0, panic: 0, alert: 1, crit: 2, err: 3, error: 3,
  warning: 4, warn: 4, notice: 5, info: 6, debug: 7,
};

/**
 * Le numero d'une severite nommee. `*` vaut « toutes » et `none`
 * « aucune » — deux mots-cles qui ne sont pas des niveaux et qui
 * decident du contraire l'un de l'autre.
 */
export function numeroSeverite(nom: string): number | null {
  return SEVERITES[nom.toLowerCase()] ?? null;
}

/** Un chemin absolu, une fois retire le `-` qui demande l'ecriture differee. */
function cibleFichier(mot: string): string | null {
  const m = mot.startsWith('-') ? mot.slice(1) : mot;
  return m.startsWith('/') ? m : null;
}

function cibleRenvoi(mot: string): RegleRsyslog['renvoi'] {
  const m = /^(@@?)([^:]+)(?::(\d+))?$/.exec(mot);
  if (!m) return null;
  return { hote: m[2], port: m[3] ? Number.parseInt(m[3], 10) : 514, tcp: m[1] === '@@' };
}

/**
 * Analyser un texte de configuration. Les inclusions ne sont PAS suivies
 * ici — l'appelant seul connait le systeme de fichiers, et un analyseur
 * qui lirait le disque ne serait pas testable sans en monter un.
 */
export function analyserRsyslog(texte: string): ConfigRsyslog {
  const ecoutes: EcouteRsyslog[] = [];
  const regles: RegleRsyslog[] = [];
  const inclusions: string[] = [];
  const modules = new Set<string>();

  for (const brute of texte.split('\n')) {
    const ligne = brute.trim();
    if (ligne === '' || ligne.startsWith('#')) continue;

    const mod = /^module\s*\(\s*load\s*=\s*"([^"]+)"/.exec(ligne);
    if (mod) { modules.add(mod[1]); continue; }

    const inc = /^\$IncludeConfig\s+(\S+)/.exec(ligne);
    if (inc) { inclusions.push(inc[1]); continue; }

    const input = /^input\s*\(\s*type\s*=\s*"(imudp|imtcp)"([^)]*)\)/.exec(ligne);
    if (input) {
      // Le module doit avoir ete CHARGE : `input(...)` seul ne fait rien
      // sur un vrai rsyslog, et l'accepter ferait ecouter une machine
      // dont la configuration ne le demande pas.
      if (!modules.has(input[1])) continue;
      const p = /port\s*=\s*"?(\d+)"?/.exec(input[2]);
      ecoutes.push({
        protocole: input[1] === 'imudp' ? 'udp' : 'tcp',
        port: p ? Number.parseInt(p[1], 10) : 514,
      });
      continue;
    }

    // Forme historique, encore tres repandue dans les supports :
    // `$ModLoad imudp` / `$UDPServerRun 514`.
    const modLoad = /^\$ModLoad\s+(\S+)/.exec(ligne);
    if (modLoad) { modules.add(modLoad[1]); continue; }
    const udpRun = /^\$UDPServerRun\s+(\d+)/.exec(ligne);
    if (udpRun && modules.has('imudp')) {
      ecoutes.push({ protocole: 'udp', port: Number.parseInt(udpRun[1], 10) });
      continue;
    }
    const tcpRun = /^\$InputTCPServerRun\s+(\d+)/.exec(ligne);
    if (tcpRun && modules.has('imtcp')) {
      ecoutes.push({ protocole: 'tcp', port: Number.parseInt(tcpRun[1], 10) });
      continue;
    }

    if (ligne.startsWith('$') || ligne.startsWith('template') || ligne.startsWith('action')) continue;

    // Une regle : `<selecteur>[;<selecteur>...]   <cible>`
    const parts = ligne.split(/\s+/);
    if (parts.length < 2) continue;
    const selecteurs = parts[0].split(';').map((s) => {
      const [f, sev] = s.split('.');
      return { facilite: (f ?? '*').toLowerCase(), severite: (sev ?? '*').toLowerCase() };
    });
    if (!selecteurs.every((s) => s.facilite.length > 0)) continue;
    const cible = parts.slice(1).join(' ').trim();
    regles.push({
      selecteurs,
      fichier: cibleFichier(cible),
      renvoi: cibleRenvoi(cible),
      source: ligne,
    });
  }
  return { ecoutes, regles, inclusions };
}

/**
 * La regle retient-elle ce message ?
 *
 * Deux points ou une lecture naive se trompe, et les deux comptent :
 *
 * - **`.info` veut dire « info ET PLUS GRAVE »**, pas « exactement
 *   info ». Les severites vont a l'envers de l'intuition (0 = le plus
 *   grave), donc le test est `severite <= seuil`.
 * - **`.none` EXCLUT**, et c'est ce qui fait fonctionner la ligne
 *   `*.*;auth,authpriv.none` de Debian : tout, sauf l'authentification.
 *   Sans elle, `/var/log/syslog` doublerait `/var/log/auth.log` et un
 *   mot de passe refuse apparaitrait dans deux fichiers.
 */
export function regleRetient(r: RegleRsyslog, facilite: string, severite: number): boolean {
  let retenu = false;
  for (const s of r.selecteurs) {
    const facilites = s.facilite.split(',').map((f) => f.trim());
    const concerne = facilites.includes('*') || facilites.includes(facilite);
    if (!concerne) continue;
    if (s.severite === 'none') return false;
    if (s.severite === '*') { retenu = true; continue; }
    const seuil = numeroSeverite(s.severite.replace(/^[=!]/, ''));
    if (seuil === null) continue;
    // `=info` veut dire EXACTEMENT info — la forme explicite de rsyslog
    // pour la seule severite nommee.
    if (s.severite.startsWith('=')) { if (severite === seuil) retenu = true; continue; }
    if (severite <= seuil) retenu = true;
  }
  return retenu;
}
