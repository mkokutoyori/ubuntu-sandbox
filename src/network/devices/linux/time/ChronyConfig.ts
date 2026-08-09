/**
 * PRD-NTP-Tutoriel.md §4 / lot N3 — `/etc/chrony/chrony.conf`, lu.
 *
 * Le paquet `chrony` etait declare installe par `dpkg`/`apt-get` et
 * **rien n'existait** : ni `/etc/chrony/chrony.conf`, ni `chronyc`, ni
 * le demon, ni son unite. Une machine annoncait un logiciel qu'elle
 * n'avait pas — la meme forme de defaut que ce depot a deja fermee pour
 * `openssl` (declare installe, binaire absent).
 *
 * Ce fichier est l'analyseur du fichier de configuration, et il est
 * LOAD-BEARING plutot que decoratif : c'est lui qui dit au demon quels
 * serveurs interroger, lesquels preferer, et a quel ecart il a le droit
 * de sauter l'horloge plutot que de la faire glisser. Sans lui,
 * `chronyc sources` n'aurait rien a montrer.
 *
 * ── Ce qui est lu, et ce qui est accepte sans agir ──────────────────
 *
 * Sont LUES et agissantes : `server`, `pool`, `peer` (avec `iburst`,
 * `prefer`, `key`), `makestep`, `allow`/`deny`, `driftfile`, `logdir`,
 * `log`, `local stratum`, `keyfile`, `rtcsync`, `maxdistance`.
 *
 * Est ACCEPTE sans agir, et la liste est explicite plutot que muette :
 * `refclock` (aucun materiel n'existe ici), `hwtimestamp`, `leapsectz`,
 * `initstepslew`. Une directive inconnue est SIGNALEE a la lecture,
 * comme le vrai chronyd, au lieu d'etre ignoree en silence.
 */

export interface ChronySource {
  /** `server`, `pool` ou `peer` — le mot-cle qui l'a declaree. */
  readonly genre: 'server' | 'pool' | 'peer';
  readonly hote: string;
  readonly iburst: boolean;
  readonly prefer: boolean;
  readonly keyId?: number;
  /** `maxsources` pour un `pool` ; sans objet ailleurs. */
  readonly maxsources?: number;
}

export interface ChronyMakestep {
  /** L'ecart, en secondes, au-dela duquel chronyd saute au lieu de glisser. */
  readonly seuilSec: number;
  /** Le nombre de mises a jour concernees ; -1 signifie « toujours ». */
  readonly limite: number;
}

export interface ChronyConf {
  readonly sources: readonly ChronySource[];
  readonly makestep: ChronyMakestep | null;
  /** Les reseaux autorises a interroger CETTE machine comme serveur. */
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly driftfile: string;
  readonly logdir: string;
  readonly logs: readonly string[];
  readonly keyfile: string;
  readonly rtcsync: boolean;
  /** `local stratum N` : servir le temps meme sans source, comme `ntp master`. */
  readonly localStratum: number | null;
  readonly maxdistanceSec: number | null;
  /** Les lignes que chronyd connait mais que ce simulateur n'applique pas. */
  readonly acceptesSansEffet: readonly string[];
  /** Les lignes qu'aucun chronyd ne connait : elles sont signalees. */
  readonly inconnues: readonly { ligne: number; texte: string }[];
}

/** Ce que chronyd connait et que ce simulateur n'applique pas. */
const CONNUES_SANS_EFFET = new Set([
  'refclock', 'hwtimestamp', 'leapsectz', 'initstepslew', 'ratelimit',
  'cmdratelimit', 'ntsdumpdir', 'ntstrustedcerts', 'minsources', 'lock_all',
  'sched_priority', 'user', 'pidfile', 'bindcmdaddress', 'cmdport',
  'noclientlog', 'clientloglimit', 'dumpdir', 'stratumweight', 'corrtimeratio',
  'maxupdateskew', 'maxchange', 'maxdrift', 'rtcfile', 'hwclockfile', 'leapsecmode',
]);

const CONF_VIDE: ChronyConf = {
  sources: [], makestep: null, allow: [], deny: [],
  driftfile: '', logdir: '', logs: [], keyfile: '',
  rtcsync: false, localStratum: null, maxdistanceSec: null,
  acceptesSansEffet: [], inconnues: [],
};

function entier(mot: string | undefined): number | null {
  return mot !== undefined && /^-?\d+$/.test(mot) ? parseInt(mot, 10) : null;
}

/** Analyse le texte d'un `chrony.conf`. Un fichier vide est legal. */
export function parseChronyConf(texte: string): ChronyConf {
  const sources: ChronySource[] = [];
  const allow: string[] = [];
  const deny: string[] = [];
  const logs: string[] = [];
  const acceptesSansEffet: string[] = [];
  const inconnues: { ligne: number; texte: string }[] = [];
  let makestep: ChronyMakestep | null = null;
  let driftfile = '';
  let logdir = '';
  let keyfile = '';
  let rtcsync = false;
  let localStratum: number | null = null;
  let maxdistanceSec: number | null = null;

  const lignes = texte.split('\n');
  for (let i = 0; i < lignes.length; i++) {
    // Le `#` et le `!` ouvrent tous deux un commentaire chez chronyd.
    const nue = lignes[i].replace(/[#!].*$/, '').trim();
    if (!nue) continue;
    const mots = nue.split(/\s+/);
    const cle = mots[0].toLowerCase();
    const args = mots.slice(1);
    switch (cle) {
      case 'server':
      case 'pool':
      case 'peer': {
        if (!args[0]) { inconnues.push({ ligne: i + 1, texte: nue }); break; }
        const iKey = args.findIndex((m) => m.toLowerCase() === 'key');
        const iMax = args.findIndex((m) => m.toLowerCase() === 'maxsources');
        sources.push({
          genre: cle as ChronySource['genre'],
          hote: args[0],
          iburst: args.some((m) => m.toLowerCase() === 'iburst'),
          prefer: args.some((m) => m.toLowerCase() === 'prefer'),
          keyId: iKey >= 0 ? entier(args[iKey + 1]) ?? undefined : undefined,
          maxsources: iMax >= 0 ? entier(args[iMax + 1]) ?? undefined : undefined,
        });
        break;
      }
      case 'makestep': {
        const seuil = parseFloat(args[0] ?? '');
        const limite = entier(args[1]);
        if (!isNaN(seuil) && limite !== null) makestep = { seuilSec: seuil, limite };
        else inconnues.push({ ligne: i + 1, texte: nue });
        break;
      }
      // `allow` sans argument autorise TOUT le monde, ce qui est une
      // vraie forme de chronyd et un vrai risque : elle est distinguee.
      case 'allow': allow.push(args[0] ?? 'all'); break;
      case 'deny': deny.push(args[0] ?? 'all'); break;
      case 'driftfile': driftfile = args[0] ?? ''; break;
      case 'logdir': logdir = args[0] ?? ''; break;
      case 'log': logs.push(...args.map((m) => m.toLowerCase())); break;
      case 'keyfile': keyfile = args[0] ?? ''; break;
      case 'rtcsync': rtcsync = true; break;
      case 'local': {
        const iStr = args.findIndex((m) => m.toLowerCase() === 'stratum');
        const s = iStr >= 0 ? entier(args[iStr + 1]) : null;
        localStratum = s !== null && s >= 1 && s <= 15 ? s : 10;
        break;
      }
      case 'maxdistance': {
        const d = parseFloat(args[0] ?? '');
        if (!isNaN(d)) maxdistanceSec = d;
        break;
      }
      default:
        if (CONNUES_SANS_EFFET.has(cle)) acceptesSansEffet.push(nue);
        else inconnues.push({ ligne: i + 1, texte: nue });
    }
  }
  return {
    ...CONF_VIDE, sources, makestep, allow, deny,
    driftfile, logdir, logs, keyfile, rtcsync, localStratum, maxdistanceSec,
    acceptesSansEffet, inconnues,
  };
}

/** Le `chrony.conf` que Debian installe avec le paquet. */
export const CHRONY_CONF_DEBIAN = `# Welcome to the chrony configuration file. See chrony.conf(5) for more
# information about usable directives.

# Use Debian vendor zone.
pool 2.debian.pool.ntp.org iburst

# This directive specify the location of the file containing ID/key pairs for
# NTP authentication.
keyfile /etc/chrony/chrony.keys

# This directive specify the file into which chronyd will store the rate
# information.
driftfile /var/lib/chrony/chrony.drift

# Uncomment the following line to turn logging on.
#log tracking measurements statistics

# Log files location.
logdir /var/log/chrony

# Stop bad estimates upsetting machine clock.
maxupdateskew 100.0

# This directive enables kernel synchronisation (every 11 minutes) of the
# real-time clock. Note that it can't be used along with the 'rtcfile'
# directive.
rtcsync

# Step the system clock instead of slewing it if the adjustment is larger than
# one second, but only in the first three clock updates.
makestep 1 3
`;
