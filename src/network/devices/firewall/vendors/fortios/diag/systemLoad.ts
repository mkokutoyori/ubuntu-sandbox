import { renderTable, FIXED_TABLE } from '../../../../shells/cli/TextTable';
import type { CpuStates, MemoryStates, SystemLoad } from '../../../health/SystemLoad';

export function cpuStatesLine(label: string, states: CpuStates): string {
  return `${label} states: ${states.user}% user ${states.system}% system `
    + `${states.nice}% nice ${states.idle}% idle ${states.iowait}% iowait `
    + `${states.irq}% irq ${states.softirq}% softirq`;
}

export function cpuStatesLines(load: SystemLoad): string[] {
  const states = load.cpuStates();
  const lines = [cpuStatesLine('CPU', states)];
  for (let index = 0; index < load.cpuCount(); index++) {
    lines.push(cpuStatesLine(`CPU${index}`, states));
  }
  return lines;
}

export function memoryLine(memory: MemoryStates): string {
  const share = (value: number) => ((value / memory.totalKib) * 100).toFixed(1);
  return `Memory: ${memory.totalKib}k total, `
    + `${memory.usedKib}k used (${share(memory.usedKib)}%), `
    + `${memory.freeKib}k free (${share(memory.freeKib)}%), `
    + `${memory.freeableKib}k freeable (${share(memory.freeableKib)}%)`;
}

export function sysTopCpuLine(load: SystemLoad): string {
  const states = load.cpuStates();
  const memory = load.memory();
  return `${states.user}U, ${states.nice}N, ${states.system}S, ${states.idle}I, `
    + `${states.iowait}WA, ${states.irq}HI, ${states.softirq}SI, 0ST; `
    + `${Math.round(memory.totalKib / 1024)}T, ${Math.round(memory.freeKib / 1024)}F`;
}

interface ConserveRow {
  readonly label: string;
  readonly value: string;
  readonly share: string;
}

export function conserveModeLines(load: SystemLoad): readonly string[] {
  const memory = load.memory();
  const thresholds = load.getThresholds();
  const conserving = load.inConserveMode();

  const megabytes = (kib: number) => `${Math.round(kib / 1024)} MB`;
  const share = (kib: number) =>
    `${Math.round((kib / memory.totalKib) * 100)}% of total RAM`;
  const at = (percent: number) => Math.round((memory.totalKib * percent) / 100);

  const rows: ConserveRow[] = [
    { label: 'memory conserve mode:', value: conserving ? 'on' : 'off', share: '' },
    { label: 'total RAM:', value: megabytes(memory.totalKib), share: '' },
    {
      label: 'memory used:', value: megabytes(memory.usedKib),
      share: share(memory.usedKib),
    },
    {
      label: 'memory freeable:', value: megabytes(memory.freeableKib),
      share: share(memory.freeableKib),
    },
    {
      label: 'memory used + freeable threshold extreme:',
      value: megabytes(at(thresholds.extremePercent)),
      share: `${thresholds.extremePercent}% of total RAM`,
    },
    {
      label: 'memory used threshold red:',
      value: megabytes(at(thresholds.redPercent)),
      share: `${thresholds.redPercent}% of total RAM`,
    },
    {
      label: 'memory used threshold green:',
      value: megabytes(at(thresholds.greenPercent)),
      share: `${thresholds.greenPercent}% of total RAM`,
    },
  ];

  return Object.freeze(renderTable(rows, [
    { header: '', width: 44, value: (row) => row.label },
    { header: '', width: 11, align: 'right', value: (row) => row.value },
    { header: '', width: 3, value: () => '' },
    { header: '', value: (row) => row.share },
  ], { ...FIXED_TABLE, header: false }));
}

export function procMeminfoLines(load: SystemLoad): readonly string[] {
  const memory = load.memory();
  const ligne = (cle: string, kib: number): string =>
    `${(cle + ':').padEnd(16)}${String(kib).padStart(8)} kB`;
  return [
    ligne('MemTotal', memory.totalKib),
    ligne('MemFree', memory.freeKib),
    ligne('MemShared', 0),
    ligne('Buffers', 0),
    ligne('Cached', memory.freeableKib),
    ligne('SwapCached', 0),
    ligne('HighTotal', 0),
    ligne('HighFree', 0),
    ligne('LowTotal', memory.totalKib),
    ligne('LowFree', memory.freeKib),
    ligne('SwapTotal', 0),
    ligne('SwapFree', 0),
  ];
}
