let horizonMs = 0;
let cursorMs = 0;
let carriedDepth = 0;
let cascadeCounter = 0;
let currentCascade = 0;

export const PathClock = {
  now(): number {
    return carriedDepth === 0 ? horizonMs : cursorMs;
  },

  horizon(): number {
    return horizonMs;
  },

  cascadeId(): number | null {
    return carriedDepth === 0 ? null : currentCascade;
  },

  carry<T>(delayMs: number, deliver: () => T): T {
    const departure = PathClock.now();
    const arrival = departure + Math.max(0, delayMs);
    cursorMs = arrival;
    if (carriedDepth === 0) currentCascade = ++cascadeCounter;
    carriedDepth++;
    if (arrival > horizonMs) horizonMs = arrival;
    try {
      return deliver();
    } finally {
      carriedDepth--;
      cursorMs = departure;
    }
  },

  wait(delayMs: number): void {
    const resumedAt = PathClock.now() + Math.max(0, delayMs);
    if (carriedDepth > 0) cursorMs = resumedAt;
    if (resumedAt > horizonMs) horizonMs = resumedAt;
  },

  reset(): void {
    horizonMs = 0;
    cursorMs = 0;
    carriedDepth = 0;
    cascadeCounter = 0;
    currentCascade = 0;
  },
};
