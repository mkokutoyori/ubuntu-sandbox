import { oidInMibView, type MibViewEntry } from './mibView';
import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import {
  type SnmpAgentConfig, type SnmpMessage, type SnmpPacket, type SnmpVarBinding, type SnmpValue,
  type SnmpCommunityAcl, type SnmpTrapHost, type SnmpErrorStatus,
  createDefaultAgentConfig, v, vb, oidCompare, oidStartsWith,
  UDP_PORT_SNMP, UDP_PORT_SNMP_TRAP,
  OID_SYS_DESCR, OID_SYS_OBJECT_ID, OID_SYS_UPTIME,
  OID_SYS_CONTACT, OID_SYS_NAME, OID_SYS_LOCATION, OID_SYS_SERVICES,
  OID_IF_NUMBER, OID_IF_INDEX_PREFIX, OID_IF_DESCR_PREFIX,
  OID_IF_TYPE_PREFIX, OID_IF_MTU_PREFIX, OID_IF_PHYS_ADDR_PREFIX,
  OID_IF_ADMIN_STATUS_PREFIX, OID_IF_OPER_STATUS_PREFIX, OID_IF_NAME_PREFIX,
  type SnmpVersion,
} from './types';
import {
  IPAddress,
  type EthernetFrame, type UDPPacket,
} from '../core/types';
import { Logger } from '../core/Logger';
import type { UdpSendRequest } from '../layers/transport/UdpEgress';
import type { Port } from '../hardware/Port';
import {
  classifyIpv4Destination, connectedPrefixesOfPort, isDirectedBroadcast,
} from '../layers/internet/InternetLayer';
import { SnmpManager, type SnmpQueryPdu } from './SnmpManager';
import {
  trapV1Pdu, trapV2Pdu, type SnmpNotification, type SnmpNotificationTarget,
} from './SnmpNotification';
import { PortNumber } from '../core/ports/PortNumber';

export interface SnmpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): Port | undefined;
  getPorts(): Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  getSysDescr(): string;
  getSysObjectId(): string;
  sendUdpDatagram(request: UdpSendRequest): boolean;
  evaluateAclPermit?(aclName: string, sourceIp: string, inPort: string): boolean;
  describeInterface?(port: Port): SnmpInterfaceRow;
  sourceAddressFor?(destination: IPAddress, iface?: string): IPAddress | null;
}

export interface SnmpInterfaceRow {
  readonly descr: string;
  readonly name?: string;
  readonly type?: number;
}

interface InterfaceEntry {
  readonly index: number;
  readonly port: Port;
  readonly row: SnmpInterfaceRow;
}

interface InterfaceColumn {
  readonly prefix: string;
  value(entry: InterfaceEntry): SnmpValue | null;
}

const ETHERNET_CSMACD = 6;

const INTERFACE_COLUMNS: readonly InterfaceColumn[] = [
  { prefix: OID_IF_INDEX_PREFIX, value: (entry) => v('integer', entry.index) },
  { prefix: OID_IF_DESCR_PREFIX, value: (entry) => v('octet-string', entry.row.descr) },
  { prefix: OID_IF_TYPE_PREFIX, value: (entry) => v('integer', entry.row.type ?? ETHERNET_CSMACD) },
  { prefix: OID_IF_MTU_PREFIX, value: (entry) => v('integer', entry.port.getMTU()) },
  {
    prefix: OID_IF_PHYS_ADDR_PREFIX,
    value: (entry) => v('octet-string', Uint8Array.from(entry.port.getMAC().getOctets())),
  },
  { prefix: OID_IF_ADMIN_STATUS_PREFIX, value: (entry) => v('integer', entry.port.getIsUp() ? 1 : 2) },
  {
    prefix: OID_IF_OPER_STATUS_PREFIX,
    value: (entry) => v('integer', entry.port.getIsUp() && entry.port.isConnected() ? 1 : 2),
  },
  {
    prefix: OID_IF_NAME_PREFIX,
    value: (entry) => (entry.row.name === undefined ? null : v('octet-string', entry.row.name)),
  },
];

interface SnmpAnswer {
  readonly errorStatus: SnmpErrorStatus;
  readonly errorIndex: number;
  readonly varBindings: SnmpVarBinding[];
}

const NMS_QUERY_TIMEOUT_MS = 5000;

export class SnmpAgent {
  private config: SnmpAgentConfig = createDefaultAgentConfig();
  private startedAtMs = 0;
  private nextTrapRequestId = 1;
  private running = false;
  private customMib = new Map<string, () => SnmpValue>();
  private readonly manager: SnmpManager;

  constructor(
    private readonly host: SnmpHost,
    private readonly getBus: () => IEventBus,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {
    this.manager = new SnmpManager(
      (query, packet) => this.transmitRouted(
        query.server, null, query.port.value, 49152 + (packet.requestId & 0x3fff), packet),
      () => this.getScheduler(),
      'request-id-and-peer',
    );
    this.startedAtMs = this.getScheduler().now();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAtMs = this.getScheduler().now();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.manager.abandonAll();
  }

  getConfig(): Readonly<SnmpAgentConfig> { return this.config; }

  setEnabled(enabled: boolean): void { this.config.enabled = enabled; }

  replaceCommunities(entries: readonly SnmpCommunityAcl[]): void {
    this.config.communities = entries.map((entry) => ({ ...entry }));
  }

  setContact(s: string): void { this.config.contact = s; }
  setLocation(s: string): void { this.config.location = s; }
  setTrapSourceInterface(iface: string | null): void { this.config.trapSourceInterface = iface; }

  /**
   * The source address a trap carries. Routing picks the egress
   * interface; `snmp-server trap-source` picks this, and it was read by
   * nobody — every trap went out with the egress interface's address,
   * so a collector filtering on a loopback saw none of them.
   */
  private trapSourceIp(): IPAddress | null {
    return this.config.trapSourceInterface
      ? this.host.getPort(this.config.trapSourceInterface)?.getIPAddress() ?? null
      : null;
  }

  addCommunity(
    community: string, access: 'ro' | 'rw', aclName?: string, viewName?: string,
  ): void {
    const existing = this.config.communities.find((c) => c.community === community);
    if (existing) {
      existing.access = access; existing.aclName = aclName; existing.viewName = viewName;
      return;
    }
    this.config.communities.push({ community, access, aclName, viewName });
  }

  setMibView(name: string, entries: readonly MibViewEntry[]): void {
    this.config.mibViews.set(name, [...entries]);
  }

  clearMibViews(): void { this.config.mibViews.clear(); }

  /**
   * Une communaute sans vue voit tout — c'est le defaut de VRP comme
   * d'IOS. Une communaute qui en NOMME une ne voit que ce que la vue
   * admet, et une vue qui n'existe pas n'admet rien : nommer une vue
   * absente est une restriction, pas une permission.
   */
  private communitySees(entry: SnmpCommunityAcl, oid: string): boolean {
    if (entry.interfaceNames && !this.interfaceRowVisible(entry.interfaceNames, oid)) return false;
    if (!entry.viewName) return true;
    return oidInMibView(oid, this.config.mibViews.get(entry.viewName) ?? []);
  }

  private interfaceRowVisible(visible: readonly string[], oid: string): boolean {
    const column = INTERFACE_COLUMNS.find((candidate) => oidStartsWith(oid, candidate.prefix));
    if (!column || oid === column.prefix) return true;
    const index = Number(oid.slice(column.prefix.length + 1));
    const entry = this.interfaceEntries().find((candidate) => candidate.index === index);
    return !entry || visible.includes(entry.port.getName());
  }

  private communityServes(entry: SnmpCommunityAcl, version: SnmpVersion, port: PortNumber): boolean {
    if (!entry.queryPorts) return port.value === UDP_PORT_SNMP;
    return entry.queryPorts[version]?.equals(port) ?? false;
  }

  private communityAdmits(entry: SnmpCommunityAcl, srcIp: IPAddress, inPort: string): boolean {
    if (!entry.aclName) return true;
    return this.host.evaluateAclPermit?.(entry.aclName, srcIp.toString(), inPort) ?? false;
  }

  removeCommunity(community: string): void {
    this.config.communities = this.config.communities.filter((c) => c.community !== community);
  }

  addTrapHost(ip: string, community: string, port = UDP_PORT_SNMP_TRAP): void {
    const existing = this.config.trapHosts.find((t) => t.ip === ip);
    if (existing) { existing.community = community; existing.port = port; return; }
    this.config.trapHosts.push({ ip, community, port });
  }

  removeTrapHost(ip: string): void {
    this.config.trapHosts = this.config.trapHosts.filter((t) => t.ip !== ip);
  }

  registerMib(oid: string, fn: () => SnmpValue): void {
    this.customMib.set(oid, fn);
  }

  handleUdp(inPort: string, srcIp: IPAddress, udp: UDPPacket, destinationIp: IPAddress): void {
    if (!this.running || !this.config.enabled) return;
    const payload = udp.payload as SnmpMessage | undefined;
    if (!payload || payload.type !== 'snmp') return;
    const senderIp = srcIp.toString();
    this.getBus().publish({
      topic: 'snmp.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp: senderIp, pduType: payload.pduType,
        ...(payload.pduType === 'trap-v1' ? {} : { requestId: payload.requestId }),
        community: payload.community,
      },
    });

    if (payload.pduType === 'get-response') {
      this.manager.accept(srcIp, PortNumber.of(udp.sourcePort), payload);
      return;
    }
    if (payload.pduType === 'get-request' || payload.pduType === 'get-next-request') {
      this.serveQuery(inPort, srcIp, udp.sourcePort, destinationIp, PortNumber.of(udp.destinationPort), payload);
    }
  }

  get(serverIp: string, community: string, oids: string[]): Promise<SnmpVarBinding[] | null> {
    return this.query(serverIp, community, 'get-request', oids);
  }

  getNext(serverIp: string, community: string, oids: string[]): Promise<SnmpVarBinding[] | null> {
    return this.query(serverIp, community, 'get-next-request', oids);
  }

  getLocalOidValue(oid: string): SnmpValue | null {
    return this.resolveOid(oid)?.value ?? null;
  }

  sendTrap(trapOid: string, varBindings: SnmpVarBinding[] = []): void {
    const source = this.trapSourceIp();
    for (const host of this.config.trapHosts) {
      this.notify({
        version: 'v2c', community: host.community, destination: new IPAddress(host.ip),
        destinationPort: PortNumber.of(host.port), sourcePort: PortNumber.of(UDP_PORT_SNMP),
        ...(source ? { source } : {}),
      }, { oid: trapOid, objects: varBindings });
    }
  }

  notify(target: SnmpNotificationTarget, notification: SnmpNotification): boolean {
    const packet = this.notificationPdu(target, notification);
    if (!packet) return false;
    const sent = this.transmitRouted(target.destination, target.source ?? null,
      target.destinationPort.value, target.sourcePort.value, packet, target.iface);
    if (!sent) return false;
    this.getBus().publish({
      topic: 'snmp.trap.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: target.destination.toString(), community: target.community,
        trapOid: notification.oid,
      },
    });
    return true;
  }

  interfaceIndexOf(name: string): number | null {
    return this.interfaceEntries().find((entry) => entry.port.getName() === name)?.index ?? null;
  }

  private notificationPdu(target: SnmpNotificationTarget, notification: SnmpNotification): SnmpMessage | null {
    if (target.version === 'v2c') {
      return trapV2Pdu(target.community, this.nextTrapRequestId++ & 0x7fffffff, this.uptimeTicks(), notification);
    }
    const agentAddress = target.source ?? this.host.sourceAddressFor?.(target.destination, target.iface) ?? null;
    return agentAddress === null ? null : trapV1Pdu(target.community, agentAddress, this.uptimeTicks(), notification);
  }

  private async query(
    serverIp: string, community: string, pduType: SnmpQueryPdu, oids: string[],
  ): Promise<SnmpVarBinding[] | null> {
    if (!this.running || !this.config.enabled) return null;
    const exchange = await this.manager.exchange(
      {
        server: new IPAddress(serverIp), port: PortNumber.of(UDP_PORT_SNMP),
        community, version: 'v2c', pduType, oids,
      },
      { timeoutMs: NMS_QUERY_TIMEOUT_MS, retries: 0 },
    );
    return exchange.kind === 'response' ? exchange.packet.varBindings.slice() : null;
  }

  private serveQuery(
    inPort: string, srcIp: IPAddress, requesterPort: number, destinationIp: IPAddress,
    destinationPort: PortNumber, request: SnmpPacket,
  ): void {
    const named = this.config.communities.filter((c) => c.community === request.community);
    if (named.length === 0) {
      this.getBus().publish({
        topic: 'snmp.auth.rejected',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          fromIp: srcIp.toString(), community: request.community,
          reason: 'unknown-community',
        },
      });
      return;
    }
    const acl = named.find((c) =>
      this.communityServes(c, request.version, destinationPort) && this.communityAdmits(c, srcIp, inPort));
    if (!acl) {
      this.getBus().publish({
        topic: 'snmp.auth.rejected',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          fromIp: srcIp.toString(), community: request.community,
          reason: 'acl-denied',
        },
      });
      return;
    }

    const answer = request.version === 'v1'
      ? this.answerV1(request, acl)
      : this.answerV2c(request, acl);
    const reply: SnmpPacket = {
      type: 'snmp', version: request.version, community: request.community,
      pduType: 'get-response',
      requestId: request.requestId,
      errorStatus: answer.errorStatus, errorIndex: answer.errorIndex,
      varBindings: answer.varBindings,
    };
    const replySource = this.replySource(inPort, destinationIp);
    if (!replySource) return;
    if (!this.transmitRouted(srcIp, replySource, requesterPort, destinationPort.value, reply)) return;
    this.getBus().publish({
      topic: 'snmp.request.served',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp: srcIp.toString(), pduType: request.pduType,
        requestId: request.requestId, errorStatus: answer.errorStatus,
        oidCount: answer.varBindings.length,
      },
    });
    Logger.info(this.host.id, 'snmp:reply',
      `${this.host.name}: ${request.pduType} req ${request.requestId} from ${srcIp} → ${answer.errorStatus}`);
  }

  private answerV2c(request: SnmpPacket, acl: SnmpCommunityAcl): SnmpAnswer {
    const visible = (oid: string): boolean => this.communitySees(acl, oid);
    const varBindings = request.varBindings.map((requested) => {
      if (request.pduType === 'get-next-request') {
        return this.resolveOidNext(requested.oid, (found) => visible(found.oid))
          ?? vb(requested.oid, v('end-of-mib-view', null));
      }
      return (visible(requested.oid) ? this.resolveOid(requested.oid) : null)
        ?? vb(requested.oid, v(this.absenceOf(requested.oid, visible), null));
    });
    return { errorStatus: 'no-error', errorIndex: 0, varBindings };
  }

  private answerV1(request: SnmpPacket, acl: SnmpCommunityAcl): SnmpAnswer {
    const representable = (found: SnmpVarBinding): boolean =>
      this.communitySees(acl, found.oid) && found.value.type !== 'counter64';
    const varBindings: SnmpVarBinding[] = [];
    for (let i = 0; i < request.varBindings.length; i++) {
      const requested = request.varBindings[i];
      const found = request.pduType === 'get-next-request'
        ? this.resolveOidNext(requested.oid, representable)
        : this.resolveOid(requested.oid);
      if (!found || !representable(found)) {
        return { errorStatus: 'no-such-name', errorIndex: i + 1, varBindings: request.varBindings.slice() };
      }
      varBindings.push(found);
    }
    return { errorStatus: 'no-error', errorIndex: 0, varBindings };
  }

  private absenceOf(oid: string, visible: (oid: string) => boolean): 'no-such-instance' | 'no-such-object' {
    const objectTypeExists = this.allKnownOids().some((known) =>
      visible(known) && oidStartsWith(oid, known.slice(0, known.lastIndexOf('.'))));
    return objectTypeExists ? 'no-such-instance' : 'no-such-object';
  }

  private replySource(inPort: string, destinationIp: IPAddress): IPAddress | null {
    const connected = this.host.getPorts().flatMap((port) => connectedPrefixesOfPort(port));
    const unicast = classifyIpv4Destination(destinationIp) === 'unicast'
      && !isDirectedBroadcast(destinationIp, connected);
    return unicast ? destinationIp : this.host.getPort(inPort)?.getIPAddress() ?? null;
  }

  private resolveOid(oid: string): SnmpVarBinding | null {
    const builtin = this.builtins().get(oid);
    if (builtin) return vb(oid, builtin());
    const custom = this.customMib.get(oid);
    if (custom) return vb(oid, custom());
    for (const entry of this.interfaceEntries()) {
      for (const column of INTERFACE_COLUMNS) {
        if (oid !== `${column.prefix}.${entry.index}`) continue;
        const value = column.value(entry);
        return value === null ? null : vb(oid, value);
      }
    }
    return null;
  }

  private interfaceEntries(): InterfaceEntry[] {
    return this.host.getPorts().map((port, position) => ({
      index: position + 1,
      port,
      row: this.host.describeInterface?.(port) ?? { descr: port.getName() },
    }));
  }

  private resolveOidNext(oid: string, admits: (found: SnmpVarBinding) => boolean): SnmpVarBinding | null {
    for (const candidate of this.allKnownOids()) {
      if (oidCompare(candidate, oid) <= 0) continue;
      const found = this.resolveOid(candidate);
      if (found && admits(found)) return found;
    }
    return null;
  }

  private allKnownOids(): string[] {
    const out = Array.from(this.builtins().keys());
    for (const k of this.customMib.keys()) out.push(k);
    for (const entry of this.interfaceEntries()) {
      for (const column of INTERFACE_COLUMNS) {
        if (column.value(entry) !== null) out.push(`${column.prefix}.${entry.index}`);
      }
    }
    out.sort(oidCompare);
    return out;
  }

  private builtins(): Map<string, () => SnmpValue> {
    const m = new Map<string, () => SnmpValue>();
    m.set(OID_SYS_DESCR, () => v('octet-string', this.host.getSysDescr()));
    m.set(OID_SYS_OBJECT_ID, () => v('object-id', this.host.getSysObjectId()));
    m.set(OID_SYS_UPTIME, () => v('timeticks', this.uptimeTicks()));
    m.set(OID_SYS_CONTACT, () => v('octet-string', this.config.contact));
    m.set(OID_SYS_NAME, () => v('octet-string', this.host.getHostname()));
    m.set(OID_SYS_LOCATION, () => v('octet-string', this.config.location));
    m.set(OID_SYS_SERVICES, () => v('integer', 78));
    m.set(OID_IF_NUMBER, () => v('integer', this.host.getPorts().length));
    return m;
  }

  uptimeTicks(): number {
    return Math.floor((this.getScheduler().now() - this.startedAtMs) / 10);
  }

  private transmitRouted(dstIp: IPAddress, srcIp: IPAddress | null, dstPort: number,
                         srcPort: number, payload: SnmpMessage, iface?: string): boolean {
    const datagram: UdpSendRequest = {
      destination: dstIp,
      destinationPort: dstPort,
      sourcePort: srcPort,
      payload,
      payloadBytes: 48 + payload.varBindings.length * 16,
      ...(srcIp ? { source: srcIp } : {}),
      ...(iface ? { iface } : {}),
    };
    if (!this.host.sendUdpDatagram(datagram)) return false;
    this.annoncerEmission(dstIp, payload);
    return true;
  }

  private annoncerEmission(dstIp: IPAddress, payload: SnmpMessage): void {
    this.getBus().publish({
      topic: 'snmp.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: dstIp.toString(), pduType: payload.pduType,
        ...(payload.pduType === 'trap-v1' ? {} : { requestId: payload.requestId }),
        community: payload.community,
      },
    });
  }

}
