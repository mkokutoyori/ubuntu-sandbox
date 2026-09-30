import { dhcpv6WireLength } from './Dhcpv6Codec';
import { IPv6Address } from '../core/types';
import type { EndHost, UdpDelivery } from '../devices/EndHost';
import { DHCPv6Packet } from './DHCPv6Packet';
import { startReconfigure } from './Dhcpv6Reconfigure';
import { DHCPv6Server } from './DHCPv6Server';
import { answerRelayForward, buildDhcpv6ServerReply } from './Dhcpv6ServerExchange';

export const DHCPV6_SERVER_PORT = 547;
export const DHCPV6_CLIENT_PORT = 546;
export const ALL_DHCP_SERVERS_GROUP = 'ff02::1:2';

export interface Dhcpv6HostPort {
  interfaces(): ReadonlyArray<{ name: string; mac: string; globalAddress: string | null }>;
  udpBind(port: number, listener: (delivery: UdpDelivery) => void, processName: string): number | false;
  udpClose(port: number): void;
  joinIPv6Group(iface: string, group: string): boolean;
  leaveIPv6Group(iface: string, group: string): boolean;
  learnIpv6Neighbor(iface: string, address: IPv6Address, mac: string): void;
  schedule(callback: () => void, delayMs: number): number;
  sendUdpDatagram6OnLink(iface: string, destination: IPv6Address, destinationPort: number, sourcePort: number, payload: unknown, payloadBytes: number): boolean;
  sendUdpDatagram6(destination: IPv6Address, destinationPort: number, sourcePort: number, payload: unknown, payloadBytes: number): boolean;
}

export class Dhcpv6HostService {
  private readonly server = new DHCPv6Server();
  private running = false;

  private onReply: ((request: DHCPv6Packet, reply: DHCPv6Packet) => void) | null = null;

  constructor(private readonly host: Dhcpv6HostPort, private readonly processName: string, clock?: () => number) {
    if (clock) this.server.setClock(clock);
  }

  observeReplies(observer: (request: DHCPv6Packet, reply: DHCPv6Packet) => void): void { this.onReply = observer; }

  servedInterfaces: ReadonlySet<string> | null = null;

  getEngine(): DHCPv6Server { return this.server; }

  isRunning(): boolean { return this.running; }

  start(): boolean {
    if (this.running) return true;
    const interfaces = this.host.interfaces();
    if (interfaces.length > 0) this.server.setServerDuid(`00:03:00:01:${interfaces[0].mac}`);
    if (this.host.udpBind(DHCPV6_SERVER_PORT, this.handle, this.processName) === false) return false;
    for (const port of interfaces) this.host.joinIPv6Group(port.name, ALL_DHCP_SERVERS_GROUP);
    this.server.enable();
    this.running = true;
    return true;
  }

  stop(): void {
    if (!this.running) return;
    for (const port of this.host.interfaces()) this.host.leaveIPv6Group(port.name, ALL_DHCP_SERVERS_GROUP);
    this.host.udpClose(DHCPV6_SERVER_PORT);
    this.server.disable();
    this.running = false;
  }

  private readonly handle = (delivery: UdpDelivery): void => {
    if (!this.running || !(delivery.sourceIP instanceof IPv6Address)) return;
    if (this.servedInterfaces && !this.servedInterfaces.has(delivery.inPort)) return;
    const message = delivery.udp.payload;
    if (!(message instanceof DHCPv6Packet)) return;
    if (delivery.sourceMAC) this.host.learnIpv6Neighbor(delivery.inPort, delivery.sourceIP, delivery.sourceMAC);

    if (message.msgType === 'RELAY-FORW') {
      const answer = answerRelayForward(this.server, message, delivery.sourceIP.toString());
      if (answer) this.send(delivery.sourceIP, DHCPV6_SERVER_PORT, answer);
      return;
    }
    const port = this.host.interfaces().find(entry => entry.name === delivery.inPort);
    const reply = buildDhcpv6ServerReply(this.server, message, {
      anchor: port?.globalAddress ?? undefined,
      clientAddress: delivery.sourceIP.toString(),
      clientInterface: delivery.inPort,
      destination: delivery.destinationIP.toString(),
      relayed: false,
      unicast: !(delivery.destinationIP instanceof IPv6Address && delivery.destinationIP.isMulticast()),
    });
    if (!reply) return;
    this.host.sendUdpDatagram6OnLink(delivery.inPort, delivery.sourceIP, DHCPV6_CLIENT_PORT, DHCPV6_SERVER_PORT, reply, dhcpv6WireLength(reply));
    this.onReply?.(message, reply);
  };

  sendReconfigure(clientDuid: string, msgType: 'RENEW' | 'REBIND' | 'INFORMATION-REQUEST'): boolean {
    if (!this.running) return false;
    return startReconfigure(this.server, clientDuid, msgType, ({ message, route }) => {
      if (route.kind === 'relay') this.send(new IPv6Address(route.relay), DHCPV6_SERVER_PORT, message);
      else this.host.sendUdpDatagram6OnLink(route.iface, new IPv6Address(route.address), DHCPV6_CLIENT_PORT, DHCPV6_SERVER_PORT, message, dhcpv6WireLength(message));
    }, { setTimeout: (callback, delay) => this.host.schedule(callback, delay) });
  }

  private send(destination: IPv6Address, destinationPort: number, message: DHCPv6Packet): void {
    this.host.sendUdpDatagram6(destination, destinationPort, DHCPV6_SERVER_PORT, message, dhcpv6WireLength(message));
  }
}

export function dhcpv6PortOf(host: EndHost): Dhcpv6HostPort {
  return {
    interfaces: () => host.getPorts().map(port => ({
      name: port.getName(), mac: port.getMAC().toString(), globalAddress: port.getGlobalIPv6()?.toString() ?? null,
    })),
    schedule: (callback, delayMs) => host.scheduleTimer(callback, delayMs),
    udpBind: (port, listener, processName) => host.udpBind(port, listener, processName),
    udpClose: port => host.udpClose(port),
    joinIPv6Group: (iface, group) => host.joinIPv6Group(iface, group),
    leaveIPv6Group: (iface, group) => host.leaveIPv6Group(iface, group),
    learnIpv6Neighbor: (iface, address, mac) => host.learnIpv6Neighbor(iface, address, mac),
    sendUdpDatagram6OnLink: (iface, destination, destinationPort, sourcePort, payload, bytes) =>
      host.sendUdpDatagram6OnLink(iface, destination, destinationPort, sourcePort, payload, bytes),
    sendUdpDatagram6: (destination, destinationPort, sourcePort, payload, bytes) =>
      host.sendUdpDatagram6(destination, destinationPort, sourcePort, payload, bytes),
  };
}
