import { oidInMibView, type MibViewEntry } from './mibView';
import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import {
  type SnmpAgentConfig, type SnmpPacket, type SnmpVarBinding, type SnmpValue,
  type SnmpCommunityAcl, type SnmpTrapHost, type SnmpErrorStatus,
  createDefaultAgentConfig, v, vb, oidCompare, oidStartsWith,
  UDP_PORT_SNMP, UDP_PORT_SNMP_TRAP,
  OID_SYS_DESCR, OID_SYS_OBJECT_ID, OID_SYS_UPTIME,
  OID_SYS_CONTACT, OID_SYS_NAME, OID_SYS_LOCATION, OID_SYS_SERVICES,
  OID_IF_NUMBER, OID_IF_INDEX_PREFIX, OID_IF_DESCR_PREFIX,
  OID_IF_TYPE_PREFIX, OID_IF_MTU_PREFIX, OID_IF_PHYS_ADDR_PREFIX,
  OID_IF_ADMIN_STATUS_PREFIX, OID_IF_OPER_STATUS_PREFIX,
} from './types';
import {
  IPAddress,
  type EthernetFrame, type UDPPacket,
} from '../core/types';
import { Logger } from '../core/Logger';
import type { UdpSendRequest } from '../layers/transport/UdpEgress';
import {
  classifyIpv4Destination, connectedPrefixesOfPort, isDirectedBroadcast,
} from '../layers/internet/InternetLayer';
import { SnmpManager, type SnmpQueryPdu } from './SnmpManager';
import { PortNumber } from '../core/ports/PortNumber';

export interface SnmpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  getSysDescr(): string;
  getSysObjectId(): string;
  sendUdpDatagram(request: UdpSendRequest): boolean;
  evaluateAclPermit?(aclName: string, sourceIp: string): boolean;
}

interface SnmpAnswer {
  readonly errorStatus: SnmpErrorStatus;
  readonly errorIndex: number;
  readonly varBindings: SnmpVarBinding[];
}

const NMS_QUERY_TIMEOUT_MS = 5000;

export class SnmpAgent {
  private config: SnmpAgentConfig = createDefaultAgentConfig();
  private startedAtMs = Date.now();
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
    );
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAtMs = Date.now();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.manager.abandonAll();
  }

  getConfig(): Readonly<SnmpAgentConfig> { return this.config; }

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
    if (!entry.viewName) return true;
    return oidInMibView(oid, this.config.mibViews.get(entry.viewName) ?? []);
  }

  private communityAdmits(entry: SnmpCommunityAcl, srcIp: IPAddress): boolean {
    if (!entry.aclName) return true;
    return this.host.evaluateAclPermit?.(entry.aclName, srcIp.toString()) ?? false;
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
    const payload = udp.payload as SnmpPacket | undefined;
    if (!payload || payload.type !== 'snmp') return;
    const senderIp = srcIp.toString();
    this.getBus().publish({
      topic: 'snmp.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp: senderIp, pduType: payload.pduType,
        requestId: payload.requestId, community: payload.community,
      },
    });

    if (payload.pduType === 'get-response') {
      this.manager.accept(srcIp, PortNumber.of(udp.sourcePort), payload);
      return;
    }
    if ((payload.pduType === 'get-request' || payload.pduType === 'get-next-request')
      && udp.destinationPort === UDP_PORT_SNMP) {
      this.serveQuery(inPort, srcIp, udp.sourcePort, destinationIp, payload);
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
    for (const t of this.config.trapHosts) {
      const srcIp = this.trapSourceIp();
      const standard: SnmpVarBinding[] = [
        vb('1.3.6.1.2.1.1.3.0', v('timeticks', this.uptimeTicks())),
        vb('1.3.6.1.6.3.1.1.4.1.0', v('object-id', trapOid)),
        ...varBindings,
      ];
      const payload: SnmpPacket = {
        type: 'snmp', version: 'v2c',
        community: t.community,
        pduType: 'trap-v2',
        requestId: this.nextTrapRequestId++ & 0x7fffffff,
        errorStatus: 'no-error', errorIndex: 0,
        varBindings: standard,
      };
      this.transmitRouted(new IPAddress(t.ip), srcIp, t.port, UDP_PORT_SNMP, payload);
      this.getBus().publish({
        topic: 'snmp.trap.sent',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          destinationIp: t.ip, community: t.community, trapOid,
        },
      });
    }
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
    request: SnmpPacket,
  ): void {
    const acl = this.config.communities.find((c) => c.community === request.community);
    if (!acl) {
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
    if (!this.communityAdmits(acl, srcIp)) {
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
    if (!this.transmitRouted(srcIp, replySource, requesterPort, UDP_PORT_SNMP, reply)) return;
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
    for (let i = 1; i <= this.host.getPorts().length; i++) {
      const port = this.host.getPorts()[i - 1];
      if (oid === `${OID_IF_INDEX_PREFIX}.${i}`) return vb(oid, v('integer', i));
      if (oid === `${OID_IF_DESCR_PREFIX}.${i}`) return vb(oid, v('octet-string', port.getName()));
      if (oid === `${OID_IF_TYPE_PREFIX}.${i}`) return vb(oid, v('integer', 6));
      if (oid === `${OID_IF_MTU_PREFIX}.${i}`) return vb(oid, v('integer', 1500));
      if (oid === `${OID_IF_PHYS_ADDR_PREFIX}.${i}`) return vb(oid, v('octet-string', Uint8Array.from(port.getMAC().getOctets())));
      if (oid === `${OID_IF_ADMIN_STATUS_PREFIX}.${i}`) return vb(oid, v('integer', port.getIsUp() ? 1 : 2));
      if (oid === `${OID_IF_OPER_STATUS_PREFIX}.${i}`) return vb(oid, v('integer', port.getIsUp() && port.isConnected() ? 1 : 2));
    }
    return null;
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
    const ports = this.host.getPorts();
    for (let i = 1; i <= ports.length; i++) {
      out.push(`${OID_IF_INDEX_PREFIX}.${i}`);
      out.push(`${OID_IF_DESCR_PREFIX}.${i}`);
      out.push(`${OID_IF_TYPE_PREFIX}.${i}`);
      out.push(`${OID_IF_MTU_PREFIX}.${i}`);
      out.push(`${OID_IF_PHYS_ADDR_PREFIX}.${i}`);
      out.push(`${OID_IF_ADMIN_STATUS_PREFIX}.${i}`);
      out.push(`${OID_IF_OPER_STATUS_PREFIX}.${i}`);
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

  private uptimeTicks(): number {
    return Math.floor((Date.now() - this.startedAtMs) / 10);
  }

  private transmitRouted(dstIp: IPAddress, srcIp: IPAddress | null, dstPort: number,
                         srcPort: number, payload: SnmpPacket): boolean {
    const datagram: UdpSendRequest = {
      destination: dstIp,
      destinationPort: dstPort,
      sourcePort: srcPort,
      payload,
      payloadBytes: 48 + payload.varBindings.length * 16,
      ...(srcIp ? { source: srcIp } : {}),
    };
    if (!this.host.sendUdpDatagram(datagram)) return false;
    this.annoncerEmission(dstIp, payload);
    return true;
  }

  private annoncerEmission(dstIp: IPAddress, payload: SnmpPacket): void {
    this.getBus().publish({
      topic: 'snmp.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: dstIp.toString(), pduType: payload.pduType,
        requestId: payload.requestId, community: payload.community,
      },
    });
  }

}
