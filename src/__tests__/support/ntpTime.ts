import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

export function installVirtualClock(): VirtualTimeScheduler {
  const clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
  return clock;
}

export function converge(clock: VirtualTimeScheduler, totalMs = 900_000, stepMs = 1000): void {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) clock.advance(stepMs);
}
