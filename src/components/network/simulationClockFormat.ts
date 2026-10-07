export const SIMULATION_JUMPS: readonly { readonly label: string; readonly ms: number }[] = [
  { label: '+1 min', ms: 60_000 },
  { label: '+1 h', ms: 3_600_000 },
  { label: '+1 d', ms: 86_400_000 },
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

