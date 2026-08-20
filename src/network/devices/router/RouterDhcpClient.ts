import { DHCPClient } from '@/network/dhcp/DHCPClient';
import { WireDhcpChannel } from '@/network/dhcp/DhcpServerChannel';
import type { DHCPPacket } from '@/network/dhcp/DHCPPacket';
import type { DHCPClientLease } from '@/network/dhcp/types';
import type { IEventBus } from '@/events/EventBus';

export interface RouterDhcpHost {
  macOf(iface: string): string;
  linkUsable(iface: string): boolean;
  applyLease(iface: string, ip: string, mask: string, gateway: string | null): void;
  clearLease(iface: string): void;
  sendDhcpFrame(iface: string, pkt: DHCPPacket): void;
  markClient(iface: string, on: boolean): void;
  bus(): IEventBus | null;
  identity(): { deviceId: string; hostname: string };
}

export class RouterDhcpClient {
  private readonly client: DHCPClient;
  private readonly channels = new Map<string, WireDhcpChannel>();
  private readonly configured = new Map<string, string>();

  constructor(private readonly host: RouterDhcpHost) {
    this.client = new DHCPClient(
      (iface) => this.host.macOf(iface),
      (iface, ip, mask, gateway) => this.host.applyLease(iface, ip, mask, gateway),
      (iface) => this.host.clearLease(iface),
    );
    this.client.setWireChannelFactory((iface) => this.channel(iface));
    const bus = this.host.bus();
    if (bus) this.client.setEventBus(bus);
    const who = this.host.identity();
    this.client.setDeviceId(who.deviceId, who.hostname);
  }

  private channel(iface: string): WireDhcpChannel {
    let channel = this.channels.get(iface);
    if (!channel) {
      channel = new WireDhcpChannel(iface, (i, pkt) => this.host.sendDhcpFrame(i, pkt));
      this.channels.set(iface, channel);
    }
    return channel;
  }

  enable(iface: string, ligne: string): void {
    this.configured.set(iface, ligne);
    this.host.markClient(iface, true);
    this.request(iface);
  }

  disable(iface: string): boolean {
    this.host.markClient(iface, false);
    if (!this.configured.delete(iface)) return false;
    if (this.client.getState(iface).lease) this.client.releaseLease(iface);
    else this.host.clearLease(iface);
    this.client.getState(iface).lastKnownLease = null;
    return true;
  }

  isEnabled(iface: string): boolean { return this.configured.has(iface); }

  configuredLine(iface: string): string | null {
    return this.configured.get(iface) ?? null;
  }

  enabledInterfaces(): string[] {
    return [...this.configured.keys()].sort();
  }

  lease(iface: string): DHCPClientLease | null {
    return this.client.getState(iface).lease;
  }

  leases(): DHCPClientLease[] {
    return this.enabledInterfaces()
      .map(i => this.client.getState(i).lease)
      .filter((l): l is DHCPClientLease => l !== null);
  }

  request(iface: string): boolean {
    if (!this.configured.has(iface)) return false;
    if (!this.host.linkUsable(iface)) return false;
    if (this.client.getState(iface).lease) return true;
    this.client.requestLease(iface, { timeout: 5 });
    return this.client.getState(iface).lease !== null;
  }

  release(iface: string): boolean {
    if (!this.configured.has(iface) || !this.client.getState(iface).lease) return false;
    this.client.releaseLease(iface);
    this.client.getState(iface).lastKnownLease = null;
    return true;
  }

  renew(iface: string): boolean {
    if (!this.configured.has(iface)) return false;
    return this.request(iface);
  }

  onLinkUp(iface: string): void { this.request(iface); }

  onLinkDown(iface: string): void {
    if (!this.configured.has(iface)) return;
    const state = this.client.getState(iface);
    state.lease = null;
    state.lastKnownLease = null;
    state.state = 'INIT';
    this.host.clearLease(iface);
  }

  deliver(iface: string, pkt: DHCPPacket, mac?: string): void {
    this.channels.get(iface)?.deliver(pkt, mac);
  }
}
