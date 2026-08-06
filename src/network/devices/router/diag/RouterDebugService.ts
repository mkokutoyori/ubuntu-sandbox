export type DebugCategory =
  | 'crypto.isakmp'
  | 'crypto.ipsec'
  | 'crypto.ikev2'
  | 'crypto.pki'
  | 'crypto.pki.transactions'
  | 'crypto.pki.messages'
  | 'ip.ospf.adj'
  | 'ip.ospf.events'
  | 'ip.ospf.spf'
  | 'ip.ospf.hello'
  | 'ip.ospf.packet'
  | 'ip.ospf.lsa-generation'
  | 'ip.rip'
  | 'ip.eigrp'
  | 'ip.bgp'
  | 'ip.routing'
  | 'ip.icmp'
  | 'ip.packet'
  | 'ip.tcp'
  | 'ip.udp'
  | 'ip.nat'
  | 'ip.arp'
  | 'interface'
  | 'ip.dhcp.server'
  | 'ip.ssh'
  | 'ip.nhrp'
  | 'standby'
  | 'vrrp'
  | 'glbp'
  | 'track'
  | 'ip.sla.trace'
  | 'ip.sla.error'
  | 'aaa.authentication'
  | 'aaa.authorization'
  | 'aaa.accounting'
  | 'radius'
  | 'tacacs'
  | 'ntp.events'
  | 'ntp.packets'
  | 'lldp.packets'
  | 'cdp.packets'
  | 'ip.pim'
  | 'vxlan'
  | 'port-security'
  | 'ipv6.packet';

import type { IEventBus } from '@/events/EventBus';
import { DebugBroadcast, type DebugLineListener, type TerminalDebugSource } from '@/network/devices/diag/DebugBroadcast';

export function toCiscoMac(mac: string): string {
  const hex = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length !== 12) return mac;
  return `${hex.slice(0, 4)}.${hex.slice(4, 8)}.${hex.slice(8, 12)}`;
}

export interface DebugFlag {
  category: DebugCategory;
  enabledAtMs: number;
  /** ACL name/number the flag is filtered by, when one was given. */
  scope?: string;
  /** `detail` keyword — an independent axis from the ACL, so it needs
   *  its own field: `debug ip packet 100 detail` carries both. */
  detail?: boolean;
}

export interface DebugPacketFacts {
  src: string;
  dst: string;
  proto: number;
  srcPort?: number;
  dstPort?: number;
}

export class RouterDebugService implements TerminalDebugSource {
  private readonly flags: Map<DebugCategory, DebugFlag> = new Map();
  private readonly broadcast = new DebugBroadcast();

  private static readonly VOLUMINEUX: ReadonlySet<string> = new Set([
    'ip.packet', 'ip.tcp', 'ip.udp', 'all',
  ]);

  private static avertissement(category: DebugCategory): string {
    return RouterDebugService.VOLUMINEUX.has(String(category))
      ? 'MUST NOT be used on production networks; High CPU utilization may occur.\n'
      : '';
  }

  enable(category: DebugCategory, scope?: string, detail = false): string {
    this.flags.set(category, { category, enabledAtMs: Date.now(), scope, detail });
    return `${RouterDebugService.avertissement(category)}${RouterDebugService.label(category)} debugging is on${scope ? ' for ' + scope : ''}${detail ? ' (detailed)' : ''}`;
  }

  disable(category: DebugCategory): string {
    this.flags.delete(category);
    return `${RouterDebugService.label(category)} debugging is off`;
  }

  isEnabled(category: DebugCategory): boolean { return this.flags.has(category); }

  hasAnyFlag(): boolean { return this.flags.size > 0; }

  list(): readonly DebugFlag[] {
    return [...this.flags.values()].sort((a, b) => a.category.localeCompare(b.category));
  }

  disableAll(): string {
    const n = this.flags.size;
    this.flags.clear();
    return n === 0 ? 'All possible debugging has been turned off' : `${n} debug flag${n === 1 ? '' : 's'} have been turned off`;
  }

  subscribe(listener: DebugLineListener): () => void {
    return this.broadcast.subscribe(listener);
  }

  subscriberCount(): number { return this.broadcast.subscriberCount(); }

  /**
   * Re-read `logging rate-limit` before each line, so an operator who
   * lowers the budget mid-flood sees it take effect at once instead of
   * having to bounce the debug.
   */
  private rateLimitResolver: (() => void) | null = null;
  setRateLimitResolver(fn: (() => void) | null): void { this.rateLimitResolver = fn; }

  /**
   * `debug condition interface X` / `debug condition vrf Y`. On IOS a
   * condition is global: every debug already on, and every one enabled
   * afterwards, inherits it. A line that carries no evidence either way
   * is dropped — a condition the operator asked for must not be widened
   * by our own inability to classify a line.
   */
  private readonly conditions: Array<{ kind: 'interface' | 'vrf' | 'ip'; value: string }> = [];

  addCondition(kind: 'interface' | 'vrf' | 'ip', value: string): string {
    if (!this.conditions.some((c) => c.kind === kind && c.value.toLowerCase() === value.toLowerCase())) {
      this.conditions.push({ kind, value });
    }
    return `Condition ${this.conditions.length} set`;
  }

  removeCondition(kind: 'interface' | 'vrf' | 'ip', value: string): string {
    const i = this.conditions.findIndex(
      (c) => c.kind === kind && c.value.toLowerCase() === value.toLowerCase());
    if (i < 0) return `% Condition not found`;
    this.conditions.splice(i, 1);
    return `Condition ${i + 1} has been removed`;
  }

  clearConditions(): void { this.conditions.length = 0; }

  listConditions(): ReadonlyArray<{ kind: 'interface' | 'vrf' | 'ip'; value: string }> {
    return this.conditions;
  }

  /** Does this line satisfy every standing condition? */
  private passesConditions(line: string): boolean {
    for (const c of this.conditions) {
      const needle = c.value.toLowerCase();
      if (!line.toLowerCase().includes(needle)) return false;
    }
    return true;
  }

  /** Master switch: `no logging on` mutes every channel, flags intact. */
  setOutputGate(gate: (() => boolean) | null): void { this.broadcast.setOutputGate(gate); }

  /** `logging rate-limit N` — console budget for debug output. */
  setRateLimit(linesPerSecond: number): void { this.broadcast.setRateLimit(linesPerSecond); }
  getRateLimit(): number { return this.broadcast.getRateLimit(); }
  /** Lines the rate limiter dropped since boot. */
  getDroppedCount(): number { return this.broadcast.getDroppedCount(); }
  /** Report the current window's drops now, rather than on the next line. */
  flushDrops(): void { this.broadcast.flushDrops(); }

  private aclMatchFn?: (aclName: string, line: string, faits?: DebugPacketFacts) => boolean;
  private readonly categoryRenderers = new Map<DebugCategory, () => string>();

  setCategoryRenderer(category: DebugCategory, render: () => string): void {
    this.categoryRenderers.set(category, render);
  }

  setAclFilterEvaluator(fn: (aclName: string, line: string, faits?: DebugPacketFacts) => boolean): void {
    this.aclMatchFn = fn;
  }

  private tamponSyslog?: (line: string) => void;

  setSyslogSink(fn: (line: string) => void): void { this.tamponSyslog = fn; }

  private emit(category: DebugCategory, line: string, faits?: DebugPacketFacts): void {
    const flag = this.flags.get(category);
    if (!flag) return;
    this.rateLimitResolver?.();
    if (!this.passesConditions(line)) return;
    if (flag.scope && this.aclMatchFn && !this.aclMatchFn(flag.scope, line, faits)) return;
    this.broadcast.fan(line);
    this.tamponSyslog?.(line);
  }

  private static faitsDe(ip: { src: string; dst: string; proto: number; transport?: unknown }): DebugPacketFacts {
    const t = ip.transport as { sourcePort?: number; destinationPort?: number } | undefined;
    return {
      src: ip.src, dst: ip.dst, proto: ip.proto,
      srcPort: t?.sourcePort, dstPort: t?.destinationPort,
    };
  }

  private readonly tcpVues = new Map<string, string>();

  private tracerTcp(ip: { src: string; dst: string; transport?: unknown }, dir: string, faits?: DebugPacketFacts): void {
    const t = ip.transport as { sourcePort?: number; destinationPort?: number;
      sequenceNumber?: number; acknowledgementNumber?: number;
      flags?: { syn?: boolean; ack?: boolean; fin?: boolean; rst?: boolean } } | undefined;
    if (!t) return;
    const f = t.flags ?? {};
    const nom = f.rst ? 'RST'
      : f.syn && f.ack ? 'SYN-ACK'
      : f.syn ? 'SYN'
      : f.fin && f.ack ? 'FIN-ACK'
      : f.fin ? 'FIN'
      : f.ack ? 'ACK' : null;
    if (!nom) return;
    const verbe = dir === 'rcvd' ? 'received' : 'sending';
    if (nom === 'RST') {
      this.emit('ip.tcp', 'TCP: received RST', faits);
      return;
    }
    this.emit('ip.tcp',
      `TCP: ${verbe} ${nom}, seq ${t.sequenceNumber ?? 0}, ack ${t.acknowledgementNumber ?? 0}`, faits);

    const cle = [ip.src, t.sourcePort, ip.dst, t.destinationPort].join(':');
    const inverse = [ip.dst, t.destinationPort, ip.src, t.sourcePort].join(':');
    if (nom === 'SYN-ACK') this.tcpVues.set(inverse, 'syn-ack');
    else if (nom === 'ACK' && this.tcpVues.get(cle) === 'syn-ack') {
      this.tcpVues.delete(cle);
      this.emit('ip.tcp', `TCP: Connection to ${ip.dst}:${t.destinationPort} ESTABLISHED`, faits);
    }
  }

  private static ligneTransport(proto: number, t: unknown): string | null {
    if (proto === 6) {
      const s = t as { sourcePort?: number; destinationPort?: number; sequenceNumber?: number;
        acknowledgementNumber?: number; windowSize?: number;
        flags?: { syn?: boolean; ack?: boolean; fin?: boolean; rst?: boolean; psh?: boolean; urg?: boolean } };
      const f = s?.flags ?? {};
      const noms = [
        f.syn ? 'SYN' : '', f.ack ? 'ACK' : '', f.fin ? 'FIN' : '',
        f.rst ? 'RST' : '', f.psh ? 'PSH' : '', f.urg ? 'URG' : '',
      ].filter(Boolean).join(' ');
      return `TCP src=${s?.sourcePort ?? 0}, dst=${s?.destinationPort ?? 0}, `
        + `seq=${s?.sequenceNumber ?? 0}, ack=${s?.acknowledgementNumber ?? 0}, `
        + `win=${s?.windowSize ?? 0}${noms ? ' ' + noms : ''}`;
    }
    if (proto === 17) {
      const u = t as { sourcePort?: number; destinationPort?: number };
      return `UDP src=${u?.sourcePort ?? 0}, dst=${u?.destinationPort ?? 0}`;
    }
    if (proto === 1) {
      const i = t as { icmpType?: string; code?: number };
      const num = i?.icmpType === 'echo-reply' ? 0
        : i?.icmpType === 'echo-request' ? 8
        : i?.icmpType === 'destination-unreachable' ? 3
        : i?.icmpType === 'redirect' ? 5
        : i?.icmpType === 'time-exceeded' ? 11 : 255;
      return `ICMP type=${num}, code=${i?.code ?? 0}`;
    }
    return null;
  }

  emitIcmpError(type: string, code: number, offendingDst: string, routerIp: string, replyTo: string): void {
    if (type === 'destination-unreachable') {
      const quoi = code === 1 ? 'host unreachable'
        : code === 0 ? 'net unreachable'
        : code === 13 ? 'administratively prohibited'
        : code === 4 ? 'frag. needed and DF set'
        : 'unreachable';
      this.emit('ip.icmp', `ICMP: dst (${offendingDst}) ${quoi}, src ${routerIp}`);
      return;
    }
    if (type === 'time-exceeded') {
      this.emit('ip.icmp', `ICMP: time exceeded (time to live) sent to ${replyTo}`);
    }
  }

  emitLine(category: DebugCategory, line: string): void {
    this.emit(category, line);
  }

  attachToBus(bus: IEventBus, deviceId: string): void {
    if (!this.broadcast.beginAttach(bus, deviceId)) return;
    const mine = (p: { deviceId?: string }) => p.deviceId === undefined || p.deviceId === deviceId;
    this.broadcast.track(bus.subscribe('ospf.neighbor.state-changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ip.ospf.adj', `OSPF-5-ADJCHG: Process ${p.processId}, Nbr ${p.neighborId} on ${p.iface} from ${p.oldState} to ${p.newState}, ${p.event}`);
    }));
    this.broadcast.track(bus.subscribe('ospf.interface.state-changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ip.ospf.events', `OSPF: Interface ${p.iface} state change from ${p.oldState} to ${p.newState}`);
    }));
    this.broadcast.track(bus.subscribe('ospf.spf.run', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ip.ospf.spf', `OSPF: Running ${p.kind} SPF (run ${p.runIndex}), ${p.routesCount} routes, runtime ${p.runtimeMs}ms`);
    }));
    this.broadcast.track(bus.subscribe('ospf.lsa.installed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as { areaId?: string; lsa?: { lsType?: number; linkStateId?: string; advertisingRouter?: string; sequenceNumber?: number } };
      const h = p.lsa ?? {};
      this.emit('ip.ospf.lsa-generation',
        `OSPF: Generate LSA type ${h.lsType ?? '?'}, LSID ${h.linkStateId ?? '?'}, adv rtr ${h.advertisingRouter ?? '?'}, area ${p.areaId ?? '?'}, seq 0x${(h.sequenceNumber ?? 0).toString(16).toUpperCase()}`);
    }));
    this.broadcast.track(bus.subscribe('ospf.hello.send-requested', (e) => {
      if (!mine(e.payload)) return;
      this.emit('ip.ospf.hello', `OSPF: Send hello packet on ${e.payload.iface}`);
    }));
    this.broadcast.track(bus.subscribe('ospf.packet.received', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ip.ospf.packet', `OSPF: rcv packet from ${p.srcIp} on ${p.iface}`);
    }));
    this.broadcast.track(bus.subscribe('ospf.packet.outgoing', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ip.ospf.packet', `OSPF: snd packet to ${p.destIp} on ${p.iface}`);
    }));

    // Neighbour discovery, multicast, VXLAN and the DHCP client. These used
    // to be raised by the logging subsystem as `%CDP-7-DEBUGGING: …` — a
    // shape IOS never prints, invented from the severity name. Real debug
    // output carries the subsystem's own prefix and no severity at all.
    this.broadcast.track(bus.subscribe('cdp.neighbor.refreshed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { localPort?: string; remoteHost?: string };
      this.emit('cdp.packets',
        `CDP-PA: Packet received from ${p.remoteHost ?? '?'} on interface ${p.localPort ?? '?'}`);
    }));
    this.broadcast.track(bus.subscribe('lldp.neighbor.refreshed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { localPort?: string; remoteSystem?: string };
      this.emit('lldp.packets',
        `LLDP: Received packet from ${p.remoteSystem ?? '?'} on ${p.localPort ?? '?'}`);
    }));
    this.broadcast.track(bus.subscribe('pim.mroute.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { group?: string; source?: string; iif?: string };
      this.emit('ip.pim',
        `PIM(0): Update (${p.source ?? '*'}, ${p.group ?? '*'}), incoming interface ${p.iif ?? 'Null'}`);
    }));
    this.broadcast.track(bus.subscribe('vxlan.mac.learned', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { vni?: number; mac?: string; vtepIp?: string };
      this.emit('vxlan',
        `NVE: Learned ${p.mac ?? '?'} in VNI ${p.vni ?? 0} from peer ${p.vtepIp ?? '?'}`);
    }));
    this.broadcast.track(bus.subscribe('dhcp.client.state-changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { iface?: string; oldState?: string; newState?: string };
      this.emit('ip.dhcp.server',
        `DHCP: ${p.iface ?? '?'} state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
    }));

    const decodeIp = (frame: unknown): { src: string; dst: string; proto: number; len: number; icmpType?: string; transport?: unknown } | null => {
      const f = frame as { etherType?: number; payload?: { type?: string; protocol?: number; totalLength?: number; sourceIP?: { toString(): string }; destinationIP?: { toString(): string }; payload?: { type?: string; icmpType?: string; data?: { length?: number } } } };
      if (f?.etherType !== 0x0800 || f.payload?.type !== 'ipv4') return null;
      const ip = f.payload;
      return {
        src: ip.sourceIP?.toString?.() ?? '?',
        dst: ip.destinationIP?.toString?.() ?? '?',
        proto: ip.protocol ?? 0,
        len: ip.totalLength ?? 0,
        icmpType: ip.payload?.type === 'icmp' ? ip.payload.icmpType : undefined,
        transport: ip.payload,
      };
    };
    const decodeArp = (frame: unknown): { op: 'request' | 'reply'; senderIp: string; senderMac: string; targetIp: string; targetMac: string } | null => {
      const f = frame as { etherType?: number; payload?: { type?: string; operation?: 'request' | 'reply'; senderIP?: { toString(): string }; senderMAC?: { toString(): string }; targetIP?: { toString(): string }; targetMAC?: { toString(): string } } };
      if (f?.etherType !== 0x0806 || f.payload?.type !== 'arp') return null;
      const a = f.payload;
      return {
        op: a.operation === 'reply' ? 'reply' : 'request',
        senderIp: a.senderIP?.toString?.() ?? '?',
        senderMac: a.senderMAC?.toString?.() ?? '?',
        targetIp: a.targetIP?.toString?.() ?? '?',
        targetMac: a.targetMAC?.toString?.() ?? '?',
      };
    };
    const onFrame = (frame: unknown, dir: 'rcvd' | 'sent', iface: string) => {
      const arp = decodeArp(frame);
      if (arp) {
        const op = arp.op === 'reply' ? 'rep' : 'req';
        const senderMac = toCiscoMac(arp.senderMac);
        const targetMac = arp.op === 'request' ? '0000.0000.0000' : toCiscoMac(arp.targetMac);
        this.emit('ip.arp', `IP ARP: ${dir} ${op} src ${arp.senderIp} ${senderMac}, dst ${arp.targetIp} ${targetMac} ${iface}`);
        return;
      }
      // IPv6 is a separate protocol with a separate flag. `debug ip
      // packet` must not see it, and `debug ipv6 packet` must not see
      // IPv4 — the etherType decides, nothing else.
      const f6 = frame as { etherType?: number; payload?: { type?: string; nextHeader?: number; payloadLength?: number; sourceIP?: { toString(): string }; destinationIP?: { toString(): string } } };
      if (f6?.etherType === 0x86dd && f6.payload?.type === 'ipv6') {
        const v6 = f6.payload;
        this.emit('ipv6.packet',
          `IPV6: s=${v6.sourceIP?.toString?.() ?? '?'} (${iface}), d=${v6.destinationIP?.toString?.() ?? '?'}, len ${v6.payloadLength ?? 0}, ${dir} (nxt ${v6.nextHeader ?? 0})`);
        return;
      }
      const ip = decodeIp(frame);
      if (!ip) return;
      const faits = RouterDebugService.faitsDe(ip);
      this.emit('ip.packet',
        `IP: s=${ip.src} (${iface}), d=${ip.dst}, len ${ip.len}, ${dir} (proto ${ip.proto})`, faits);
      const detail = RouterDebugService.ligneTransport(ip.proto, ip.transport);
      if (detail && this.flags.get('ip.packet')?.detail) this.emit('ip.packet', detail, faits);
      if (ip.proto === 6 && dir !== 'forward') this.tracerTcp(ip, dir, faits);
      if (ip.proto === 17 && dir === 'rcvd') {
        const u = ip.transport as { sourcePort?: number; destinationPort?: number; length?: number } | undefined;
        if (u) {
          this.emit('ip.udp',
            `UDP: src=${ip.src}(${u.sourcePort ?? 0}), dst=${ip.dst}(${u.destinationPort ?? 0}), `
            + `length=${u.length ?? 0}`, faits);
        }
      }
      if (ip.proto === 1) {
        if (ip.icmpType === 'echo-request') {
          this.emit('ip.icmp', `ICMP: echo received, src ${ip.src}, dst ${ip.dst}`, faits);
        } else if (ip.icmpType === 'echo-reply') {
          this.emit('ip.icmp', `ICMP: echo reply sent, src ${ip.src}, dst ${ip.dst}`, faits);
        } else {
          this.emit('ip.icmp', `ICMP: ${ip.icmpType ?? 'message'} ${dir}, src ${ip.src}, dst ${ip.dst}`, faits);
        }
      }
    };
    this.broadcast.track(bus.subscribe('port.link.up', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as { portName?: string };
      this.emit('interface', `${p.portName ?? '?'} came back up`);
    }));
    this.broadcast.track(bus.subscribe('port.link.down', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as { portName?: string };
      this.emit('interface', `${p.portName ?? '?'} went down`);
      this.emit('interface', `${p.portName ?? '?'} keepalive timer expired`);
    }));
    // `ip.sla.trace`/`track` étaient déclarées comme catégories et
    // émises par personne : `debug ip sla trace` retombait sur le
    // fourre-tout `debug ip` et imprimait « IP packet debugging is on ».
    this.broadcast.track(bus.subscribe('ipsla.probe.completed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      const rtt = p.rttMs === null ? '-' : `${Math.round(p.rttMs)} ms`;
      this.emit('ip.sla.trace',
        `IP SLA(${p.operationId}) Scheduler: probe completed, `
        + `type ${p.type}, target ${p.target ?? '-'}, RTT ${rtt}, return code ${p.returnCode}`);
      if (p.returnCode !== 'ok' && p.returnCode !== 'overThreshold') {
        this.emit('ip.sla.error',
          `IP SLA(${p.operationId}) ${p.returnCode}${p.diagText ? `: ${p.diagText}` : ''}`);
      }
    }));
    this.broadcast.track(bus.subscribe('ipsla.operation.state-changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ip.sla.trace',
        `IP SLA(${p.operationId}) Scheduler: entry ${p.oldState} -> ${p.newState} (${p.reason})`);
    }));
    this.broadcast.track(bus.subscribe('track.state.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('track',
        `Track ${p.objectId} ${p.description} ${p.oldState} -> ${p.newState}`);
    }));
    this.broadcast.track(bus.subscribe('port.frame.received', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as { frame: unknown; portName?: string };
      onFrame(p.frame, 'rcvd', p.portName ?? '?');
    }));
    this.broadcast.track(bus.subscribe('port.frame.tx-requested', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as { frame: unknown; portName?: string };
      onFrame(p.frame, 'sent', p.portName ?? '?');
    }));
  }

  detachFromBus(): void {
    this.broadcast.detach();
  }

  static label(category: DebugCategory): string {
    switch (category) {
      case 'crypto.isakmp': return 'Crypto ISAKMP';
      case 'crypto.ipsec': return 'Crypto IPSEC';
      case 'crypto.ikev2': return 'IKEv2';
      case 'crypto.pki': return 'Crypto PKI';
      case 'crypto.pki.transactions': return 'PKI Transactions';
      case 'crypto.pki.messages': return 'PKI Messages';
      case 'ip.ospf.adj': return 'OSPF adjacency';
      case 'ip.ospf.events': return 'OSPF events';
      case 'ip.ospf.spf': return 'OSPF SPF';
      case 'ip.ospf.hello': return 'OSPF Hello';
      case 'ip.ospf.packet': return 'OSPF packet';
      case 'ip.ospf.lsa-generation': return 'OSPF LSA generation';
      case 'ip.rip': return 'RIP';
      case 'ip.eigrp': return 'EIGRP';
      case 'ip.bgp': return 'BGP';
      case 'ip.routing': return 'IP routing';
      case 'ip.icmp': return 'ICMP packet';
      case 'ip.packet': return 'IP packet';
      case 'ip.tcp': return 'TCP special event';
      case 'ip.udp': return 'UDP packet';
      case 'ip.nat': return 'IP NAT';
      case 'ip.arp': return 'ARP packet';
      case 'interface': return 'Interface';
      case 'ip.dhcp.server': return 'IP DHCP server';
      case 'ip.ssh': return 'SSH';
      case 'ip.nhrp': return 'NHRP';
      case 'standby': return 'HSRP';
      case 'vrrp': return 'VRRP';
      case 'glbp': return 'GLBP';
      case 'track': return 'TRACK';
      case 'ip.sla.trace': return 'IP SLA';
      case 'ip.sla.error': return 'IP SLA error';
      case 'aaa.authentication': return 'AAA Authentication';
      case 'aaa.authorization': return 'AAA Authorization';
      case 'aaa.accounting': return 'AAA Accounting';
      case 'radius': return 'RADIUS';
      case 'tacacs': return 'TACACS+';
      case 'ntp.events': return 'NTP events';
      case 'ntp.packets': return 'NTP packets';
      case 'lldp.packets': return 'LLDP packets';
      case 'cdp.packets': return 'CDP packets';
      case 'ip.pim': return 'PIM';
      case 'vxlan': return 'VXLAN';
      case 'port-security': return 'Port security';
      case 'ipv6.packet': return 'IPv6 packet';
    }
  }

  /**
   * The debug category behind a syslog tag, for the severity-7 lines the
   * logging subsystem raises on its own (`LoggingConfig.setDebugGate`).
   * An unmapped tag has no `debug` verb to turn it on, so its lines stay
   * off — nothing may reach a console that never asked for it.
   */
  static categoryForSyslogTag(tag: string): DebugCategory | null {
    switch (tag) {
      case 'cdp': return 'cdp.packets';
      case 'lldp': return 'lldp.packets';
      case 'nat': return 'ip.nat';
      case 'arp': return 'ip.arp';
      case 'dhcp': return 'ip.dhcp.server';
      case 'pim': return 'ip.pim';
      case 'vxlan': return 'vxlan';
      case 'port_security': return 'port-security';
      case 'ospf': return 'ip.ospf.events';
      default: return null;
    }
  }

  /** Is the `debug` behind this syslog tag currently on? */
  isEnabledForSyslogTag(tag: string): boolean {
    if (tag === 'ospf') {
      return [...this.flags.keys()].some(k => String(k).startsWith('ip.ospf.'));
    }
    const category = RouterDebugService.categoryForSyslogTag(tag);
    return category !== null && this.isEnabled(category);
  }

  private static groupe(category: DebugCategory): string {
    const c = String(category);
    if (c.startsWith('ip.ospf')) return 'OSPF';
    if (c.startsWith('crypto.pki')) return 'Crypto PKI';
    if (c.startsWith('crypto')) return 'Crypto';
    if (c === 'ip.arp') return 'ARP';
    if (c === 'ip.routing') return 'IP routing';
    if (c === 'ip.packet') return 'IP packet';
    if (c === 'ip.icmp') return 'ICMP';
    if (c === 'ip.nat') return 'IP NAT';
    if (c.startsWith('ip.')) return RouterDebugService.label(category);
    return RouterDebugService.label(category);
  }

  formatConditions(): string {
    if (this.conditions.length === 0) return 'Condition 1 is not set';
    return this.conditions
      .map((c, i) => `Condition ${i + 1}: ${c.kind} ${c.value} (0 flags triggered)`)
      .join('\n');
  }

  format(): string {
    if (this.flags.size === 0) return 'No debug flags are enabled';
    const parGroupe = new Map<string, string[]>();
    for (const f of this.list()) {
      const custom = this.categoryRenderers.get(f.category);
      const ligne = custom
        ? custom()
        : f.category === 'interface' && f.scope
          ? `Interface ${f.scope} debugging is on`
          : `${RouterDebugService.label(f.category)} debugging is on${f.scope ? ' for ' + f.scope : ''}${f.detail ? ' (detailed)' : ''}`;
      const g = RouterDebugService.groupe(f.category);
      const dejaLa = parGroupe.get(g);
      if (dejaLa) dejaLa.push(...ligne.split('\n'));
      else parGroupe.set(g, ligne.split('\n'));
    }
    const out: string[] = [];
    for (const [g, lignes] of parGroupe) {
      out.push(`${g}:`);
      for (const l of lignes) out.push(`  ${l}`);
    }
    return out.join('\n');
  }
}
