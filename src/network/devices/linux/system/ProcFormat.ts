/**
 * ProcFormat — shared process-metrics formatting utilities.
 *
 * `ps` and `top` previously each carried their own copies of the
 * clock / CPU-time / memory-percentage formatters. Centralising them
 * here removes the duplication (DRY) and guarantees both commands
 * render identical values for the same process.
 */

const TOTAL_MEM_KB = 4_000_000;

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** Wall-clock HH:MM used for the STIME / START columns. */
export function formatClock(d: Date): string {
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Accumulated CPU time as MM:SS (the ps/top TIME column). */
export function formatCpuTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${two(Math.floor(total / 60))}:${two(total % 60)}`;
}

/** RSS as a percentage of (simulated) total memory, one decimal. */
export function memPercent(rssKb: number): string {
  return ((rssKb / TOTAL_MEM_KB) * 100).toFixed(1);
}

/** KB → integer MiB (top VIRT/RES columns). */
export function kbToMiB(kb: number): number {
  return Math.floor(kb / 1024);
}
