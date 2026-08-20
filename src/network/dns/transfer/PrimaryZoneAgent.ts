import type { IPAddress } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import { RRType } from '@/network/dns/wire/RRType';
import { makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import type { ResourceRecord, ResourceRecordData, SoaRecordData } from '@/network/dns/wire/ResourceRecord';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { Zone } from '@/network/dns/zone/Zone';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { serialAdd } from '@/network/dns/zone/SerialNumber';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { bindDnsUdpServer, unbindDnsUdpServer } from '@/network/dns/transport/DnsUdpTransport';
import { bindDnsTcpServer, unbindDnsTcpServer } from '@/network/dns/transport/DnsTcpTransport';
import { ZoneJournal } from '@/network/dns/transfer/ZoneJournal';
import {
  isTransferQuery, buildAxfrAnswers, buildTransferResponse, refuseTransfer,
} from '@/network/dns/transfer/AxfrSession';
import { buildIxfrAnswers } from '@/network/dns/transfer/IxfrSession';
import { sendNotify } from '@/network/dns/transfer/NotifyProtocol';

export interface ZoneUpdate {
  readonly additions: readonly ResourceRecord<ResourceRecordData>[];
  readonly removals: readonly ResourceRecord<ResourceRecordData>[];
  readonly serial?: number;
  readonly notify?: boolean;
}

export interface PrimaryZoneAgentOptions {
  readonly secondaries?: readonly IPAddress[];
  readonly journalLimit?: number;
}

export type TransferListener = (qtype: number, response: DnsMessage) => void;

export class PrimaryZoneAgent {
  private readonly store = new ZoneStore();
  private readonly authServer: AuthoritativeServer;
  private readonly journal: ZoneJournal;
  private readonly secondaries: readonly IPAddress[];
  private readonly transferListeners: TransferListener[] = [];

  constructor(
    private readonly host: EndHost,
    readonly zone: Zone,
    options: PrimaryZoneAgentOptions = {},
  ) {
    this.store.addZone(zone);
    this.authServer = new AuthoritativeServer(this.store);
    this.journal = new ZoneJournal(options.journalLimit);
    this.secondaries = options.secondaries ?? [];
  }

  start(): void {
    bindDnsUdpServer(this.host, (query) =>
      isTransferQuery(query) ? refuseTransfer(query) : this.authServer.answer(query));
    bindDnsTcpServer(this.host, (query) =>
      isTransferQuery(query) ? this.answerTransfer(query) : this.authServer.answer(query));
  }

  stop(): void {
    unbindDnsUdpServer(this.host);
    unbindDnsTcpServer(this.host);
  }

  onTransfer(listener: TransferListener): void {
    this.transferListeners.push(listener);
  }

  async applyUpdate(update: ZoneUpdate): Promise<void> {
    const fromSerial = this.zone.soa.data.serial;
    for (const rr of update.removals) this.zone.removeRecord(rr);
    for (const rr of update.additions) this.zone.addRecord(rr);

    const toSerial = update.serial ?? serialAdd(fromSerial, 1);
    const previous = this.zone.soa;
    this.zone.updateSoa(makeSoaRecord(previous.name, previous.ttl, {
      ...previous.data, serial: toSerial,
    }));
    this.journal.record({
      fromSerial, toSerial,
      removals: update.removals,
      additions: update.additions,
    });

    if (update.notify ?? true) {
      await Promise.all(this.secondaries.map((secondaryIP) =>
        sendNotify(this.host, secondaryIP, this.zone.origin, this.zone.soa)));
    }
  }

  private answerTransfer(query: DnsMessage): DnsMessage {
    const qtype = query.questions[0].qtype;
    const answers = qtype === RRType.AXFR
      ? buildAxfrAnswers(this.zone)
      : buildIxfrAnswers(this.zone, this.journal, this.clientSerialOf(query));
    const response = buildTransferResponse(query, answers);
    for (const listener of this.transferListeners) listener(qtype, response);
    return response;
  }

  private clientSerialOf(query: DnsMessage): number {
    const soa = query.authorities.find((rr) => rr.data.type === RRType.SOA);
    return soa ? (soa.data as SoaRecordData).serial : -1;
  }
}
