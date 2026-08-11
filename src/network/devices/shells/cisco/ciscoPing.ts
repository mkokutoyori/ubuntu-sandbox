/**
 * Shared Cisco IOS `ping` helpers.
 *
 * The argument parsing and the `Success rate is N percent` rendering are
 * identical on routers and Layer-2 switches (management plane), so they live
 * here as a single source of truth instead of being copied into each shell.
 */

/**
 * Why a probe ended. IOS prints one character per probe and the character
 * IS the diagnosis, so the cause has to survive all the way from the ICMP
 * layer to the renderer rather than being flattened into "failed".
 */
export type CiscoPingFailure =
  /** Nothing came back before the timeout. */
  | 'timeout'
  /** An ICMP Destination Unreachable was received (type 3, any code but 4). */
  | 'unreachable'
  /** An ICMP Time Exceeded was received (type 11). */
  | 'ttl-exceeded'
  /** An ICMP Fragmentation Needed was received while DF was set (type 3 code 4). */
  | 'frag-needed';

/** One probe outcome, as produced by a device's `executePingSequence`. */
export interface CiscoPingRow {
  success: boolean;
  rttMs: number;
  ttl: number;
  seq: number;
  fromIP: string;
  error?: CiscoPingFailure | string;
}

/**
 * The IOS character for one probe. A reply is `!`; silence is `.`; every
 * other mark means a router actually answered with an ICMP error, which
 * is precisely what makes them worth distinguishing when troubleshooting.
 */
export function ciscoPingMark(row: CiscoPingRow): string {
  if (row.success) return '!';
  switch (row.error) {
    case 'unreachable': return 'U';
    case 'ttl-exceeded': return '&';
    case 'frag-needed': return 'M';
    default: return '.';
  }
}

/** Upper bound on `ping … repeat N` the simulator will drive synchronously. */
export const MAX_PING_REPEAT = 10000;

export interface ParsedPing {
  target: string;
  count: number;
  timeoutMs: number;
  /** Datagram size in bytes (IOS default 100). */
  sizeBytes: number;
  sourceIP: string | null;
  /** Which protocol the target belongs to — IOS keys the whole probe on it. */
  protocol: 'ip' | 'ipv6';
  /** Set when the target is missing or malformed — caller should echo it. */
  error?: string;
}

/**
 * IOS accepts `ping ipv6 <addr>` and a bare `ping <addr>` alike, so the
 * family has to be decided from the literal rather than from a keyword.
 * A colon is what no IPv4 literal can carry.
 */
export function looksLikeIPv6(target: string): boolean {
  if (!target.includes(':')) return false;
  return /^[0-9a-fA-F:]+(:\d{1,3}(\.\d{1,3}){3})?(%[^\s]+)?$/.test(target)
    && !/:::/.test(target)
    && (target.match(/::/g)?.length ?? 0) <= 1;
}

/**
 * Parse the tail of an IOS `ping <target> [repeat N] [timeout S] [size B]
 * [source X]` command. Returns an `error` string (IOS-worded) when the
 * target is absent or not a dotted-quad.
 */
export function estUneAdresseLitterale(target: string): boolean {
  const t = target.trim();
  if (t.length === 0) return false;
  if (looksLikeIPv6(t)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(t);
  return m !== null && [+m[1], +m[2], +m[3], +m[4]].every((o) => o <= 255);
}

export function parsePingArgs(args: string[]): ParsedPing {
  const base: ParsedPing = {
    target: '', count: 5, timeoutMs: 2000, sizeBytes: 100, sourceIP: null, protocol: 'ip',
  };
  if (args.length === 0) {
    return { ...base, error: '% Ping requires a target IP address.' };
  }

  let i = 0;
  // `ping ip <addr>` and `ping ipv6 <addr>` name the protocol first; the
  // keyword only says which family follows, never which target.
  const first = args[0]?.trim().toLowerCase();
  if (first === 'ipv6' || first === 'ip') {
    base.protocol = first === 'ipv6' ? 'ipv6' : 'ip';
    i++;
    if (i >= args.length) {
      return { ...base, error: '% Ping requires a target IP address.' };
    }
  }
  base.target = args[i++]?.trim() || '';

  while (i < args.length) {
    const kw = args[i]?.toLowerCase();
    if (kw === 'source' && args[i + 1]) {
      base.sourceIP = args[i + 1];
      i += 2;
    } else if (kw === 'repeat' && args[i + 1]) {
      const n = parseInt(args[i + 1], 10);
      if (!isNaN(n) && n > 0) base.count = n;
      i += 2;
    } else if (kw === 'timeout' && args[i + 1]) {
      const n = parseInt(args[i + 1], 10);
      if (!isNaN(n) && n > 0) base.timeoutMs = n * 1000;
      i += 2;
    } else if (kw === 'size' && args[i + 1]) {
      const n = parseInt(args[i + 1], 10);
      if (!isNaN(n) && n > 0) base.sizeBytes = n;
      i += 2;
    } else {
      i++;
    }
  }

  if (!base.target) {
    return { ...base, error: '% Ping requires a target IP address.' };
  }
  if (base.protocol === 'ipv6' || looksLikeIPv6(base.target)) {
    if (!looksLikeIPv6(base.target)) {
      return { ...base, error: '% Unrecognized host or address, or protocol not running.' };
    }
    base.protocol = 'ipv6';
  } else {
    const m = base.target.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    const ressembleAUneAdresse = /^[\d.]+$/.test(base.target);
    if (ressembleAUneAdresse && (!m || [+m[1], +m[2], +m[3], +m[4]].some(o => o > 255))) {
      return { ...base, error: '% Unrecognized host or address, or protocol not running.' };
    }
  }
  // Practical simulator bounds (the probes are driven synchronously): a
  // multi-million `repeat` is rejected like an out-of-range IOS parameter.
  if (base.count > MAX_PING_REPEAT) {
    return { ...base, error: "% Invalid input detected at '^' marker." };
  }
  return base;
}

/**
 * Render the IOS ping transcript:
 *
 *   Type escape sequence to abort.
 *   Sending 5, 100-byte ICMP Echos to 10.0.0.1, timeout is 2 seconds:
 *   !!!!!
 *   Success rate is 100 percent (5/5), round-trip min/avg/max = 0/0/1 ms
 */
export function formatCiscoPing(
  target: string,
  count: number,
  timeoutMs: number,
  results: CiscoPingRow[],
  sizeBytes = 100,
): string {
  const lines: string[] = [];
  lines.push('Type escape sequence to abort.');
  lines.push(`Sending ${count}, ${sizeBytes}-byte ICMP Echos to ${target}, timeout is ${timeoutMs / 1000} seconds:`);

  const chars = results.map(ciscoPingMark);
  if (results.length === 0) {
    for (let i = 0; i < count; i++) chars.push('.');
  }
  lines.push(chars.join(''));

  lines.push(formatCiscoPingSummary(results, count));
  return lines.join('\n');
}

/**
 * Render the trailing `Success rate is …` line on its own, so the streaming
 * ping (which paints the `!!!!!` marks progressively) and the block ping share
 * one summary implementation.
 */
export function formatCiscoPingSummary(results: CiscoPingRow[], count: number): string {
  const successes = results.filter(r => r.success).length;
  const total = results.length || count;
  const pct = Math.round((successes / total) * 100);
  let summary = `Success rate is ${pct} percent (${successes}/${total})`;

  if (successes > 0) {
    const rtts = results.filter(r => r.success).map(r => r.rttMs);
    const min = Math.min(...rtts);
    const max = Math.max(...rtts);
    const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
    summary += `, round-trip min/avg/max = ${min.toFixed(0)}/${avg.toFixed(0)}/${max.toFixed(0)} ms`;
  }
  return summary;
}

// ── Extended ping ──────────────────────────────────────────────────

/**
 * Everything the IOS extended-ping dialog can set. The fields that reach
 * the packet are `count`, `sizeBytes`, `timeoutMs`, `sourceIP`, `tos` and
 * `df`; `sweep` turns one run into a series of increasing sizes.
 *
 * `validateReply`, `dataPattern` and the record-route options are part of
 * the dialog because IOS asks them, but the simulator has no payload
 * bytes to validate and no IP-option area to record a route in, so they
 * are collected and reported rather than silently pretended.
 */
export interface ExtendedPingParams {
  target: string;
  count: number;
  sizeBytes: number;
  timeoutMs: number;
  sourceIP: string | null;
  tos: number;
  df: boolean;
  validateReply: boolean;
  dataPattern: string;
  routeOptions: string;
  sweep: { min: number; max: number; interval: number } | null;
}

export function defaultExtendedPingParams(): ExtendedPingParams {
  return {
    target: '', count: 5, sizeBytes: 100, timeoutMs: 2000, sourceIP: null,
    tos: 0, df: false, validateReply: false, dataPattern: '0xABCD',
    routeOptions: 'none', sweep: null,
  };
}

/** The prompts, in IOS order. `extended` gates the middle block. */
export const EXTENDED_PING_PROMPTS = {
  protocol: 'Protocol [ip]:',
  target: 'Target IP address:',
  repeat: 'Repeat count [5]:',
  size: 'Datagram size [100]:',
  timeout: 'Timeout in seconds [2]:',
  extended: 'Extended commands [n]:',
  source: 'Source address or interface:',
  tos: 'Type of service [0]:',
  df: 'Set DF bit in IP header? [no]:',
  validate: 'Validate reply data? [no]:',
  pattern: 'Data pattern [0xABCD]:',
  routeOptions: 'Loose, Strict, Record, Timestamp, Verbose[none]:',
  sweep: 'Sweep range of sizes [n]:',
  sweepMin: 'Sweep min size [36]:',
  sweepMax: 'Sweep max size [18024]:',
  sweepInterval: 'Sweep interval [1]:',
} as const;

/** IOS treats an empty answer as the bracketed default. */
export function answerOr(value: string, fallback: string): string {
  const t = value.trim();
  return t === '' ? fallback : t;
}

export function isYes(value: string, fallback = false): boolean {
  const t = value.trim().toLowerCase();
  if (t === '') return fallback;
  return t === 'y' || t === 'yes';
}

/**
 * The size series a sweep produces: min, min+interval, … up to max. A
 * sweep is how an operator finds the real path MTU by hand, so the sizes
 * have to be genuinely sent, not summarised.
 */
export function sweepSizes(sweep: { min: number; max: number; interval: number }): number[] {
  const step = Math.max(1, Math.floor(sweep.interval));
  const sizes: number[] = [];
  for (let s = sweep.min; s <= sweep.max; s += step) sizes.push(s);
  return sizes;
}
