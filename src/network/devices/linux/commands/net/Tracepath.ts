/**
 * `tracepath(8)` — trace le chemin ET découvre la MTU du trajet.
 *
 * Ce que `traceroute` ne fait pas : `tracepath` n'a besoin d'aucun
 * privilège, et sa raison d'être est la colonne `pmtu` — il annonce la
 * MTU au départ, puis la révise à la baisse chaque fois qu'un routeur
 * répond « Fragmentation Needed ». La dernière ligne, `Resume: pmtu N`,
 * est ce qu'on vient y chercher.
 *
 * Le nom était déclaré dans `KNOWN_LINUX_COMMANDS` sans implémentation,
 * si bien que `which tracepath` rendait `/usr/bin/tracepath` pendant que
 * la commande répondait `command not found` — une machine qui se
 * contredit sur ce qu'elle possède (audit 11, §2).
 *
 * Le trajet vient du même moteur que `traceroute` (`ctx.net.traceroute`),
 * la MTU de l'interface de sortie. La découverte de MTU par ICMP
 * Fragmentation Needed le long du chemin n'est pas simulée ici : la
 * colonne `pmtu` ne bouge donc pas d'un bout à l'autre du trajet, et le
 * `Resume:` rend la MTU de l'interface locale. C'est une simplification
 * assumée, pas un oubli — le simulateur sait produire un « Frag needed »
 * (`Ipv4Fragmentation.ts`) mais aucun chemin ne le remonte à un client.
 */

import { IPAddress } from '@/network/core/types';
import type { LinuxCommand } from '../LinuxCommand';
import type { TracerouteHop } from '../../LinuxNetKernel';
import { isValidIPv4 } from '@/network/core/ip';
import { makeArgCompleter } from '../completionHelpers';

const USAGE = 'Usage: tracepath [-4] [-6] [-n] [-b] [-l pktlen] [-m max_hops] [-p port] <destination>';

interface Args {
  target: string;
  maxHops: number;
  numeric: boolean;
  showBoth: boolean;
  parseError?: string;
  showHelp: boolean;
}

export function parseTracepathArgs(args: string[]): Args {
  const out: Args = { target: '', maxHops: 30, numeric: false, showBoth: false, showHelp: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') { out.showHelp = true; continue; }
    if (a === '-n') { out.numeric = true; continue; }
    if (a === '-b') { out.showBoth = true; continue; }
    if (a === '-4' || a === '-6') continue;
    if (a === '-m') {
      const v = Number(args[++i]);
      if (!Number.isInteger(v) || v < 1) { out.parseError = `tracepath: invalid max hops: ${args[i]}`; return out; }
      out.maxHops = v; continue;
    }
    if (a === '-l' || a === '-p') { i++; continue; }
    if (a.startsWith('-')) { out.parseError = `tracepath: unrecognized option '${a}'`; return out; }
    if (!out.target) out.target = a;
  }
  return out;
}

/**
 * Une ligne de `tracepath`. Le format est celui du vrai, y compris le
 * numéro de saut suivi d'un deux-points et l'alignement de `pmtu` :
 *
 *      1?: [LOCALHOST]                      pmtu 1500
 *      1:  192.168.1.1                       0.412ms
 *      2:  10.0.0.1                          1.203ms reached
 *     Resume: pmtu 1500 hops 2 back 2
 */
export function formatTracepathLines(
  hops: readonly TracerouteHop[], mtu: number, reachedAt: number | null,
): string[] {
  const lines = [` 1?: [LOCALHOST]${' '.repeat(24)}pmtu ${mtu}`];
  for (const hop of hops) {
    const num = String(hop.hop).padStart(2, ' ');
    if (hop.timeout || !hop.probes || hop.probes.length === 0) {
      lines.push(`${num}:  no reply`);
      continue;
    }
    const ip = hop.probes[0].ip ?? '???';
    const rtt = hop.probes.find((p) => p.rttMs !== undefined)?.rttMs;
    const temps = rtt === undefined ? '' : `${rtt.toFixed(3)}ms`;
    const atteint = reachedAt === hop.hop ? ' reached' : '';
    lines.push(`${num}:  ${ip.padEnd(32)}${temps}${atteint}`);
  }
  return lines;
}

export const tracepathCommand: LinuxCommand = {
  name: 'tracepath',
  needsNetworkContext: true,
  manSection: 8,
  usage: USAGE,
  help: 'Traces path to a network host discovering MTU along this path.',
  options: [
    { flag: '-n', description: 'Print numeric addresses without DNS lookup.' },
    { flag: '-b', description: 'Print both host names and numeric addresses.' },
    { flag: '-m', description: 'Maximum number of hops.', takesArg: true, argName: 'max_hops' },
    { flag: '-l', description: 'Initial packet length.', takesArg: true, argName: 'pktlen' },
    { flag: '-p', description: 'Initial destination port.', takesArg: true, argName: 'port' },
  ],
  complete: makeArgCompleter({ flags: ['-4', '-6', '-n', '-b', '-l', '-m', '-p'], hostsAtBarePosition: true }),
  run: async (ctx, args) => {
    const parsed = parseTracepathArgs(args);
    if (parsed.showHelp) return USAGE;
    if (parsed.parseError) return parsed.parseError;
    if (!parsed.target) return USAGE;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.target) && !isValidIPv4(parsed.target)) {
      return `tracepath: invalid address: ${parsed.target}`;
    }

    let ip = await ctx.net.resolveHostname(parsed.target);
    if (!ip && parsed.target.toLowerCase() === 'localhost') {
      try { ip = new IPAddress('127.0.0.1'); } catch { /* rien */ }
    }
    if (!ip) return `tracepath: ${parsed.target}: Name or service not known`;

    const maxHops = Math.min(parsed.maxHops, 8);
    const hops = await ctx.net.traceroute(ip, maxHops, 1, 1, 100);
    // La MTU rendue est celle de l'interface de sortie : c'est la seule
    // que la machine connaisse réellement (voir l'en-tête).
    const mtu = [...ctx.net.getPorts().values()]
      .map((p) => (p as unknown as { getMTU?: () => number }).getMTU?.())
      .find((m): m is number => typeof m === 'number') ?? 1500;

    const cible = ip.toString();
    const reachedAt = hops.find((h) => h.probes?.some((p) => p.ip === cible))?.hop ?? null;
    const lines = formatTracepathLines(hops, mtu, reachedAt);
    const back = reachedAt ?? hops.length;
    lines.push(`     Resume: pmtu ${mtu} hops ${back} back ${back}`);
    return lines.join('\n');
  },
};
