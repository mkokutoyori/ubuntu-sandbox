import {
  NMAP_USAGE, NmapImmediateOutput, NmapOptionError, parseNmapArgs,
} from './NmapOptions';
import { scan } from './ScanEngine';
import { renderNormal, renderGreppable, totalSeconds } from './NmapFormatter';
import { renderXml } from './NmapXml';
import { buildScanProbes, type ScanHost } from './NmapProbes';
import { IPAddress } from '@/network/core/types';
import {
  parseTargetSpec, randomTargets, readHostSpecs, type OctetSet,
} from './TargetSpec';

export interface NmapRunResult {
  output: string;
  normal: string;
  greppable: string | null;
  xml: string | null;
  outputNormalPath: string | null;
  outputGreppablePath: string | null;
  outputXmlPath: string | null;
}

/**
 * `nmap` du premier argument au texte rendu. Les deux plateformes lisent
 * ce corps : ce que la machine EMET est decide par le `ScanHost` qu'elle
 * fournit, ce qu'elle ECRIT reste a l'appelant, un fichier ne s'ecrivant
 * pas de la meme facon sous Linux et sous Windows.
 */
export async function runNmap(host: ScanHost, args: string[]): Promise<NmapRunResult> {
  const refuse = (line: string): NmapRunResult => ({
    output: line, normal: line, greppable: null, xml: null,
    outputNormalPath: null, outputGreppablePath: null, outputXmlPath: null,
  });

  let options;
  try {
    options = parseNmapArgs(args);
  } catch (e) {
    // Une option refusee n'est pas un balayage rate, c'est un balayage
    // qui n'a pas eu lieu : rien n'est emis et aucun fichier n'est ecrit.
    // `-h` et `-V` sortent par le meme chemin, pour la meme raison.
    const text = e instanceof NmapOptionError ? e.lines.join('\n')
      : e instanceof NmapImmediateOutput ? e.text
        : null;
    if (text === null) throw e;
    return refuse(text);
  }

  if (options.inputFile !== undefined) {
    const text = host.readFile(options.inputFile);
    if (text === null) {
      return refuse(`Failed to open input file ${options.inputFile}`
        + ' for reading: No such file or directory');
    }
    options.targets = [...options.targets, ...readHostSpecs(text)];
  }

  const excludeSpecs = [...(options.excludeSpecs ?? [])];
  if (options.excludeFile !== undefined) {
    const text = host.readFile(options.excludeFile);
    if (text === null) {
      return refuse(`Failed to open exclude file ${options.excludeFile}`
        + ' for reading: No such file or directory');
    }
    excludeSpecs.push(...readHostSpecs(text));
  }
  if (excludeSpecs.length > 0) {
    const parsed: OctetSet[] = [];
    for (const spec of excludeSpecs) {
      const octets = parseTargetSpec(spec);
      if (octets === null) return refuse(`Invalid address specification: ${spec}`);
      parsed.push(octets);
    }
    options.excluded = parsed;
  }

  if (options.randomTargets !== undefined) {
    options.targets = [
      ...options.targets,
      ...randomTargets(options.randomTargets, options.excluded ?? []),
    ];
  }

  if (options.targets.length === 0) return refuse(NMAP_USAGE);

  const scanProbes = buildScanProbes(host, options.noDns, options.ipv6);
  for (const decoy of options.decoys ?? []) {
    if (decoy.kind === 'me' || IPAddress.tryParse(decoy.ip) !== null) continue;
    const resolved = await scanProbes.resolveTarget(decoy.ip);
    if (!resolved) {
      return refuse(`Failed to resolve decoy host "${decoy.ip}":`
        + ' Name or service not known');
    }
    decoy.ip = resolved.ip;
  }

  const commandLine = `nmap ${args.join(' ')}`;
  const report = await scan(options, scanProbes);
  const normal = renderNormal(report, options, commandLine);

  return {
    output: normal,
    normal,
    greppable: options.outputGreppable ? renderGreppable(report, commandLine) : null,
    xml: options.outputXml
      ? renderXml(report, options, commandLine, totalSeconds(report)) : null,
    outputNormalPath: options.outputNormal ?? null,
    outputGreppablePath: options.outputGreppable ?? null,
    outputXmlPath: options.outputXml ?? null,
  };
}
