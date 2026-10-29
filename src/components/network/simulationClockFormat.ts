import type { MessageKey } from '@/i18n';

export const SIMULATION_JUMPS: readonly {
  readonly labelKey: MessageKey; readonly spanKey: MessageKey; readonly ms: number;
}[] = [
  { labelKey: 'clock.jumpMinute', spanKey: 'clock.spanMinute', ms: 60_000 },
  { labelKey: 'clock.jumpHour', spanKey: 'clock.spanHour', ms: 3_600_000 },
  { labelKey: 'clock.jumpDay', spanKey: 'clock.spanDay', ms: 86_400_000 },
];

export const DISPLAY_REFRESH_MS = 250;

export function formatSimulatedInstant(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatSpeed(speed: number): string {
  return `×${speed}`;
}

