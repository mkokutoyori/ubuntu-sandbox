/**
 * Shared Cisco IOS `ping` helpers.
 *
 * The argument parsing and the `Success rate is N percent` rendering are
 * identical on routers and Layer-2 switches (management plane), so they live
 * here as a single source of truth instead of being copied into each shell.
 */

/** One probe outcome, as produced by a device's `executePingSequence`. */
export interface CiscoPingRow {
  success: boolean;
  rttMs: number;
  ttl: number;
  seq: number;
  fromIP: string;
  error?: string;
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
  /** Set when the target is missing or malformed — caller should echo it. */
  error?: string;
}

/**
 * Parse the tail of an IOS `ping <target> [repeat N] [timeout S] [size B]
 * [source X]` command. Returns an `error` string (IOS-worded) when the
 * target is absent or not a dotted-quad.
 */
export function parsePingArgs(args: string[]): ParsedPing {
  const base: ParsedPing = {
    target: '', count: 5, timeoutMs: 2000, sizeBytes: 100, sourceIP: null,
  };
  if (args.length === 0) {
    return { ...base, error: '% Ping requires a target IP address.' };
  }

  let i = 0;
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
  const m = base.target.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m || [+m[1], +m[2], +m[3], +m[4]].some(o => o > 255)) {
    return { ...base, error: '% Unrecognized host or address, or protocol not running.' };
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

  const chars = results.map(r => (r.success ? '!' : '.'));
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
