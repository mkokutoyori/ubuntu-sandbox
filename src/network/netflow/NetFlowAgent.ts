import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  type NetFlowConfig, type NetFlowCollector,
  type NetFlowV5Record, type NetFlowV5Packet, type NetFlowV5Header,
  createDefaultNetFlowConfig, defaultCollector, flowKey, newRecord,
  NETFLOW_V5_MAX_RECORDS, NETFLOW_V5_VERSION, UDP_PORT_NETFLOW,
} from './types';
import {
  IPAddress,
  type EthernetFrame, type IPv4Packet,
} from '../core/types';
import { Logger } from '../core/Logger';
import { buildUdpOverIpv4, type UdpSendRequest } from '../layers/transport/UdpEgress';

export interface NetFlowHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  /** ARP-aware send (queues on a cold cache instead of broadcasting) — falls back to broadcast when absent (mirrors `TcpHost`). */
  sendIpv4FrameArpAware?(outPortName: string, ipPkt: IPv4Packet, nextHopIP: IPAddress): void;
}

interface ActiveFlow extends NetFlowV5Record {
  key: string;
}

export interface NetFlowRecordInput {
  sourceIp: string; destinationIp: string;
  inputIfIndex?: number; outputIfIndex?: number;
  sourcePort?: number; destinationPort?: number;
  protocol: number; bytes?: number; packets?: number;
  tos?: number; nextHopIp?: string; tcpFlags?: number;
}

export class NetFlowAgent {
  private config: NetFlowConfig = createDefaultNetFlowConfig();
  private activeFlows = new Map<string, ActiveFlow>();
  private startedAtMs = 0;
  private flowSequence = 0;
  private samplingCounter = 0;
  private exportTimer: TimerHandle | null = null;
  private agingTimer: TimerHandle | null = null;
  private scheduler: IScheduler | null = null;
  private running = false;

  constructor(
    private readonly host: NetFlowHost,
    private readonly getBus: () => IEventBus,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAtMs = this.nowMs();
    if (this.config.enabled) this.startTimers();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.stopTimers();
    this.flushAllPending('manual');
  }

  getConfig(): Readonly<NetFlowConfig> { return this.config; }

  setEnabled(on: boolean): void {
    if (this.config.enabled === on) return;
    this.config.enabled = on;
    if (on) this.startTimers();
    else this.stopTimers();
  }

  setActiveTimeoutSec(s: number): void { this.config.activeTimeoutSec = Math.max(60, s); }
  setInactiveTimeoutSec(s: number): void { this.config.inactiveTimeoutSec = Math.max(1, s); }
  setSamplingInterval(n: number): void { this.config.samplingInterval = Math.max(1, n); }
  setSourceInterface(iface: string | null): void { this.config.sourceInterface = iface; }

  addCollector(ip: string, port = UDP_PORT_NETFLOW): void {
    if (this.config.collectors.has(ip)) {
      const c = this.config.collectors.get(ip)!;
      c.port = port; c.enabled = true;
      return;
    }
    this.config.collectors.set(ip, defaultCollector(ip, port));
    this.getBus().publish({
      topic: 'netflow.collector.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        collectorIp: ip, port, added: true,
      },
    });
  }

  removeCollector(ip: string): void {
    if (!this.config.collectors.has(ip)) return;
    const c = this.config.collectors.get(ip)!;
    this.config.collectors.delete(ip);
    this.getBus().publish({
      topic: 'netflow.collector.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        collectorIp: ip, port: c.port, added: false,
      },
    });
  }

  listCollectors(): NetFlowCollector[] {
    return Array.from(this.config.collectors.values()).sort((a, b) => a.ip.localeCompare(b.ip));
  }

  listActiveFlows(): NetFlowV5Record[] {
    return Array.from(this.activeFlows.values()).map((f) => ({ ...f }));
  }

  recordFlow(input: NetFlowRecordInput): void {
    if (!this.config.enabled) return;
    if (this.config.samplingInterval > 1) {
      this.samplingCounter = (this.samplingCounter + 1) % this.config.samplingInterval;
      if (this.samplingCounter !== 0) return;
    }
    const r = newRecord(input, this.nowMs());
    const key = flowKey(r);
    const existing = this.activeFlows.get(key);
    if (existing) {
      existing.packets += r.packets;
      existing.octets += r.octets;
      existing.lastSwitchedMs = this.nowMs();
      existing.tcpFlags |= r.tcpFlags;
      this.getBus().publish({
        topic: 'netflow.flow.recorded',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          sourceIp: r.sourceIp, destinationIp: r.destinationIp,
          protocol: r.protocol, bytes: r.octets, packets: r.packets,
        },
      });
      return;
    }
    const flow: ActiveFlow = { ...r, key };
    this.activeFlows.set(key, flow);
    this.getBus().publish({
      topic: 'netflow.flow.recorded',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        sourceIp: r.sourceIp, destinationIp: r.destinationIp,
        protocol: r.protocol, bytes: r.octets, packets: r.packets,
      },
    });
    if (this.activeFlows.size >= NETFLOW_V5_MAX_RECORDS * 2) {
      this.exportOlderHalf();
    }
  }

  flushAllPending(reason: 'active-timeout' | 'inactive-timeout' | 'manual' = 'manual'): void {
    if (this.activeFlows.size === 0) return;
    const records = Array.from(this.activeFlows.values());
    for (const r of records) {
      this.activeFlows.delete(r.key);
      this.publishExpired(r, reason);
    }
    this.shipRecords(records);
  }

  private exportOlderHalf(): void {
    const sorted = Array.from(this.activeFlows.values()).sort((a, b) => a.firstSwitchedMs - b.firstSwitchedMs);
    const half = sorted.slice(0, Math.ceil(sorted.length / 2));
    for (const r of half) {
      this.activeFlows.delete(r.key);
      this.publishExpired(r, 'inactive-timeout');
    }
    this.shipRecords(half);
  }

  private publishExpired(r: NetFlowV5Record,
                         reason: 'active-timeout' | 'inactive-timeout' | 'tcp-rst' | 'tcp-fin' | 'cache-full' | 'manual'): void {
    this.getBus().publish({
      topic: 'netflow.flow.expired',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        sourceIp: r.sourceIp, destinationIp: r.destinationIp,
        protocol: r.protocol, bytes: r.octets, packets: r.packets, reason,
      },
    });
  }

  private shipRecords(records: NetFlowV5Record[]): void {
    if (records.length === 0) return;
    if (this.config.collectors.size === 0) return;
    for (let i = 0; i < records.length; i += NETFLOW_V5_MAX_RECORDS) {
      const chunk = records.slice(i, i + NETFLOW_V5_MAX_RECORDS);
      for (const c of this.config.collectors.values()) {
        if (!c.enabled) continue;
        this.exportTo(c, chunk);
      }
    }
  }

  private exportTo(collector: NetFlowCollector, chunk: NetFlowV5Record[]): void {
    const egress = this.resolveEgress(collector.ip);
    if (!egress) return;
    const srcIp = this.sourceIpFor(egress.port);
    if (!srcIp) return;
    const header: NetFlowV5Header = {
      version: NETFLOW_V5_VERSION,
      count: chunk.length,
      sysUptimeMs: this.nowMs() - this.startedAtMs,
      unixSecs: Math.floor(this.nowMs() / 1000),
      unixNsecs: (this.nowMs() % 1000) * 1_000_000,
      flowSequence: this.flowSequence,
      engineType: this.config.engineType,
      engineId: this.config.engineId,
      samplingInterval: this.config.samplingInterval,
    };
    this.flowSequence = (this.flowSequence + chunk.length) >>> 0;
    const payload: NetFlowV5Packet = { type: 'netflow-v5', header, records: chunk };
    const destination = new IPAddress(collector.ip);
    const request: UdpSendRequest = {
      destination,
      destinationPort: collector.port,
      sourcePort: 49152 + (this.flowSequence & 0x3fff),
      payload,
      payloadBytes: 24 + chunk.length * 48,
      source: srcIp,
    };
    if (!this.host.sendIpv4FrameArpAware) return;
    this.host.sendIpv4FrameArpAware(
      egress.name, buildUdpOverIpv4(srcIp, request), destination);
    collector.exportedPackets++;
    collector.exportedFlows += chunk.length;
    collector.lastExportMs = this.nowMs();
    this.getBus().publish({
      topic: 'netflow.packet.exported',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        collectorIp: collector.ip, flowCount: chunk.length,
        flowSequence: header.flowSequence, sysUptimeMs: header.sysUptimeMs,
      },
    });
    Logger.info(this.host.id, 'netflow:export',
      `${this.host.name}: ${chunk.length} flows → ${collector.ip}:${collector.port}`);
  }

  /**
   * The clock flows age against. It has to be the scheduler's, not the
   * wall clock: the ageing timer runs on the injected scheduler, so
   * under a virtual one wall time never moves and a `Date.now()` stamp
   * compared on a scheduler tick never elapses — no flow ever expired
   * and nothing was ever exported. Same rule `StpAgent.nowMs()` states.
   */
  private nowMs(): number { return this.getScheduler().now(); }

  private startTimers(): void {
    const s = this.getScheduler();
    this.scheduler = s;
    if (this.exportTimer === null) {
      this.exportTimer = s.setInterval(() => this.exportFullBatches(), this.config.exportIntervalMs);
    }
    if (this.agingTimer === null) {
      this.agingTimer = s.setInterval(() => this.ageOut(), 1000);
    }
  }

  private stopTimers(): void {
    const s = this.scheduler ?? this.getScheduler();
    if (this.exportTimer !== null) { s.clear(this.exportTimer); this.exportTimer = null; }
    if (this.agingTimer !== null) { s.clear(this.agingTimer); this.agingTimer = null; }
  }

  private exportFullBatches(): void {
    if (this.activeFlows.size < NETFLOW_V5_MAX_RECORDS) return;
    const sorted = Array.from(this.activeFlows.values()).sort((a, b) => a.firstSwitchedMs - b.firstSwitchedMs);
    const chunk = sorted.slice(0, NETFLOW_V5_MAX_RECORDS);
    for (const r of chunk) this.activeFlows.delete(r.key);
    for (const r of chunk) this.publishExpired(r, 'inactive-timeout');
    this.shipRecords(chunk);
  }

  private ageOut(): void {
    const now = this.nowMs();
    const inactiveMs = this.config.inactiveTimeoutSec * 1000;
    const activeMs = this.config.activeTimeoutSec * 1000;
    const expired: ActiveFlow[] = [];
    for (const [k, f] of this.activeFlows) {
      if (now - f.lastSwitchedMs >= inactiveMs) {
        this.activeFlows.delete(k);
        this.publishExpired(f, 'inactive-timeout');
        expired.push(f);
      } else if (now - f.firstSwitchedMs >= activeMs) {
        this.activeFlows.delete(k);
        this.publishExpired(f, 'active-timeout');
        expired.push(f);
      }
    }
    this.shipRecords(expired);
  }

  /**
   * The source address to stamp on a management datagram.
   *
   * The egress interface and the source address are two different
   * decisions: routing picks the first, `source-interface` picks the
   * second. Returning the source interface AS the egress port sent the
   * datagram out of a loopback, which has no cable, so nothing left the
   * machine at all — the command silenced the very feature it
   * configures.
   */
  private sourceIpFor(egressPort: import('../hardware/Port').Port): import('../core/types').IPAddress | null {
    const named = this.config.sourceInterface
      ? this.host.getPort(this.config.sourceInterface)?.getIPAddress() ?? null
      : null;
    return named ?? egressPort.getIPAddress();
  }

  private resolveEgress(targetIp: string): { name: string; port: import('../hardware/Port').Port } | null {
    const target = targetIp.split('.').map(Number);
    for (const port of this.host.getPorts()) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (!ip || !mask) continue;
      const local = ip.toString().split('.').map(Number);
      const maskBits = mask.toString().split('.').map(Number);
      let same = true;
      for (let i = 0; i < 4; i++) {
        if ((local[i] & maskBits[i]) !== (target[i] & maskBits[i])) { same = false; break; }
      }
      if (same) return { name: port.getName(), port };
    }
    for (const port of this.host.getPorts()) {
      if (port.getIPAddress() && port.getIsUp() && port.isConnected()) {
        return { name: port.getName(), port };
      }
    }
    return null;
  }
}
