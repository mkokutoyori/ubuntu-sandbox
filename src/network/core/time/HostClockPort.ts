import { PathClock } from './PathClock';
import { simulationNowMs } from '../SystemClock';

export interface HostClockPort {
  monotonic(): number;
  wall(): number;
  step(deltaMs: number): void;
  set(epochMs: number): void;
}

export function defaultHostClockPort(): HostClockPort {
  return {
    monotonic: simulationNowMs,
    wall: simulationNowMs,
    step: (deltaMs) => PathClock.wait(deltaMs),
    set: () => undefined,
  };
}
