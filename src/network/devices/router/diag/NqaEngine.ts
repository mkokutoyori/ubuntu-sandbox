export type NqaTestType = 'icmp' | 'icmpv6' | 'dns' | 'dhcp' | 'ftp' | 'http' | 'tcp' | 'udp' | 'snmp' | 'trace' | 'lsp-ping';

export type NqaTestStatus = 'inactive' | 'active' | 'completed' | 'failed';

export interface NqaProbeResult {
  index: number;
  startedAt: number;
  finishedAt: number;
  rttMs: number;
  success: boolean;
  errorCode?: string;
}

export interface NqaThresholds {
  rttMaxMs?: number;
  packetLossPct?: number;
}

export class NqaTestInstance {
  readonly admin: string;
  readonly testName: string;
  testType: NqaTestType = 'icmp';
  destinationAddress: string | null = null;
  sourceAddress: string | null = null;
  destinationPort: number | null = null;
  frequency: number = 60;
  probeCount: number = 3;
  intervalSec: number = 4;
  timeoutSec: number = 3;
  ttl: number = 255;
  vrf: string | null = null;
  description: string | null = null;
  tos: number = 0;
  dataSize: number = 56;
  thresholds: NqaThresholds = {};
  status: NqaTestStatus = 'inactive';
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  lastResults: NqaProbeResult[] = [];
  history: NqaProbeResult[] = [];

  constructor(admin: string, testName: string) {
    this.admin = admin;
    this.testName = testName;
  }

  start(now: number = Date.now()): void {
    this.status = 'active';
    this.startedAt = now;
    this.stoppedAt = null;
  }

  stop(now: number = Date.now()): void {
    this.status = 'inactive';
    this.stoppedAt = now;
  }

  recordProbeBatch(results: NqaProbeResult[]): void {
    this.lastResults = results;
    this.history.push(...results);
    if (this.history.length > 1000) this.history.splice(0, this.history.length - 1000);
    const allSucceeded = results.every(r => r.success);
    this.status = allSucceeded ? 'completed' : 'failed';
  }

  summary(): { sent: number; received: number; lossPct: number; rttMin: number; rttMax: number; rttAvg: number } {
    const sent = this.lastResults.length;
    const received = this.lastResults.filter(r => r.success).length;
    const rtts = this.lastResults.filter(r => r.success).map(r => r.rttMs);
    const rttMin = rtts.length > 0 ? Math.min(...rtts) : 0;
    const rttMax = rtts.length > 0 ? Math.max(...rtts) : 0;
    const rttAvg = rtts.length > 0 ? rtts.reduce((a, b) => a + b, 0) / rtts.length : 0;
    return { sent, received, lossPct: sent > 0 ? ((sent - received) / sent) * 100 : 0, rttMin, rttMax, rttAvg };
  }

  isTrackUp(): boolean {
    if (this.status === 'inactive') return false;
    const s = this.summary();
    if (this.thresholds.rttMaxMs !== undefined && s.rttMax > this.thresholds.rttMaxMs) return false;
    if (this.thresholds.packetLossPct !== undefined && s.lossPct > this.thresholds.packetLossPct) return false;
    return s.received > 0;
  }

  render(): string[] {
    const out = [`nqa test-instance ${this.admin} ${this.testName}`];
    if (this.testType) out.push(` test-type ${this.testType}`);
    if (this.destinationAddress) out.push(` destination-address ipv4 ${this.destinationAddress}`);
    if (this.sourceAddress) out.push(` source-address ipv4 ${this.sourceAddress}`);
    if (this.destinationPort !== null) out.push(` destination-port ${this.destinationPort}`);
    if (this.frequency !== 60) out.push(` frequency ${this.frequency}`);
    if (this.probeCount !== 3) out.push(` probe-count ${this.probeCount}`);
    if (this.intervalSec !== 4) out.push(` interval seconds ${this.intervalSec}`);
    if (this.timeoutSec !== 3) out.push(` timeout ${this.timeoutSec}`);
    if (this.ttl !== 255) out.push(` ttl ${this.ttl}`);
    if (this.description) out.push(` description ${this.description}`);
    if (this.thresholds.rttMaxMs !== undefined) out.push(` threshold rtt ${this.thresholds.rttMaxMs}`);
    if (this.thresholds.packetLossPct !== undefined) out.push(` threshold packet-loss ${this.thresholds.packetLossPct}`);
    if (this.status === 'active') out.push(' start now');
    return out;
  }

  renderResults(): string {
    const s = this.summary();
    return [
      `NQA entry(admin, ${this.testName}) :`,
      `  Send operation times: ${s.sent}             Receive response times: ${s.received}`,
      `  Completion: ${this.status}                  RTD OverThresholds number: 0`,
      `  Attempts number: ${this.history.length}    Drop operation number: ${s.sent - s.received}`,
      `  Disconnect operation number: 0              Operation timeout number: ${s.sent - s.received}`,
      `  System busy operation number: 0             Connection fail number: 0`,
      `  Operation sequence errors number: 0         RTT Stats errors number: 0`,
      `  Destination ip address: ${this.destinationAddress || '0.0.0.0'}`,
      `  Min/Max/Avg RTT: ${Math.round(s.rttMin)}/${Math.round(s.rttMax)}/${Math.round(s.rttAvg)} ms`,
      `  Packet loss: ${s.lossPct.toFixed(1)}%`,
    ].join('\n');
  }
}

export class NqaEngine {
  private instances = new Map<string, NqaTestInstance>();

  private key(admin: string, name: string): string { return `${admin}::${name}`; }

  upsert(admin: string, name: string): NqaTestInstance {
    const k = this.key(admin, name);
    let t = this.instances.get(k);
    if (!t) { t = new NqaTestInstance(admin, name); this.instances.set(k, t); }
    return t;
  }

  get(admin: string, name: string): NqaTestInstance | undefined {
    return this.instances.get(this.key(admin, name));
  }

  remove(admin: string, name: string): boolean {
    return this.instances.delete(this.key(admin, name));
  }

  list(): NqaTestInstance[] { return [...this.instances.values()]; }

  renderHuawei(): string {
    const out: string[] = [];
    for (const t of this.list()) { out.push(...t.render(), ' quit'); }
    return out.join('\n');
  }
}
