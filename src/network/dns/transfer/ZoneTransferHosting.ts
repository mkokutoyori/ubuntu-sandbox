import type { IPAddress } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { Zone } from '@/network/dns/zone/Zone';
import type { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { udpClientOf } from '@/network/dns/transport/DnsUdpTransport';
import { buildAxfrAnswers, buildTransferMessages } from '@/network/dns/transfer/AxfrSession';
import { sendNotify } from '@/network/dns/transfer/NotifyProtocol';
import { ZoneTransferClient, transferTransportOf } from '@/network/dns/transfer/ZoneTransferClient';
import { normalizeDnsName } from '@/network/dns/wire/DnsName';
import { signMessageStream, type TsigKey } from '@/network/dns/tsig/Tsig';
import type { UpdateAuthorization } from '@/network/dns/update/UpdateResponder';

export function serveZoneTransfer(store: ZoneStore | null, query: DnsMessage): DnsMessage[] | null {
  const qname = normalizeDnsName(query.questions[0].qname);
  const zone = store?.findZone(qname);
  if (!zone || zone.origin !== qname) return null;
  return buildTransferMessages(query, buildAxfrAnswers(zone));
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

export function notifyZoneTargets(host: EndHost, zone: Zone, targets: readonly IPAddress[]): void {
  for (const target of targets) void sendNotify(host, target, zone.origin, zone.soa);
}

export interface SecondaryRefreshOutcome {
  readonly succeeded: boolean;
  readonly deferred: boolean;
  readonly zone: Zone | null;
}

export class SecondaryZoneRefresher {
  private readonly clients = new Map<string, ZoneTransferClient>();
  private readonly inFlight = new Set<string>();
  private readonly queued = new Map<string, boolean>();

  constructor(
    private readonly host: EndHost,
    private readonly rerun: (zoneName: string, force: boolean) => void,
  ) {}

  async refresh(
    store: ZoneStore, zoneName: string, primaries: readonly IPAddress[], force = false,
    keys: ReadonlyMap<string, TsigKey> = new Map(),
  ): Promise<SecondaryRefreshOutcome> {
    if (this.inFlight.has(zoneName)) {
      this.queued.set(zoneName, force || this.queued.get(zoneName) === true);
      return { succeeded: false, deferred: true, zone: null };
    }
    this.inFlight.add(zoneName);
    try {
      return await this.transfer(store, zoneName, primaries, force, keys);
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
    keys: ReadonlyMap<string, TsigKey>,
  ): Promise<SecondaryRefreshOutcome> {
    const failure = { succeeded: false, deferred: false, zone: null };
    if (primaries.length === 0) return failure;
    const client = this.clientFor(zoneName, primaries, keys);
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
  ): ZoneTransferClient {
    const existing = this.clients.get(zoneName);
    if (existing) return existing;
    const client = new ZoneTransferClient(zoneName, primaries,
      transferTransportOf(udpClientOf(this.host), this.host), { keys });
    this.clients.set(zoneName, client);
    return client;
  }
}
