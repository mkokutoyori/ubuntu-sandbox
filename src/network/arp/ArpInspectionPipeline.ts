/**
 * ArpInspectionPipeline — wires `ArpInspectionEngine` and
 * `ArpRateLimiter` to a host switch.
 *
 * Responsibilities (in order):
 *   1. Bump the per-port `received` counter.
 *   2. Refuse the frame if the port is currently err-disabled by DAI.
 *   3. Apply the rate-limiter (untrusted ports only).
 *   4. Run the inspection engine against config + ACLs + bindings.
 *   5. Update per-port stats, log to the snooping log, and publish a
 *      typed `ArpDomainEvent` on the host's event bus.
 *   6. On `pass`, hand the frame back to the switch's normal pipeline;
 *      on `drop`, swallow it.
 *
 * The pipeline holds no policy of its own — every knob lives in the
 * `ArpInspectionConfig` carried by the switch, which keeps the running
 * / startup config the single source of truth.
 */
import type { IEventBus } from '@/events/EventBus';
import type {
  ArpAccessList, ArpInspectionConfig, ArpInspectionContext, ArpInspectionVerdict,
  ArpStats,
} from './types';
import type { DHCPSnoopingBinding } from '../dhcp/types';
import { ArpInspectionEngine } from './ArpInspectionEngine';
import { ArpRateLimiter } from './ArpRateLimiter';
import { createDefaultArpStats } from './types';
import { Logger } from '../core/Logger';

export interface ArpInspectionHost {
  id: string;
  name: string;
  _getArpInspectionConfig(): ArpInspectionConfig;
  _getArpAccessLists(): Map<string, ArpAccessList>;
  _getSnoopingBindings(): DHCPSnoopingBinding[];
  _addSnoopingLog(msg: string): void;
  _arpErrDisable(port: string): void;
  _isArpErrDisabled(port: string): boolean;
}

export class ArpInspectionPipeline {
  private readonly engine = new ArpInspectionEngine();
  private readonly limiter = new ArpRateLimiter();
  private readonly stats: Map<string, ArpStats> = new Map();

  constructor(
    private readonly host: ArpInspectionHost,
    private readonly getBus: () => IEventBus,
  ) {}

  private get bus(): IEventBus { return this.getBus(); }

  /**
   * Inspect an ARP frame. Returns `true` to let the caller forward it
   * through the normal L2 pipeline; `false` means the engine dropped
   * the frame and the caller must stop processing it.
   */
  process(ctx: ArpInspectionContext): boolean {
    const cfg = this.host._getArpInspectionConfig();
    const port = ctx.ingressPort;
    const s = this.stats.get(port) ?? this.installStats(port);
    s.received++;

    if (this.host._isArpErrDisabled(port)) {
      s.dropped++;
      s.droppedDisabled++;
      this.publish({ kind: 'drop', reason: 'port-err-disabled', detail: 'port is err-disabled by arp-inspection' }, ctx);
      return false;
    }

    if (cfg.vlans.has(ctx.vlan) && !cfg.trustedPorts.has(port)) {
      const limit = cfg.rateLimits.get(port);
      if (limit && limit > 0) {
        const r = this.limiter.consume(port, limit, cfg.rateBurstSec);
        if (!r.ok) {
          s.dropped++;
          s.droppedRateLimit++;
          this.host._arpErrDisable(port);
          this.bus.publish({
            topic: 'arp.rate-limit-exceeded',
            payload: {
              switchId: this.host.id, switchName: this.host.name,
              ingressPort: port, rateLimitPps: r.limit, observedPps: r.observedPps,
            },
          });
          this.appendLog(
            `%SW_DAI-4-PACKET_RATE_EXCEEDED: ${port} exceeded ${r.limit} pps; err-disabled`,
            cfg.loggingEnabled,
          );
          this.publish({ kind: 'drop', reason: 'rate-limit', detail: `>${r.limit} pps` }, ctx);
          return false;
        }
      }
    }

    const verdict = this.engine.inspect(
      ctx, cfg, this.host._getArpAccessLists(), this.host._getSnoopingBindings(),
    );

    if (verdict.kind === 'pass') {
      s.forwarded++;
    } else {
      s.dropped++;
      this.bumpDropCounter(s, verdict);
      this.appendLog(this.formatDropLog(ctx, verdict), cfg.loggingEnabled);
      this.bus.publish({
        topic: 'arp.violation',
        payload: {
          switchId: this.host.id, switchName: this.host.name,
          ingressPort: port, vlan: ctx.vlan,
          senderIp: ctx.senderIp.toString(), senderMac: ctx.senderMac.toString().toLowerCase(),
          reason: verdict.reason, detail: verdict.detail,
        },
      });
    }
    this.publish(verdict, ctx);
    return verdict.kind === 'pass';
  }

  getStats(): Map<string, ArpStats> {
    return new Map(this.stats);
  }

  getPortStats(port: string): ArpStats {
    return this.stats.get(port) ?? this.installStats(port);
  }

  resetStats(): void {
    this.stats.clear();
    this.limiter.clear();
  }

  /**
   * Discard rate-limit accounting for a port. Counters are kept across
   * link flaps to match Cisco DAI behaviour — they only reset on an
   * explicit `clear ip arp inspection statistics`.
   */
  resetPort(port: string): void {
    this.limiter.reset(port);
  }

  // ── helpers ────────────────────────────────────────────────────────

  private installStats(port: string): ArpStats {
    const s = createDefaultArpStats();
    this.stats.set(port, s);
    return s;
  }

  private bumpDropCounter(s: ArpStats, v: ArpInspectionVerdict): void {
    if (v.kind !== 'drop') return;
    switch (v.reason) {
      case 'binding-mismatch':  s.droppedBindingMismatch++; break;
      case 'acl-deny':          s.droppedAclDeny++; break;
      case 'src-mac-mismatch':  s.droppedSrcMacMismatch++; break;
      case 'dst-mac-mismatch':  s.droppedDstMacMismatch++; break;
      case 'invalid-ip':        s.droppedInvalidIp++; break;
      case 'rate-limit':        s.droppedRateLimit++; break;
      case 'port-err-disabled': s.droppedDisabled++; break;
    }
  }

  private publish(v: ArpInspectionVerdict, ctx: ArpInspectionContext): void {
    this.bus.publish({
      topic: 'arp.inspected',
      payload: {
        switchId: this.host.id, switchName: this.host.name,
        ingressPort: ctx.ingressPort, vlan: ctx.vlan,
        senderIp: ctx.senderIp.toString(),
        senderMac: ctx.senderMac.toString().toLowerCase(),
        targetIp: ctx.targetIp.toString(),
        operation: ctx.operation,
        verdict: v.kind, reason: v.reason,
      },
    });
  }

  private formatDropLog(ctx: ArpInspectionContext, v: ArpInspectionVerdict): string {
    const op = ctx.operation === 'request' ? 'Request' : 'Response';
    return `%SW_DAI-4-DHCP_SNOOPING_DENY: 1 Invalid ARP ${op}s on ${ctx.ingressPort}, vlan ${ctx.vlan}.` +
      ` ([${ctx.senderMac.toString().toLowerCase()}/${ctx.senderIp.toString()}/` +
      `${ctx.targetMac.toString().toLowerCase()}/${ctx.targetIp.toString()}]) — ${v.kind === 'drop' ? v.detail : ''}`;
  }

  private appendLog(line: string, enabled: boolean): void {
    if (!enabled) return;
    const ts = new Date().toISOString();
    this.host._addSnoopingLog(`*${ts}: ${line}`);
    Logger.warn(this.host.id, 'switch:arp-inspection', `${this.host.name}: ${line}`);
  }
}
