import { getDefaultEventBus } from '@/events/EventBus';

/**
 * LoggingConfig — config-driven syslog/logging state (Lot C).
 *
 * `logging …` commands mutate this real Repository instead of being
 * swallowed as no-ops; `show logging` projects it. Defaults match IOS.
 */
const SEVERITIES = [
  'emergencies', 'alerts', 'critical', 'errors', 'warnings',
  'notifications', 'informational', 'debugging',
] as const;
type Severity = typeof SEVERITIES[number];

function normSeverity(tok: string): Severity | null {
  const t = tok.toLowerCase();
  if ((SEVERITIES as readonly string[]).includes(t)) return t as Severity;
  const n = parseInt(t, 10);
  return Number.isNaN(n) || n < 0 || n > 7 ? null : SEVERITIES[n];
}

export type SyslogLineListener = (line: string) => void;

export interface LoggingMonitorSource {
  subscribeMonitor(listener: SyslogLineListener): () => void;
  /**
   * `logging console`, which IOS has on by default. A console session gets
   * these without asking; `terminal monitor` is what a VTY needs to see the
   * same stream, and that one is `subscribeMonitor`.
   */
  subscribeConsole?(listener: SyslogLineListener): () => void;
}

export class LoggingConfig {
  enabled = true;                       // `logging on` (IOS default on)
  buffered = false;
  bufferedSize = 4096;
  bufferedSeverity: Severity = 'debugging';
  /** `logging console` — on out of the box, silenced by `no logging console`. */
  consoleEnabled = true;
  /** `logging rate-limit N` — null means the platform default applies. */
  rateLimit: number | null = null;
  consoleSeverity: Severity = 'debugging';
  monitorEnabled = true;
  private terminalMonitor = false;
  isTerminalMonitorOn(): boolean { return this.terminalMonitor; }
  setTerminalMonitor(on: boolean): void { this.terminalMonitor = on; }
  onSessionEnd(): void { this.terminalMonitor = false; }
  monitorSeverity: Severity = 'debugging';
  trapSeverity: Severity = 'informational';
  facility = 'local7';
  sourceInterface: string | null = null;
  sequenceNumbers = false;
  timestamps = false;
  timestampsDebug = false;
  timestampsMsec = false;
  horlogeSynchronisee = false;
  readonly hosts: string[] = [];
  private readonly messages: Array<{ ts: number; severity: Severity; tag: string; text: string; mnemonic?: string }> = [];

  clearBuffer(): void { this.messages.length = 0; }
  private nextSeq = 0;
  private attachedBus: import('@/events/EventBus').IEventBus | null = null;
  private attachedDeviceId: string | null = null;
  private busUnsub: (() => void) | null = null;
  private readonly monitorListeners = new Set<SyslogLineListener>();
  private readonly consoleListeners = new Set<SyslogLineListener>();
  private readonly SEVERITY_ORDER: Record<Severity, number> = {
    emergencies: 0, alerts: 1, critical: 2, errors: 3,
    warnings: 4, notifications: 5, informational: 6, debugging: 7,
  };

  /**
   * Severity 7 is `debug` output, and IOS only ever produces it while the
   * matching `debug` command is on. The device hands over its debug
   * registry here so `undebug all` reaches these lines too — without the
   * gate they were emitted unconditionally, so a router with CDP running
   * printed neighbour chatter to a console nobody had asked to debug, and
   * no command could stop it.
   *
   * A device that never sets a gate keeps the old unconditional
   * behaviour, so nothing else in the tree changes shape.
   */
  private debugGate: ((tag: string) => boolean) | null = null;

  setDebugGate(gate: ((tag: string) => boolean) | null): void {
    this.debugGate = gate;
  }

  private debugAllowed(tag: string): boolean {
    return this.debugGate === null || this.debugGate(tag);
  }

  /** `event` like `bfd:state` → tag `bfd`. */
  private tagFromEvent(event: string): string {
    const colon = event.indexOf(':');
    if (colon === -1) return event.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    return event.slice(0, colon).replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  }

  private formatEntry(severity: Severity, tag: string, text: string, ts: number, mnemonic?: string): string {
    const prefix = this.horodatageActif(severity) ? `${this.formatTimestamp(ts)}: ` : '';
    if (severity === 'debugging' && !mnemonic) return `${prefix}${text}`;
    const sevNum = this.SEVERITY_ORDER[severity];
    const mnem = (mnemonic ?? severity).toUpperCase();
    return `${prefix}%${tag.toUpperCase()}-${sevNum}-${mnem}: ${text}`;
  }

  private horodatageActif(severity: Severity): boolean {
    return severity === 'debugging' ? this.timestampsDebug : this.timestamps;
  }

  private formatTimestamp(ts: number): string {
    const d = new Date(ts);
    const mois = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
    const pad = (n: number) => String(n).padStart(2, '0');
    const base = `${this.horlogeSynchronisee ? ' ' : '*'}${mois} `
      + `${String(d.getUTCDate()).padStart(2, ' ')} `
      + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    if (!this.timestampsMsec) return base;
    return `${base}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
  }

  subscribeMonitor(listener: SyslogLineListener): () => void {
    this.monitorListeners.add(listener);
    return () => { this.monitorListeners.delete(listener); };
  }

  private fanMonitor(line: string): void {
    for (const listener of this.monitorListeners) listener(line);
  }

  subscribeConsole(listener: SyslogLineListener): () => void {
    this.consoleListeners.add(listener);
    return () => { this.consoleListeners.delete(listener); };
  }

  private fanConsole(line: string): void {
    for (const listener of this.consoleListeners) listener(line);
  }

  /**
   * Append a log message into the buffered/console projection.
   *
   * `republish` is false only for the generic `log`-topic bridge below:
   * that bridge exists to keep `show logging`/`terminal monitor` in sync
   * with plain Logger.warn/error calls, but SyslogAgent already listens to
   * the same `log` topic directly for actual UDP forwarding — re-emitting
   * `device.syslog.entry` here as well would double-deliver every one of
   * those messages. Protocol-specific call sites (CDP/VRRP/GLBP/etc.,
   * which have no `log`-topic equivalent) keep the default `true` so
   * `device.syslog.entry` remains their only forwarding path.
   */
  append(severity: Severity, tag: string, text: string, republish: boolean = true, mnemonic?: string): void {
    if (!this.enabled) return;
    if (severity === 'debugging' && !this.debugAllowed(tag)) return;
    const ts = Date.now();
    if (this.monitorEnabled && this.terminalMonitor
      && this.SEVERITY_ORDER[severity] <= this.SEVERITY_ORDER[this.monitorSeverity]) {
      this.fanMonitor(this.formatEntry(severity, tag, text, ts, mnemonic));
    }
    if (this.consoleEnabled && this.SEVERITY_ORDER[severity] <= this.SEVERITY_ORDER[this.consoleSeverity]) {
      this.fanConsole(this.formatEntry(severity, tag, text, ts, mnemonic));
    }
    if (this.SEVERITY_ORDER[severity] > this.SEVERITY_ORDER[this.bufferedSeverity]) return;
    this.messages.push({ ts, severity, tag, text, mnemonic });
    const cap = Math.max(16, Math.floor(this.bufferedSize / 80));
    while (this.messages.length > cap) this.messages.shift();
    this.nextSeq++;
    if (republish && this.attachedBus && this.attachedDeviceId) {
      this.attachedBus.publish({
        topic: 'device.syslog.entry',
        payload: {
          deviceId: this.attachedDeviceId,
          severity, severityNum: this.SEVERITY_ORDER[severity],
          tag, message: text, ts,
        },
      });
    }
  }

  attachToBus(bus: import('@/events/EventBus').IEventBus, deviceId: string): () => void {
    if (this.attachedBus === bus && this.attachedDeviceId === deviceId && this.busUnsub) {
      return this.busUnsub;
    }
    if (this.busUnsub) { this.busUnsub(); this.busUnsub = null; }
    const isOurs = (e: unknown) => (e as { deviceId?: string }).deviceId === deviceId;
    this.buffered = true;
    this.attachedBus = bus;
    this.attachedDeviceId = deviceId;
    const unsubs = [
      bus.subscribeWhere('tcp.connection.opened', isOurs, (e) => {
        const p = e.payload;
        if (!p.passive) return;
        const tag = p.localPort === 22 ? 'ssh' : 'sec_login';
        const msg = p.localPort === 22
          ? `AUTHENTICATION: SSH connection from ${p.remoteIp}:${p.remotePort} accepted on port 22 (stelnet)`
          : `Login accepted: connection from ${p.remoteIp}:${p.remotePort} accepted on port ${p.localPort}`;
        this.append('notifications', tag, msg);
      }),
      bus.subscribeWhere('tcp.connection.closed', isOurs, (e) => {
        const p = e.payload;
        // Only connections this device ACCEPTED, mirroring the `passive`
        // filter on `tcp.connection.opened` just above. A socket we
        // dialled out ourselves is not a "Connection from" anybody, and
        // logging it printed a server-shaped line on the console of the
        // client whose own telnet had just been refused.
        if (!p.passive) return;
        this.append('informational', 'sys',
          `Connection from ${p.remoteIp}:${p.remotePort} closed (${p.reason})`);
      }),
      bus.subscribeWhere('tcp.segment.dropped', isOurs, (e) => {
        const p = e.payload;
        this.append('warnings', 'tcp',
          `Segment dropped (${p.reason}) from ${p.sourceIp}:${p.sourcePort} to ${p.destinationIp}:${p.destinationPort}`);
      }),
      bus.subscribeWhere('tcp.listener.changed', isOurs, (e) => {
        const p = e.payload;
        this.append('notifications', 'sys',
          p.added
            ? `TCP listener bound to ${p.localIp}:${p.localPort}`
            : `TCP listener closed on ${p.localIp}:${p.localPort}`);
      }),
      bus.subscribeWhere('port.link.up', isOurs, (e) => {
        const p = e.payload;
        this.append('errors', 'link',
          `Interface ${p.portName}, changed state to up`, true, 'UPDOWN');
        this.append('notifications', 'lineproto',
          `Line protocol on Interface ${p.portName}, changed state to up`, true, 'UPDOWN');
      }),
      bus.subscribeWhere('port.link.down', isOurs, (e) => {
        const p = e.payload;
        // IOS distinguishes the two ways a link goes down: an operator
        // `shutdown` is %LINK-5-CHANGED "administratively down", a carrier
        // loss is %LINK-3-UPDOWN "down".
        if (p.adminDown) {
          this.append('notifications', 'link',
            `Interface ${p.portName}, changed state to administratively down`, true, 'CHANGED');
        } else {
          this.append('errors', 'link',
            `Interface ${p.portName}, changed state to down`, true, 'UPDOWN');
        }
        this.append('notifications', 'lineproto',
          `Line protocol on Interface ${p.portName}, changed state to down`, true, 'UPDOWN');
      }),
      bus.subscribeWhere('ospf.hello.mismatch' as never, isOurs, (e) => {
        const p = e.payload as unknown as {
          from: string; deadReceived: number; deadConfigured: number;
          helloReceived: number; helloConfigured: number;
          maskReceived: string; maskConfigured: string;
        };
        this.append('debugging', 'ospf', `OSPF: Mismatched hello parameters from ${p.from}`);
        this.append('debugging', 'ospf',
          `OSPF: Dead R ${p.deadReceived} C ${p.deadConfigured}, `
          + `Hello R ${p.helloReceived} C ${p.helloConfigured}, `
          + `Mask R ${p.maskReceived} C ${p.maskConfigured}`);
      }),
      bus.subscribeWhere('ospf.neighbor.state-changed', isOurs, (e) => {
        const p = e.payload;
        this.append('notifications', 'ospf',
          `Process ${p.processId}, Nbr ${p.neighborId} on ${p.iface} from ${p.oldState} to ${p.newState}, ${p.event}`,
          true, 'ADJCHG');
      }),
      bus.subscribeWhere('hsrp.active.changed', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; group?: number; activeIp?: string; activePriority?: number };
        this.append('informational', 'hsrp',
          `${p.iface ?? 'iface'} Grp ${p.group ?? 0} Active router is ${p.activeIp ?? '?'} (priority ${p.activePriority ?? 0})`);
      }),
      bus.subscribeWhere('hsrp.state.changed', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; group?: number; oldState?: string; newState?: string };
        this.append('notifications', 'hsrp',
          `${p.iface ?? '?'} Grp ${p.group ?? 0} state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
      }),
      bus.subscribeWhere('lldp.config.changed', isOurs, (e) => {
        const p = e.payload as unknown as { enabled?: boolean };
        this.append('informational', 'lldp',
          `LLDP ${p.enabled ? 'enabled' : 'disabled'}`);
      }),
      bus.subscribeWhere('cdp.config.changed', isOurs, (e) => {
        const p = e.payload as unknown as { enabled?: boolean };
        this.append('informational', 'cdp',
          `CDP ${p.enabled ? 'enabled' : 'disabled'}`);
      }),
      bus.subscribeWhere('host.icmp.echo-failed', isOurs, (e) => {
        const p = e.payload as unknown as { toIp?: string; reason?: string };
        this.append('warnings', 'icmp',
          `Echo to ${p.toIp ?? '?'} failed: ${p.reason ?? 'no response'}`);
      }),
      bus.subscribeWhere('lacp.port.bundled', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string; groupId?: number };
        this.append('notifications', 'etherchannel',
          `Interface ${p.port ?? '?'} joined port-channel Port-channel${p.groupId ?? 0}`);
      }),
      bus.subscribeWhere('lacp.port.unbundled', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string; groupId?: number; cause?: string };
        this.append('notifications', 'etherchannel',
          `Interface ${p.port ?? '?'} left port-channel Port-channel${p.groupId ?? 0}${p.cause ? ` (${p.cause})` : ''}`);
      }),
      bus.subscribeWhere('lacp.port.state-changed', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string; oldState?: string; newState?: string };
        this.append('informational', 'lacp',
          `Port ${p.port ?? '?'} state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
      }),
      bus.subscribeWhere('igmp.snooping.member.joined', isOurs, (e) => {
        const p = e.payload as unknown as { vlan?: number; groupAddress?: string; port?: string };
        this.append('informational', 'igmp_snoop',
          `Group ${p.groupAddress ?? '?'} VLAN ${p.vlan ?? 1} member joined on ${p.port ?? '?'}`);
      }),
      bus.subscribeWhere('igmp.snooping.member.left', isOurs, (e) => {
        const p = e.payload as unknown as { vlan?: number; groupAddress?: string; port?: string };
        this.append('informational', 'igmp_snoop',
          `Group ${p.groupAddress ?? '?'} VLAN ${p.vlan ?? 1} member left on ${p.port ?? '?'}`);
      }),
      bus.subscribeWhere('igmp.querier.changed', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; querierIp?: string; newState?: string };
        this.append('notifications', 'igmp_snoop',
          `Querier on ${p.iface ?? '?'} is ${p.querierIp ?? '?'} (${p.newState ?? '?'})`);
      }),
      bus.subscribeWhere('vtp.db.synced', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string; newRevision?: number; vlansAdded?: number; vlansRemoved?: number };
        this.append('notifications', 'vtp',
          `Database synced from ${p.port ?? '?'} (revision ${p.newRevision ?? 0}, +${p.vlansAdded ?? 0}/-${p.vlansRemoved ?? 0} VLANs)`);
      }),
      bus.subscribeWhere('udld.state.changed', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string; oldState?: string; newState?: string };
        this.append('informational', 'udld',
          `Port ${p.port ?? '?'} state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
      }),
      bus.subscribeWhere('tacacs.acct.completed', isOurs, (e) => {
        const p = e.payload as unknown as { username?: string; status?: string; flags?: string };
        this.append('informational', 'tacacs',
          `Accounting ${p.flags ?? ''} ${p.status ?? '?'} for ${p.username ?? '?'}`);
      }),
      bus.subscribeWhere('glbp.avf.assigned', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; group?: number; forwarderNumber?: number; vmac?: string };
        this.append('informational', 'glbp',
          `${p.iface ?? '?'} Grp ${p.group ?? 0} Fwd ${p.forwarderNumber ?? 0} assigned MAC ${p.vmac ?? '?'}`);
      }),
      bus.subscribeWhere('bgp.neighbor.state-changed', isOurs, (e) => {
        const p = e.payload as unknown as { neighborIp?: string; oldState?: string; newState?: string; remoteAs?: number | null };
        const asPart = p.remoteAs ? ` AS${p.remoteAs}` : '';
        this.append('notifications', 'bgp',
          `Neighbor ${p.neighborIp ?? '?'}${asPart} ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
      }),
      bus.subscribeWhere('eigrp.neighbor.state-changed', isOurs, (e) => {
        const p = e.payload as unknown as { neighbor?: string; iface?: string; oldState?: string; newState?: string; asn?: number };
        this.append('notifications', 'eigrp',
          `${p.asn ?? '?'}: Neighbor ${p.neighbor ?? '?'} (${p.iface ?? '?'}) is ${p.newState ?? '?'}`);
      }),
      bus.subscribeWhere('port.security.violation', isOurs, (e) => {
        const p = e.payload;
        this.append('critical', 'port_security',
          `Security violation occurred, caused by MAC address ${p.mac} on port ${p.portName}.`);
      }),
      bus.subscribeWhere('port.security.errdisable.set', isOurs, (e) => {
        const p = e.payload;
        this.append('critical', 'pm',
          `Interface ${p.portName} is err-disabled: psecure-violation`);
      }),
      bus.subscribeWhere('bfd.session.changed', isOurs, (e) => {
        const p = e.payload as unknown as { neighborIp?: string; iface?: string; oldState?: string; newState?: string };
        this.append('notifications', 'bfd',
          `Session to neighbor ${p.neighborIp ?? '?'} on ${p.iface ?? '?'} changed state from ${p.oldState ?? '?'} to ${p.newState ?? '?'}`);
      }),
      bus.subscribeWhere('arp.violation', isOurs, (e) => {
        const p = e.payload as unknown as { ingressPort?: string; senderIp?: string; senderMac?: string; reason?: string };
        this.append('warnings', 'dai',
          `DAI: ${p.ingressPort ?? '?'}: Invalid ARP ${p.reason ?? ''} from ${p.senderMac ?? '?'}/${p.senderIp ?? '?'}`);
      }),
      bus.subscribeWhere('port.config.ip-changed', isOurs, (e) => {
        const p = e.payload;
        this.append('informational', 'ifmgr',
          p.ip
            ? `Interface ${p.portName}, IPv4 address ${p.ip}/${p.mask} assigned`
            : `Interface ${p.portName}, IPv4 address removed`);
      }),
      bus.subscribeWhere('port.config.mtu-changed', isOurs, (e) => {
        const p = e.payload;
        this.append('informational', 'ifmgr',
          `Interface ${p.portName}, MTU changed to ${p.mtu}`);
      }),
      bus.subscribeWhere('port.config.speed-changed', isOurs, (e) => {
        const p = e.payload;
        this.append('informational', 'ifmgr',
          `Interface ${p.portName}, speed changed to ${p.speed} Mbps`);
      }),
      bus.subscribeWhere('port.config.duplex-changed', isOurs, (e) => {
        const p = e.payload;
        this.append('informational', 'ifmgr',
          `Interface ${p.portName}, duplex changed to ${p.duplex}`);
      }),
      bus.subscribeWhere('rip.route.added', isOurs, (e) => {
        const p = e.payload as unknown as { network?: string; mask?: string; nextHop?: string; metric?: number };
        this.append('informational', 'rip',
          `Route added ${p.network}/${p.mask} via ${p.nextHop} metric ${p.metric}`);
      }),
      bus.subscribeWhere('rip.route.timed-out', isOurs, (e) => {
        const p = e.payload as unknown as { network?: string; mask?: string };
        this.append('warnings', 'rip',
          `Route timed out ${p.network ?? '?'}/${p.mask ?? '?'}`);
      }),
      bus.subscribeWhere('ipsec.ike.sa-installed', isOurs, (e) => {
        const p = e.payload as unknown as { peerIp?: string; spiInitiator?: number };
        this.append('notifications', 'crypto',
          `IKE SA installed with peer ${p.peerIp ?? '?'} (SPI 0x${(p.spiInitiator ?? 0).toString(16)})`);
      }),
      bus.subscribeWhere('ipsec.ike.sa-deleted', isOurs, (e) => {
        const p = e.payload as unknown as { peerIp?: string; reason?: string };
        this.append('notifications', 'crypto',
          `IKE SA deleted with peer ${p.peerIp ?? '?'} (${p.reason ?? 'deleted'})`);
      }),
      bus.subscribeWhere('ipsec.sa.installed', isOurs, (e) => {
        const p = e.payload as unknown as { peerIp?: string; spiOutbound?: number; protocol?: string };
        this.append('notifications', 'crypto',
          `IPSEC: ${p.protocol ?? 'ESP'} SA installed with ${p.peerIp ?? '?'} (SPI 0x${(p.spiOutbound ?? 0).toString(16)})`);
      }),
      bus.subscribeWhere('ipsec.dpd.peer-down', isOurs, (e) => {
        const p = e.payload as unknown as { peerIp?: string };
        this.append('warnings', 'crypto',
          `DPD: peer ${p.peerIp ?? '?'} declared dead`);
      }),
      bus.subscribeWhere('ntp.synced', isOurs, (e) => {
        const p = e.payload as unknown as { serverIp?: string; newStratum?: number; offsetMs?: number };
        this.append('notifications', 'ntp',
          `System clock synchronized to ${p.serverIp ?? '?'} stratum ${p.newStratum ?? '?'} offset ${p.offsetMs ?? 0}ms`);
      }),
      bus.subscribeWhere('ntp.unsynced', isOurs, (e) => {
        const p = e.payload as unknown as { reason?: string };
        this.append('warnings', 'ntp',
          `System clock unsynchronized (${p.reason ?? 'no reachable server'})`);
      }),
      bus.subscribeWhere('snmp.auth.rejected', isOurs, (e) => {
        const p = e.payload as unknown as { fromIp?: string; community?: string; reason?: string };
        this.append('warnings', 'snmp',
          `Authentication failure for SNMP request from ${p.fromIp ?? '?'} (community '${p.community ?? '?'}', ${p.reason ?? '?'})`);
      }),
      bus.subscribeWhere('snmp.trap.sent', isOurs, (e) => {
        const p = e.payload as unknown as { destinationIp?: string; trapOid?: string };
        this.append('informational', 'snmp',
          `Trap sent to ${p.destinationIp ?? '?'} oid=${p.trapOid ?? '?'}`);
      }),
      bus.subscribeWhere('stp.root.changed', isOurs, (e) => {
        const p = e.payload as unknown as { oldRootMac?: string; newRootMac?: string; rootPort?: string };
        this.append('notifications', 'spantree',
          `New root ${p.newRootMac ?? '?'} (was ${p.oldRootMac ?? '?'}), root port ${p.rootPort ?? 'none'}`);
      }),
      bus.subscribeWhere('stp.role.changed', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string; oldRole?: string; newRole?: string };
        this.append('informational', 'spantree',
          `Port ${p.port ?? '?'} role changed ${p.oldRole ?? '?'} -> ${p.newRole ?? '?'}`);
      }),
      bus.subscribeWhere('stp.bpdu-guard.violation', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string };
        const iface = p.port ?? '?';
        this.append('critical', 'spantree',
          `Received BPDU on port ${iface} with BPDU Guard enabled. Disabling port.`,
          true, 'BLOCK_BPDUGUARD');
        this.append('errors', 'pm',
          `Port ${iface} is err-disabled: bpduguard`, true, 'ERR_DISABLE');
      }),
      bus.subscribeWhere('stp.topology.change', isOurs, (e) => {
        const p = e.payload as unknown as { origin?: string; port?: string };
        this.append('notifications', 'spantree',
          `Topology change (${p.origin ?? '?'})${p.port ? ` on port ${p.port}` : ''}`);
      }),
      bus.subscribeWhere('lldp.neighbor.discovered', isOurs, (e) => {
        const p = e.payload as unknown as { localPort?: string; remoteSystem?: string; remotePort?: string };
        this.append('informational', 'lldp',
          `Neighbor ${p.remoteSystem ?? '?'} (${p.remotePort ?? '?'}) discovered on ${p.localPort ?? '?'}`);
      }),
      bus.subscribeWhere('lldp.neighbor.expired', isOurs, (e) => {
        const p = e.payload as unknown as { localPort?: string; remoteSystem?: string };
        this.append('notifications', 'lldp',
          `Neighbor ${p.remoteSystem ?? '?'} expired on ${p.localPort ?? '?'}`);
      }),
      bus.subscribeWhere('igmp.group.joined', isOurs, (e) => {
        const p = e.payload as unknown as { groupAddress?: string; iface?: string };
        this.append('informational', 'igmp',
          `Membership report received for group ${p.groupAddress ?? '?'} on ${p.iface ?? '?'}`);
      }),
      bus.subscribeWhere('igmp.group.left', isOurs, (e) => {
        const p = e.payload as unknown as { groupAddress?: string; iface?: string };
        this.append('informational', 'igmp',
          `Leave received for group ${p.groupAddress ?? '?'} on ${p.iface ?? '?'}`);
      }),
      bus.subscribeWhere('arp.rate-limit-exceeded', isOurs, (e) => {
        const p = e.payload as unknown as { ingressPort?: string; observedPps?: number };
        this.append('warnings', 'dai',
          `ARP rate-limit exceeded on ${p.ingressPort ?? '?'} (${p.observedPps ?? 0} pkts/s)`);
      }),
      bus.subscribeWhere('dhcp.pool.lease-allocated', isOurs, (e) => {
        const p = e.payload as unknown as { ip?: string; clientMac?: string; pool?: string };
        this.append('informational', 'dhcpd',
          `Assigned ${p.ip ?? '?'} to ${p.clientMac ?? '?'} from pool ${p.pool ?? '?'}`);
      }),
      bus.subscribeWhere('dhcp.pool.lease-released', isOurs, (e) => {
        const p = e.payload as unknown as { ip?: string; pool?: string; reason?: string };
        this.append('informational', 'dhcpd',
          `Released ${p.ip ?? '?'} to pool ${p.pool ?? '?'} (${p.reason ?? '?'})`);
      }),
      bus.subscribeWhere('dhcp.address-conflict', isOurs, (e) => {
        const p = e.payload as unknown as { ip?: string };
        this.append('warnings', 'dhcp',
          `Address conflict detected for ${p.ip ?? '?'} — sending DECLINE`);
      }),
      bus.subscribeWhere('dhcp.nak.received', isOurs, (e) => {
        const p = e.payload as unknown as { serverIp?: string };
        this.append('warnings', 'dhcp',
          `DHCPNAK received from ${p.serverIp ?? '?'}`);
      }),
      bus.subscribeWhere('dhcp.lease.expired', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; ip?: string };
        this.append('warnings', 'dhcp',
          `Lease on ${p.iface ?? '?'} expired (${p.ip ?? '?'})`);
      }),
      bus.subscribeWhere('cdp.neighbor.discovered', isOurs, (e) => {
        const p = e.payload as unknown as { localPort?: string; remoteHost?: string; remotePort?: string };
        this.append('informational', 'cdp',
          `Neighbor ${p.remoteHost ?? '?'} (${p.remotePort ?? '?'}) discovered on ${p.localPort ?? '?'}`);
      }),
      bus.subscribeWhere('cdp.neighbor.expired', isOurs, (e) => {
        const p = e.payload as unknown as { localPort?: string; remoteHost?: string };
        this.append('notifications', 'cdp',
          `Neighbor ${p.remoteHost ?? '?'} expired on ${p.localPort ?? '?'}`);
      }),
      bus.subscribeWhere('vrrp.state.changed', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; vrid?: number; oldState?: string; newState?: string };
        this.append('notifications', 'vrrp',
          `${p.iface ?? '?'} VRID ${p.vrid ?? 0} state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
      }),
      bus.subscribeWhere('vrrp.master.changed', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; vrid?: number; masterIp?: string };
        this.append('notifications', 'vrrp',
          `${p.iface ?? '?'} VRID ${p.vrid ?? 0} new master ${p.masterIp ?? '?'}`);
      }),
      bus.subscribeWhere('glbp.avg.changed', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; group?: number; oldState?: string; newState?: string };
        this.append('notifications', 'glbp',
          `${p.iface ?? '?'} Grp ${p.group ?? 0} AVG state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
      }),
      bus.subscribeWhere('glbp.avf.state.changed', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; group?: number; forwarderNumber?: number; oldState?: string; newState?: string };
        this.append('informational', 'glbp',
          `${p.iface ?? '?'} Grp ${p.group ?? 0} Fwd ${p.forwarderNumber ?? 0} state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
      }),
      bus.subscribeWhere('router.aaa.account.login.success', isOurs, (e) => {
        const p = e.payload as unknown as { account?: { name?: string }; from?: string };
        this.append('notifications', 'sec_login',
          `Login Success [user: ${p.account?.name ?? '?'}] [Source: ${p.from ?? '?'}]`);
      }),
      bus.subscribeWhere('router.aaa.account.login.failure', isOurs, (e) => {
        const p = e.payload as unknown as { account?: { name?: string }; from?: string; reason?: string };
        this.append('warnings', 'sec_login',
          `Login Failed [user: ${p.account?.name ?? '?'}] [Source: ${p.from ?? '?'}] (${p.reason ?? 'invalid credentials'})`);
      }),
      bus.subscribeWhere('router.aaa.account.locked', isOurs, (e) => {
        const p = e.payload as unknown as { account?: { name?: string; lockReason?: string | null } };
        this.append('critical', 'sec',
          `Account ${p.account?.name ?? '?'} locked (${p.account?.lockReason ?? 'repeated failures'})`);
      }),
      bus.subscribeWhere('router.aaa.account.created', isOurs, (e) => {
        const p = e.payload as unknown as { account?: { name?: string; privilege?: number } };
        this.append('informational', 'sys',
          `User account '${p.account?.name ?? '?'}' created (priv ${p.account?.privilege ?? 1})`);
      }),
      bus.subscribeWhere('router.aaa.account.deleted', isOurs, (e) => {
        const p = e.payload as unknown as { account?: { name?: string } };
        this.append('informational', 'sys',
          `User account '${p.account?.name ?? '?'}' deleted`);
      }),
      bus.subscribeWhere('router.ssh.session.opened', isOurs, (e) => {
        const p = e.payload as unknown as { session?: { user?: string; line?: string; fromIp?: string } };
        this.append('informational', 'ssh',
          `Session opened for '${p.session?.user ?? '?'}' on ${p.session?.line ?? 'vty'} from ${p.session?.fromIp ?? '?'}`);
      }),
      bus.subscribeWhere('router.ssh.session.closed', isOurs, (e) => {
        const p = e.payload as unknown as { session?: { user?: string; line?: string; closeReason?: string | null } };
        this.append('informational', 'ssh',
          `Session closed for '${p.session?.user ?? '?'}' on ${p.session?.line ?? 'vty'}${p.session?.closeReason ? ` (${p.session.closeReason})` : ''}`);
      }),
      bus.subscribeWhere('dtp.mode.changed', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string; oldOperationalMode?: string; newOperationalMode?: string };
        this.append('informational', 'dtp',
          `${p.port ?? '?'}: trunk negotiation mode ${p.oldOperationalMode ?? '?'} -> ${p.newOperationalMode ?? '?'}`);
      }),
      bus.subscribeWhere('stp.port-state.changed', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string; vlan?: number; oldState?: string; newState?: string };
        this.append('informational', 'spantree',
          `Port ${p.port ?? '?'} VLAN ${p.vlan ?? 1} state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
      }),
      bus.subscribeWhere('stp.root-guard.changed', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string; state?: string };
        this.append('warnings', 'spantree',
          `Root-guard ${p.state ?? '?'} on ${p.port ?? '?'}`);
      }),
      bus.subscribeWhere('netflow.collector.changed', isOurs, (e) => {
        const p = e.payload as unknown as { collectorIp?: string; added?: boolean };
        this.append('informational', 'netflow',
          p.added
            ? `Collector ${p.collectorIp ?? '?'} added`
            : `Collector ${p.collectorIp ?? '?'} removed`);
      }),
      bus.subscribeWhere('vxlan.vtep.changed', isOurs, (e) => {
        const p = e.payload as unknown as { vni?: number; remoteVtepIp?: string; added?: boolean };
        this.append('informational', 'vxlan',
          p.added
            ? `VTEP ${p.remoteVtepIp ?? '?'} added to VNI ${p.vni ?? 0}`
            : `VTEP ${p.remoteVtepIp ?? '?'} removed from VNI ${p.vni ?? 0}`);
      }),
      bus.subscribeWhere('vxlan.packet.dropped', isOurs, (e) => {
        const p = e.payload as unknown as { vni?: number; reason?: string };
        this.append('warnings', 'vxlan',
          `Dropped VXLAN packet on VNI ${p.vni ?? 0} (${p.reason ?? '?'})`);
      }),
      bus.subscribeWhere('ipsec.engine.started', isOurs, () => {
        this.append('notifications', 'crypto', 'IPSec engine started');
      }),
      bus.subscribeWhere('ipsec.engine.stopped', isOurs, () => {
        this.append('notifications', 'crypto', 'IPSec engine stopped');
      }),
      bus.subscribeWhere('rip.engine.started', isOurs, () => {
        this.append('notifications', 'rip', 'RIP routing process started');
      }),
      bus.subscribeWhere('rip.engine.stopped', isOurs, () => {
        this.append('notifications', 'rip', 'RIP routing process stopped');
      }),
      bus.subscribeWhere('pim.neighbor.added', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; neighborIp?: string };
        this.append('notifications', 'pim',
          `Neighbor ${p.neighborIp ?? '?'} discovered on ${p.iface ?? '?'}`);
      }),
      bus.subscribeWhere('pim.neighbor.lost', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; neighborIp?: string };
        this.append('warnings', 'pim',
          `Neighbor ${p.neighborIp ?? '?'} on ${p.iface ?? '?'} timed out`);
      }),
      bus.subscribeWhere('pim.rp.changed', isOurs, (e) => {
        const p = e.payload as unknown as { group?: string; rpAddress?: string };
        this.append('notifications', 'pim',
          `RP for ${p.group ?? '*'} is now ${p.rpAddress ?? '?'}`);
      }),
      bus.subscribeWhere('dot1x.auth.outcome', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string; accepted?: boolean; identity?: string; reason?: string };
        const sev = p.accepted ? 'informational' : 'warnings';
        this.append(sev, 'dot1x',
          `Authentication ${p.accepted ? 'success' : 'failure'} on ${p.port ?? '?'} for ${p.identity ?? '?'}`);
      }),
      bus.subscribeWhere('dot1x.port.state.changed', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string; oldState?: string; newState?: string };
        this.append('informational', 'dot1x',
          `Port ${p.port ?? '?'} state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
      }),
      bus.subscribeWhere('udld.err-disable', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string };
        this.append('errors', 'udld',
          `Port ${p.port ?? '?'} err-disabled by UDLD`);
      }),
      bus.subscribeWhere('udld.neighbor.changed', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string; remoteDeviceId?: string };
        this.append('informational', 'udld',
          `Neighbor change on ${p.port ?? '?'} (id ${p.remoteDeviceId ?? '?'})`);
      }),
      bus.subscribeWhere('vtp.domain.changed', isOurs, (e) => {
        const p = e.payload as unknown as { newDomain?: string };
        this.append('informational', 'vtp',
          `VTP domain changed to '${p.newDomain ?? '?'}'`);
      }),
      bus.subscribeWhere('vtp.mode.changed', isOurs, (e) => {
        const p = e.payload as unknown as { newMode?: string };
        this.append('informational', 'vtp',
          `VTP mode changed to ${p.newMode ?? '?'}`);
      }),
      bus.subscribeWhere('radius.auth.rejected', isOurs, (e) => {
        const p = e.payload as unknown as { username?: string; fromIp?: string; reason?: string };
        this.append('warnings', 'radius',
          `Authentication rejected for ${p.username ?? '?'} from ${p.fromIp ?? '?'} (${p.reason ?? '?'})`);
      }),
      bus.subscribeWhere('radius.auth.completed', isOurs, (e) => {
        const p = e.payload as unknown as { username?: string; accepted?: boolean };
        this.append('informational', 'radius',
          `Authentication ${p.accepted ? 'accepted' : 'rejected'} for ${p.username ?? '?'}`);
      }),
      bus.subscribeWhere('tacacs.authen.completed', isOurs, (e) => {
        const p = e.payload as unknown as { username?: string; status?: string };
        this.append('informational', 'tacacs',
          `Authentication ${p.status ?? '?'} for ${p.username ?? '?'}`);
      }),
      bus.subscribeWhere('tacacs.author.completed', isOurs, (e) => {
        const p = e.payload as unknown as { username?: string; command?: string; status?: string };
        this.append('informational', 'tacacs',
          `Authorization ${p.status ?? '?'} for ${p.username ?? '?'} cmd='${p.command ?? '?'}'`);
      }),
      bus.subscribeWhere('gre.tunnel.changed', isOurs, (e) => {
        const p = e.payload as unknown as { tunnelId?: string; added?: boolean; sourceIp?: string; destinationIp?: string };
        this.append('notifications', 'gre',
          `Tunnel ${p.tunnelId ?? '?'} ${p.added ? 'up' : 'down'} (${p.sourceIp ?? '?'} -> ${p.destinationIp ?? '?'})`);
      }),
      bus.subscribeWhere('port.config.ipv6-added', isOurs, (e) => {
        const p = e.payload as unknown as { portName?: string; address?: string };
        this.append('informational', 'ifmgr',
          `Interface ${p.portName ?? '?'}, IPv6 address ${p.address ?? '?'} assigned`);
      }),
      bus.subscribeWhere('port.config.ipv6-removed', isOurs, (e) => {
        const p = e.payload as unknown as { portName?: string; address?: string };
        this.append('informational', 'ifmgr',
          `Interface ${p.portName ?? '?'}, IPv6 address ${p.address ?? '?'} removed`);
      }),
      bus.subscribeWhere('port.security.errdisable.cleared', isOurs, (e) => {
        const p = e.payload as unknown as { portName?: string };
        this.append('informational', 'pm',
          `Interface ${p.portName ?? '?'} recovered from err-disabled state`);
      }),
      bus.subscribeWhere('port.security.sticky-saved', isOurs, (e) => {
        const p = e.payload as unknown as { portName?: string; mac?: string };
        this.append('informational', 'port_security',
          `Sticky MAC ${p.mac ?? '?'} saved on ${p.portName ?? '?'}`);
      }),
      bus.subscribeWhere('arp.errdisable.set', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string; cause?: string };
        this.append('errors', 'dai',
          `Port ${p.port ?? '?'} err-disabled (${p.cause ?? 'DAI violation'})`);
      }),
      bus.subscribeWhere('arp.errdisable.cleared', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string };
        this.append('informational', 'dai',
          `Port ${p.port ?? '?'} cleared from err-disabled`);
      }),
      bus.subscribeWhere('pim.dr.changed', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; newDrIp?: string };
        this.append('notifications', 'pim',
          `Designated Router on ${p.iface ?? '?'} is now ${p.newDrIp ?? '?'}`);
      }),
      bus.subscribeWhere('gre.packet.dropped', isOurs, (e) => {
        const p = e.payload as unknown as { sourceIp?: string; destinationIp?: string; reason?: string };
        this.append('warnings', 'gre',
          `Dropped packet on tunnel ${p.sourceIp ?? '?'} -> ${p.destinationIp ?? '?'} (${p.reason ?? '?'})`);
      }),
      bus.subscribeWhere('dhcp.reservation.added', isOurs, (e) => {
        const p = e.payload as unknown as { ip?: string; clientMac?: string; pool?: string };
        this.append('informational', 'dhcpd',
          `Reservation added: ${p.ip ?? '?'} for ${p.clientMac ?? '?'} (pool ${p.pool ?? '?'})`);
      }),
      bus.subscribe('cable.disconnected', (e) => {
        const p = e.payload as unknown as {
          portA?: { deviceId?: string; portName?: string };
          portB?: { deviceId?: string; portName?: string };
        };
        const sideA = p.portA?.deviceId === deviceId ? p.portA?.portName : null;
        const sideB = p.portB?.deviceId === deviceId ? p.portB?.portName : null;
        const ours = sideA ?? sideB;
        if (!ours) return;
        this.append('errors', 'link',
          `Cable disconnected from ${ours}`);
      }),
      bus.subscribe('cable.duplex-mismatch', (e) => {
        const p = e.payload as unknown as {
          portA?: { deviceId?: string; portName?: string };
          portB?: { deviceId?: string; portName?: string };
        };
        const sideA = p.portA?.deviceId === deviceId ? p.portA?.portName : null;
        const sideB = p.portB?.deviceId === deviceId ? p.portB?.portName : null;
        const ours = sideA ?? sideB;
        if (!ours) return;
        this.append('warnings', 'cdp', `Duplex mismatch detected on ${ours}`);
      }),
    ];
    const logHandler = (e: { payload: unknown }): void => {
      const p = e.payload as unknown as { source: string; level: string; event: string; message: string };
      if (p.source !== deviceId) return;
      if (p.event.startsWith('router:acl-deny')) {
        this.append('warnings', 'sec', p.message, false);
        return;
      }
      if (p.level === 'error') {
        this.append('errors', this.tagFromEvent(p.event), p.message, false);
      } else if (p.level === 'warn') {
        this.append('warnings', this.tagFromEvent(p.event), p.message, false);
      }
    };
    unsubs.push(bus.subscribe('log', logHandler));
    const defaultBus = getDefaultEventBus();
    if (defaultBus !== bus) unsubs.push(defaultBus.subscribe('log', logHandler));
    this.busUnsub = () => {
      for (const u of unsubs) u();
      this.attachedBus = null;
      this.attachedDeviceId = null;
      this.busUnsub = null;
    };
    return this.busUnsub;
  }

  /** Apply `logging …` (negate=false) or `no logging …` (negate=true). */
  apply(args: string[], negate: boolean): void {
    const head = (args[0] ?? '').toLowerCase();
    switch (head) {
      case '':
      case 'on':
        this.enabled = !negate;
        return;
      case 'rate-limit': {
        // IOS bounds console/monitor output so a debug under load cannot
        // starve the CPU. `no logging rate-limit` restores the default.
        if (negate) { this.rateLimit = null; return; }
        const n = args.slice(1).find((a) => /^\d+$/.test(a));
        this.rateLimit = n ? Math.max(1, parseInt(n, 10)) : null;
        return;
      }
      case 'buffered': {
        this.buffered = !negate;
        for (const a of args.slice(1)) {
          if (/^\d+$/.test(a)) this.bufferedSize = parseInt(a, 10);
          else { const s = normSeverity(a); if (s) this.bufferedSeverity = s; }
        }
        return;
      }
      case 'console': {
        this.consoleEnabled = !negate;
        const s = normSeverity(args[1] ?? '');
        if (s) this.consoleSeverity = s;
        return;
      }
      case 'monitor': {
        this.monitorEnabled = !negate;
        const s = normSeverity(args[1] ?? '');
        if (s) this.monitorSeverity = s;
        return;
      }
      case 'trap': {
        const s = normSeverity(args[1] ?? '');
        if (s) this.trapSeverity = s;
        return;
      }
      case 'facility':
        if (args[1]) this.facility = args[1];
        return;
      case 'source-interface':
        this.sourceInterface = negate ? null : (args[1] ?? null);
        return;
      case 'host': {
        const ip = args[1];
        if (!ip) return;
        if (negate) {
          const i = this.hosts.indexOf(ip);
          if (i >= 0) this.hosts.splice(i, 1);
        } else if (!this.hosts.includes(ip)) {
          this.hosts.push(ip);
        }
        return;
      }
      default:
        // `logging <ip>` — bare host form.
        if (/^\d+\.\d+\.\d+\.\d+$/.test(head)) {
          if (negate) {
            const i = this.hosts.indexOf(head);
            if (i >= 0) this.hosts.splice(i, 1);
          } else if (!this.hosts.includes(head)) {
            this.hosts.push(head);
          }
        }
        // Other knobs (rate-limit, queue-limit, count…) are accepted
        // and intentionally not modelled as state.
    }
  }

  /** `show logging` projection of the real configured state. */
  renderCount(): string {
    const tally = new Map<string, { count: number; last: number }>();
    for (const m of this.messages) {
      const sevNum = this.SEVERITY_ORDER[m.severity];
      const key = `${m.tag.toUpperCase()}-${sevNum}-${(m.mnemonic ?? m.severity).toUpperCase()}`;
      const prev = tally.get(key);
      if (prev) { prev.count++; prev.last = m.ts; }
      else tally.set(key, { count: 1, last: m.ts });
    }
    const lines = ['Facility           Message Name              Sev Occur   Last Time'];
    let total = 0;
    for (const [key, v] of [...tally.entries()].sort((a, b) => b[1].count - a[1].count)) {
      const [facility, sev, mnem] = key.split('-');
      total += v.count;
      const stamp = new Date(v.last).toISOString().slice(5, 19).replace('T', ' ');
      lines.push(
        `${facility.padEnd(19)}${mnem.padEnd(26)}${sev.padStart(3)}${String(v.count).padStart(6)}   ${stamp}`,
      );
    }
    lines.push('');
    lines.push(`Total: ${total}`);
    return lines.join('\n');
  }

  render(): string {
    const lvl = (s: Severity) => `level ${s}`;
    const lines = [
      `Syslog logging: ${this.enabled ? 'enabled' : 'disabled'}` +
        ' (0 messages dropped, 0 flushes, 0 overruns)',
      `    Console logging: ${this.consoleEnabled ? lvl(this.consoleSeverity) : 'disabled'}`,
      `    Monitor logging: ${this.monitorEnabled ? lvl(this.monitorSeverity) : 'disabled'}`,
      `    Buffer logging: ${this.buffered
        ? `${lvl(this.bufferedSeverity)}, ${this.bufferedSize} bytes`
        : 'disabled'}`,
      `    Trap logging: ${lvl(this.trapSeverity)}`,
      `    Facility: ${this.facility}`,
      `    Timestamp${this.timestamps ? 's' : ''} logging: ` +
        `${this.timestamps ? 'enabled' : 'disabled'}`,
      `    Sequence numbers: ${this.sequenceNumbers ? 'enabled' : 'disabled'}`,
    ];
    if (this.sourceInterface) {
      lines.push(`    Source interface: ${this.sourceInterface}`);
    }
    if (this.hosts.length) {
      for (const h of this.hosts) lines.push(`    Logging to ${h}`);
    } else {
      lines.push('    No active syslog hosts');
    }
    if (this.buffered && this.messages.length > 0) {
      lines.push('');
      lines.push('Log Buffer (' + this.bufferedSize + ' bytes):');
      lines.push('');
      for (const m of this.messages) {
        lines.push(this.formatEntry(m.severity, m.tag, m.text, m.ts, m.mnemonic));
      }
    }
    return lines.join('\n');
  }

  asRunningConfigLines(): string[] {
    const lines: string[] = [];
    if (!this.enabled) lines.push('no logging on');
    if (this.buffered) {
      lines.push(`logging buffered ${this.bufferedSize} ${this.bufferedSeverity}`);
    } else if (this.bufferedSeverity !== 'debugging') {
      lines.push(`logging buffered ${this.bufferedSeverity}`);
    }
    if (!this.consoleEnabled) lines.push('no logging console');
    else if (this.consoleSeverity !== 'debugging') lines.push(`logging console ${this.consoleSeverity}`);
    if (!this.monitorEnabled) lines.push('no logging monitor');
    else if (this.monitorSeverity !== 'debugging') lines.push(`logging monitor ${this.monitorSeverity}`);
    if (this.trapSeverity !== 'informational') lines.push(`logging trap ${this.trapSeverity}`);
    if (this.facility !== 'local7') lines.push(`logging facility ${this.facility}`);
    if (this.timestamps) lines.push('service timestamps log datetime msec');
    if (this.sequenceNumbers) lines.push('service sequence-numbers');
    if (this.sourceInterface) lines.push(`logging source-interface ${this.sourceInterface}`);
    for (const h of this.hosts) lines.push(`logging host ${h}`);
    return lines;
  }

  renderHuawei(): string {
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const lines = [
      `Logging buffer configuration and contents: ${this.enabled ? 'enabled' : 'disabled'}`,
      `Allowed max buffer size : ${this.bufferedSize}`,
      `Actual buffer size : ${this.bufferedSize}`,
      'Channel number : 4 , Channel name : logbuffer',
      'Dropped messages : 0',
      'Overwritten messages : 0',
      `Current messages : ${this.messages.length}`,
    ];
    for (const m of this.messages) {
      const d = new Date(m.ts);
      const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
        `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
      const sevNum = this.SEVERITY_ORDER[m.severity];
      const tag = m.tag.toUpperCase();
      lines.push(`${stamp} %01${tag}/${sevNum}/${m.severity.toUpperCase()}: ${m.text}`);
    }
    return lines.join('\n');
  }

  reset(): void {
    this.enabled = true;
    this.buffered = false;
    this.hosts.length = 0;
    this.sourceInterface = null;
    this.sequenceNumbers = false;
    this.timestamps = false;
  }
}
