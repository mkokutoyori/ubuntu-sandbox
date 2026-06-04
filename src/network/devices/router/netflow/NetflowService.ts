export interface FlowExporter {
  name: string;
  destination?: string;
  source?: string;
  transportProtocol?: 'udp';
  transportPort?: number;
  exportProtocol?: 'netflow-v9' | 'ipfix' | 'netflow-v5';
  templateDataTimeoutSec?: number;
}

export interface FlowRecord {
  name: string;
  matches: string[];
  collects: string[];
}

export interface FlowMonitor {
  name: string;
  recordName?: string;
  exporterNames: string[];
  cacheTimeoutActiveSec?: number;
  cacheTimeoutInactiveSec?: number;
  maximumFlows?: number;
}

export interface InterfaceFlowAttachment {
  ifName: string;
  monitorName: string;
  direction: 'input' | 'output';
}

export interface LegacyNetflowConfig {
  destinations: Array<{ ip: string; port: number }>;
  source?: string;
  version?: number;
  cacheTimeoutActiveMin?: number;
  cacheTimeoutInactiveSec?: number;
  ifaceModes: Map<string, { ingress: boolean; egress: boolean }>;
}

export class NetflowService {
  private readonly exporters: Map<string, FlowExporter> = new Map();
  private readonly records: Map<string, FlowRecord> = new Map();
  private readonly monitors: Map<string, FlowMonitor> = new Map();
  private readonly ifAttachments: InterfaceFlowAttachment[] = [];
  private readonly legacy: LegacyNetflowConfig = {
    destinations: [],
    ifaceModes: new Map(),
  };

  ensureExporter(name: string): FlowExporter {
    let e = this.exporters.get(name);
    if (!e) { e = { name }; this.exporters.set(name, e); }
    return e;
  }
  ensureRecord(name: string): FlowRecord {
    let r = this.records.get(name);
    if (!r) { r = { name, matches: [], collects: [] }; this.records.set(name, r); }
    return r;
  }
  ensureMonitor(name: string): FlowMonitor {
    let m = this.monitors.get(name);
    if (!m) { m = { name, exporterNames: [] }; this.monitors.set(name, m); }
    return m;
  }

  attachToInterface(ifName: string, monitorName: string, direction: 'input' | 'output'): void {
    const existing = this.ifAttachments.find(a => a.ifName === ifName && a.direction === direction);
    if (existing) existing.monitorName = monitorName;
    else this.ifAttachments.push({ ifName, monitorName, direction });
  }
  detachFromInterface(ifName: string, direction?: 'input' | 'output'): void {
    for (let i = this.ifAttachments.length - 1; i >= 0; i--) {
      const a = this.ifAttachments[i];
      if (a.ifName === ifName && (!direction || a.direction === direction)) {
        this.ifAttachments.splice(i, 1);
      }
    }
  }

  setLegacyDestination(ip: string, port: number): void {
    if (!this.legacy.destinations.find(d => d.ip === ip && d.port === port)) {
      this.legacy.destinations.push({ ip, port });
    }
  }
  setLegacySource(source: string): void { this.legacy.source = source; }
  setLegacyVersion(v: number): void { this.legacy.version = v; }
  setLegacyCacheActiveMin(min: number): void { this.legacy.cacheTimeoutActiveMin = min; }
  setLegacyCacheInactiveSec(sec: number): void { this.legacy.cacheTimeoutInactiveSec = sec; }
  setLegacyInterfaceMode(ifName: string, mode: 'ingress' | 'egress', on: boolean): void {
    let m = this.legacy.ifaceModes.get(ifName);
    if (!m) { m = { ingress: false, egress: false }; this.legacy.ifaceModes.set(ifName, m); }
    if (mode === 'ingress') m.ingress = on;
    else m.egress = on;
  }

  getExporters(): readonly FlowExporter[] { return [...this.exporters.values()]; }
  getRecords(): readonly FlowRecord[] { return [...this.records.values()]; }
  getMonitors(): readonly FlowMonitor[] { return [...this.monitors.values()]; }
  getInterfaceAttachments(): readonly InterfaceFlowAttachment[] { return [...this.ifAttachments]; }
  getLegacy(): Readonly<LegacyNetflowConfig> { return this.legacy; }

  asRunningConfigLines(): string[] {
    const lines: string[] = [];
    for (const e of this.exporters.values()) {
      lines.push(`flow exporter ${e.name}`);
      if (e.destination) lines.push(` destination ${e.destination}`);
      if (e.source) lines.push(` source ${e.source}`);
      if (e.transportProtocol === 'udp') lines.push(` transport udp ${e.transportPort ?? 2055}`);
      if (e.exportProtocol) lines.push(` export-protocol ${e.exportProtocol}`);
      if (e.templateDataTimeoutSec !== undefined) lines.push(` template data timeout ${e.templateDataTimeoutSec}`);
    }
    for (const r of this.records.values()) {
      lines.push(`flow record ${r.name}`);
      for (const m of r.matches) lines.push(` match ${m}`);
      for (const c of r.collects) lines.push(` collect ${c}`);
    }
    for (const m of this.monitors.values()) {
      lines.push(`flow monitor ${m.name}`);
      if (m.recordName) lines.push(` record ${m.recordName}`);
      for (const en of m.exporterNames) lines.push(` exporter ${en}`);
      if (m.cacheTimeoutActiveSec !== undefined) lines.push(` cache timeout active ${m.cacheTimeoutActiveSec}`);
      if (m.cacheTimeoutInactiveSec !== undefined) lines.push(` cache timeout inactive ${m.cacheTimeoutInactiveSec}`);
      if (m.maximumFlows !== undefined) lines.push(` cache entries ${m.maximumFlows}`);
    }
    if (this.legacy.version !== undefined) lines.push(`ip flow-export version ${this.legacy.version}`);
    if (this.legacy.source) lines.push(`ip flow-export source ${this.legacy.source}`);
    for (const d of this.legacy.destinations) lines.push(`ip flow-export destination ${d.ip} ${d.port}`);
    if (this.legacy.cacheTimeoutActiveMin !== undefined) lines.push(`ip flow-cache timeout active ${this.legacy.cacheTimeoutActiveMin}`);
    if (this.legacy.cacheTimeoutInactiveSec !== undefined) lines.push(`ip flow-cache timeout inactive ${this.legacy.cacheTimeoutInactiveSec}`);
    return lines;
  }

  asInterfaceRunningConfigLines(ifName: string): string[] {
    const out: string[] = [];
    const legacyIface = this.legacy.ifaceModes.get(ifName);
    if (legacyIface?.ingress) out.push(' ip flow ingress');
    if (legacyIface?.egress) out.push(' ip flow egress');
    for (const a of this.ifAttachments) {
      if (a.ifName !== ifName) continue;
      out.push(` ip flow monitor ${a.monitorName} ${a.direction}`);
    }
    return out;
  }
}
