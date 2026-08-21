export const FORTI_VM_MEMORY_MB = 1985;
export const FORTI_VM_CPUS = 1;

export interface CpuStates {
  readonly user: number;
  readonly system: number;
  readonly nice: number;
  readonly idle: number;
  readonly iowait: number;
  readonly irq: number;
  readonly softirq: number;
}

export interface MemoryStates {
  readonly totalKib: number;
  readonly usedKib: number;
  readonly freeKib: number;
  readonly freeableKib: number;
}

export const CPU_STATES: CpuStates = Object.freeze({
  user: 0, system: 0, nice: 0, idle: 100, iowait: 0, irq: 0, softirq: 0,
});

export function memoryStates(): MemoryStates {
  const totalKib = FORTI_VM_MEMORY_MB * 1024;
  return Object.freeze({ totalKib, usedKib: 0, freeKib: totalKib, freeableKib: 0 });
}

export function cpuStatesLine(label: string): string {
  const s = CPU_STATES;
  return `${label} states: ${s.user}% user ${s.system}% system ${s.nice}% nice `
    + `${s.idle}% idle ${s.iowait}% iowait ${s.irq}% irq ${s.softirq}% softirq`;
}

export function sysTopCpuLine(): string {
  const s = CPU_STATES;
  const m = memoryStates();
  return `${s.user}U, ${s.nice}N, ${s.system}S, ${s.idle}I, ${s.iowait}WA, `
    + `${s.irq}HI, ${s.softirq}SI, 0ST; ${Math.round(m.totalKib / 1024)}T, `
    + `${Math.round(m.freeKib / 1024)}F`;
}

export function memoryLine(): string {
  const m = memoryStates();
  const pct = (value: number) => ((value / m.totalKib) * 100).toFixed(1);
  return `Memory: ${m.totalKib}k total, ${m.usedKib}k used (${pct(m.usedKib)}%), `
    + `${m.freeKib}k free (${pct(m.freeKib)}%), `
    + `${m.freeableKib}k freeable (${pct(m.freeableKib)}%)`;
}
