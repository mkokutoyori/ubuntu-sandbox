import type { LinuxCommandContext } from './LinuxCommandContext';
import { SIGNAL_NUMBERS, type Signal } from '../LinuxProcessManager';

export interface CommandInterruption {
  readonly signal: AbortSignal;
  killedBy(): Signal | null;
  exitStatus(): number | null;
  release(): void;
}

export function listenForInterruption(ctx: LinuxCommandContext): CommandInterruption {
  const controller = new AbortController();
  let killedBy: Signal | null = null;
  const stopListening = ctx.whenKilled?.((signal) => {
    killedBy = signal;
    controller.abort();
  }) ?? (() => undefined);
  return {
    signal: controller.signal,
    killedBy: () => killedBy,
    exitStatus: () => (killedBy === null ? null : 128 + SIGNAL_NUMBERS[killedBy]),
    release: stopListening,
  };
}
