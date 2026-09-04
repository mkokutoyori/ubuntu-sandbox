import { parsePortSpec } from './PortSpec';
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
  showReason: boolean;
  noDns: boolean;
  verbose: boolean;
  outputNormal?: string;
  outputGreppable?: string;
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
    if (a.startsWith('-T') || a === '-R' || a === '--reason-only') continue;
    if (a.startsWith('-')) continue;

    targets.push(a);
  }

  return {
    targets, ports, scanType, pingOnly, skipDiscovery, versionScan, osScan,
    openOnly, ipv6, disableArpPing, showReason, noDns, verbose,
    outputNormal, outputGreppable,
  };
}
