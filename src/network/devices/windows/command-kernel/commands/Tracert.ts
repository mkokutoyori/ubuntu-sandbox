import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { isValidIPv4 } from '@/network/core/ip';
import { unquote } from '@/lib/format';
import { IPv6Address } from '@/network/core/types';
import type { WindowsTracerouteHop } from '@/command-kernel/machine/types';

const TRACERT_HELP = `
Usage: tracert [-d] [-h maximum_hops] [-j host-list] [-w timeout]
               [-R] [-S srcaddr] [-4] [-6] target_name

Options:
    -d                 Do not resolve addresses to hostnames.
    -h maximum_hops    Maximum number of hops to search for target.
    -j host-list       Loose source route along host-list (IPv4-only).
    -w timeout         Wait timeout milliseconds for each reply.
    -R                 Trace round-trip path (IPv6-only).
    -S srcaddr         Source address to use (IPv6-only).
    -4                 Force using IPv4.
    -6                 Force using IPv6.`.trim();

interface ParsedTracert {
  targetStr: string;
  maxHops: number;
  timeoutMs: number;
  numeric: boolean;
  srcAddr?: string;
  looseSourceRoute?: string;
  forceV4: boolean;
  forceV6: boolean;
  showHelp: boolean;
  parseError?: string;
  extraTargets: string[];
}

function isIPv6Literal(target: string): boolean {
  try { new IPv6Address(target); return true; } catch { return false; }
}

function isInteger(s: string, allowNeg = false): boolean {
  if (allowNeg) return /^-?\d+$/.test(s);
  return /^\d+$/.test(s);
}

function parseTracertArgs(args: string[]): ParsedTracert {
  const result: ParsedTracert = {
    targetStr: '',
    maxHops: 30,
    timeoutMs: 4000,
    numeric: false,
    forceV4: false,
    forceV6: false,
    showHelp: false,
    extraTargets: [],
  };

  const expanded: string[] = [];
  for (const a of args) {
    const m = a.match(/^(-[hwj])(.+)$/);
    if (m && /^[0-9]/.test(m[2])) {
      expanded.push(m[1], m[2]);
    } else {
      expanded.push(a);
    }
  }

  for (let i = 0; i < expanded.length; i++) {
    const a = expanded[i];
    const aLower = a.toLowerCase();
    const next = expanded[i + 1];

    if (a === '/?' || a === '/help' || aLower === '--help') {
      result.showHelp = true; continue;
    }
    if (aLower === '-d') { result.numeric = true; continue; }
    if (aLower === '-r') { continue; }
    if (aLower === '-4') { result.forceV4 = true; continue; }
    if (aLower === '-6') { result.forceV6 = true; continue; }

    if (aLower === '-h') {
      if (!next) { result.parseError = TRACERT_HELP; return result; }
      if (!isInteger(next, true)) {
        result.parseError = `Invalid value for option -h, valid range is from 1 to 255.`; return result;
      }
      const v = parseInt(next, 10);
      if (v < 1 || v > 255) {
        result.parseError = `Invalid value for option -h, valid range is from 1 to 255.`; return result;
      }
      result.maxHops = v; i++; continue;
    }

    if (aLower === '-w') {
      if (!next) { result.parseError = TRACERT_HELP; return result; }
      if (!isInteger(next, true)) {
        result.parseError = `Invalid value for option -w.`; return result;
      }
      const v = parseInt(next, 10);
      if (v < 0) {
        result.parseError = `Invalid value for option -w (must be >= 0).`; return result;
      }
      result.timeoutMs = v; i++; continue;
    }

    if (aLower === '-j') {
      if (!next) { result.parseError = TRACERT_HELP; return result; }
      const list = unquote(next).split(/[,\s]+/).filter(Boolean);
      for (const h of list) {
        if (!isValidIPv4(h)) {
          result.parseError = `Invalid host-list (-j) — invalid IP: ${h}.`; return result;
        }
      }
      result.looseSourceRoute = list.join(','); i++; continue;
    }

    if (aLower === '-s') {
      if (!next) { result.parseError = TRACERT_HELP; return result; }
      const cleaned = unquote(next);
      if (!isValidIPv4(cleaned) && !cleaned.includes(':')) {
        result.parseError = `Invalid source address: ${next}.`; return result;
      }
      result.srcAddr = cleaned; i++; continue;
    }

    if (a.startsWith('-') || a.startsWith('/')) continue;

    const cleaned = unquote(a);
    if (!cleaned) continue;
    if (result.targetStr === '') {
      result.targetStr = cleaned;
    } else {
      result.extraTargets.push(cleaned);
    }
  }

  return result;
}

function formatTracertHeader(target: string, maxHops: number, hostname?: string): string[] {
  const dest = hostname ? `${hostname} [${target}]` : target;
  return ['', `Tracing route to ${dest} over a maximum of ${maxHops} hops:`, ''];
}

function formatTracertHop(hop: WindowsTracerouteHop): string {
  const num = String(hop.hop).padStart(2);
  const slot = '*'.padStart(5).padEnd(8);

  if (hop.timeout && (!hop.probes || hop.probes.every((p) => !p.responded))) {
    return `  ${num}     * * *     Request timed out.`;
  }

  let line: string;
  if (hop.probes && hop.probes.length > 0) {
    const cols: string[] = [];
    for (const probe of hop.probes) {
      if (!probe.responded) cols.push(slot);
      else {
        const ms = Math.round(probe.rttMs ?? 0);
        cols.push((ms < 1 ? '<1 ms' : `${ms} ms`).padEnd(8));
      }
    }
    while (cols.length < 3) cols.push(slot);
    line = `  ${num}    ${cols.join(' ')} ${hop.ip}`;
  } else {
    const ms = Math.round(hop.rttMs ?? 0);
    const msStr = (ms < 1 ? '<1 ms' : `${ms} ms`).padEnd(8);
    line = `  ${num}    ${msStr} ${msStr} ${msStr} ${hop.ip}`;
  }
  if (hop.unreachable) line += '\n        Destination net unreachable.';
  return line;
}

function formatNumericHopLine(hop: WindowsTracerouteHop): string {
  const num = String(hop.hop).padStart(2);
  if (hop.timeout && (!hop.probes || hop.probes.every((p) => !p.responded))) {
    return `  ${num}     *        *        *     ${hop.ip ?? ''}`;
  }
  if (hop.probes && hop.probes.length > 0) {
    const cols: string[] = [];
    for (const probe of hop.probes) {
      if (!probe.responded) cols.push('*       ');
      else cols.push(`${Math.round(probe.rttMs ?? 0)}      `.slice(0, 8));
    }
    while (cols.length < 3) cols.push('*       ');
    return `  ${num}    ${cols.join(' ')} ${hop.ip}`;
  }
  const r = Math.round(hop.rttMs ?? 0);
  return `  ${num}    ${r}        ${r}        ${r}     ${hop.ip}`;
}

export class TracertCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'tracert',
    summary: 'Trace le chemin réseau vers un hôte',
    usage: TRACERT_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options tracert' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'réseau',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (!ctx.machine.netConfig) {
      await ctx.io.stdout.write('TRACERT: not supported on this device\n');
      return 1;
    }

    if (args.length === 0) {
      await ctx.io.stdout.write(TRACERT_HELP + '\n');
      return EXIT_OK;
    }

    const parsed = parseTracertArgs(args);

    if (parsed.showHelp) {
      await ctx.io.stdout.write(TRACERT_HELP + '\n');
      return EXIT_OK;
    }
    if (parsed.parseError) {
      await ctx.io.stdout.write(parsed.parseError + '\n');
      return 1;
    }

    if (parsed.extraTargets.length > 0) {
      await ctx.io.stdout.write(`Invalid parameter: ${parsed.extraTargets[0]}.\n`);
      return 1;
    }

    if (!parsed.targetStr) {
      await ctx.io.stdout.write(TRACERT_HELP + '\n');
      return EXIT_OK;
    }

    if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.targetStr) && !isValidIPv4(parsed.targetStr)) {
      await ctx.io.stdout.write(`Unable to resolve target system name ${parsed.targetStr}. Invalid address.\n`);
      return 1;
    }

    if (parsed.targetStr.length > 253 ||
        parsed.targetStr.split('.').some((lbl) => lbl.length > 63)) {
      await ctx.io.stdout.write(`Unable to resolve target system name ${parsed.targetStr}. Failed to resolve.\n`);
      return 1;
    }

    if (isIPv6Literal(parsed.targetStr)) {
      await ctx.io.stdout.write(`Unable to contact IP driver. General failure.\n`);
      return 1;
    }

    const targetIP = await ctx.machine.netConfig.resolveHostname(parsed.targetStr);
    if (!targetIP) {
      await ctx.io.stdout.write(`Unable to resolve target system name ${parsed.targetStr}.\n`);
      return 1;
    }

    const probeTimeoutMs = Math.min(parsed.timeoutMs, 200);
    const effectiveMaxHops = Math.min(parsed.maxHops, 8);
    const isLoopback = targetIP === '127.0.0.1' || targetIP.startsWith('127.') || targetIP === '::1';

    let hops = await ctx.machine.netConfig.traceroute(targetIP, effectiveMaxHops, probeTimeoutMs);
    if (hops.length === 0) {
      const built: WindowsTracerouteHop[] = [];
      if (isLoopback) {
        built.push({ hop: 1, ip: targetIP, rttMs: 0, timeout: false, probes: [{ responded: true, rttMs: 0 }, { responded: true, rttMs: 0 }, { responded: true, rttMs: 0 }] });
      } else {
        const gw = ctx.machine.netConfig.routes().find((r) => r.type === 'default')?.nextHop ?? null;
        if (gw) {
          built.push({ hop: 1, ip: gw, rttMs: 1, timeout: false, probes: [{ responded: true, rttMs: 1 }, { responded: true, rttMs: 1 }, { responded: true, rttMs: 1 }] });
          for (let i = 2; i <= Math.min(3, parsed.maxHops); i++) {
            built.push({ hop: i, timeout: true, probes: [] });
          }
        } else {
          for (let i = 1; i <= Math.min(3, parsed.maxHops); i++) {
            built.push({ hop: i, timeout: true, probes: [] });
          }
        }
      }
      hops = built;
    }

    const hostname = parsed.targetStr !== targetIP ? parsed.targetStr : undefined;

    if (parsed.numeric) {
      const lines: string[] = [];
      for (const hop of hops) lines.push(formatNumericHopLine(hop));
      await ctx.io.stdout.write(lines.join('\n') + '\n');
      return EXIT_OK;
    }

    const lines = [...formatTracertHeader(targetIP, parsed.maxHops, hostname)];
    for (const hop of hops) {
      let line = formatTracertHop(hop);
      if (hop.ip) {
        const name = ctx.machine.netConfig.reverseLookup(hop.ip);
        if (name) {
          const esc = hop.ip.replace(/\./g, '\\.');
          line = line.replace(new RegExp(`${esc}$`), `${name} [${hop.ip}]`);
        }
      }
      lines.push(line);
    }
    lines.push('');
    lines.push('Trace complete.');
    await ctx.io.stdout.write(lines.join('\n') + '\n');
    return EXIT_OK;
  }
}
