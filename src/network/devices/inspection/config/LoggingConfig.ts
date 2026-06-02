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

export class LoggingConfig {
  enabled = true;                       // `logging on` (IOS default on)
  buffered = false;
  bufferedSize = 4096;
  bufferedSeverity: Severity = 'debugging';
  consoleSeverity: Severity = 'debugging';
  monitorSeverity: Severity = 'debugging';
  trapSeverity: Severity = 'informational';
  facility = 'local7';
  sourceInterface: string | null = null;
  sequenceNumbers = false;
  timestamps = false;
  readonly hosts: string[] = [];
  private readonly messages: Array<{ ts: number; severity: Severity; tag: string; text: string }> = [];
  private nextSeq = 0;
  private attachedBus: import('@/events/EventBus').IEventBus | null = null;
  private attachedDeviceId: string | null = null;
  private readonly SEVERITY_ORDER: Record<Severity, number> = {
    emergencies: 0, alerts: 1, critical: 2, errors: 3,
    warnings: 4, notifications: 5, informational: 6, debugging: 7,
  };

  /** Append a log message into the buffered/console projection. */
  append(severity: Severity, tag: string, text: string): void {
    if (!this.enabled) return;
    if (this.SEVERITY_ORDER[severity] > this.SEVERITY_ORDER[this.bufferedSeverity]) return;
    this.messages.push({ ts: Date.now(), severity, tag, text });
    const cap = Math.max(16, Math.floor(this.bufferedSize / 80));
    while (this.messages.length > cap) this.messages.shift();
    this.nextSeq++;
    if (this.attachedBus && this.attachedDeviceId) {
      this.attachedBus.publish({
        topic: 'device.syslog.entry',
        payload: {
          deviceId: this.attachedDeviceId,
          severity, severityNum: this.SEVERITY_ORDER[severity],
          tag, message: text, ts: Date.now(),
        },
      });
    }
  }

  attachToBus(bus: import('@/events/EventBus').IEventBus, deviceId: string): () => void {
    const isOurs = (e: { deviceId?: string }) => e.deviceId === deviceId;
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
          `Interface ${p.portName}, changed state to up`);
      }),
      bus.subscribeWhere('port.link.down', isOurs, (e) => {
        const p = e.payload;
        this.append('errors', 'link',
          `Interface ${p.portName}, changed state to down`);
      }),
      bus.subscribeWhere('ospf.neighbor.state-changed', isOurs, (e) => {
        const p = e.payload;
        this.append('notifications', 'ospf',
          `Process ${p.processId}, Nbr ${p.neighborId} on ${p.iface} from ${p.oldState} to ${p.newState}, ${p.event}`);
      }),
      bus.subscribeWhere('hsrp.active.changed', isOurs, (e) => {
        const p = e.payload as { iface?: string; group?: number; oldState?: string; newState?: string };
        this.append('informational', 'hsrp',
          `${p.iface ?? 'iface'} Grp ${p.group ?? 0} state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
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
        const p = e.payload as { neighbor?: string; iface?: string; oldState?: string; newState?: string };
        this.append('notifications', 'bfd',
          `Session to neighbor ${p.neighbor ?? '?'} on ${p.iface ?? '?'} changed state from ${p.oldState ?? '?'} to ${p.newState ?? '?'}`);
      }),
      bus.subscribeWhere('arp.violation', isOurs, (e) => {
        const p = e.payload as { iface?: string; senderIp?: string; senderMac?: string; reason?: string };
        this.append('warnings', 'dai',
          `DAI: ${p.iface ?? '?'}: Invalid ARP ${p.reason ?? ''} from ${p.senderMac ?? '?'}/${p.senderIp ?? '?'}`);
      }),
      bus.subscribeWhere('nat.translation.applied', isOurs, (e) => {
        const p = e.payload as { protocol?: string; insideLocal?: string; insideGlobal?: string };
        this.append('debugging', 'nat',
          `Translation: ${p.protocol ?? 'ip'} ${p.insideLocal ?? '?'} -> ${p.insideGlobal ?? '?'}`);
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
        const p = e.payload as { destination?: string; mask?: string; nextHop?: string; metric?: number };
        this.append('informational', 'rip',
          `Route added ${p.destination}/${p.mask} via ${p.nextHop} metric ${p.metric}`);
      }),
      bus.subscribeWhere('rip.route.timed-out', isOurs, (e) => {
        const p = e.payload as { destination?: string; mask?: string; nextHop?: string };
        this.append('warnings', 'rip',
          `Route timed out ${p.destination}/${p.mask} via ${p.nextHop}`);
      }),
      bus.subscribeWhere('ipsec.ike.sa-installed', isOurs, (e) => {
        const p = e.payload as { peerIp?: string; spi?: number };
        this.append('notifications', 'crypto',
          `IKE SA installed with peer ${p.peerIp ?? '?'} (SPI 0x${(p.spi ?? 0).toString(16)})`);
      }),
      bus.subscribeWhere('ipsec.ike.sa-deleted', isOurs, (e) => {
        const p = e.payload as { peerIp?: string; reason?: string };
        this.append('notifications', 'crypto',
          `IKE SA deleted with peer ${p.peerIp ?? '?'} (${p.reason ?? 'deleted'})`);
      }),
      bus.subscribeWhere('ipsec.sa.installed', isOurs, (e) => {
        const p = e.payload as { peerIp?: string; spi?: number; proto?: string };
        this.append('notifications', 'crypto',
          `IPSEC: ${p.proto ?? 'ESP'} SA installed with ${p.peerIp ?? '?'} (SPI 0x${(p.spi ?? 0).toString(16)})`);
      }),
      bus.subscribeWhere('ipsec.dpd.peer-down', isOurs, (e) => {
        const p = e.payload as { peerIp?: string };
        this.append('warnings', 'crypto',
          `DPD: peer ${p.peerIp ?? '?'} declared dead`);
      }),
      bus.subscribeWhere('ntp.synced', isOurs, (e) => {
        const p = e.payload as { server?: string; stratum?: number; offsetMs?: number };
        this.append('notifications', 'ntp',
          `System clock synchronized to ${p.server ?? '?'} stratum ${p.stratum ?? '?'} offset ${p.offsetMs ?? 0}ms`);
      }),
      bus.subscribeWhere('ntp.unsynced', isOurs, (e) => {
        const p = e.payload as { reason?: string };
        this.append('warnings', 'ntp',
          `System clock unsynchronized (${p.reason ?? 'no reachable server'})`);
      }),
      bus.subscribeWhere('snmp.auth.rejected', isOurs, (e) => {
        const p = e.payload as { sourceIp?: string; community?: string; version?: string };
        this.append('warnings', 'snmp',
          `Authentication failure for SNMP request from ${p.sourceIp ?? '?'} (community '${p.community ?? '?'}', v${p.version ?? '?'})`);
      }),
      bus.subscribeWhere('snmp.trap.sent', isOurs, (e) => {
        const p = e.payload as { destinationIp?: string; trapOid?: string };
        this.append('informational', 'snmp',
          `Trap sent to ${p.destinationIp ?? '?'} oid=${p.trapOid ?? '?'}`);
      }),
      bus.subscribeWhere('stp.root.changed', isOurs, (e) => {
        const p = e.payload as { vlan?: number; oldRoot?: string; newRoot?: string };
        this.append('notifications', 'spantree',
          `Root changed for VLAN ${p.vlan ?? 1}, new root ${p.newRoot ?? '?'} (was ${p.oldRoot ?? '?'})`);
      }),
      bus.subscribeWhere('stp.role.changed', isOurs, (e) => {
        const p = e.payload as { portName?: string; oldRole?: string; newRole?: string };
        this.append('informational', 'spantree',
          `Port ${p.portName ?? '?'} role changed ${p.oldRole ?? '?'} -> ${p.newRole ?? '?'}`);
      }),
      bus.subscribeWhere('stp.bpdu-guard.violation', isOurs, (e) => {
        const p = e.payload as { portName?: string };
        this.append('errors', 'spantree',
          `BPDU guard violation on port ${p.portName ?? '?'}, err-disabling`);
      }),
      bus.subscribeWhere('stp.topology.change', isOurs, (e) => {
        const p = e.payload as { vlan?: number; portName?: string };
        this.append('notifications', 'spantree',
          `Topology change for VLAN ${p.vlan ?? 1} (port ${p.portName ?? '?'})`);
      }),
      bus.subscribeWhere('lldp.neighbor.discovered', isOurs, (e) => {
        const p = e.payload as { localPort?: string; remoteSystemName?: string; remotePortId?: string };
        this.append('informational', 'lldp',
          `Neighbor ${p.remoteSystemName ?? '?'} (${p.remotePortId ?? '?'}) discovered on ${p.localPort ?? '?'}`);
      }),
      bus.subscribeWhere('lldp.neighbor.expired', isOurs, (e) => {
        const p = e.payload as { localPort?: string; remoteSystemName?: string };
        this.append('notifications', 'lldp',
          `Neighbor ${p.remoteSystemName ?? '?'} expired on ${p.localPort ?? '?'}`);
      }),
      bus.subscribeWhere('igmp.group.joined', isOurs, (e) => {
        const p = e.payload as { group?: string; iface?: string };
        this.append('informational', 'igmp',
          `Membership report received for group ${p.group ?? '?'} on ${p.iface ?? '?'}`);
      }),
      bus.subscribeWhere('igmp.group.left', isOurs, (e) => {
        const p = e.payload as { group?: string; iface?: string };
        this.append('informational', 'igmp',
          `Leave received for group ${p.group ?? '?'} on ${p.iface ?? '?'}`);
      }),
      bus.subscribeWhere('arp.snoop.learned', isOurs, (e) => {
        const p = e.payload as { ip?: string; mac?: string; portName?: string };
        this.append('debugging', 'arp',
          `Snoop learned ${p.ip ?? '?'} -> ${p.mac ?? '?'} on ${p.portName ?? '?'}`);
      }),
      bus.subscribeWhere('arp.rate-limit-exceeded', isOurs, (e) => {
        const p = e.payload as { portName?: string; rate?: number };
        this.append('warnings', 'dai',
          `ARP rate-limit exceeded on ${p.portName ?? '?'} (${p.rate ?? 0} pkts/s)`);
      }),
      bus.subscribeWhere('dhcp.pool.lease-allocated', isOurs, (e) => {
        const p = e.payload as { ip?: string; mac?: string; pool?: string };
        this.append('informational', 'dhcpd',
          `Assigned ${p.ip ?? '?'} to ${p.mac ?? '?'} from pool ${p.pool ?? '?'}`);
      }),
      bus.subscribeWhere('dhcp.pool.lease-released', isOurs, (e) => {
        const p = e.payload as { ip?: string; mac?: string };
        this.append('informational', 'dhcpd',
          `Released ${p.ip ?? '?'} from ${p.mac ?? '?'}`);
      }),
      bus.subscribeWhere('dhcp.address-conflict', isOurs, (e) => {
        const p = e.payload as { ip?: string };
        this.append('warnings', 'dhcp',
          `Address conflict detected for ${p.ip ?? '?'} — sending DECLINE`);
      }),
      bus.subscribeWhere('dhcp.nak.received', isOurs, (e) => {
        const p = e.payload as { serverIp?: string };
        this.append('warnings', 'dhcp',
          `DHCPNAK received from ${p.serverIp ?? '?'}`);
      }),
      bus.subscribeWhere('dhcp.lease.expired', isOurs, (e) => {
        const p = e.payload as { iface?: string; ip?: string };
        this.append('warnings', 'dhcp',
          `Lease on ${p.iface ?? '?'} expired (${p.ip ?? '?'})`);
      }),
      bus.subscribeWhere('cdp.neighbor.discovered', isOurs, (e) => {
        const p = e.payload as { localPort?: string; deviceId?: string; remoteDeviceId?: string; remotePortId?: string };
        const remote = (p as { remoteDeviceId?: string; deviceIdRemote?: string }).remoteDeviceId
          ?? (p as { deviceIdRemote?: string }).deviceIdRemote ?? '?';
        this.append('informational', 'cdp',
          `Neighbor ${remote} (${p.remotePortId ?? '?'}) discovered on ${p.localPort ?? '?'}`);
      }),
      bus.subscribeWhere('cdp.neighbor.expired', isOurs, (e) => {
        const p = e.payload as { localPort?: string; remoteDeviceId?: string };
        this.append('notifications', 'cdp',
          `Neighbor ${p.remoteDeviceId ?? '?'} expired on ${p.localPort ?? '?'}`);
      }),
      bus.subscribeWhere('vrrp.state.changed', isOurs, (e) => {
        const p = e.payload as { iface?: string; vrid?: number; oldState?: string; newState?: string };
        this.append('notifications', 'vrrp',
          `${p.iface ?? '?'} VRID ${p.vrid ?? 0} state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
      }),
      bus.subscribeWhere('vrrp.master.changed', isOurs, (e) => {
        const p = e.payload as { iface?: string; vrid?: number; masterIp?: string };
        this.append('notifications', 'vrrp',
          `${p.iface ?? '?'} VRID ${p.vrid ?? 0} new master ${p.masterIp ?? '?'}`);
      }),
      bus.subscribeWhere('glbp.avg.changed', isOurs, (e) => {
        const p = e.payload as { iface?: string; group?: number; avgIp?: string };
        this.append('notifications', 'glbp',
          `${p.iface ?? '?'} Grp ${p.group ?? 0} AVG is ${p.avgIp ?? '?'}`);
      }),
      bus.subscribeWhere('glbp.avf.state.changed', isOurs, (e) => {
        const p = e.payload as { iface?: string; group?: number; forwarder?: number; oldState?: string; newState?: string };
        this.append('informational', 'glbp',
          `${p.iface ?? '?'} Grp ${p.group ?? 0} Fwd ${p.forwarder ?? 0} state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
      }),
      bus.subscribeWhere('router.aaa.account.login.success', isOurs, (e) => {
        const p = e.payload as { username?: string; sourceIp?: string };
        this.append('notifications', 'sec_login',
          `Login Success [user: ${p.username ?? '?'}] [Source: ${p.sourceIp ?? '?'}]`);
      }),
      bus.subscribeWhere('router.aaa.account.login.failure', isOurs, (e) => {
        const p = e.payload as { username?: string; sourceIp?: string; reason?: string };
        this.append('warnings', 'sec_login',
          `Login Failed [user: ${p.username ?? '?'}] [Source: ${p.sourceIp ?? '?'}] (${p.reason ?? 'invalid credentials'})`);
      }),
      bus.subscribeWhere('router.aaa.account.locked', isOurs, (e) => {
        const p = e.payload as { username?: string };
        this.append('critical', 'sec',
          `Account ${p.username ?? '?'} locked due to repeated failures`);
      }),
      bus.subscribeWhere('router.aaa.account.created', isOurs, (e) => {
        const p = e.payload as { username?: string; privLvl?: number };
        this.append('informational', 'sys',
          `User account '${p.username ?? '?'}' created (priv ${p.privLvl ?? 1})`);
      }),
      bus.subscribeWhere('router.aaa.account.deleted', isOurs, (e) => {
        const p = e.payload as { username?: string };
        this.append('informational', 'sys',
          `User account '${p.username ?? '?'}' deleted`);
      }),
      bus.subscribeWhere('router.ssh.session.opened', isOurs, (e) => {
        const p = e.payload as { username?: string; sourceIp?: string; vty?: string };
        this.append('informational', 'ssh',
          `Session opened for '${p.username ?? '?'}' on ${p.vty ?? 'vty'} from ${p.sourceIp ?? '?'}`);
      }),
      bus.subscribeWhere('router.ssh.session.closed', isOurs, (e) => {
        const p = e.payload as { username?: string; vty?: string };
        this.append('informational', 'ssh',
          `Session closed for '${p.username ?? '?'}' on ${p.vty ?? 'vty'}`);
      }),
      bus.subscribeWhere('dtp.mode.changed', isOurs, (e) => {
        const p = e.payload as { portName?: string; oldMode?: string; newMode?: string };
        this.append('informational', 'dtp',
          `${p.portName ?? '?'}: trunk negotiation mode ${p.oldMode ?? '?'} -> ${p.newMode ?? '?'}`);
      }),
      bus.subscribeWhere('stp.state.changed', isOurs, (e) => {
        const p = e.payload as { portName?: string; vlan?: number; oldState?: string; newState?: string };
        this.append('informational', 'spantree',
          `Port ${p.portName ?? '?'} VLAN ${p.vlan ?? 1} state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
      }),
      bus.subscribeWhere('stp.root-guard.changed', isOurs, (e) => {
        const p = e.payload as { portName?: string; blocked?: boolean };
        this.append('warnings', 'spantree',
          `Root-guard ${p.blocked ? 'blocked' : 'unblocked'} on ${p.portName ?? '?'}`);
      }),
      bus.subscribeWhere('netflow.collector.changed', isOurs, (e) => {
        const p = e.payload as { collectorIp?: string; added?: boolean };
        this.append('informational', 'netflow',
          p.added
            ? `Collector ${p.collectorIp ?? '?'} added`
            : `Collector ${p.collectorIp ?? '?'} removed`);
      }),
      bus.subscribeWhere('vxlan.vtep.changed', isOurs, (e) => {
        const p = e.payload as { vni?: number; vtepIp?: string; added?: boolean };
        this.append('informational', 'vxlan',
          p.added
            ? `VTEP ${p.vtepIp ?? '?'} added to VNI ${p.vni ?? 0}`
            : `VTEP ${p.vtepIp ?? '?'} removed from VNI ${p.vni ?? 0}`);
      }),
      bus.subscribeWhere('vxlan.packet.dropped', isOurs, (e) => {
        const p = e.payload as { vni?: number; reason?: string };
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
        const p = e.payload as { iface?: string; neighbor?: string };
        this.append('notifications', 'pim',
          `Neighbor ${p.neighbor ?? '?'} discovered on ${p.iface ?? '?'}`);
      }),
      bus.subscribeWhere('pim.neighbor.lost', isOurs, (e) => {
        const p = e.payload as { iface?: string; neighbor?: string };
        this.append('warnings', 'pim',
          `Neighbor ${p.neighbor ?? '?'} on ${p.iface ?? '?'} timed out`);
      }),
      bus.subscribeWhere('pim.rp.changed', isOurs, (e) => {
        const p = e.payload as { group?: string; oldRp?: string; newRp?: string };
        this.append('notifications', 'pim',
          `RP for ${p.group ?? '*'} changed ${p.oldRp ?? '?'} -> ${p.newRp ?? '?'}`);
      }),
      bus.subscribeWhere('dot1x.auth.outcome', isOurs, (e) => {
        const p = e.payload as { portName?: string; mac?: string; outcome?: string; user?: string };
        const sev = p.outcome === 'success' ? 'informational' : 'warnings';
        this.append(sev, 'dot1x',
          `Authentication ${p.outcome ?? '?'} on ${p.portName ?? '?'} for ${p.user ?? p.mac ?? '?'}`);
      }),
      bus.subscribeWhere('dot1x.port.state.changed', isOurs, (e) => {
        const p = e.payload as { portName?: string; oldState?: string; newState?: string };
        this.append('informational', 'dot1x',
          `Port ${p.portName ?? '?'} state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
      }),
      bus.subscribeWhere('udld.err-disable', isOurs, (e) => {
        const p = e.payload as { portName?: string };
        this.append('errors', 'udld',
          `Port ${p.portName ?? '?'} err-disabled by UDLD`);
      }),
      bus.subscribeWhere('udld.neighbor.changed', isOurs, (e) => {
        const p = e.payload as { portName?: string; neighborId?: string };
        this.append('informational', 'udld',
          `Neighbor change on ${p.portName ?? '?'} (id ${p.neighborId ?? '?'})`);
      }),
      bus.subscribeWhere('vtp.domain.changed', isOurs, (e) => {
        const p = e.payload as { domain?: string };
        this.append('informational', 'vtp',
          `VTP domain changed to '${p.domain ?? '?'}'`);
      }),
      bus.subscribeWhere('vtp.mode.changed', isOurs, (e) => {
        const p = e.payload as { mode?: string };
        this.append('informational', 'vtp',
          `VTP mode changed to ${p.mode ?? '?'}`);
      }),
      bus.subscribeWhere('radius.auth.rejected', isOurs, (e) => {
        const p = e.payload as { username?: string; sourceIp?: string; reason?: string };
        this.append('warnings', 'radius',
          `Authentication rejected for ${p.username ?? '?'} from ${p.sourceIp ?? '?'} (${p.reason ?? '?'})`);
      }),
      bus.subscribeWhere('radius.auth.completed', isOurs, (e) => {
        const p = e.payload as { username?: string; status?: string };
        this.append('informational', 'radius',
          `Authentication ${p.status ?? '?'} for ${p.username ?? '?'}`);
      }),
      bus.subscribeWhere('tacacs.authen.completed', isOurs, (e) => {
        const p = e.payload as { username?: string; status?: string };
        this.append('informational', 'tacacs',
          `Authentication ${p.status ?? '?'} for ${p.username ?? '?'}`);
      }),
      bus.subscribeWhere('tacacs.author.completed', isOurs, (e) => {
        const p = e.payload as { username?: string; command?: string; status?: string };
        this.append('informational', 'tacacs',
          `Authorization ${p.status ?? '?'} for ${p.username ?? '?'} cmd='${p.command ?? '?'}'`);
      }),
      bus.subscribeWhere('gre.tunnel.changed', isOurs, (e) => {
        const p = e.payload as { tunnelName?: string; oldState?: string; newState?: string };
        this.append('notifications', 'gre',
          `Tunnel ${p.tunnelName ?? '?'} state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
      }),
      bus.subscribeWhere('port.config.ipv6-added', isOurs, (e) => {
        const p = e.payload as { portName?: string; ipv6?: string };
        this.append('informational', 'ifmgr',
          `Interface ${p.portName ?? '?'}, IPv6 address ${p.ipv6 ?? '?'} assigned`);
      }),
      bus.subscribeWhere('port.config.ipv6-removed', isOurs, (e) => {
        const p = e.payload as { portName?: string; ipv6?: string };
        this.append('informational', 'ifmgr',
          `Interface ${p.portName ?? '?'}, IPv6 address ${p.ipv6 ?? '?'} removed`);
      }),
      bus.subscribeWhere('port.security.mac-aged', isOurs, (e) => {
        const p = e.payload as { portName?: string; mac?: string };
        this.append('debugging', 'port_security',
          `MAC ${p.mac ?? '?'} aged out on ${p.portName ?? '?'}`);
      }),
      bus.subscribeWhere('port.security.errdisable.cleared', isOurs, (e) => {
        const p = e.payload as { portName?: string };
        this.append('informational', 'pm',
          `Interface ${p.portName ?? '?'} recovered from err-disabled state`);
      }),
      bus.subscribeWhere('port.security.sticky-saved', isOurs, (e) => {
        const p = e.payload as { portName?: string; count?: number };
        this.append('informational', 'port_security',
          `Sticky MAC addresses saved on ${p.portName ?? '?'} (${p.count ?? 0} entries)`);
      }),
      bus.subscribeWhere('arp.errdisable.set', isOurs, (e) => {
        const p = e.payload as { portName?: string; reason?: string };
        this.append('errors', 'dai',
          `Port ${p.portName ?? '?'} err-disabled (${p.reason ?? 'DAI violation'})`);
      }),
      bus.subscribeWhere('arp.errdisable.cleared', isOurs, (e) => {
        const p = e.payload as { portName?: string };
        this.append('informational', 'dai',
          `Port ${p.portName ?? '?'} cleared from err-disabled`);
      }),
      bus.subscribeWhere('pim.dr.changed', isOurs, (e) => {
        const p = e.payload as { iface?: string; newDr?: string };
        this.append('notifications', 'pim',
          `Designated Router on ${p.iface ?? '?'} is now ${p.newDr ?? '?'}`);
      }),
      bus.subscribeWhere('gre.packet.dropped', isOurs, (e) => {
        const p = e.payload as { tunnelName?: string; reason?: string };
        this.append('warnings', 'gre',
          `Dropped packet on tunnel ${p.tunnelName ?? '?'} (${p.reason ?? '?'})`);
      }),
      bus.subscribeWhere('dhcp.client.state-changed', isOurs, (e) => {
        const p = e.payload as { iface?: string; oldState?: string; newState?: string };
        this.append('debugging', 'dhcp',
          `Client ${p.iface ?? '?'} state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
      }),
      bus.subscribeWhere('dhcp.reservation.added', isOurs, (e) => {
        const p = e.payload as { ip?: string; mac?: string; pool?: string };
        this.append('informational', 'dhcpd',
          `Reservation added: ${p.ip ?? '?'} for ${p.mac ?? '?'} (pool ${p.pool ?? '?'})`);
      }),
      bus.subscribeWhere('cable.connected', () => undefined),
      bus.subscribe('cable.disconnected', (e) => {
        const p = e.payload as {
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
        const p = e.payload as {
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
      const p = e.payload as { source: string; level: string; event: string; message: string };
      if (p.source !== deviceId) return;
      if (p.event.startsWith('router:acl-deny')) {
        this.append('warnings', 'sec', p.message);
      }
    };
    unsubs.push(bus.subscribe('log', logHandler));
    const defaultBus = getDefaultEventBus();
    if (defaultBus !== bus) unsubs.push(defaultBus.subscribe('log', logHandler));
    return () => { for (const u of unsubs) u(); };
  }

  /** Apply `logging …` (negate=false) or `no logging …` (negate=true). */
  apply(args: string[], negate: boolean): void {
    const head = (args[0] ?? '').toLowerCase();
    switch (head) {
      case '':
      case 'on':
        this.enabled = !negate;
        return;
      case 'buffered': {
        this.buffered = !negate;
        for (const a of args.slice(1)) {
          if (/^\d+$/.test(a)) this.bufferedSize = parseInt(a, 10);
          else { const s = normSeverity(a); if (s) this.bufferedSeverity = s; }
        }
        return;
      }
      case 'console': {
        const s = normSeverity(args[1] ?? '');
        if (s) this.consoleSeverity = s;
        return;
      }
      case 'monitor': {
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
  render(): string {
    const lvl = (s: Severity) => `level ${s}`;
    const lines = [
      `Syslog logging: ${this.enabled ? 'enabled' : 'disabled'}` +
        ' (0 messages dropped, 0 flushes, 0 overruns)',
      `    Console logging: ${lvl(this.consoleSeverity)}`,
      `    Monitor logging: ${lvl(this.monitorSeverity)}`,
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
        const sevNum = this.SEVERITY_ORDER[m.severity];
        const date = new Date(m.ts);
        const stamp = `${date.toISOString().slice(5, 19).replace('T', ' ')}`;
        lines.push(`${stamp}: %${m.tag.toUpperCase()}-${sevNum}-${m.severity.toUpperCase()}: ${m.text}`);
      }
    }
    return lines.join('\n');
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
