import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { LinuxServiceManager } from '../LinuxServiceManager';
import type { LinuxService } from '../service/LinuxService';

const DEFAULT_RESTART_SEC = 0.1;
const DEFAULT_START_LIMIT_BURST = 5;
const DEFAULT_START_LIMIT_INTERVAL_SEC = 10;

interface MainExit {
  readonly code?: number;
  readonly signal?: string;
}

function isCleanExit(exit: MainExit): boolean {
  return exit.signal === undefined && (exit.code ?? 0) === 0;
}

function shouldRestart(policy: string, exit: MainExit): boolean {
  switch (policy) {
    case 'always': return true;
    case 'on-failure': return !isCleanExit(exit);
    case 'on-abnormal': return exit.signal !== undefined;
    case 'on-success': return isCleanExit(exit);
    default: return false;
  }
}

function exitDescription(exit: MainExit): string {
  if (exit.signal !== undefined) {
    return `killed by ${exit.signal}`;
  }
  return `exited with status ${exit.code ?? 0}`;
}

export class LinuxServiceSupervisor {
  private readonly off: Unsubscribe;
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    bus: IEventBus,
    private readonly services: LinuxServiceManager,
    private readonly deviceId: string,
  ) {
    this.off = bus.subscribe('linux.process.exited', (event) => {
      const { deviceId, pid, signal, exitCode } = event.payload;
      if (deviceId !== this.deviceId) return;
      this.onMainProcessExit(pid, { code: exitCode, signal });
    });
  }

  dispose(): void {
    this.off();
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
  }

  private onMainProcessExit(pid: number, exit: MainExit): void {
    const unit = this.services.findByMainPid(pid);
    if (!unit || unit.state !== 'active') return;

    this.services.noteMainExited(unit.name, { code: exit.code, signal: exit.signal });

    if (!shouldRestart(unit.restart, exit)) {
      if (isCleanExit(exit)) {
        this.services.deactivateAfterExit(unit.name);
      } else {
        this.services.markFailed(unit.name, `main process ${exitDescription(exit)}`);
      }
      return;
    }

    if (this.startLimitReached(unit)) {
      this.services.hitStartLimit(unit.name);
      return;
    }

    const counter = (unit.restartEpochs ?? []).length;
    const delayMs = (unit.restartSec ?? DEFAULT_RESTART_SEC) * 1000;
    this.services.scheduleAutoRestart(unit.name, counter, delayMs);
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      this.services.completeAutoRestart(unit.name);
    }, delayMs);
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
    this.pendingTimers.add(timer);
  }

  private startLimitReached(unit: LinuxService): boolean {
    const burst = unit.startLimitBurst ?? DEFAULT_START_LIMIT_BURST;
    const intervalMs = (unit.startLimitIntervalSec ?? DEFAULT_START_LIMIT_INTERVAL_SEC) * 1000;
    const now = Date.now();
    const epochs = (unit.restartEpochs ?? []).filter((t) => now - t <= intervalMs);
    if (epochs.length >= burst) {
      unit.restartEpochs = epochs;
      return true;
    }
    epochs.push(now);
    unit.restartEpochs = epochs;
    return false;
  }
}
