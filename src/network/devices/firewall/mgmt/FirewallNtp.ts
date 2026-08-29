import { NtpAgent, type NtpHost } from '../../../ntp/NtpAgent';
import type { IPv4Packet, IPAddress } from '../../../core/types';
import type { IEventBus } from '../../../../events/EventBus';
import type { EthernetFrame } from '../../../core/types';
import type { Port } from '../../../hardware/Port';

export interface NtpSettings {
  readonly enabled: boolean;
  readonly servers: readonly string[];
  readonly syncIntervalMin: number;
  readonly sourceInterface: string;
}

export const NTP_DEFAULTS: NtpSettings = Object.freeze({
  enabled: false,
  servers: Object.freeze([]),
  syncIntervalMin: 60,
  sourceInterface: '',
});

export class FirewallNtp {
  private readonly agent: NtpAgent;
  private settings: NtpSettings = NTP_DEFAULTS;

  constructor(host: NtpHost, bus: () => IEventBus) {
    this.agent = new NtpAgent(host, bus);
  }

  getAgent(): NtpAgent { return this.agent; }

  getSettings(): NtpSettings { return this.settings; }

  apply(settings: NtpSettings): string | undefined {
    this.settings = settings;

    for (const address of [...this.agent.getConfig().associations.keys()]) {
      this.agent.removeServer(address);
    }
    for (const server of settings.servers) this.agent.addServer(server);
    if (settings.sourceInterface.length > 0) {
      this.agent.setSourceInterface(settings.sourceInterface);
    }

    this.agent.setEnabled(settings.enabled);
    if (settings.enabled) this.agent.start(); else this.agent.stop();
    return undefined;
  }
}

export interface NtpWiringHost {
  readonly deviceId: string;
  readonly deviceName: string;
  hostname(): string;
  port(name: string): Port | undefined;
  ports(): Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  sendArpAware(portName: string, ipPkt: IPv4Packet, nextHopIP: IPAddress): void;
  bus(): IEventBus;
}

export function buildFirewallNtp(host: NtpWiringHost): FirewallNtp {
  return new FirewallNtp({
    id: host.deviceId,
    name: host.deviceName,
    getHostname: () => host.hostname(),
    getPort: (name) => host.port(name),
    getPorts: () => host.ports(),
    sendIpv4FrameArpAware: (p, ipPkt, nextHopIP) => host.sendArpAware(p, ipPkt, nextHopIP),
    sendFrame: (portName, frame) => { host.sendFrame(portName, frame); },
  }, () => host.bus());
}
