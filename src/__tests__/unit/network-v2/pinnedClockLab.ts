export const PINNED_LAB_EPOCH_MS = new Date(2026, 5, 20).getTime();

export function pinClock(machine: { _setSystemClock(epochMs: number): void }): void {
  machine._setSystemClock(PINNED_LAB_EPOCH_MS);
}
