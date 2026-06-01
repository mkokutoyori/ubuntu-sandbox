import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
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
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
  IP_PROTO_UDP, ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';
import { Logger } from '../core/Logger';

export interface SnmpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  getSysDescr(): string;
  getSysObjectId(): string;
}

interface PendingRequest {
  requestId: number;
  serverIp: string;
  resolve: (vbs: SnmpVarBinding[] | null) => void;
  timer: TimerHandle | null;
}

export class SnmpAgent {
  private config: SnmpAgentConfig = createDefaultAgentConfig();
  private startedAtMs = Date.now();
  private pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private scheduler: IScheduler | null = null;
  private running = false;
  private customMib = new Map<string, () => SnmpValue>();

  constructor(
    private readonly host: SnmpHost,
    private readonly getBus: () => IEventBus,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAtMs = Date.now();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const p of this.pending.values()) {
      if (p.timer !== null) (this.scheduler ?? this.getScheduler()).clear(p.timer);
      p.resolve(null);
    }
    this.pending.clear();
  }

  getConfig(): Readonly<SnmpAgentConfig> { return this.config; }

  setContact(s: string): void { this.config.contact = s; }
  setLocation(s: string): void { this.config.location = s; }

  addCommunity(community: string, access: 'ro' | 'rw'): void {
    const existing = this.config.communities.find((c) => c.community === community);
    if (existing) { existing.access = access; return; }
    this.config.communities.push({ community, access });
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

  handleUdp(inPort: string, srcIp: IPAddress, udp: UDPPacket): void {
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
      this.deliverResponse(senderIp, payload);
      return;
    }
    if (payload.pduType === 'get-request' || payload.pduType === 'get-next-request') {
      this.serveQuery(inPort, srcIp, payload);
      return;
    }
  }

  get(serverIp: string, community: string, oids: string[]): Promise<SnmpVarBinding[] | null> {
    return this.sendRequest(serverIp, community, 'get-request', oids);
  }

  getNext(serverIp: string, community: string, oids: string[]): Promise<SnmpVarBinding[] | null> {
    return this.sendRequest(serverIp, community, 'get-next-request', oids);
  }

  sendTrap(trapOid: string, varBindings: SnmpVarBinding[] = []): void {
    for (const t of this.config.trapHosts) {
      const egress = this.resolveEgress(t.ip);
      if (!egress) continue;
      const srcIp = egress.port.getIPAddress();
      if (!srcIp) continue;
      const standard: SnmpVarBinding[] = [
        vb('1.3.6.1.2.1.1.3.0', v('timeticks', this.uptimeTicks())),
        vb('1.3.6.1.6.3.1.1.4.1.0', v('object-id', trapOid)),
        ...varBindings,
      ];
      const payload: SnmpPacket = {
        type: 'snmp', version: 'v2c',
        community: t.community,
        pduType: 'trap-v2',
        requestId: this.nextRequestId++ & 0x7fffffff,
        errorStatus: 'no-error', errorIndex: 0,
        varBindings: standard,
      };
      this.transmit(egress.name, egress.port, new IPAddress(t.ip), srcIp, t.port, payload);
      this.getBus().publish({
        topic: 'snmp.trap.sent',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          destinationIp: t.ip, community: t.community, trapOid,
        },
      });
    }
  }

  private sendRequest(serverIp: string, community: string, pduType: 'get-request' | 'get-next-request', oids: string[]): Promise<SnmpVarBinding[] | null> {
    if (!this.running || !this.config.enabled) return Promise.resolve(null);
    const egress = this.resolveEgress(serverIp);
    if (!egress) return Promise.resolve(null);
    const srcIp = egress.port.getIPAddress();
    if (!srcIp) return Promise.resolve(null);
    const requestId = this.nextRequestId++ & 0x7fffffff;
    const payload: SnmpPacket = {
      type: 'snmp', version: 'v2c', community,
      pduType, requestId,
      errorStatus: 'no-error', errorIndex: 0,
      varBindings: oids.map((o) => vb(o, v('null', null))),
    };
    return new Promise<SnmpVarBinding[] | null>((resolve) => {
      const pending: PendingRequest = { requestId, serverIp, resolve, timer: null };
      this.pending.set(requestId, pending);
      this.transmit(egress.name, egress.port, new IPAddress(serverIp), srcIp,
                    UDP_PORT_SNMP, payload);
      const s = this.getScheduler();
      this.scheduler = s;
      pending.timer = s.setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          resolve(null);
        }
      }, 5000);
    });
  }

  private deliverResponse(senderIp: string, payload: SnmpPacket): void {
    const pending = this.pending.get(payload.requestId);
    if (!pending || pending.serverIp !== senderIp) return;
    if (pending.timer !== null) (this.scheduler ?? this.getScheduler()).clear(pending.timer);
    this.pending.delete(payload.requestId);
    pending.resolve(payload.varBindings.slice());
  }

  private serveQuery(inPort: string, srcIp: IPAddress, request: SnmpPacket): void {
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

    let errorStatus: SnmpErrorStatus = 'no-error';
    let errorIndex = 0;
    const replyVbs: SnmpVarBinding[] = [];
    for (let i = 0; i < request.varBindings.length; i++) {
      const reqVb = request.varBindings[i];
      let resolved: SnmpVarBinding | null;
      if (request.pduType === 'get-request') {
        resolved = this.resolveOid(reqVb.oid);
        if (!resolved) {
          resolved = vb(reqVb.oid, v('no-such-object', null));
          if (errorStatus === 'no-error') { errorStatus = 'no-such-name'; errorIndex = i + 1; }
        }
      } else {
        resolved = this.resolveOidNext(reqVb.oid);
        if (!resolved) {
          resolved = vb(reqVb.oid, v('end-of-mib-view', null));
        }
      }
      replyVbs.push(resolved);
    }

    const reply: SnmpPacket = {
      type: 'snmp', version: 'v2c', community: request.community,
      pduType: 'get-response',
      requestId: request.requestId, errorStatus, errorIndex,
      varBindings: replyVbs,
    };
    const port = this.host.getPort(inPort);
    if (!port) return;
    const replySrc = port.getIPAddress();
    if (!replySrc) return;
    this.transmit(inPort, port, srcIp, replySrc, UDP_PORT_SNMP, reply);
    this.getBus().publish({
      topic: 'snmp.request.served',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp: srcIp.toString(), pduType: request.pduType,
        requestId: request.requestId, errorStatus, oidCount: replyVbs.length,
      },
    });
    Logger.info(this.host.id, 'snmp:reply',
      `${this.host.name}: ${request.pduType} req ${request.requestId} from ${srcIp} → ${errorStatus}`);
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
      if (oid === `${OID_IF_PHYS_ADDR_PREFIX}.${i}`) return vb(oid, v('octet-string', port.getMAC().toString()));
      if (oid === `${OID_IF_ADMIN_STATUS_PREFIX}.${i}`) return vb(oid, v('integer', port.getIsUp() ? 1 : 2));
      if (oid === `${OID_IF_OPER_STATUS_PREFIX}.${i}`) return vb(oid, v('integer', port.getIsUp() && port.isConnected() ? 1 : 2));
    }
    return null;
  }

  private resolveOidNext(oid: string): SnmpVarBinding | null {
    const known = this.allKnownOids();
    let best: string | null = null;
    for (const k of known) {
      if (oidCompare(k, oid) <= 0) continue;
      if (best === null || oidCompare(k, best) < 0) best = k;
    }
    if (!best) return null;
    return this.resolveOid(best);
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

  private transmit(portName: string, port: import('../hardware/Port').Port,
                   dstIp: IPAddress, srcIp: IPAddress, dstPort: number,
                   payload: SnmpPacket): void {
    const udp: UDPPacket = {
      type: 'udp',
      sourcePort: dstPort === UDP_PORT_SNMP ? 49152 + (payload.requestId & 0x3fff) : UDP_PORT_SNMP,
      destinationPort: dstPort,
      length: 8 + 48 + payload.varBindings.length * 16,
      checksum: 0, payload,
    };
    const ipPkt: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0,
      totalLength: 20 + udp.length,
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 64, protocol: IP_PROTO_UDP, headerChecksum: 0,
      sourceIP: srcIp, destinationIP: dstIp,
      payload: udp,
    };
    ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
    const eth: EthernetFrame = {
      srcMAC: port.getMAC(),
      dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    };
    this.host.sendFrame(portName, eth);
    this.getBus().publish({
      topic: 'snmp.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: dstIp.toString(), pduType: payload.pduType,
        requestId: payload.requestId, community: payload.community,
      },
    });
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
