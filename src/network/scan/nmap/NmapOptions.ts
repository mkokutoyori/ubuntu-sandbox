import { parsePortSpec } from './PortSpec';
import { NMAP_LONG_OPTIONS, NMAP_SHORT_OPTIONS } from './NmapOptionTables';
import { topPorts, fastPorts } from './ServiceRegistry';

export type ScanType =
  'tcp' | 'syn' | 'udp' | 'ack' | 'fin' | 'null' | 'xmas' | 'maimon' | 'window';

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
  showReason: boolean;
  noDns: boolean;
  verbose: boolean;
  outputNormal?: string;
  outputGreppable?: string;
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
  let pingOnly = false;
  let skipDiscovery = false;
  let versionScan = false;
  let osScan = false;
  let openOnly = false;
  let ipv6 = false;
  let disableArpPing = false;
  let alwaysResolve = false;
  let showReason = false;
  let noDns = false;
  let verbose = false;
  let outputNormal: string | undefined;
  let outputGreppable: string | undefined;

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

    if (a === '-sU') { scanType = 'udp'; continue; }
    if (a === '-sA') { scanType = 'ack'; continue; }
    if (a === '-sS') { scanType = 'syn'; continue; }
    if (a === '-sT') { scanType = 'tcp'; continue; }
    if (a === '-sF') { scanType = 'fin'; continue; }
    if (a === '-sN') { scanType = 'null'; continue; }
    if (a === '-sX') { scanType = 'xmas'; continue; }
    if (a === '-sM') { scanType = 'maimon'; continue; }
    if (a === '-sW') { scanType = 'window'; continue; }

    if (a === '-sn' || a === '-sP') { pingOnly = true; continue; }
    if (a === '-Pn' || a === '-P0') { skipDiscovery = true; continue; }

    if (a === '-sV') { versionScan = true; continue; }
    if (a === '-O') { osScan = true; continue; }
    if (a === '-A') { versionScan = true; osScan = true; continue; }

    if (a === '--open') { openOnly = true; continue; }
    if (a === '--reason') { showReason = true; continue; }
    if (a === '-n') { noDns = true; continue; }
    if (a === '-v' || a === '-vv' || a === '-d') { verbose = true; continue; }

    if (a === '-oN' && args[i + 1] !== undefined) { outputNormal = args[++i]; continue; }
    if (a === '-oG' && args[i + 1] !== undefined) { outputGreppable = args[++i]; continue; }
    if (a === '-oA' && args[i + 1] !== undefined) {
      const base = args[++i];
      outputNormal = `${base}.nmap`;
      outputGreppable = `${base}.gnmap`;
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

  return {
    targets, ports, scanType, pingOnly, skipDiscovery, versionScan, osScan,
    openOnly, ipv6, disableArpPing, alwaysResolve, showReason, noDns, verbose,
    outputNormal, outputGreppable,
  };
}
