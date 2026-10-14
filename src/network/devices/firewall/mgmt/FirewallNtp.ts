import { NtpAgent, type NtpHost } from '../../../ntp/NtpAgent';
import type { UdpSendRequest } from '../../../layers/transport/UdpEgress';
import type { IEventBus } from '../../../../events/EventBus';
import { IP_PROTO_UDP, type EthernetFrame, type IPv4Packet, type UDPPacket } from '../../../core/types';
import { UDP_PORT_NTP } from '../../../ntp/types';
import { isValidIPv4 } from '../../../core/ip';
import type { Port } from '../../../hardware/Port';

export type NtpKeyType = 'MD5' | 'SHA1' | 'SHA256';
export type NtpIpType = 'IPv4' | 'IPv6' | 'Both';
export type NtpInterfaceSelectMethod = 'auto' | 'sdwan' | 'specify';

export interface NtpServerSetting {
  readonly id: number;
  readonly server: string;
  readonly authentication: boolean;
  readonly keyId: number;
  readonly key: string;
  readonly keyType: NtpKeyType;
  readonly ntpv3: boolean;
  readonly interface: string;
  readonly interfaceSelectMethod: NtpInterfaceSelectMethod;
  readonly ipType: NtpIpType;
  readonly vrf: number;
}

export interface NtpSettings {
  readonly enabled: boolean;
  readonly servers: readonly string[];
  readonly serverEntries: readonly NtpServerSetting[];
  readonly syncIntervalMin: number;
  readonly sourceInterface: string;
  readonly sourceIp: string;
  readonly sourceIp6: string;
  readonly serverMode: boolean;
  readonly serverInterfaces: readonly string[];
  readonly authentication: boolean;
  readonly keyId: number;
  readonly key: string;
  readonly keyType: NtpKeyType;
}

export const NTP_DEFAULTS: NtpSettings = Object.freeze({
  enabled: false,
  servers: Object.freeze([]),
  serverEntries: Object.freeze([]),
  syncIntervalMin: 60,
  sourceInterface: '',
  sourceIp: '0.0.0.0',
  sourceIp6: '::',
  serverMode: false,
  serverInterfaces: Object.freeze([]),
  authentication: false,
  keyId: 0,
  key: '',
  keyType: 'MD5' as NtpKeyType,
});

export type NtpWiringContext = NtpHost & { vrfs?(): readonly number[] };

export class FirewallNtp {
  private readonly agent: NtpAgent;
  private settings: NtpSettings = NTP_DEFAULTS;

  constructor(private readonly host: NtpWiringContext, bus: () => IEventBus) {
    this.agent = new NtpAgent(host, bus);
  }

  getAgent(): NtpAgent { return this.agent; }

  getSettings(): NtpSettings { return this.settings; }

  observe(iface: string, packet: IPv4Packet): boolean {
    const udp = packet.payload as UDPPacket | undefined;
    if (packet.protocol !== IP_PROTO_UDP || udp?.type !== 'udp') return false;
    const fromServer = udp.sourcePort === UDP_PORT_NTP && this.agent.getAssociation(packet.sourceIP.toString()) !== undefined;
    const toServer = udp.destinationPort === UDP_PORT_NTP && this.settings.serverMode;
    if (!this.settings.enabled && !toServer) return false;
    if (!fromServer && !toServer) return false;
    this.agent.handleUdp(iface, packet.sourceIP, udp, packet.destinationIP);
    return true;
  }

  apply(settings: NtpSettings): string | undefined {
    this.settings = settings;
    const agent = this.agent;
    for (const address of [...agent.getConfig().associations.keys()]) agent.removeServer(address);
    for (const id of [...agent.getConfig().authKeys.keys()]) {
      agent.removeAuthKey(id);
      agent.removeTrustedKey(id);
    }
    agent.setAuthenticate(false);
    agent.setSourceInterface(settings.sourceInterface);
    agent.setSourceAddress(settings.sourceIp);
    const vrfs = this.host.vrfs?.() ?? [0];
    for (const entry of settings.serverEntries) {
      if (!this.reachable(entry, vrfs)) continue;
      const keyed = entry.authentication && entry.key.length > 0;
      if (keyed) {
        agent.addAuthKey(entry.keyId, entry.keyType, entry.key);
        agent.addTrustedKey(entry.keyId);
        agent.setAuthenticate(true);
      }
      const specify = entry.interfaceSelectMethod === 'specify' && entry.interface.length > 0;
      agent.addServer(entry.server, false, keyed ? entry.keyId : undefined, 'ntp', {
        version: entry.ntpv3 ? 3 : 4,
        iburst: true,
        ...(specify ? { sourceInterface: entry.interface } : {}),
      });
      agent.setSourceCriteria(entry.server, { fixedPollSec: settings.syncIntervalMin * 60 });
    }
    agent.setServingInterfaces(settings.serverMode ? new Set(settings.serverInterfaces) : new Set());
    const requireKey = settings.serverMode && settings.authentication && settings.key.length > 0;
    if (requireKey) {
      agent.addAuthKey(settings.keyId, settings.keyType, settings.key);
      agent.addTrustedKey(settings.keyId);
      agent.setAuthenticate(true);
    }
    agent.setRequireRequestAuthentication(requireKey);
    agent.setEnabled(settings.enabled || settings.serverMode);
    if (settings.enabled || settings.serverMode) agent.start(); else agent.stop();
    return undefined;
  }

  private reachable(entry: NtpServerSetting, vrfs: readonly number[]): boolean {
    if (!vrfs.includes(entry.vrf)) return false;
    const isV4 = isValidIPv4(entry.server);
    if (isV4 && entry.ipType === 'IPv6') return false;
    return isV4;
  }
}

export interface NtpWiringHost {
  readonly deviceId: string;
  readonly deviceName: string;
  hostname(): string;
  port(name: string): Port | undefined;
  ports(): Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  sendUdpDatagram(request: UdpSendRequest): boolean;
  vrfs?(): readonly number[];
  bus(): IEventBus;
}

export function buildFirewallNtp(host: NtpWiringHost): FirewallNtp {
  return new FirewallNtp({
    id: host.deviceId,
    name: host.deviceName,
    getHostname: () => host.hostname(),
    getPort: (name) => host.port(name),
    getPorts: () => host.ports(),
    sendUdpDatagram: (request) => host.sendUdpDatagram(request),
    sendFrame: (portName, frame) => { host.sendFrame(portName, frame); },
    vrfs: () => host.vrfs?.() ?? [0],
  }, () => host.bus());
}
