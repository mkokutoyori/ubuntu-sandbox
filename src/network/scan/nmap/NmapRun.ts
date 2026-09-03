import { parseNmapArgs } from './NmapOptions';
import { scan } from './ScanEngine';
import { renderNormal, renderGreppable } from './NmapFormatter';
import { buildScanProbes, type ScanHost } from './NmapProbes';

export interface NmapRunResult {
  output: string;
  normal: string;
  greppable: string | null;
  outputNormalPath: string | null;
  outputGreppablePath: string | null;
}

const USAGE = 'Nmap 7.94 ( https://nmap.org )\nUsage: nmap [Scan Type(s)] [Options] {target specification}';

/**
 * `nmap` du premier argument au texte rendu. Les deux plateformes lisent
 * ce corps : ce que la machine EMET est decide par le `ScanHost` qu'elle
 * fournit, ce qu'elle ECRIT reste a l'appelant, un fichier ne s'ecrivant
 * pas de la meme facon sous Linux et sous Windows.
 */
export async function runNmap(host: ScanHost, args: string[]): Promise<NmapRunResult> {
  const options = parseNmapArgs(args);
  if (options.targets.length === 0) {
    return {
      output: USAGE, normal: USAGE, greppable: null,
      outputNormalPath: null, outputGreppablePath: null,
    };
  }

  const commandLine = `nmap ${args.join(' ')}`;
  const report = await scan(options, buildScanProbes(host, options.noDns));
  const normal = renderNormal(report, options, commandLine);

  return {
    output: normal,
    normal,
    greppable: options.outputGreppable ? renderGreppable(report, commandLine) : null,
    outputNormalPath: options.outputNormal ?? null,
    outputGreppablePath: options.outputGreppable ?? null,
  };
}
