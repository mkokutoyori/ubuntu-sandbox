/**
 * Domain event types.
 *
 * The full taxonomy of topics is documented in
 * `docs/REFONTE-REACTIVE-EVENT-DRIVEN.md` §8.2 and §12.4.
 *
 * Each phase of the refactor extends this union with the topics it requires.
 *
 * Type-only imports are used for domain types (`EthernetFrame`, `MACAddress`,
 * etc.) to keep the events module zero-runtime-cost and to avoid any
 * circular runtime dependency between `src/events/` and `src/network/`.
 */

import type {
  EthernetFrame,
  MACAddress,
  IPAddress,
  IPv6Address,
  SubnetMask,
  PortDuplex,
  PortSpeed,
  PortViolationMode,
} from '@/network/core/types';
import type { OspfDomainEvent } from '@/network/ospf/events';
import type { IpsecDomainEvent } from '@/network/ipsec/events';
import type { RipDomainEvent } from '@/network/rip/events';
import type { DhcpDomainEvent } from '@/network/dhcp/events';
import type { ArpDomainEvent } from '@/network/arp/events';
import type { CdpDomainEvent } from '@/network/cdp/events';
import type { LldpDomainEvent } from '@/network/lldp/events';
import type { DtpDomainEvent } from '@/network/dtp/events';
import type { StpDomainEvent } from '@/network/stp/events';
import type { LacpDomainEvent } from '@/network/lacp/events';
import type { VtpDomainEvent } from '@/network/vtp/events';
import type { FhrpDomainEvent } from '@/network/fhrp/events';
import type { HsrpDomainEvent } from '@/network/hsrp/events';
import type { VrrpDomainEvent } from '@/network/vrrp/events';
import type { GlbpDomainEvent } from '@/network/glbp/events';
import type { BfdDomainEvent } from '@/network/bfd/events';
import type { IpSlaDomainEvent } from '@/network/ipsla/events';
import type { UdldDomainEvent } from '@/network/udld/events';
import type { IgmpDomainEvent } from '@/network/igmp/events';
import type { LlmnrDomainEvent } from '@/network/llmnr/events';
import type { MdnsDomainEvent } from '@/network/mdns/events';
import type { IgmpSnoopingDomainEvent } from '@/network/igmp-snooping/events';
import type { PimSnoopingDomainEvent } from '@/network/pim-snooping/events';
import type { PimDomainEvent } from '@/network/pim/events';
import type { SyslogDomainEvent } from '@/network/syslog/events';
import type { RadiusDomainEvent } from '@/network/radius/events';
import type { Dot1xDomainEvent } from '@/network/dot1x/events';
import type { GreDomainEvent } from '@/network/gre/events';
import type { SnmpDomainEvent } from '@/network/snmp/events';
import type { NetFlowDomainEvent } from '@/network/netflow/events';
import type { TacacsDomainEvent } from '@/network/tacacs/events';
import type { VxlanDomainEvent } from '@/network/vxlan/events';
import type { TcpDomainEvent } from '@/network/tcp/events';
import type { BgpDomainEvent } from '@/network/bgp/events';
import type { TlsDomainEvent } from '@/network/tls/events';
import type { QuicDomainEvent } from '@/network/quic/events';
import type { HttpDomainEvent } from '@/network/http/events';
import type { FtpDomainEvent } from '@/network/ftp/events';
import type { SmtpDomainEvent } from '@/network/smtp/events';
import type { NhrpDomainEvent } from '@/network/nhrp/events';
import type { TftpDomainEvent } from '@/network/tftp/events';
import type { SftpDomainEvent } from '@/network/protocols/ssh/sftp/events';
import type { NetworkOsAccountEventEnvelope } from '@/network/devices/router/aaa/NetworkOsAccount';
import type { SshSessionRecord } from '@/network/devices/router/aaa/SshSessionRegistry';
import type { EigrpDomainEvent } from '@/network/eigrp/events';
import type { NtpDomainEvent } from '@/network/ntp/events';
import type { NatDomainEvent } from '@/network/devices/router/nat/events';
import type { HostDomainEvent } from '@/network/devices/host/events';
import type { LinuxProcessServiceDomainEvent } from '@/network/devices/linux/events';
import type { LinuxIamDomainEvent } from '@/network/devices/linux/iam/events';
import type { WindowsDomainEvent } from '@/network/devices/windows/events';
import type { KerberosDomainEvent } from '@/network/kerberos/events';
import type { ReplicationDomainEvent } from '@/network/devices/windows/server/ad/replication/events';
import type { AdcsDomainEvent } from '@/network/devices/windows/server/adcs/events';
import type { RdpDomainEvent } from '@/network/devices/windows/server/rdp/events';
import type { ClusterDomainEvent } from '@/network/devices/windows/server/cluster/events';
import type { DfsDomainEvent } from '@/network/devices/windows/server/dfs/events';
import type { OracleDomainEvent } from '@/database/oracle/events';
import type { RmanDomainEvent } from '@/terminal/subshells/rman/events';

// ──────────────────────────────────────────────────────────────────────────
// Cross-cutting
// ──────────────────────────────────────────────────────────────────────────

export interface LogEventPayload {
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  event: string;
  message: string;
  data?: unknown;
}

export interface BusHandlerErrorPayload {
  topic: string;
  error: unknown;
}

// ──────────────────────────────────────────────────────────────────────────
// Device lifecycle (consumed by Phase 2)
// ──────────────────────────────────────────────────────────────────────────

export interface DeviceSyslogEntryPayload {
  deviceId: string;
  severity: 'emergencies' | 'alerts' | 'critical' | 'errors'
          | 'warnings' | 'notifications' | 'informational' | 'debugging';
  severityNum: number;
  tag: string;
  /**
   * Le mnémonique IOS (`UPDOWN`, `CONFIG_I`), qui complète `tag` et
   * `severityNum` pour reconstituer le `%TAG-SEV-MNEMONIQUE` qu'un
   * collecteur syslog attend. Sans lui, le relais devait inventer une
   * forme, et la ligne partie sur le fil ne ressemblait pas à celle que
   * la même machine affichait dans `show logging`.
   */
  mnemonic?: string;
  message: string;
  ts: number;
}

export interface DeviceRegisteredPayload {
  id: string;
  type: string;
  name: string;
}

export interface DeviceDeregisteredPayload {
  id: string;
}

export interface DeviceRemovedPayload {
  /** Equipment id removed by user (distinct from registry.cleared). */
  id: string;
  /** Human-readable name at removal time (terminals can label the trace). */
  name: string;
  /** Whether the device was still powered on when removed. */
  wasPoweredOn: boolean;
}

export interface DevicePowerOnPayload {
  id: string;
}

export interface DevicePowerOffPayload {
  id: string;
}

export interface DevicePositionChangedPayload {
  id: string;
  x: number;
  y: number;
}

export interface DeviceRenamedPayload {
  id: string;
  oldName: string;
  newName: string;
}

export interface RegistryClearedPayload {
  reason?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Hardware: Port (Phase 3)
// ──────────────────────────────────────────────────────────────────────────

export interface PortRef {
  deviceId: string;
  portName: string;
}

export interface PortFrameTxRequestedPayload extends PortRef {
  frame: EthernetFrame;
}

export interface PortFrameTxBlockedPayload extends PortRef {
  reason: 'link-down' | 'no-cable' | 'powered-off';
}

export interface PortFrameReceivedPayload extends PortRef {
  frame: EthernetFrame;
}

export interface PortFrameDroppedPayload extends PortRef {
  reason: 'link-down' | 'security-violation';
  /** Source MAC of the dropped frame, when available. */
  srcMac?: MACAddress;
}

export interface PortLinkUpPayload extends PortRef {}
export interface PortLinkDownPayload extends PortRef {
  /** True when the operator shut the port, false for a carrier loss. */
  adminDown?: boolean;
}

export interface PortIpChangedPayload extends PortRef {
  ip: IPAddress | null;
  mask: SubnetMask | null;
}

export interface PortIpv6AddedPayload extends PortRef {
  address: IPv6Address;
  prefixLength: number;
  origin: 'link-local' | 'static' | 'slaac' | 'dhcpv6';
}

export interface PortIpv6RemovedPayload extends PortRef {
  address: IPv6Address;
}

export interface PortMtuChangedPayload extends PortRef {
  mtu: number;
}

export interface PortSpeedChangedPayload extends PortRef {
  speed: PortSpeed;
}

export interface PortDuplexChangedPayload extends PortRef {
  duplex: PortDuplex;
}

export interface PortSecurityViolationPayload extends PortRef {
  mac: MACAddress;
  mode: PortViolationMode;
  action: 'discarded' | 'shutdown' | 'restricted';
}

export interface PortSecurityErrDisabledPayload extends PortRef {
  mac: MACAddress;
}
export interface PortSecurityRecoveredPayload extends PortRef {}
export interface PortSecurityStickySavedPayload extends PortRef {
  mac: MACAddress;
  vlan: number;
}
export interface PortSecurityMacAgedPayload extends PortRef {
  mac: MACAddress;
  vlan: number;
  type: 'static' | 'sticky' | 'dynamic';
}

// ──────────────────────────────────────────────────────────────────────────
// Hardware: Cable (Phase 3)
// ──────────────────────────────────────────────────────────────────────────

export interface CableRef {
  cableId: string;
}

export interface CableConnectedPayload extends CableRef {
  portA: PortRef;
  portB: PortRef;
  cableType: string;
}

export interface CableDisconnectedPayload extends CableRef {}

export interface CableNegotiatedPayload extends CableRef {
  speed: PortSpeed;
  duplex: PortDuplex;
}

export interface CableDuplexMismatchPayload extends CableRef {
  portA: PortRef;
  portB: PortRef;
}

export interface CableFrameDispatchedPayload extends CableRef {
  from: PortRef;
  to: PortRef;
  frame: EthernetFrame;
  propagationMs: number;
}

export interface CableFrameDeliveredPayload extends CableRef {
  from: PortRef;
  to: PortRef;
  frame: EthernetFrame;
}

export interface CableFrameLostPayload extends CableRef {
  reason: 'simulated-loss' | 'cable-down' | 'no-peer' | 'l2-loop-suppressed' | 'fcs-corrupted';
}

// ──────────────────────────────────────────────────────────────────────────
// Discriminated union
// ──────────────────────────────────────────────────────────────────────────

type DistributeTopics<T extends string, P> = T extends unknown ? { topic: T; payload: P } : never;

export type DomainEvent =
  // Cross-cutting
  | { topic: 'log'; payload: LogEventPayload }
  | { topic: 'bus.handler-error'; payload: BusHandlerErrorPayload }
  | { topic: 'device.syslog.entry'; payload: DeviceSyslogEntryPayload }
  // Device lifecycle
  | { topic: 'device.registered'; payload: DeviceRegisteredPayload }
  | { topic: 'device.deregistered'; payload: DeviceDeregisteredPayload }
  | { topic: 'device.removed'; payload: DeviceRemovedPayload }
  | { topic: 'device.power-on'; payload: DevicePowerOnPayload }
  | { topic: 'device.power-off'; payload: DevicePowerOffPayload }
  | { topic: 'device.position-changed'; payload: DevicePositionChangedPayload }
  | { topic: 'device.renamed'; payload: DeviceRenamedPayload }
  | { topic: 'registry.cleared'; payload: RegistryClearedPayload }
  // Port
  | { topic: 'port.frame.tx-requested'; payload: PortFrameTxRequestedPayload }
  | { topic: 'port.frame.tx-blocked'; payload: PortFrameTxBlockedPayload }
  | { topic: 'port.frame.received'; payload: PortFrameReceivedPayload }
  | { topic: 'port.frame.dropped'; payload: PortFrameDroppedPayload }
  | { topic: 'port.link.up'; payload: PortLinkUpPayload }
  | { topic: 'port.link.down'; payload: PortLinkDownPayload }
  | { topic: 'port.config.ip-changed'; payload: PortIpChangedPayload }
  | { topic: 'port.config.ipv6-added'; payload: PortIpv6AddedPayload }
  | { topic: 'port.config.ipv6-removed'; payload: PortIpv6RemovedPayload }
  | { topic: 'port.config.mtu-changed'; payload: PortMtuChangedPayload }
  | { topic: 'port.config.speed-changed'; payload: PortSpeedChangedPayload }
  | { topic: 'port.config.duplex-changed'; payload: PortDuplexChangedPayload }
  | { topic: 'port.security.violation'; payload: PortSecurityViolationPayload }
  | { topic: 'port.security.errdisable.set'; payload: PortSecurityErrDisabledPayload }
  | { topic: 'port.security.errdisable.cleared'; payload: PortSecurityRecoveredPayload }
  | { topic: 'port.security.sticky-saved'; payload: PortSecurityStickySavedPayload }
  | { topic: 'port.security.mac-aged'; payload: PortSecurityMacAgedPayload }
  // Switch L2 forwarding table
  | { topic: 'switch.mac.learned'; payload: SwitchMacEntryPayload }
  | { topic: 'switch.mac.moved'; payload: SwitchMacMovedPayload }
  | { topic: 'switch.mac.aged'; payload: SwitchMacEntryPayload }
  | { topic: 'switch.mac.flushed'; payload: SwitchMacFlushedPayload }
  | { topic: 'switch.mac.cleared'; payload: { deviceId: string; hostname: string } }
  | { topic: 'switch.mac.learning-discard'; payload: SwitchMacEntryPayload }
  // Cable
  | { topic: 'cable.connected'; payload: CableConnectedPayload }
  | { topic: 'cable.disconnected'; payload: CableDisconnectedPayload }
  | { topic: 'cable.negotiated'; payload: CableNegotiatedPayload }
  | { topic: 'cable.duplex-mismatch'; payload: CableDuplexMismatchPayload }
  | { topic: 'cable.frame.dispatched'; payload: CableFrameDispatchedPayload }
  | { topic: 'cable.frame.delivered'; payload: CableFrameDeliveredPayload }
  | { topic: 'cable.frame.lost'; payload: CableFrameLostPayload }
  // OSPF (sub-union, see src/network/ospf/events.ts)
  | OspfDomainEvent
  // IPSec (sub-union, see src/network/ipsec/events.ts)
  | IpsecDomainEvent
  // RIP (sub-union, see src/network/rip/events.ts)
  | RipDomainEvent
  // DHCP (sub-union, see src/network/dhcp/events.ts)
  | DhcpDomainEvent
  // ARP / DAI (sub-union, see src/network/arp/events.ts)
  | ArpDomainEvent
  // CDP (sub-union, see src/network/cdp/events.ts)
  | CdpDomainEvent
  | LldpDomainEvent
  | DtpDomainEvent
  | StpDomainEvent
  | LacpDomainEvent
  | VtpDomainEvent
  | FhrpDomainEvent
  | HsrpDomainEvent
  | VrrpDomainEvent
  | GlbpDomainEvent
  | BfdDomainEvent
  // IP SLA: sondes actives, cycle de vie des operations, reactions, track
  // (sous-union, cf. src/network/ipsla/events.ts)
  | IpSlaDomainEvent
  | UdldDomainEvent
  | IgmpDomainEvent
  | LlmnrDomainEvent
  | MdnsDomainEvent
  | IgmpSnoopingDomainEvent
  | PimSnoopingDomainEvent
  | PimDomainEvent
  | SyslogDomainEvent
  | RadiusDomainEvent
  | Dot1xDomainEvent
  | GreDomainEvent
  | SnmpDomainEvent
  | NetFlowDomainEvent
  | TacacsDomainEvent
  | VxlanDomainEvent
  | TcpDomainEvent
  | BgpDomainEvent
  | TlsDomainEvent
  | QuicDomainEvent
  | HttpDomainEvent
  | FtpDomainEvent
  | TftpDomainEvent
  | SftpDomainEvent
  | DistributeTopics<NetworkOsAccountEventEnvelope['topic'], NetworkOsAccountEventEnvelope['payload']>
  | { topic: 'router.ssh.session.opened'; payload: { deviceId: string; session: SshSessionRecord } }
  | { topic: 'router.ssh.session.closed'; payload: { deviceId: string; session: SshSessionRecord; reason: string } }
  | EigrpDomainEvent
  | NtpDomainEvent
  // NAT (sub-union, see src/network/devices/router/nat/events.ts)
  | NatDomainEvent
  // Host L3/L4 (sub-union, see src/network/devices/host/events.ts)
  | HostDomainEvent
  // Linux process & service (sub-union, see src/network/devices/linux/events.ts)
  | LinuxProcessServiceDomainEvent
  // Linux IAM: accounts & groups (sub-union, see src/network/devices/linux/iam/events.ts)
  | LinuxIamDomainEvent
  // Oracle DBMS (sub-union, see src/database/oracle/events.ts)
  | OracleDomainEvent
  // RMAN sub-shell (sub-union, see src/terminal/subshells/rman/events.ts)
  | RmanDomainEvent
  // Windows device: services, accounts, groups, processes
  // (sub-union, see src/network/devices/windows/events.ts)
  | WindowsDomainEvent
  // Kerberos: AS/TGS exchange, cross-realm referrals, S4U2Proxy delegation
  // (sub-union, see src/network/kerberos/events.ts)
  | KerberosDomainEvent
  // AD replication: pull cycles (sub-union, see
  // src/network/devices/windows/server/ad/replication/events.ts)
  | ReplicationDomainEvent
  // AD CS: certificate issuance (sub-union, see
  // src/network/devices/windows/server/adcs/events.ts)
  | AdcsDomainEvent
  // RDP: session lifecycle (sub-union, see
  // src/network/devices/windows/server/rdp/events.ts)
  | RdpDomainEvent
  // WSFC cluster: node liveness, resource-group failover (sub-union, see
  // src/network/devices/windows/server/cluster/events.ts)
  | ClusterDomainEvent
  // DFSR: replication cycles (sub-union, see
  // src/network/devices/windows/server/dfs/events.ts)
  | DfsDomainEvent
  // SMTP: control channel, mail transaction, delivery outcomes, DSN, retry
  // queue (sub-union, see src/network/smtp/events.ts)
  | SmtpDomainEvent
  | NhrpDomainEvent;

export interface SwitchMacEntryPayload {
  deviceId: string;
  hostname: string;
  mac: string;
  vlan: number;
  port: string;
}

export interface SwitchMacMovedPayload extends SwitchMacEntryPayload {
  fromPort: string;
}

export interface SwitchMacFlushedPayload {
  deviceId: string;
  hostname: string;
  port: string;
  reason: string;
  count: number;
}

export type DomainEventTopic = DomainEvent['topic'];

export type EventOf<T extends DomainEventTopic> = Extract<DomainEvent, { topic: T }>;

export type PayloadOf<T extends DomainEventTopic> = EventOf<T>['payload'];
