import { VirtualTimeScheduler, __setDefaultScheduler } from './Scheduler';

export const SIMULATION_SPEEDS: readonly number[] = [1, 10, 60, 600, 3600];

const PUMP_PERIOD_MS = 20;

export interface SimulationClockState {
  readonly running: boolean;
  readonly speed: number;
  readonly advancing: boolean;
}

export interface SimulationClockOptions {
  readonly realNow?: () => number;
  readonly startPump?: (tick: () => void) => () => void;
  readonly originMs?: number;
}

type Listener = () => void;

function defaultRealNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function defaultStartPump(tick: () => void): () => void {
  const handle = globalThis.setInterval(tick, PUMP_PERIOD_MS);
  return () => globalThis.clearInterval(handle);
}

export class SimulationClock {
  readonly scheduler = new VirtualTimeScheduler();
  private readonly realNow: () => number;
  private readonly startPump: (tick: () => void) => () => void;
  private readonly listeners = new Set<Listener>();
  private stopPump: (() => void) | null = null;
  private lastRealMs = 0;
  private speed = 1;
  private advancing = false;
  private snapshot: SimulationClockState = { running: false, speed: 1, advancing: false };

  constructor(options: SimulationClockOptions = {}) {
    this.realNow = options.realNow ?? defaultRealNow;
    this.startPump = options.startPump ?? defaultStartPump;
    if (options.originMs !== undefined) this.scheduler.setEpochOrigin(options.originMs);
  }

  getState(): SimulationClockState {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  play(speed: number = this.speed): void {
    this.setSpeed(speed);
    if (this.stopPump) return;
    this.lastRealMs = this.realNow();
    this.stopPump = this.startPump(() => this.pump());
    this.publish();
  }

  pause(): void {
    if (!this.stopPump) return;
    this.pump();
    this.stopPump();
    this.stopPump = null;
    this.publish();
  }

  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new RangeError(`simulation speed must be a positive number, got ${speed}`);
    }
    if (this.stopPump) this.pump();
    this.speed = speed;
    this.publish();
  }

  async advance(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`cannot advance the simulation by ${ms} ms`);
    }
    const wasRunning = this.stopPump !== null;
    if (wasRunning) this.pause();
    this.advancing = true;
    this.publish();
    try {
      await this.scheduler.advanceBy(ms);
    } finally {
      this.advancing = false;
      if (wasRunning) this.play();
      else this.publish();
    }
  }

  private pump(): void {
    const now = this.realNow();
    const elapsed = Math.max(0, now - this.lastRealMs);
    this.lastRealMs = now;
    if (this.advancing || elapsed === 0) return;
    this.scheduler.advance(elapsed * this.speed);
  }

  private publish(): void {
    this.snapshot = { running: this.stopPump !== null, speed: this.speed, advancing: this.advancing };
    for (const listener of [...this.listeners]) listener();
  }
}

let installed: SimulationClock | null = null;

export function getSimulationClock(): SimulationClock | null {
  return installed;
}

export function installSimulationClock(clock: SimulationClock = new SimulationClock()): SimulationClock {
  installed = clock;
  __setDefaultScheduler(clock.scheduler);
  return clock;
}

export function __resetSimulationClock(): void {
  installed = null;
  __setDefaultScheduler(null);
}
