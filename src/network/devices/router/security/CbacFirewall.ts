import type { IPv4Packet } from '../../../core/types';
import { simulationNowMs } from '@/network/core/SystemClock';
import {
  FlowTable, flowOf, protocolLabel, protocolMatches, IP_TCP,
  type FlowSession, type FlowView, type FlowTimeouts, type FlowEndReason,
} from './FlowTable';

export interface InspectProtocolOptions {
  alert?: boolean;
  auditTrail?: boolean;
  timeoutSec?: number;
}

export interface InspectRule {
  name: string;
  maxSessions?: number;
  protocols: Map<string, InspectProtocolOptions>;
}

export interface InspectSettings {
  tcpIdleSec: number;
  tcpSynwaitSec: number;
  tcpFinwaitSec: number;
  udpIdleSec: number;
  dnsTimeoutSec: number;
  maxIncompleteHigh: number;
  maxIncompleteLow: number;
  oneMinuteHigh: number;
  oneMinuteLow: number;
  hostMaxIncomplete: number;
  hostBlockMinutes: number;
  alertOff: boolean;
  auditTrail: boolean;
  logDropPkt: boolean;
}

export const DEFAULT_INSPECT_SETTINGS: Readonly<InspectSettings> = Object.freeze({
  tcpIdleSec: 3600, tcpSynwaitSec: 30, tcpFinwaitSec: 5, udpIdleSec: 30, dnsTimeoutSec: 5,
  maxIncompleteHigh: 500, maxIncompleteLow: 400, oneMinuteHigh: 500, oneMinuteLow: 400,
  hostMaxIncomplete: 50, hostBlockMinutes: 0,
  alertOff: false, auditTrail: false, logDropPkt: false,
});

export interface CbacConfig {
  readonly rules: ReadonlyMap<string, InspectRule>;
  readonly settings: InspectSettings;
  inspectRuleOf(iface: string, direction: 'in' | 'out'): string | undefined;
  inspectedInterfaces(): number;
}

export interface CbacLogLine {
  readonly severity: 'warnings' | 'informational';
  readonly mnemonic: string;
  readonly text: string;
}

export interface CbacVerdict {
  readonly permit: boolean;
}

export interface CbacPort {
  inspect(inIface: string, outIface: string, packet: IPv4Packet): CbacVerdict;
  admitsReturn(packet: IPv4Packet): boolean;
  drainLogs(): CbacLogLine[];
  sweep(): void;
  hasWork(): boolean;
}

export interface CbacStatistics {
  created: number;
  maxEstablished: number;
  maxHalfOpen: number;
  maxTerminating: number;
  lastCreatedMs: number | null;
  resetMs: number | null;
  packetsByProtocol: Map<string, number>;
  packetsDropped: number;
}

interface HostBlock {
  untilMs: number;
}

const RATE_WINDOW_MS = 60_000;

export class CbacFirewall implements CbacPort {
  private readonly flows: FlowTable;
  private readonly logs: CbacLogLine[] = [];
  private readonly creationTimes: number[] = [];
  private readonly blockedHosts = new Map<string, HostBlock>();
  private readonly hostAlerted = new Set<string>();
  private aggressive = false;
  private statistics: CbacStatistics = CbacFirewall.freshStatistics(null);

  constructor(private readonly source: () => CbacConfig) {
    this.flows = new FlowTable(() => this.timeouts(), (session, reason) => this.onSessionEnd(session, reason));
  }

  private static freshStatistics(resetMs: number | null): CbacStatistics {
    return {
      created: 0, maxEstablished: 0, maxHalfOpen: 0, maxTerminating: 0,
      lastCreatedMs: null, resetMs, packetsByProtocol: new Map(), packetsDropped: 0,
    };
  }

  private get config(): CbacConfig {
    return this.source();
  }

  private timeouts(): FlowTimeouts {
    const s = this.config.settings;
    return {
      tcpIdleSec: s.tcpIdleSec, tcpSynwaitSec: s.tcpSynwaitSec, tcpFinwaitSec: s.tcpFinwaitSec,
      udpIdleSec: s.udpIdleSec, icmpIdleSec: 10, dnsSec: s.dnsTimeoutSec,
    };
  }

  private alertsEnabled(options: InspectProtocolOptions | undefined): boolean {
    return options?.alert ?? !this.config.settings.alertOff;
  }

  private onSessionEnd(session: FlowSession, reason: FlowEndReason): void {
    if (reason === 'evicted' || !session.audit) return;
    this.logs.push({
      severity: 'informational', mnemonic: 'SESS_AUDIT_TRAIL',
      text: `Stop ${session.label} session: initiator (${session.initiator}:${session.initiatorPort}) sent ${session.initiatorBytes} bytes -- responder (${session.responder}:${session.responderPort}) sent ${session.responderBytes} bytes`,
    });
  }

  private halfOpen(): FlowSession[] {
    return this.flows.list().filter((s) => s.state === 'SIS_OPENING');
  }

  private pruneRate(now: number): number {
    while (this.creationTimes.length > 0 && now - this.creationTimes[0] >= RATE_WINDOW_MS) this.creationTimes.shift();
    return this.creationTimes.length;
  }

  private entryFor(rule: InspectRule, flow: FlowView): { keyword: string; options: InspectProtocolOptions } | null {
    let generic: { keyword: string; options: InspectProtocolOptions } | null = null;
    for (const [keyword, options] of rule.protocols) {
      if (!protocolMatches(keyword, flow)) continue;
      if (keyword === 'tcp' || keyword === 'udp' || keyword === 'icmp') generic = { keyword, options };
      else return { keyword, options };
    }
    return generic;
  }

  private dropLine(flow: FlowView, packet: IPv4Packet, reason: string): void {
    if (!this.config.settings.logDropPkt) return;
    const tcp = flow.protocol === IP_TCP;
    const ports = `${flow.source}:${flow.sourcePort} => ${flow.destination}:${flow.destinationPort}`;
    this.logs.push({
      severity: 'informational', mnemonic: tcp ? 'DROP_TCP_PKT' : 'DROP_PKT',
      text: `Dropping ${protocolLabel(flow.protocol)} pkt ${ports} with ip ident ${packet.identification} due to ${reason}`,
    });
  }

  private evictOldestHalfOpen(exceptContext?: string, host?: string): boolean {
    const candidates = this.halfOpen()
      .filter((s) => host === undefined || s.responder === host)
      .sort((a, b) => a.createdMs - b.createdMs);
    const victim = candidates.find((s) => s.context !== exceptContext) ?? candidates[0];
    if (!victim) return false;
    this.flows.remove(victim, 'evicted');
    return true;
  }

  private updateAggression(now: number, options: InspectProtocolOptions | undefined): void {
    const s = this.config.settings;
    const count = this.halfOpen().length;
    const rate = this.pruneRate(now);
    if (!this.aggressive && (count > s.maxIncompleteHigh || rate > s.oneMinuteHigh)) {
      this.aggressive = true;
      if (this.alertsEnabled(options)) {
        this.logs.push({
          severity: 'warnings', mnemonic: 'ALERT_ON',
          text: `getting aggressive, count (${count}/${s.maxIncompleteHigh}) current 1-min rate: ${rate}`,
        });
      }
    } else if (this.aggressive && count < s.maxIncompleteLow && rate < s.oneMinuteLow) {
      this.aggressive = false;
      if (this.alertsEnabled(options)) {
        this.logs.push({
          severity: 'warnings', mnemonic: 'ALERT_OFF',
          text: `calming down, count (${count}/${s.maxIncompleteLow}) current 1-min rate: ${rate}`,
        });
      }
    }
  }

  private releaseHostBlocks(now: number): void {
    for (const [host, block] of [...this.blockedHosts]) {
      if (now < block.untilMs) continue;
      this.blockedHosts.delete(host);
      this.hostAlerted.delete(host);
      if (!this.config.settings.alertOff) {
        this.logs.push({
          severity: 'warnings', mnemonic: 'UNBLOCK_HOST',
          text: `New TCP connections to host ${host} no longer blocked`,
        });
      }
    }
  }

  private updateStatistics(now: number): void {
    const sessions = this.flows.list();
    const open = sessions.filter((s) => s.state === 'SIS_OPEN').length;
    const half = sessions.filter((s) => s.state === 'SIS_OPENING').length;
    const closing = sessions.filter((s) => s.state === 'SIS_CLOSING').length;
    this.statistics.maxEstablished = Math.max(this.statistics.maxEstablished, open);
    this.statistics.maxHalfOpen = Math.max(this.statistics.maxHalfOpen, half);
    this.statistics.maxTerminating = Math.max(this.statistics.maxTerminating, closing);
    this.statistics.lastCreatedMs = now;
  }

  private countPacket(flow: FlowView, keyword: string): void {
    this.statistics.packetsByProtocol.set(keyword, (this.statistics.packetsByProtocol.get(keyword) ?? 0) + 1);
    if (flow.protocol === IP_TCP && keyword !== 'tcp') {
      this.statistics.packetsByProtocol.set('tcp', (this.statistics.packetsByProtocol.get('tcp') ?? 0) + 1);
    }
  }

  admitsReturn(packet: IPv4Packet): boolean {
    this.flows.expire(simulationNowMs());
    const known = this.flows.lookup(flowOf(packet));
    return known !== null && !known.forward;
  }

  inspect(inIface: string, outIface: string, packet: IPv4Packet): CbacVerdict {
    const now = simulationNowMs();
    const config = this.config;
    this.releaseHostBlocks(now);
    const flow = flowOf(packet);
    const known = this.flows.observe(flow, now);
    if (known) {
      this.countPacket(flow, known.label);
      return { permit: true };
    }

    const ruleName = config.inspectRuleOf(inIface, 'in') ?? config.inspectRuleOf(outIface, 'out');
    const rule = ruleName === undefined ? undefined : config.rules.get(ruleName);
    if (!rule) return { permit: true };
    const entry = this.entryFor(rule, flow);
    if (!entry) return { permit: true };
    if (flow.protocol === IP_TCP && !flow.synOnly) return { permit: true };
    this.countPacket(flow, entry.keyword);

    const settings = config.settings;
    const tcp = flow.protocol === IP_TCP;
    const context = config.inspectRuleOf(inIface, 'in') === ruleName ? inIface : outIface;

    if (tcp && this.blockedHosts.has(flow.destination)) {
      this.statistics.packetsDropped += 1;
      this.dropLine(flow, packet, 'Session limiting');
      return { permit: false };
    }

    if (rule.maxSessions !== undefined
      && this.flows.count((s) => s.owner === rule.name && s.context === context) >= rule.maxSessions) {
      this.statistics.packetsDropped += 1;
      if (this.alertsEnabled(entry.options)) {
        this.logs.push({
          severity: 'warnings', mnemonic: 'SESSION_THRESHOLD_EXCEEDED',
          text: `Number of sessions for the firewall rule ${rule.name} on interface ${context} exceeds the configured threshold ${rule.maxSessions}`,
        });
      }
      this.dropLine(flow, packet, 'Session limiting');
      return { permit: false };
    }

    if (tcp && settings.hostMaxIncomplete > 0) {
      const toHost = this.halfOpen().filter((s) => s.protocol === IP_TCP && s.responder === flow.destination);
      if (toHost.length >= settings.hostMaxIncomplete) {
        if (!this.hostAlerted.has(flow.destination) && this.alertsEnabled(entry.options)) {
          this.hostAlerted.add(flow.destination);
          this.logs.push({
            severity: 'warnings', mnemonic: 'HOST_TCP_ALERT_ON',
            text: `Max tcp half-open connections (${settings.hostMaxIncomplete}) exceeded for host ${flow.destination}.`,
          });
        }
        if (settings.hostBlockMinutes > 0) {
          for (const session of toHost) this.flows.remove(session, 'evicted');
          this.blockedHosts.set(flow.destination, { untilMs: now + settings.hostBlockMinutes * 60_000 });
          if (this.alertsEnabled(entry.options)) {
            this.logs.push({
              severity: 'warnings', mnemonic: 'BLOCK_HOST',
              text: `Blocking new TCP connections to host ${flow.destination} for ${settings.hostBlockMinutes} minutes (half-open count ${settings.hostMaxIncomplete} exceeded)`,
            });
          }
          this.statistics.packetsDropped += 1;
          this.dropLine(flow, packet, 'Session limiting');
          return { permit: false };
        }
        this.evictOldestHalfOpen(undefined, flow.destination);
      }
    }

    this.updateAggression(now, entry.options);
    if (this.aggressive) this.evictOldestHalfOpen();

    const audit = entry.options.auditTrail ?? settings.auditTrail;
    this.flows.create(flow, rule.name, entry.keyword, now, {
      idleOverrideSec: entry.options.timeoutSec, audit, context,
    });
    this.creationTimes.push(now);
    this.statistics.created += 1;
    this.updateStatistics(now);
    if (audit) {
      this.logs.push({
        severity: 'informational', mnemonic: 'SESS_AUDIT_TRAIL_START',
        text: `Start ${entry.keyword} session: initiator (${flow.source}:${flow.sourcePort}) -- responder (${flow.destination}:${flow.destinationPort})`,
      });
    }
    return { permit: true };
  }

  sweep(): void {
    const now = simulationNowMs();
    this.flows.expire(now);
    this.releaseHostBlocks(now);
    this.updateAggression(now, undefined);
  }

  hasWork(): boolean {
    return this.flows.list().length > 0 || this.blockedHosts.size > 0 || this.aggressive;
  }

  drainLogs(): CbacLogLine[] {
    return this.logs.splice(0, this.logs.length);
  }

  sessionList(rule?: string): FlowSession[] {
    this.flows.expire(simulationNowMs());
    return this.flows.list(rule);
  }

  clearSessions(address?: number): void {
    for (const session of this.flows.list()) {
      if (address === undefined || session.id === address) this.flows.remove(session, 'cleared');
    }
  }

  clearStatistics(): void {
    this.statistics = CbacFirewall.freshStatistics(simulationNowMs());
  }

  statisticsView(): CbacStatistics & { current: { open: number; half: number; closing: number }; rate: number } {
    const now = simulationNowMs();
    this.flows.expire(now);
    const sessions = this.flows.list();
    return {
      ...this.statistics,
      current: {
        open: sessions.filter((s) => s.state === 'SIS_OPEN').length,
        half: sessions.filter((s) => s.state === 'SIS_OPENING').length,
        closing: sessions.filter((s) => s.state === 'SIS_CLOSING').length,
      },
      rate: this.pruneRate(now),
    };
  }
}
