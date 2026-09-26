import type { WinCommandContext } from './WinCommandExecutor';
import { IPAddress, IPv6Address } from '../../core/types';
import { isValidIPv4 } from '@/network/core/ip';
import { unquote } from '@/lib/format';
import { winUnreachText } from './WinPing';

function isIPv6Literal(target: string): boolean {
  try { new IPv6Address(target); return true; } catch { return false; }
}

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

interface TracertHopView {
  hop: number;
  ip?: string;
  rttMs?: number;
  timeout: boolean;
  unreachable?: boolean;
  icmpCode?: number;
  probes?: Array<{ responded: boolean; rttMs?: number }>;
}

export interface ParsedWinTracert {
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

function isInteger(s: string, allowNeg = false): boolean {
  if (allowNeg) return /^-?\d+$/.test(s);
  return /^\d+$/.test(s);
}

export function parseWinTracertArgs(args: string[]): ParsedWinTracert {
  const result: ParsedWinTracert = {
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

export function formatWinTracertHeader(target: IPAddress, maxHops: number, hostname?: string): string[] {
  if (hostname) {
    return ['', `Tracing route to ${hostname} [${target}]`, `over a maximum of ${maxHops} hops:`, ''];
  }
  return ['', `Tracing route to ${target} over a maximum of ${maxHops} hops`, ''];
}

const TRACERT_TIMEOUT_CELL = '     *   ';

function tracertTimeCell(rttMs: number | undefined): string {
  const ms = Math.round(rttMs ?? 0);
  return `${ms < 1 ? '<1' : String(ms)} ms`.padStart(9);
}

export function formatWinTracertHop(hop: TracertHopView, nameOf?: (ip: string) => string | null): string {
  const num = String(hop.hop).padStart(3);
  const shown = (ip: string) => {
    const name = nameOf?.(ip) ?? null;
    return name === null ? ip : `${name} [${ip}]`;
  };
  if (hop.unreachable && hop.ip !== undefined) {
    return `${num}  ${shown(hop.ip)}  reports: ${winUnreachText(hop.icmpCode)}`;
  }
  if (hop.timeout && (!hop.probes || hop.probes.every(p => !p.responded))) {
    return `${num}${TRACERT_TIMEOUT_CELL.repeat(3)}  Request timed out.`;
  }
  let cells: string[];
  if (hop.probes && hop.probes.length > 0) {
    cells = hop.probes.map((probe) =>
      probe.responded ? tracertTimeCell(probe.rttMs) : TRACERT_TIMEOUT_CELL);
    while (cells.length < 3) cells.push(TRACERT_TIMEOUT_CELL);
  } else {
    cells = [0, 1, 2].map(() => tracertTimeCell(hop.rttMs));
  }
  return `${num}${cells.join('')}  ${shown(hop.ip ?? '')}`;
}

export interface TracertHost {
  resolveHostname(name: string): Promise<IPAddress | null>;
  reverseLookup?(ip: string): string | null;
  trace(
    target: IPAddress, maxHops: number, timeoutMs: number,
    onHop: (hop: TracertHopView) => void, shouldStop: () => boolean,
  ): Promise<number>;
}

const PROBE_WAIT_CAP_MS = 80;

export async function runTracert(
  args: string[], host: TracertHost, emit: (line: string) => void,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  if (args.length === 0) { emit(TRACERT_HELP); return; }
  const parsed = parseWinTracertArgs(args);
  if (parsed.showHelp) { emit(TRACERT_HELP); return; }
  if (parsed.parseError) { emit(parsed.parseError); return; }
  if (parsed.extraTargets.length > 0) { emit(`Invalid parameter: ${parsed.extraTargets[0]}.`); return; }
  if (!parsed.targetStr) { emit(TRACERT_HELP); return; }
  if (parsed.looseSourceRoute !== undefined) {
    emit('tracert: -j: this simulator has no loose source route IP option on its probes');
    return;
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.targetStr) && !isValidIPv4(parsed.targetStr)) {
    emit(`Unable to resolve target system name ${parsed.targetStr}. Invalid address.`);
    return;
  }
  if (parsed.targetStr.length > 253 || parsed.targetStr.split('.').some(lbl => lbl.length > 63)) {
    emit(`Unable to resolve target system name ${parsed.targetStr}. Failed to resolve.`);
    return;
  }
  if (isIPv6Literal(parsed.targetStr)) { emit('Unable to contact IP driver. General failure.'); return; }

  const targetIP = await host.resolveHostname(parsed.targetStr);
  if (!targetIP) { emit(`Unable to resolve target system name ${parsed.targetStr}.`); return; }

  const nameOf = parsed.numeric ? undefined : (ip: string) => host.reverseLookup?.(ip) ?? null;
  const hostname = parsed.targetStr !== targetIP.toString()
    ? parsed.targetStr
    : nameOf?.(targetIP.toString()) ?? undefined;
  for (const line of formatWinTracertHeader(targetIP, parsed.maxHops, hostname)) emit(line);
  const traced = await host.trace(
    targetIP, parsed.maxHops, Math.min(parsed.timeoutMs, PROBE_WAIT_CAP_MS),
    (hop) => emit(formatWinTracertHop(hop, nameOf)), shouldStop);
  if (shouldStop()) return;
  if (traced === 0) emit('  1  Transmit error: code 1231.');
  emit('');
  emit('Trace complete.');
}

export async function cmdTracert(ctx: WinCommandContext, args: string[]): Promise<string> {
  const lines: string[] = [];
  await runTracert(args, tracertHostOf(ctx), (line) => lines.push(line));
  return lines.join('\n');
}

export function tracertHostOf(ctx: WinCommandContext): TracertHost {
  return {
    resolveHostname: (name) => ctx.resolveHostname(name),
    reverseLookup: ctx.reverseLookup === undefined ? undefined : (ip) => ctx.reverseLookup!(ip),
    trace: async (target, maxHops, timeoutMs, onHop, stop) =>
      (await ctx.executeTraceroute(target, maxHops, timeoutMs, { onHop, shouldStop: stop })).length,
  };
}
