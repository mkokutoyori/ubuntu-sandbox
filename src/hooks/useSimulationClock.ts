import { useSyncExternalStore } from 'react';
import { getSimulationClock, type SimulationClock, type SimulationClockState } from '@/events/SimulationClock';

const NO_CLOCK: SimulationClockState = { running: false, speed: 1, advancing: false };
const NEVER = (): (() => void) => () => undefined;

export function useSimulationClock(): { clock: SimulationClock | null; state: SimulationClockState } {
  const clock = getSimulationClock();
  const state = useSyncExternalStore(
    clock ? (listener) => clock.subscribe(listener) : NEVER,
    () => clock?.getState() ?? NO_CLOCK,
  );
  return { clock, state };
}
