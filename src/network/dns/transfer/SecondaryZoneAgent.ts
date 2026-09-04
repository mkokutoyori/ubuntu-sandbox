import type { IPAddress } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { Zone } from '@/network/dns/zone/Zone';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { bindDnsUdpServer, unbindDnsUdpServer, udpClientOf } from '@/network/dns/transport/DnsUdpTransport';
import { bindDnsTcpServer, unbindDnsTcpServer } from '@/network/dns/transport/DnsTcpTransport';
import { isTransferQuery, refuseTransfer } from '@/network/dns/transfer/AxfrSession';
import { isNotify, makeNotifyAck } from '@/network/dns/transfer/NotifyProtocol';
import { ZoneTransferClient, transferTransportOf } from '@/network/dns/transfer/ZoneTransferClient';

export interface SecondaryZoneAgentOptions {
  readonly timeoutMs?: number;
}

export class SecondaryZoneAgent {
  private readonly store = new ZoneStore();
  private readonly authServer = new AuthoritativeServer(this.store);
  private readonly client: ZoneTransferClient;
  private installed: Zone | null = null;

  constructor(
    private readonly host: EndHost,
    private readonly origin: string,
    primaryIP: IPAddress,
    options: SecondaryZoneAgentOptions = {},
  ) {
    this.client = new ZoneTransferClient(origin, [primaryIP],
      transferTransportOf(udpClientOf(host), host), options);
  }

  start(): void {
    bindDnsUdpServer(this.host, (query) => this.routeUdp(query));
    bindDnsTcpServer(this.host, (query) =>
      isTransferQuery(query) ? refuseTransfer(query) : this.authServer.answer(query));
  }

  stop(): void {
    unbindDnsUdpServer(this.host);
    unbindDnsTcpServer(this.host);
  }

  async refresh(): Promise<boolean> {
    const fetched = await this.client.refresh();
    this.publish();
    return fetched;
  }

  private publish(): void {
    const zone = this.client.currentZone();
    if (!zone || zone === this.installed) return;
    this.store.removeZone(this.origin);
    this.store.addZone(zone);
    this.installed = zone;
  }

  private routeUdp(query: DnsMessage): DnsMessage {
    if (isNotify(query)) {
      void this.refresh();
      return makeNotifyAck(query);
    }
    if (isTransferQuery(query)) {
      return refuseTransfer(query);
    }
    return this.authServer.answer(query);
  }
}
