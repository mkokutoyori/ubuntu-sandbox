import { CounterWindow, GaugeWindow } from './LoadWindow';

export type PacketWorkKind = 'kernel' | 'inspection';

export type ConservePosture = 'green' | 'conserve' | 'extreme';

export type AntivirusFailopen = 'pass' | 'off' | 'one-shot';

export type InspectionPosture = 'normal' | 'bypass' | 'block';

export interface CpuStates {
  readonly user: number;
  readonly system: number;
  readonly nice: number;
  readonly idle: number;
  readonly iowait: number;
  readonly irq: number;
  readonly softirq: number;
}

export interface MemoryStates {
  readonly totalKib: number;
  readonly usedKib: number;
  readonly freeKib: number;
  readonly freeableKib: number;
}

export interface ConserveThresholds {
  readonly extremePercent: number;
  readonly redPercent: number;
  readonly greenPercent: number;
}

export const DEFAULT_CONSERVE_THRESHOLDS: ConserveThresholds = Object.freeze({
  extremePercent: 95, redPercent: 88, greenPercent: 82,
});

export const CONSERVE_THRESHOLD_MIN = 70;
export const CONSERVE_THRESHOLD_MAX = 97;

export interface MemoryWorkload {
  readonly usedBytes: number;
  readonly freeableBytes: number;
}

export interface ConserveTransition {
  readonly entered: boolean;
  readonly memory: MemoryStates;
  readonly thresholds: ConserveThresholds;
}

export interface SystemLoadDeps {
  readonly now: () => number;
  readonly cpuCount: number;
  readonly memoryKib: number;
  readonly packetsPerSecondPerCpu: number;
  readonly baseMemoryKib?: number;
  readonly onConserveChange?: (transition: ConserveTransition) => void;
}

const MINUTE_MS = 60_000;

export const CPU_WINDOW_MS = MINUTE_MS;

export class SystemLoad {
  private readonly kernelPackets: CounterWindow;
  private readonly inspectionPackets: CounterWindow;
  private readonly bytesIn: CounterWindow;
  private readonly bytesOut: CounterWindow;
  private readonly sessionsCreated: CounterWindow;
  private readonly sessionGauge: GaugeWindow;
  private readonly workloads = new Set<() => MemoryWorkload>();
  private thresholds: ConserveThresholds = DEFAULT_CONSERVE_THRESHOLDS;
  private posture: ConservePosture = 'green';
  private failopen: AntivirusFailopen = 'pass';
  private ipsFailOpen = false;
  private bypassLatched = false;
  private processed = 0;

  constructor(private readonly deps: SystemLoadDeps) {
    const now = deps.now;
    this.kernelPackets = new CounterWindow(now);
    this.inspectionPackets = new CounterWindow(now);
    this.bytesIn = new CounterWindow(now);
    this.bytesOut = new CounterWindow(now);
    this.sessionsCreated = new CounterWindow(now);
    this.sessionGauge = new GaugeWindow(now);
  }

  addWorkload(workload: () => MemoryWorkload): void {
    this.workloads.add(workload);
  }

  recordPacket(kind: PacketWorkKind): void {
    this.processed++;
    if (kind === 'inspection') this.inspectionPackets.add(1);
    else this.kernelPackets.add(1);
  }

  recordBytes(direction: 'in' | 'out', bytes: number): void {
    if (direction === 'in') this.bytesIn.add(bytes);
    else this.bytesOut.add(bytes);
  }

  recordSessionCreated(): void {
    this.sessionsCreated.add(1);
  }

  observeSessionCount(count: number): void {
    this.sessionGauge.observe(count);
  }

  packetsProcessed(): number {
    return this.processed;
  }

  packetRate(): number {
    return this.kernelPackets.ratePerSecond(MINUTE_MS)
      + this.inspectionPackets.ratePerSecond(MINUTE_MS);
  }

  cpuCount(): number {
    return this.deps.cpuCount;
  }

  cpuStates(): CpuStates {
    const capacity = this.deps.packetsPerSecondPerCpu * this.deps.cpuCount;
    const share = (rate: number) => capacity <= 0
      ? 0 : Math.min(100, Math.round((rate / capacity) * 100));

    const system = share(this.kernelPackets.ratePerSecond(MINUTE_MS));
    const user = Math.min(100 - system,
      share(this.inspectionPackets.ratePerSecond(MINUTE_MS)));

    return Object.freeze({
      user, system, nice: 0, idle: 100 - user - system,
      iowait: 0, irq: 0, softirq: 0,
    });
  }

  memory(): MemoryStates {
    const totalKib = this.deps.memoryKib;
    let usedBytes = (this.deps.baseMemoryKib ?? 0) * 1024;
    let freeableBytes = 0;
    for (const workload of this.workloads) {
      const measured = workload();
      usedBytes += measured.usedBytes;
      freeableBytes += measured.freeableBytes;
    }

    const usedKib = Math.min(totalKib, Math.round(usedBytes / 1024));
    const freeableKib = Math.min(totalKib - usedKib, Math.round(freeableBytes / 1024));
    const states = Object.freeze({
      totalKib, usedKib, freeableKib,
      freeKib: totalKib - usedKib - freeableKib,
    });
    this.settle(states);
    return states;
  }

  setThresholds(thresholds: ConserveThresholds): void {
    this.thresholds = Object.freeze({ ...thresholds });
    this.reassess();
  }

  reassess(): void {
    this.conservePosture();
  }

  getThresholds(): ConserveThresholds {
    return this.thresholds;
  }

  conservePosture(): ConservePosture {
    this.memory();
    return this.posture;
  }

  private settle(memory: MemoryStates): void {
    const usedPercent = (memory.usedKib / memory.totalKib) * 100;
    const withFreeable = ((memory.usedKib + memory.freeableKib) / memory.totalKib) * 100;
    const previous = this.posture;

    if (withFreeable >= this.thresholds.extremePercent) this.posture = 'extreme';
    else if (usedPercent >= this.thresholds.redPercent) this.posture = 'conserve';
    else if (usedPercent < this.thresholds.greenPercent) this.posture = 'green';
    else if (previous === 'extreme') this.posture = 'conserve';

    if (previous !== this.posture) this.announce(previous, memory);
  }

  inConserveMode(): boolean {
    return this.conservePosture() !== 'green';
  }

  refusesNewSessions(): boolean {
    return this.conservePosture() === 'extreme';
  }

  setAntivirusFailopen(mode: AntivirusFailopen): void {
    this.failopen = mode;
    this.bypassLatched = false;
  }

  getAntivirusFailopen(): AntivirusFailopen {
    return this.failopen;
  }

  proxyInspectionPosture(): InspectionPosture {
    if (!this.inConserveMode()) return this.bypassLatched ? 'bypass' : 'normal';
    if (this.failopen === 'off') return 'block';
    if (this.failopen === 'one-shot') this.bypassLatched = true;
    return 'bypass';
  }

  setIpsFailOpen(open: boolean): void {
    this.ipsFailOpen = open;
  }

  getIpsFailOpen(): boolean {
    return this.ipsFailOpen;
  }

  flowInspectionPosture(): InspectionPosture {
    if (!this.inConserveMode()) return 'normal';
    return this.ipsFailOpen ? 'bypass' : 'block';
  }

  private announce(previous: ConservePosture, memory: MemoryStates): void {
    const wasConserving = previous !== 'green';
    const conserving = this.posture !== 'green';
    if (wasConserving === conserving) return;
    this.deps.onConserveChange?.({
      entered: conserving, memory, thresholds: this.thresholds,
    });
  }

  averageSessions(minutes: number): number {
    return Math.round(this.sessionGauge.average(minutes * MINUTE_MS));
  }

  averageSetupRate(minutes: number): number {
    return Math.round(this.sessionsCreated.ratePerSecond(minutes * MINUTE_MS));
  }

  averageKbps(minutes: number): { readonly inbound: number; readonly outbound: number } {
    const seconds = minutes * 60;
    return {
      inbound: Math.round((this.bytesIn.total(minutes * MINUTE_MS) * 8) / seconds / 1000),
      outbound: Math.round((this.bytesOut.total(minutes * MINUTE_MS) * 8) / seconds / 1000),
    };
  }
}
