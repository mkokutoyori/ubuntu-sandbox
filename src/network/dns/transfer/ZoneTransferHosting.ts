import type { IPAddress } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { Zone } from '@/network/dns/zone/Zone';
import type { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { udpClientOf } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsPacketObserver } from '@/network/dns/transport/DnsPacketObserver';
import { buildAxfrAnswers, buildTransferMessages } from '@/network/dns/transfer/AxfrSession';
import { sendNotify, type NotifyTarget } from '@/network/dns/transfer/NotifyProtocol';
import { ZoneTransferClient, transferTransportOf } from '@/network/dns/transfer/ZoneTransferClient';
import { secureTransferClientOf } from '@/network/dns/transfer/SecureTransferClient';
import type { TransferEndpoint } from '@/network/dns/transfer/TransferEndpoint';
import { normalizeDnsName } from '@/network/dns/wire/DnsName';
import { RRType } from '@/network/dns/wire/RRType';
import type { SoaRecordData } from '@/network/dns/wire/ResourceRecord';
import { serialGreaterThan } from '@/network/dns/zone/SerialNumber';
import { signMessageStream, type TsigKey } from '@/network/dns/tsig/Tsig';
import type { UpdateAuthorization } from '@/network/dns/update/UpdateResponder';

export function serveZoneTransfer(store: ZoneStore | null, query: DnsMessage): DnsMessage[] | null {
  const qname = normalizeDnsName(query.questions[0].qname);
  const zone = store?.findZone(qname);
  if (!zone || zone.origin !== qname) return null;
  return buildTransferMessages(query, clientHoldsZone(query, zone) ? [zone.soa] : buildAxfrAnswers(zone));
}

function clientHoldsZone(query: DnsMessage, zone: Zone): boolean {
  if (query.questions[0].qtype !== RRType.IXFR) return false;
  const held = query.authorities.find((record) => record.data.type === RRType.SOA);
  return held !== undefined && !serialGreaterThan(zone.soa.data.serial, (held.data as SoaRecordData).serial);
}

export function datagramReply(
  reply: DnsMessage | readonly DnsMessage[] | Promise<DnsMessage | readonly DnsMessage[]>,
): DnsMessage | Promise<DnsMessage> {
  const first = (value: DnsMessage | readonly DnsMessage[]): DnsMessage =>
    Array.isArray(value) ? value[0] : value as DnsMessage;
  return reply instanceof Promise ? reply.then(first) : first(reply);
}

export function signTransferResponse(
  messages: readonly DnsMessage[], auth: UpdateAuthorization, now: number,
): DnsMessage[] {
  if (!auth.key) return [...messages];
  return signMessageStream(messages, { key: auth.key, timeSigned: now, requestMac: auth.requestMac });
}

export function notifyZoneTargets(
  host: EndHost, zone: Zone, targets: readonly NotifyTarget[], observer?: DnsPacketObserver,
): void {
  for (const target of targets) void sendNotify(host, target.address, zone.origin, zone.soa, undefined, observer, target);
}

export interface SecondaryRefreshOutcome {
  readonly succeeded: boolean;
  readonly deferred: boolean;
  readonly zone: Zone | null;
}

export class SecondaryZoneRefresher {
  private readonly clients = new Map<string, { readonly client: ZoneTransferClient; readonly signature: string }>();
  private readonly inFlight = new Set<string>();
  private readonly queued = new Map<string, boolean>();

  constructor(
    private readonly host: EndHost,
    private readonly rerun: (zoneName: string, force: boolean) => void,
    private readonly observer?: DnsPacketObserver,
  ) {}

  async refresh(
    store: ZoneStore, zoneName: string, primaries: readonly IPAddress[], force = false,
    keys: ReadonlyMap<string, TsigKey> = new Map(),
    endpoints: ReadonlyMap<string, TransferEndpoint> = new Map(),
  ): Promise<SecondaryRefreshOutcome> {
    if (this.inFlight.has(zoneName)) {
      this.queued.set(zoneName, force || this.queued.get(zoneName) === true);
      return { succeeded: false, deferred: true, zone: null };
    }
    this.inFlight.add(zoneName);
    try {
      return await this.transfer(store, zoneName, primaries, force, keys, endpoints);
    } finally {
      this.inFlight.delete(zoneName);
      const again = this.queued.get(zoneName);
      if (again !== undefined) {
        this.queued.delete(zoneName);
        this.rerun(zoneName, again);
      }
    }
  }

  discard(zoneName: string): void {
    this.clients.delete(zoneName);
    this.queued.delete(zoneName);
  }

  private async transfer(
    store: ZoneStore, zoneName: string, primaries: readonly IPAddress[], force: boolean,
    keys: ReadonlyMap<string, TsigKey>, endpoints: ReadonlyMap<string, TransferEndpoint>,
  ): Promise<SecondaryRefreshOutcome> {
    const failure = { succeeded: false, deferred: false, zone: null };
    if (primaries.length === 0) return failure;
    const client = this.clientFor(zoneName, primaries, keys, endpoints);
    client.adopt(store.getZone(zoneName));
    if (!await client.refresh(force)) return failure;
    const fetched = client.currentZone();
    if (!fetched) return failure;
    store.removeZone(zoneName);
    store.addZone(fetched);
    return { succeeded: true, deferred: false, zone: fetched };
  }

  private clientFor(
    zoneName: string, primaries: readonly IPAddress[], keys: ReadonlyMap<string, TsigKey>,
    endpoints: ReadonlyMap<string, TransferEndpoint>,
  ): ZoneTransferClient {
    const signature = JSON.stringify([
      primaries.map(String),
      [...endpoints].map(([address, endpoint]) => [
        address, endpoint.port,
        endpoint.tls === null ? null : [endpoint.tls.anchors?.map((anchor) => anchor.serialNumber) ?? null, endpoint.tls.serverName, endpoint.tls.setupFailed],
      ]),
    ]);
    const existing = this.clients.get(zoneName);
    if (existing && existing.signature === signature) return existing.client;
    const client = new ZoneTransferClient(zoneName, primaries,
      transferTransportOf(udpClientOf(this.host), this.host, undefined, this.observer, secureTransferClientOf(this.host)),
      { keys, endpoints });
    this.clients.set(zoneName, { client, signature });
    return client;
  }
}
