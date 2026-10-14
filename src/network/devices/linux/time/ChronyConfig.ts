import type { SelectionParameters } from '../../../ntp/ChronySelection';
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

import { parseChronySubnet, type ChronySubnet } from './ChronyAccess';

export interface ChronySource {
  /** `server`, `pool` ou `peer` — le mot-cle qui l'a declaree. */
  readonly genre: 'server' | 'pool' | 'peer';
  readonly hote: string;
  readonly iburst: boolean;
  readonly prefer: boolean;
  readonly keyId?: number;
  /** `maxsources` pour un `pool` ; sans objet ailleurs. */
  readonly maxsources?: number;
  readonly minpoll?: number;
  readonly maxpoll?: number;
  readonly offline: boolean;
  readonly noselect: boolean;
  readonly trust: boolean;
  readonly require: boolean;
  readonly maxdelay?: number;
  readonly maxdelayratio?: number;
  readonly maxdelaydevratio?: number;
  readonly minstratum?: number;
  readonly polltarget?: number;
  readonly burst: boolean;
  readonly version?: number;
  readonly minsamples?: number;
  readonly maxsamples?: number;
  readonly mindelay?: number;
  readonly offsetCorrection?: number;
  readonly port?: number;
  readonly presend?: number;
  readonly autoOffline: boolean;
  readonly copy: boolean;
  readonly maxdelayquant?: number;
  readonly filter?: number;
  readonly asymmetry?: number;
  readonly nts: boolean;
  readonly ntsPort: number;
  readonly certSet: number;
  readonly unevaluated: readonly string[];
}

const VALUE_OPTIONS: Readonly<Record<string, 'integer' | 'number' | 'hex'>> = {
  certset: 'integer', key: 'integer', asymmetry: 'number', extfield: 'hex', filter: 'integer',
  maxdelay: 'number', maxdelayratio: 'number', maxdelaydevratio: 'number', maxdelayquant: 'number',
  maxpoll: 'integer', maxsamples: 'integer', maxsources: 'integer', mindelay: 'number',
  minpoll: 'integer', minsamples: 'integer', minstratum: 'integer', ntsport: 'integer',
  offset: 'number', port: 'integer', polltarget: 'integer', presend: 'integer', version: 'integer',
};

const FLAG_OPTIONS = new Set([
  'auto_offline', 'burst', 'copy', 'iburst', 'offline', 'nts', 'xleave',
  'prefer', 'noselect', 'trust', 'require',
]);

const UNEVALUATED_OPTIONS = new Set(['extfield', 'xleave']);

export function parseChronySource(genre: ChronySource['genre'], args: readonly string[]): ChronySource | null {
  if (!args[0]) return null;
  const flags = new Set<string>();
  const values = new Map<string, number>();
  const unevaluated: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const option = args[i].toLowerCase();
    const kind = VALUE_OPTIONS[option];
    if (kind !== undefined) {
      const text = args[i + 1];
      const pattern = kind === 'integer' ? /^[+-]?\d+$/ : kind === 'hex' ? /^[0-9a-f]+$/i : /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
      if (text === undefined || !pattern.test(text)) return null;
      values.set(option, kind === 'hex' ? parseInt(text, 16) : Number(text));
      i++;
    } else if (FLAG_OPTIONS.has(option)) {
      flags.add(option);
    } else {
      return null;
    }
    if (UNEVALUATED_OPTIONS.has(option)) unevaluated.push(option);
  }
  const key = values.get('key');
  if (key === 0xffffffff) return null;
  return {
    genre,
    hote: args[0],
    iburst: flags.has('iburst'),
    prefer: flags.has('prefer'),
    keyId: key,
    maxsources: values.get('maxsources'),
    minpoll: values.get('minpoll'),
    maxpoll: values.get('maxpoll'),
    offline: flags.has('offline'),
    noselect: flags.has('noselect'),
    trust: flags.has('trust'),
    require: flags.has('require'),
    maxdelay: values.get('maxdelay'),
    maxdelayratio: values.get('maxdelayratio'),
    maxdelaydevratio: values.get('maxdelaydevratio'),
    minstratum: values.get('minstratum'),
    polltarget: values.get('polltarget'),
    burst: flags.has('burst'),
    version: values.get('version'),
    minsamples: values.get('minsamples'),
    maxsamples: values.get('maxsamples'),
    mindelay: values.get('mindelay'),
    offsetCorrection: values.get('offset'),
    port: values.get('port'),
    presend: values.get('presend'),
    autoOffline: flags.has('auto_offline'),
    copy: flags.has('copy'),
    maxdelayquant: values.get('maxdelayquant'),
    filter: values.get('filter'),
    asymmetry: values.get('asymmetry'),
    nts: flags.has('nts'),
    ntsPort: values.get('ntsport') ?? 4460,
    certSet: values.get('certset') ?? 0,
    unevaluated,
  };
}

export interface ChronyAccessDirective {
  readonly kind: 'allow' | 'deny' | 'cmdallow' | 'cmddeny';
  readonly subnet: ChronySubnet;
  readonly includingChildren: boolean;
}

export interface ChronyRateLimit {
  readonly interval: number;
  readonly burst: number;
  readonly leak: number;
}

export interface ChronyMakestep {
  /** L'ecart, en secondes, au-dela duquel chronyd saute au lieu de glisser. */
  readonly seuilSec: number;
  /** Le nombre de mises a jour concernees ; -1 signifie « toujours ». */
  readonly limite: number;
}

export interface ChronyNtsConf {
  readonly serverCerts: readonly string[];
  readonly serverKeys: readonly string[];
  readonly port: number;
  readonly processes: number;
  readonly maxConnections: number;
  readonly dumpDir: string;
  readonly ntpServer: string | null;
  readonly rotateSeconds: number;
  readonly refreshSeconds: number;
  readonly trustedCerts: readonly { readonly set: number; readonly path: string }[];
  readonly systemCerts: boolean;
}

export interface ChronyConf {
  readonly sources: readonly ChronySource[];
  readonly makestep: ChronyMakestep | null;
  readonly access: readonly ChronyAccessDirective[];
  readonly ratelimit: ChronyRateLimit | null;
  readonly driftfile: string;
  readonly logdir: string;
  readonly logs: readonly string[];
  readonly keyfile: string;
  readonly rtcsync: boolean;
  readonly manual: boolean;
  /** `local stratum N` : servir le temps meme sans source, comme `ntp master`. */
  readonly localStratum: number | null;
  readonly maxdistanceSec: number | null;
  readonly ntpPort: number;
  readonly commandPort: number;
  readonly bindCommandAddresses: readonly string[];
  readonly commandRateLimit: ChronyRateLimit | null;
  readonly smooth: { maxFrequencyPpm: number; maxWanderPpm: number; leapOnly: boolean } | null;
  readonly localDistance: number;
  readonly localOrphan: boolean;
  readonly selection: Partial<SelectionParameters>;
  readonly maxUpdateSkewPpm: number | null;
  readonly maxChange: { offset: number; delay: number; ignore: number } | null;
  readonly nts: ChronyNtsConf;
  /** Les lignes que chronyd connait mais que ce simulateur n'applique pas. */
  readonly acceptesSansEffet: readonly string[];
  /** Les lignes qu'aucun chronyd ne connait : elles sont signalees. */
  readonly inconnues: readonly { ligne: number; texte: string }[];
}

/** Ce que chronyd connait et que ce simulateur n'applique pas. */
const CONNUES_SANS_EFFET = new Set([
  'refclock', 'hwtimestamp', 'leapsectz', 'initstepslew',
  'lock_all',
  'sched_priority', 'user', 'pidfile',
  'noclientlog', 'clientloglimit', 'dumpdir', 'corrtimeratio',
  'maxdrift', 'rtcfile', 'hwclockfile', 'leapsecmode',
]);

const CONF_VIDE: ChronyConf = {
  sources: [], makestep: null, access: [], ratelimit: null,
  driftfile: '', logdir: '', logs: [], keyfile: '',
  rtcsync: false, manual: false, localStratum: null, maxdistanceSec: null,
  ntpPort: 123, commandPort: 323, bindCommandAddresses: [], commandRateLimit: null, smooth: null, localDistance: 1.0, localOrphan: false, selection: {}, maxUpdateSkewPpm: null, maxChange: null,
  nts: { serverCerts: [], serverKeys: [], port: 4460, processes: 1, maxConnections: 100, dumpDir: '', ntpServer: null, rotateSeconds: 604800, refreshSeconds: 2419200, trustedCerts: [], systemCerts: true },
  acceptesSansEffet: [], inconnues: [],
};

function entier(mot: string | undefined): number | null {
  return mot !== undefined && /^-?\d+$/.test(mot) ? parseInt(mot, 10) : null;
}

/** Analyse le texte d'un `chrony.conf`. Un fichier vide est legal. */
export function parseChronyConf(texte: string): ChronyConf {
  const sources: ChronySource[] = [];
  const access: ChronyAccessDirective[] = [];
  let ratelimit: ChronyRateLimit | null = null;
  const logs: string[] = [];
  const acceptesSansEffet: string[] = [];
  const inconnues: { ligne: number; texte: string }[] = [];
  let makestep: ChronyMakestep | null = null;
  let driftfile = '';
  let logdir = '';
  let keyfile = '';
  let rtcsync = false;
  let manual = false;
  let localStratum: number | null = null;
  let maxdistanceSec: number | null = null;
  let localDistance = 1.0;
  let ntpPort = 123;
  let commandPort = 323;
  const bindCommandAddresses: string[] = [];
  let commandRateLimit: ChronyRateLimit | null = null;
  let smooth: { maxFrequencyPpm: number; maxWanderPpm: number; leapOnly: boolean } | null = null;
  let localOrphan = false;
  const selection: Partial<SelectionParameters> = {};
  let maxUpdateSkewPpm: number | null = null;
  let maxChange: { offset: number; delay: number; ignore: number } | null = null;
  const serverCerts: string[] = [];
  const serverKeys: string[] = [];
  const trustedCerts: { set: number; path: string }[] = [];
  const ntsSettings = { ...CONF_VIDE.nts };

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
        const source = parseChronySource(cle as ChronySource['genre'], args);
        if (source === null) inconnues.push({ ligne: i + 1, texte: nue });
        else sources.push(source);
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
      case 'allow':
      case 'deny':
      case 'cmdallow':
      case 'cmddeny': {
        const includingChildren = args[0]?.toLowerCase() === 'all';
        const target = includingChildren ? args[1] : args[0];
        const subnet = parseChronySubnet(target ?? '');
        if (subnet === null) inconnues.push({ ligne: i + 1, texte: nue });
        else access.push({ kind: cle, subnet, includingChildren });
        break;
      }
      case 'ratelimit': {
        const read = (name: string, fallback: number): number => {
          const at = args.findIndex((m) => m.toLowerCase() === name);
          return at >= 0 ? entier(args[at + 1]) ?? fallback : fallback;
        };
        ratelimit = { interval: read('interval', 3), burst: read('burst', 8), leak: read('leak', 2) };
        break;
      }
      case 'driftfile': driftfile = args[0] ?? ''; break;
      case 'logdir': logdir = args[0] ?? ''; break;
      case 'log': logs.push(...args.map((m) => m.toLowerCase())); break;
      case 'keyfile': keyfile = args[0] ?? ''; break;
      case 'rtcsync': rtcsync = true; break;
      case 'manual': manual = true; break;
      case 'local': {
        let stratum = 10;
        let distance = 1.0;
        let orphan = false;
        let valid = true;
        for (let k = 0; k < args.length; k++) {
          const word = args[k].toLowerCase();
          if (word === 'orphan') orphan = true;
          else if (word === 'stratum') {
            const v = entier(args[++k]);
            if (v === null || v <= 0 || v >= 16) valid = false; else stratum = v;
          } else if (word === 'distance') {
            const v = parseFloat(args[++k] ?? '');
            if (isNaN(v)) valid = false; else distance = v;
          } else valid = false;
        }
        if (!valid) { inconnues.push({ ligne: i + 1, texte: nue }); break; }
        localStratum = stratum; localDistance = distance; localOrphan = orphan;
        break;
      }
      case 'cmdport': {
        const v = entier(args[0]);
        if (v === null || args.length !== 1 || v < 0 || v > 65535) inconnues.push({ ligne: i + 1, texte: nue });
        else commandPort = v;
        break;
      }
      case 'bindcmdaddress': {
        if (args.length !== 1) inconnues.push({ ligne: i + 1, texte: nue });
        else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(args[0])) bindCommandAddresses.push(args[0]);
        else if (!args[0].startsWith('/') && !args[0].includes(':')) inconnues.push({ ligne: i + 1, texte: nue });
        break;
      }
      case 'cmdratelimit': {
        const read = (name: string, fallback: number): number => {
          const at = args.findIndex((m) => m.toLowerCase() === name);
          return at >= 0 ? entier(args[at + 1]) ?? fallback : fallback;
        };
        commandRateLimit = { interval: read('interval', -4), burst: read('burst', 8), leak: read('leak', 2) };
        break;
      }
      case 'smoothtime': {
        const maxFrequency = parseFloat(args[0] ?? '');
        const maxWander = parseFloat(args[1] ?? '');
        const leapOnly = args[2]?.toLowerCase() === 'leaponly';
        if (isNaN(maxFrequency) || isNaN(maxWander) || args.length < 2 || args.length > 3 || (args.length === 3 && !leapOnly)) {
          inconnues.push({ ligne: i + 1, texte: nue });
        } else {
          smooth = maxFrequency > 0 && maxWander > 0 ? { maxFrequencyPpm: maxFrequency, maxWanderPpm: maxWander, leapOnly } : null;
        }
        break;
      }
      case 'port': {
        const v = entier(args[0]);
        if (v === null || args.length !== 1 || v < 0 || v > 65535) inconnues.push({ ligne: i + 1, texte: nue });
        else ntpPort = v;
        break;
      }
      case 'maxdistance': case 'maxjitter': case 'reselectdist': case 'stratumweight':
      case 'combinelimit': case 'maxclockerror': case 'maxupdateskew': {
        const value = parseFloat(args[0] ?? '');
        if (isNaN(value) || args.length !== 1) { inconnues.push({ ligne: i + 1, texte: nue }); break; }
        if (cle === 'maxdistance') { maxdistanceSec = value; selection.maxDistance = value; }
        else if (cle === 'maxjitter') selection.maxJitter = value;
        else if (cle === 'reselectdist') selection.reselectDistance = value;
        else if (cle === 'stratumweight') selection.stratumWeight = value;
        else if (cle === 'combinelimit') selection.combineLimit = value;
        else if (cle === 'maxclockerror') selection.maxClockError = value * 1e-6;
        else maxUpdateSkewPpm = value;
        break;
      }
      case 'minsources': {
        const v = entier(args[0]);
        if (v === null || args.length !== 1) inconnues.push({ ligne: i + 1, texte: nue });
        else selection.minSources = v;
        break;
      }
      case 'maxchange': {
        const offset = parseFloat(args[0] ?? '');
        const delay = entier(args[1]);
        const ignore = entier(args[2]);
        if (isNaN(offset) || delay === null || ignore === null || args.length !== 3) inconnues.push({ ligne: i + 1, texte: nue });
        else maxChange = { offset, delay, ignore };
        break;
      }
      case 'ntsservercert': case 'ntsserverkey': case 'ntsdumpdir': case 'ntsntpserver': {
        if (args.length !== 1) { inconnues.push({ ligne: i + 1, texte: nue }); break; }
        if (cle === 'ntsservercert') serverCerts.push(args[0]);
        else if (cle === 'ntsserverkey') serverKeys.push(args[0]);
        else if (cle === 'ntsdumpdir') ntsSettings.dumpDir = args[0];
        else ntsSettings.ntpServer = args[0];
        break;
      }
      case 'ntsport': case 'ntsprocesses': case 'maxntsconnections': case 'ntsrotate': case 'ntsrefresh': {
        const v = entier(args[0]);
        const maximum = cle === 'ntsport' ? 65535 : 2147483647;
        if (v === null || args.length !== 1 || v < 0 || v > maximum) { inconnues.push({ ligne: i + 1, texte: nue }); break; }
        if (cle === 'ntsport') ntsSettings.port = v;
        else if (cle === 'ntsprocesses') ntsSettings.processes = v;
        else if (cle === 'maxntsconnections') ntsSettings.maxConnections = v;
        else if (cle === 'ntsrotate') ntsSettings.rotateSeconds = v;
        else ntsSettings.refreshSeconds = v;
        break;
      }
      case 'ntstrustedcerts': {
        const set = args.length === 2 ? entier(args[0]) : 0;
        if (args.length < 1 || args.length > 2 || set === null || set < 0) { inconnues.push({ ligne: i + 1, texte: nue }); break; }
        trustedCerts.push({ set, path: args[args.length - 1] });
        break;
      }
      case 'nosystemcert': ntsSettings.systemCerts = false; break;
      default:
        if (CONNUES_SANS_EFFET.has(cle)) acceptesSansEffet.push(nue);
        else inconnues.push({ ligne: i + 1, texte: nue });
    }
  }
  return {
    ...CONF_VIDE, sources, makestep, access, ratelimit,
    driftfile, logdir, logs, keyfile, rtcsync, manual, localStratum, maxdistanceSec,
    ntpPort, commandPort, bindCommandAddresses, commandRateLimit, smooth, localDistance, localOrphan, selection, maxUpdateSkewPpm, maxChange,
    nts: { ...ntsSettings, serverCerts, serverKeys, trustedCerts },
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
