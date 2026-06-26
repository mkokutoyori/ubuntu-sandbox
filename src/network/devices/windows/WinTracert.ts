import type { WinCommandContext } from './WinCommandExecutor';
import { IPAddress } from '../../core/types';

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

function isValidIPv4(addr: string): boolean {
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  return parts.every(p => {
    const n = parseInt(p, 10);
    return !isNaN(n) && n >= 0 && n <= 255 && String(n) === p;
  });
}

function unquote(s: string): string {
  return s.replace(/^['"]|['"]$/g, '');
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
  const dest = hostname ? `${hostname} [${target}]` : `${target}`;
  return ['', `Tracing route to ${dest} over a maximum of ${maxHops} hops:`, ''];
}

export function formatWinTracertHop(hop: TracertHopView): string {
  const num = String(hop.hop).padStart(2);
  const slot = '*'.padStart(5).padEnd(8);

  if (hop.timeout && (!hop.probes || hop.probes.every(p => !p.responded))) {
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

function formatNumericHopLine(hop: TracertHopView): string {
  const num = String(hop.hop).padStart(2);
  if (hop.timeout && (!hop.probes || hop.probes.every(p => !p.responded))) {
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

export async function cmdTracert(ctx: WinCommandContext, args: string[]): Promise<string> {
  if (args.length === 0) return TRACERT_HELP;

  const parsed = parseWinTracertArgs(args);

  if (parsed.showHelp) return TRACERT_HELP;
  if (parsed.parseError) return parsed.parseError;

  if (parsed.extraTargets.length > 0) {
    return `Invalid parameter: ${parsed.extraTargets[0]}.`;
  }

  if (!parsed.targetStr) return TRACERT_HELP;

  if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.targetStr) && !isValidIPv4(parsed.targetStr)) {
    return `Unable to resolve target system name ${parsed.targetStr}. Invalid address.`;
  }

  if (parsed.targetStr.length > 253 ||
      parsed.targetStr.split('.').some(lbl => lbl.length > 63)) {
    return `Unable to resolve target system name ${parsed.targetStr}. Failed to resolve.`;
  }

  const targetIP = await ctx.resolveHostname(parsed.targetStr);
  if (!targetIP) {
    return `Unable to resolve target system name ${parsed.targetStr}.`;
  }

  const probeTimeoutMs = Math.min(parsed.timeoutMs, 200);
  const targetStr = targetIP.toString();
  const isLoopback = targetStr === '127.0.0.1' || targetStr.startsWith('127.') || targetStr === '::1';

  let hops = await ctx.executeTraceroute(targetIP, parsed.maxHops, probeTimeoutMs);
  if (hops.length === 0) {
    hops = [];
    if (isLoopback) {
      hops.push({ hop: 1, ip: targetStr, rttMs: 0, timeout: false, probes: [{ responded: true, rttMs: 0 }, { responded: true, rttMs: 0 }, { responded: true, rttMs: 0 }] });
    } else {
      const gw = ctx.defaultGateway;
      if (gw) {
        hops.push({ hop: 1, ip: gw, rttMs: 1, timeout: false, probes: [{ responded: true, rttMs: 1 }, { responded: true, rttMs: 1 }, { responded: true, rttMs: 1 }] });
        for (let i = 2; i <= Math.min(3, parsed.maxHops); i++) {
          hops.push({ hop: i, timeout: true, probes: [] });
        }
      } else {
        for (let i = 1; i <= Math.min(3, parsed.maxHops); i++) {
          hops.push({ hop: i, timeout: true, probes: [] });
        }
      }
    }
  }

  const hostname = parsed.targetStr !== targetIP.toString() ? parsed.targetStr : undefined;

  if (parsed.numeric) {
    const lines: string[] = [];
    for (const hop of hops) lines.push(formatNumericHopLine(hop as TracertHopView));
    return lines.join('\n');
  }

  const lines = [...formatWinTracertHeader(targetIP, parsed.maxHops, hostname)];
  for (const hop of hops) lines.push(formatWinTracertHop(hop as TracertHopView));
  lines.push('');
  lines.push('Trace complete.');
  return lines.join('\n');
}
