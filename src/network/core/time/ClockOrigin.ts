let origin: number | null = null;

export function setWindowsClockOrigin(epochMs: number | null): void {
  origin = epochMs;
}

export function windowsClockOrigin(): number | null {
  return origin;
}
