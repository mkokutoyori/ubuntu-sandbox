/**
 * Rendu de `top` (une frame) — fonction pure vivant dans la couche commande.
 * La commande façade `TopCommand` lit l'état de l'équipement (`processControl`,
 * `metrics`) puis délègue le formatage ici. Aucune dépendance à l'exécuteur.
 */
import { memPercent, kbToMiB } from '../../system/ProcFormat';

export interface TopProc {
  readonly pid: number;
  readonly user: string;
  readonly priority: number;
  readonly nice: number;
  readonly vsizeKib: number;
  readonly rssKib: number;
  readonly state: string;
  readonly cpuTimeMs: number;
  readonly comm: string;
}

export interface TopMemory {
  readonly totalKib: number;
  readonly usedKib: number;
  readonly freeKib: number;
  readonly buffCacheKib: number;
}

export interface TopInputs {
  readonly procs: readonly TopProc[];
  readonly memory: TopMemory;
  readonly uptimeSeconds: number;
  readonly now: Date;
}

function topCpuTime(ms: number): string {
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${min}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function loadAverage(running: number): string {
  const v = running.toFixed(2);
  return `${v}, ${v}, ${v}`;
}

export function renderTop(inputs: TopInputs): string {
  const { procs, memory, uptimeSeconds: upSec, now } = inputs;
  const timeStr = now.toLocaleTimeString('en-US', { hour12: false });
  const mib = (kib: number) => Math.round(kib / 1024);
  const totalMem = mib(memory.totalKib);
  const usedMem = mib(memory.usedKib);
  const freeMem = mib(memory.freeKib);
  const bufCache = mib(memory.buffCacheKib);

  const sleeping = procs.filter(p => p.state === 'S').length;
  const running = procs.filter(p => p.state === 'R').length;
  const stopped = procs.filter(p => p.state === 'T').length;
  const zombie = procs.filter(p => p.state === 'Z').length;

  const upDays = Math.floor(upSec / 86_400);
  const upH = Math.floor((upSec % 86_400) / 3600);
  const upM = Math.floor((upSec % 3600) / 60);
  const upClause = upDays > 0
    ? `${upDays} day${upDays > 1 ? 's' : ''}, ${upH}:${String(upM).padStart(2, '0')}`
    : upH > 0 ? `${upH}:${String(upM).padStart(2, '0')}` : `${upM} min`;
  const runnable = procs.filter(p => p.state === 'R' || p.state === 'D').length;

  const lines: string[] = [];
  lines.push(`top - ${timeStr} up  ${upClause},  1 user,  load average: ${loadAverage(runnable)}`);
  lines.push(`Tasks: ${procs.length} total,  ${running} running, ${sleeping} sleeping,  ${stopped} stopped,  ${zombie} zombie`);
  const busyPct = Math.min(100, running * 100);
  const us = (busyPct * 0.6).toFixed(1);
  const sy = (busyPct * 0.4).toFixed(1);
  const id = (100 - busyPct).toFixed(1);
  lines.push(`%Cpu(s):  ${us} us,  ${sy} sy,  0.0 ni,${id.padStart(5)} id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st`);
  lines.push(`MiB Mem :  ${totalMem}.0 total,  ${freeMem}.0 free,  ${usedMem}.0 used,  ${bufCache}.0 buff/cache`);
  lines.push('MiB Swap:  2048.0 total,  2048.0 free,      0.0 used.  2519.0 avail Mem');
  lines.push('');
  lines.push('    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND');

  for (const p of procs) {
    const pcpu = upSec > 0 ? ((p.cpuTimeMs / 1000) / upSec) * 100 : 0;
    lines.push([
      String(p.pid).padStart(7),
      p.user.padEnd(9),
      String(p.priority).padStart(3),
      String(p.nice).padStart(4),
      `${kbToMiB(p.vsizeKib)}M`.padStart(7),
      `${kbToMiB(p.rssKib)}M`.padStart(6),
      '4M'.padStart(6),
      p.state,
      pcpu.toFixed(1).padStart(5),
      memPercent(p.rssKib).padStart(5),
      topCpuTime(p.cpuTimeMs).padStart(9),
      p.comm,
    ].join(' '));
  }
  return lines.join('\n');
}
