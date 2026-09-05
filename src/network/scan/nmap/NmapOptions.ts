import { parsePortSpec } from './PortSpec';
import { NMAP_LONG_OPTIONS, NMAP_SHORT_OPTIONS } from './NmapOptionTables';
import { NMAP_DEFAULT_STYLESHEET, NMAP_WEB_STYLESHEET } from './NmapXml';
import type { ScanProbeShape } from '@/network/tcp/TcpStack';
import { IPAddress } from '@/network/core/types';
import { parseScanFlags, type ScanProbeFlags } from './StatelessScans';
import { topPorts, fastPorts } from './ServiceRegistry';

/**
 * `NmapOps.cc:527` et `nmap.cc:1833` : les options qui composent le
 * paquet exigent l'acces BRUT, et un balayage connecte laisse le noyau
 * composer — nmap les accepte alors, avertit, et ne les honore pas.
 */
const RAW_OPTIONS_WARNING = [
  'You have specified some options that require raw socket access.',
  'These options will not be honored for TCP Connect scan.',
];

const SOURCE_PORT_CONNECT_WARNING = 'WARNING: -g is incompatible with the'
  + ' default connect() scan (-sT).  Use a raw scan such as -sS if you want'
  + ' to set the source port.';

const ZERO_SOURCE_PORT_WARNING =
  'WARNING: a source port of zero may not work on all systems.';

/**
 * La CHARGE que chaque type de balayage compose, en octets, donc ce que
 * `--mtu` a a decouper : un en-tete TCP sans option pour les balayages
 * qui composent un segment, un en-tete UDP pour `-sU`. Sans `--data`, un
 * vrai nmap n'ajoute aucune donnee derriere.
 */
const TCP_HEADER_BYTES = 20;
const UDP_HEADER_BYTES = 8;

function probePayloadBytes(scanType: ScanType): number {
  return scanType === 'udp' ? UDP_HEADER_BYTES : TCP_HEADER_BYTES;
}

export type DecoySource = { kind: 'me' } | { kind: 'forged'; ip: string };

const MAX_DECOYS = 128;

function randomUnreservedIpv4(): string {
  for (;;) {
    const n = Math.floor(Math.random() * 0x100000000) >>> 0;
    const candidate = IPAddress.fromUint32(n);
    if (!candidate.isReserved()) return candidate.toString();
  }
}

function parseDecoys(spec: string): DecoySource[] {
  const parsed: DecoySource[] = [];
  let sawMe = false;
  for (const raw of spec.split(',')) {
    const entry = raw.trim();
    if (entry.toLowerCase() === 'me') {
      if (sawMe) throw new NmapOptionError(["Can only use 'ME' as a decoy once."]);
      sawMe = true;
      parsed.push({ kind: 'me' });
      continue;
    }
    const random = /^rnd(?::(\d+))?$/i.exec(entry);
    if (random) {
      const howMany = random[1] === undefined ? 1 : Number(random[1]);
      if (howMany < 1) throw new NmapOptionError([`Bad 'rnd' decoy "${entry}"`]);
      if (parsed.length + howMany >= MAX_DECOYS - 1) {
        throw new NmapOptionError([`You are only allowed ${MAX_DECOYS} decoys`
          + ` (if you need more redefine MAX_DECOYS in nmap.h)`]);
      }
      for (let i = 0; i < howMany; i++) {
        parsed.push({ kind: 'forged', ip: randomUnreservedIpv4() });
      }
      continue;
    }
    if (parsed.length >= MAX_DECOYS - 1) {
      throw new NmapOptionError([`You are only allowed ${MAX_DECOYS} decoys`
        + ` (if you need more redefine MAX_DECOYS in nmap.h)`]);
    }
    parsed.push({ kind: 'forged', ip: entry });
  }
  if (!sawMe) {
    const turn = parsed.length === 0 ? 0 : Math.floor(Math.random() * parsed.length);
    parsed.splice(turn, 0, { kind: 'me' });
  }
  return parsed;
}

export type ScanType =
  'tcp' | 'syn' | 'udp' | 'ack' | 'fin' | 'null' | 'xmas' | 'maimon' | 'window';

const SCAN_TYPE_OPTIONS: Readonly<Record<string, ScanType>> = {
  '-sT': 'tcp', '-sS': 'syn', '-sU': 'udp', '-sA': 'ack', '-sF': 'fin',
  '-sN': 'null', '-sX': 'xmas', '-sM': 'maimon', '-sW': 'window',
};

export interface NmapOptions {
  targets: string[];
  ports?: number[];
  scanType: ScanType;
  pingOnly: boolean;
  skipDiscovery: boolean;
  versionScan: boolean;
  osScan: boolean;
  openOnly: boolean;
  /** `-6` : la cible se resout en IPv6, et le balayage part en IPv6. */
  ipv6: boolean;
  /** `--disable-arp-ping` : plus de decouverte de couche lien, meme sur le segment local. */
  disableArpPing: boolean;
  /** `-R` : resoudre le nom meme d'un hote qui n'a pas repondu. */
  alwaysResolve: boolean;
  /**
   * `--scanflags` : les drapeaux du segment emis. Le balayage de base,
   * lui, garde la LECTURE de la reponse — les deux sont distincts, ce qui
   * est tout l'interet de l'option.
   */
  scanFlags?: ScanProbeFlags;
  /**
   * `--traceroute` : le chemin jusqu'a chaque hote, releve APRES le
   * balayage et avec la sonde qui a fait repondre la cible.
   *
   * Sur une vraie machine l'option exige les privileges (`nmap.cc:1590`,
   * « Traceroute has to be run as root »), tout comme `-sS`, `-sU` et
   * `-O`. Ce simulateur ne modelise ce partage pour AUCUNE d'elles — un
   * balayage SYN y fonctionne sans `sudo` — donc `--traceroute` suit ses
   * soeurs plutot que de porter seule une garde que rien d'autre ne
   * porte. C'est la meme raison qui fait `-A` l'activer ici sans
   * condition la ou `nmap` l'active « if (o.isr00t) ».
   */
  traceroute: boolean;
  /**
   * `--packet-trace` : chaque paquet emis et recu par le balayage, dans
   * la forme de `PacketTrace` (`tcpip.cc`). Un balayage CONNECTE ne rend
   * que ses appels `connect()`, parce qu'un vrai `nmap` ne voit pas les
   * paquets que le noyau emet pour lui.
   */
  packetTrace: boolean;
  showReason: boolean;
  noDns: boolean;
  verbose: boolean;
  /**
   * `nmap.cc:1057` : `-d` leve la verbosite ET le niveau de debogage
   * ensemble, et c'est ce niveau qui DEFINIT `packetTrace()`.
   */
  debugLevel: number;
  /**
   * La feuille de style que le XML associe au document, ou `null` quand
   * `--no-stylesheet` la supprime. `XSLStyleSheet()` (`NmapOps.cc:618`)
   * cherche `nmap.xsl` sur le disque et retombe sur l'URL relative
   * lorsqu'il ne l'y trouve pas — ce qui est toujours le cas ici.
   */
  stylesheet: string | null;
  /**
   * Ce que le balayage COMPOSE dans sa sonde au lieu de laisser la pile
   * le decider : `-g`/`--source-port`, `--ttl` et `--badsum`. Absent
   * quand aucune des trois n'est demandee, et — surtout — absent aussi
   * sous un balayage CONNECTE, ou `connect()` compose le paquet a la
   * place de nmap (`nmap.cc:1833`).
   */
  probeShape?: ScanProbeShape;
  /**
   * `-D` : les sources dont partiront les sondes, dans l'ordre, la vraie
   * a sa place. Absent quand l'option n'est pas demandee, et absent aussi
   * sous un balayage CONNECTE, qui ne compose pas ses paquets.
   */
  decoys?: DecoySource[];
  /**
   * Ce que nmap ecrit AVANT sa banniere : les avertissements des options
   * qu'il accepte sans pouvoir les honorer.
   */
  warnings: string[];
  outputNormal?: string;
  outputGreppable?: string;
  outputXml?: string;
}

/**
 * Ce que l'analyseur rend quand il refuse : la ou les lignes a ecrire, et
 * rien d'autre. Un refus d'option n'est pas un balayage rate, c'est un
 * balayage qui n'a pas eu lieu.
 */
export class NmapOptionError extends Error {
  constructor(readonly lines: string[]) {
    super(lines.join('\n'));
    this.name = 'NmapOptionError';
  }
}

/**
 * Une option qui REND un texte et n'entreprend aucun balayage : `-h` sort
 * l'usage et `-V` la version, chacune suivie d'`exit(0)` sur une vraie
 * machine (`nmap.cc:1091` et `1420`). Elles sont implantees plutot que
 * refusees parce que le message de refus RENVOIE a `nmap -h` : le laisser
 * pointer vers une option qui repond « non implantee » serait une
 * impasse.
 */
export class NmapImmediateOutput extends Error {
  constructor(readonly text: string) {
    super(text);
    this.name = 'NmapImmediateOutput';
  }
}

export const NMAP_USAGE = 'Nmap 7.94 ( https://nmap.org )\n'
  + 'Usage: nmap [Scan Type(s)] [Options] {target specification}';

/**
 * `nmap.cc:2891` : `"%s version %s ( %s )"`. Les lignes `Platform:` et
 * `Compiled with:` qui suivent decrivent une construction qui n'existe
 * pas ici, donc elles sont OMISES plutot qu'inventees.
 */
export const NMAP_VERSION_TEXT = 'Nmap version 7.94 ( https://nmap.org )';

const UNKNOWN_TAIL = 'See the output of nmap -h for a summary of options.';

/**
 * `-T` ne regle qu'une vitesse et `-r` qu'un ordre de tirage des ports.
 * Ce simulateur livre ses trames de facon synchrone et ne tire aucun
 * ordre : leur effet observable est DEJA atteint, donc les accepter sans
 * rien changer est exact, la ou les refuser annoncerait un manque qui
 * n'existe pas.
 */
function acceptedWithoutEffect(arg: string): boolean {
  return arg === '-r' || /^-T[0-5]?$/.test(arg);
}

function refuseUnknown(arg: string): never {
  const name = arg.startsWith('--')
    ? `nmap: unrecognized option '${arg}'`
    : `nmap: invalid option -- '${arg.slice(1, 2)}'`;
  throw new NmapOptionError([name, UNKNOWN_TAIL]);
}

function refuseUnimplemented(name: string): never {
  throw new NmapOptionError(
    [`nmap: option ${name}: is not implemented in this simulator`]);
}

/**
 * Un argument commencant par un tiret que l'analyseur n'a pas reconnu.
 * Trois issues, comme pour `curl` : connue de `nmap` et non implantee ici
 * — refus nommant le simulateur, puisqu'aucun vrai `nmap` n'est jamais
 * dans cette situation et que repondre « inconnue » serait un second
 * mensonge ; inexistante — le message de `nmap` ; acceptee sans effet
 * pour une raison ecrite.
 *
 * Le refus etant immediat, la valeur d'une option a valeur n'est jamais
 * atteinte, donc jamais rangee dans les cibles : c'est ce qui faisait
 * balayer `100` comme une machine sous `nmap --max-rate 100 <cible>`.
 */
function refuseUnrecognized(arg: string): void {
  if (acceptedWithoutEffect(arg)) return;

  if (arg.startsWith('--')) {
    const name = arg.slice(2).split('=', 1)[0];
    if (!NMAP_LONG_OPTIONS.has(name)) refuseUnknown(arg);
    refuseUnimplemented(`--${name}`);
  }

  const letter = arg[1];
  if (!NMAP_SHORT_OPTIONS.has(letter)) refuseUnknown(arg);
  refuseUnimplemented(`-${letter}`);
}

export function parseNmapArgs(args: string[]): NmapOptions {
  const targets: string[] = [];
  let ports: number[] | undefined;
  let scanType: ScanType = 'tcp';
  let scanTypeGiven = false;
  let scanFlags: ScanProbeFlags | undefined;
  let pingOnly = false;
  let skipDiscovery = false;
  let versionScan = false;
  let osScan = false;
  let openOnly = false;
  let ipv6 = false;
  let disableArpPing = false;
  let alwaysResolve = false;
  let traceroute = false;
  let packetTrace = false;
  let debugLevel = 0;
  let showReason = false;
  let noDns = false;
  let verbose = false;
  let outputNormal: string | undefined;
  let outputGreppable: string | undefined;
  let outputXml: string | undefined;
  let stylesheet: string | null = NMAP_DEFAULT_STYLESHEET;
  let sourcePort: number | undefined;
  let probeTtl: number | undefined;
  let badChecksum = false;
  let fragmentMtu = 0;
  let decoySpec: DecoySource[] | undefined;
  let spoofSource: string | undefined;
  const warnings: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];

    if (a === '-p' && args[i + 1] !== undefined) { ports = parsePortSpec(args[++i]); continue; }
    if (a === '-p-') { ports = parsePortSpec('-'); continue; }
    if (a.startsWith('-p')) { ports = parsePortSpec(a.slice(2)); continue; }

    if (a === '-F') { ports = fastPorts(); continue; }
    if (a === '--top-ports' && args[i + 1] !== undefined) {
      ports = topPorts(Number(args[++i]) || 0);
      continue;
    }

    const chosen = SCAN_TYPE_OPTIONS[a];
    if (chosen) { scanType = chosen; scanTypeGiven = true; continue; }

    if (a === '--scanflags' && args[i + 1] !== undefined) {
      const parsed = parseScanFlags(args[++i]);
      if (!parsed) {
        throw new NmapOptionError(['--scanflags option must be a number between 0'
          + ' and 255 (inclusive) or a string like "URGPSHFIN".']);
      }
      scanFlags = parsed;
      continue;
    }

    if (a === '-sn' || a === '-sP') { pingOnly = true; continue; }
    if (a === '-Pn' || a === '-P0') { skipDiscovery = true; continue; }

    if (a === '-sV') { versionScan = true; continue; }
    if (a === '-O') { osScan = true; continue; }
    if (a === '-A') { versionScan = true; osScan = true; traceroute = true; continue; }
    if (a === '--traceroute') { traceroute = true; continue; }
    if (a === '--packet-trace') { packetTrace = true; continue; }

    if (a === '--open') { openOnly = true; continue; }
    if (a === '--reason') { showReason = true; continue; }
    if (a === '-n') { noDns = true; continue; }
    // `nmap.cc:1057` : `-d` leve la verbosite ET le niveau de debogage
    // ENSEMBLE — `o.debugging = o.verbose = box(0, 10, i)` pour `-dN`,
    // les deux incrementes d'un cran par `d` supplementaire sinon.
    const debug = /^-d(\d+|d*)$/.exec(a);
    if (debug) {
      const arg = debug[1];
      debugLevel = /^\d+$/.test(arg)
        ? Math.min(10, Number(arg))
        : Math.min(10, debugLevel + 1 + arg.length);
      verbose = true;
      continue;
    }
    if (/^-v(\d+|v*)$/.test(a)) { verbose = true; continue; }

    if (a === '-oN' && args[i + 1] !== undefined) { outputNormal = args[++i]; continue; }
    if (a === '-oG' && args[i + 1] !== undefined) { outputGreppable = args[++i]; continue; }
    if (a === '-oX' && args[i + 1] !== undefined) { outputXml = args[++i]; continue; }
    // `nmap.cc:918` : `-oA` ecrit TROIS fichiers, `.nmap`, `.gnmap` et
    // `.xml`.
    if (a === '-oA' && args[i + 1] !== undefined) {
      const base = args[++i];
      outputNormal = `${base}.nmap`;
      outputGreppable = `${base}.gnmap`;
      outputXml = `${base}.xml`;
      continue;
    }
    // `nmap.cc:1082` : `-f` AJOUTE huit, donc `-f -f` vaut `-ff`, que la
    // forme longue ecrit d'un coup (`nmap.cc:961`).
    if (a === '-f') { fragmentMtu += 8; continue; }
    if (a === '-ff' || a === '--ff') { fragmentMtu += 16; continue; }
    // `nmap.cc:969` : `--mtu` POSE la valeur, et le champ « fragment
    // offset » comptant par huit octets, une valeur qui n'en est pas un
    // multiple ne serait pas representable.
    if (a === '--mtu' && args[i + 1] !== undefined) {
      fragmentMtu = Number(args[++i]);
      if (!Number.isInteger(fragmentMtu) || fragmentMtu <= 0 || fragmentMtu % 8 !== 0) {
        throw new NmapOptionError(['Data payload MTU must be >0 and multiple of 8']);
      }
      continue;
    }
    if (a === '-D' && args[i + 1] !== undefined) {
      decoySpec = parseDecoys(args[++i]);
      continue;
    }
    if (a === '-S' && args[i + 1] !== undefined) {
      if (spoofSource !== undefined) {
        throw new NmapOptionError(['You can only use the source option once!'
          + '  Use -D <decoy1> -D <decoy2> etc. for decoys']);
      }
      spoofSource = args[++i];
      continue;
    }
    if (a === '--badsum') { badChecksum = true; continue; }
    if ((a === '-g' || a === '--source-port') && args[i + 1] !== undefined) {
      sourcePort = Number(args[++i]);
      if (!Number.isInteger(sourcePort) || sourcePort < 0 || sourcePort > 65535) {
        throw new NmapOptionError(
          ['Invalid source port number, must be a number between 0 and 65535.']);
      }
      if (sourcePort === 0) warnings.push(ZERO_SOURCE_PORT_WARNING);
      continue;
    }
    // `nmap.cc:750` : hors de [0, 255] c'est un `fatal`, donc aucun
    // balayage n'a lieu.
    if (a === '--ttl' && args[i + 1] !== undefined) {
      probeTtl = Number(args[++i]);
      if (!Number.isInteger(probeTtl) || probeTtl < 0 || probeTtl > 255) {
        throw new NmapOptionError(
          ['ttl option must be a number between 0 and 255 (inclusive)']);
      }
      continue;
    }
    if (a === '--no-stylesheet') { stylesheet = null; continue; }
    if (a === '--webxml') { stylesheet = NMAP_WEB_STYLESHEET; continue; }
    if (a === '--stylesheet' && args[i + 1] !== undefined) {
      stylesheet = args[++i];
      continue;
    }

    if (a === '-6') { ipv6 = true; continue; }
    if (a === '--disable-arp-ping' || a === '--send-ip') { disableArpPing = true; continue; }
    if (a === '-R') { alwaysResolve = true; continue; }
    if (a === '-h' || a === '--help') throw new NmapImmediateOutput(NMAP_USAGE);
    if (a === '-V' || a === '--version') throw new NmapImmediateOutput(NMAP_VERSION_TEXT);
    if (a.startsWith('-')) { refuseUnrecognized(a); continue; }

    targets.push(a);
  }

  // « If you don't specify a base type, SYN scan is used. » Le defaut
  // ORDINAIRE reste le balayage connecte ; c'est `--scanflags` qui le
  // deplace, parce qu'un balayage connecte ne compose aucun segment et
  // n'aurait donc rien a faire de ces drapeaux.
  if (scanFlags && !scanTypeGiven) scanType = 'syn';

  // `NmapOps.h:127` : `packetTrace()` rend vrai des le niveau de
  // debogage 3, que `--packet-trace` ait ete ecrit ou non.
  if (debugLevel >= 3) packetTrace = true;

  // `send_frag_ip_packet` (`libnetutil/netutil.cc:2748`) : une charge deja
  // plus petite que la MTU demandee part ENTIERE, et le dit. Un vrai nmap
  // l'ecrit par paquet, depuis la fonction d'emission ; ici la sonde a la
  // meme taille pour tous les ports d'un balayage, donc la repeter par
  // port enfouirait le rapport sans rien apprendre de plus.
  const payload = probePayloadBytes(scanType);
  if (fragmentMtu > 0 && payload <= fragmentMtu) {
    warnings.push(`Warning: fragmentation (mtu=${fragmentMtu}) requested but`
      + ` the payload is too small already (${payload})`);
    fragmentMtu = 0;
  }

  const shapesTheProbe = badChecksum || sourcePort !== undefined
    || probeTtl !== undefined || fragmentMtu > 0
    || spoofSource !== undefined || decoySpec !== undefined;
  // Un balayage CONNECTE ne compose pas son paquet, donc il n'honore
  // aucune des trois. L'avertissement propre a `-g` precede le
  // generique, `ValidateOptions()` (`nmap.cc:1535`) etant appele avant
  // le controle de `nmap.cc:1833`.
  const connectScan = scanType === 'tcp';
  if (sourcePort !== undefined && connectScan) {
    warnings.push(SOURCE_PORT_CONNECT_WARNING);
  }
  if (shapesTheProbe && connectScan) warnings.push(...RAW_OPTIONS_WARNING);
  const probeShape: ScanProbeShape | undefined =
    shapesTheProbe && !connectScan
      ? {
        sourcePort, ttl: probeTtl, badChecksum, sourceIp: spoofSource,
        fragmentMtu: fragmentMtu > 0 ? fragmentMtu : undefined,
      }
      : undefined;
  const decoys = shapesTheProbe && !connectScan ? decoySpec : undefined;

  return {
    targets, ports, scanType, scanFlags, pingOnly, skipDiscovery, versionScan,
    osScan, openOnly, ipv6, disableArpPing, alwaysResolve, traceroute, packetTrace,
    showReason, noDns, verbose, debugLevel, stylesheet, probeShape, decoys, warnings,
    outputNormal, outputGreppable, outputXml,
  };
}
