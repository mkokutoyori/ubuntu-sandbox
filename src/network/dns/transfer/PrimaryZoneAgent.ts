import { simulationNowMs } from '@/network/core/SystemClock';

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
  isTransferQuery, buildAxfrAnswers, buildTransferResponse, buildTransferMessages, refuseTransfer,
} from '@/network/dns/transfer/AxfrSession';
import { buildIxfrAnswers } from '@/network/dns/transfer/IxfrSession';
import { sendNotify } from '@/network/dns/transfer/NotifyProtocol';
import { isUpdateMessage } from '@/network/dns/update/DnsUpdate';
import {
  evaluateUpdate, updateResponse, parseOrFormerr, authorizeUpdate, signIfKeyed,
  type UpdateSecurityPolicy,
} from '@/network/dns/update/UpdateResponder';
import { TsigKeyring } from '@/network/dns/tsig/Tsig';
import { signTransferResponse, datagramReply } from '@/network/dns/transfer/ZoneTransferHosting';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';

export interface ZoneUpdate {
  readonly additions: readonly ResourceRecord<ResourceRecordData>[];
  readonly removals: readonly ResourceRecord<ResourceRecordData>[];
  readonly serial?: number;
  readonly soa?: ResourceRecord<SoaRecordData>;
  readonly notify?: boolean;
}

export interface PrimaryZoneAgentOptions {
  readonly secondaries?: readonly IPAddress[];
  readonly journalLimit?: number;
  readonly updatePolicy?: UpdateSecurityPolicy;
  readonly transferPolicy?: UpdateSecurityPolicy;
}

export type TransferListener = (qtype: number, response: DnsMessage) => void;

export class PrimaryZoneAgent {
  private readonly store = new ZoneStore();
  private readonly authServer: AuthoritativeServer;
  private readonly journal: ZoneJournal;
  private readonly secondaries: readonly IPAddress[];
  private readonly transferListeners: TransferListener[] = [];
  private readonly keyring = new TsigKeyring();
  private updatePolicy: UpdateSecurityPolicy;
  private transferPolicy: UpdateSecurityPolicy;

  constructor(
    private readonly host: EndHost,
    readonly zone: Zone,
    options: PrimaryZoneAgentOptions = {},
  ) {
    this.store.addZone(zone);
    this.authServer = new AuthoritativeServer(this.store);
    this.journal = new ZoneJournal(options.journalLimit);
    this.secondaries = options.secondaries ?? [];
    this.updatePolicy = options.updatePolicy ?? 'none';
    this.transferPolicy = options.transferPolicy ?? 'none';
  }

  start(): void {
    bindDnsUdpServer(this.host, (query, _ip, _port, raw) => datagramReply(this.dispatch(query, false, raw)));
    bindDnsTcpServer(this.host, (query, _ip, _port, raw) => this.dispatch(query, true, raw));
  }

  private dispatch(
    query: DnsMessage, transferAllowed: boolean, raw?: Uint8Array,
  ): DnsMessage | DnsMessage[] | Promise<DnsMessage> {
    if (isUpdateMessage(query)) return this.answerUpdate(query, raw);
    if (isTransferQuery(query)) {
      return transferAllowed ? this.answerTransfer(query, raw) : refuseTransfer(query);
    }
    return this.authServer.answer(query);
  }

  private async answerUpdate(query: DnsMessage, raw?: Uint8Array): Promise<DnsMessage> {
    const now = Math.floor(simulationNowMs() / 1000);
    const auth = authorizeUpdate(raw, this.updatePolicy, this.keyring, now);
    const reply = (rcode: number): DnsMessage =>
      signIfKeyed(updateResponse(query, rcode), auth, now);
    if (auth.rcode !== DnsRcode.NOERROR) return reply(auth.rcode);

    const request = parseOrFormerr(query);
    if (!request) return reply(DnsRcode.FORMERR);

    const verdict = evaluateUpdate(this.zone, request);
    if (verdict.rcode !== DnsRcode.NOERROR) return reply(verdict.rcode);

    const { additions, removals, soa } = verdict.applied;
    if (additions.length > 0 || removals.length > 0 || soa) {
      await this.applyUpdate({ additions, removals, soa });
    }
    return reply(DnsRcode.NOERROR);
  }

  getTsigKeyring(): TsigKeyring { return this.keyring; }

  setUpdatePolicy(policy: UpdateSecurityPolicy): void { this.updatePolicy = policy; }

  setTransferPolicy(policy: UpdateSecurityPolicy): void { this.transferPolicy = policy; }

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

    const toSerial = update.serial ?? (update.soa ? update.soa.data.serial : serialAdd(fromSerial, 1));
    const previous = update.soa ?? this.zone.soa;
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

  private answerTransfer(query: DnsMessage, raw?: Uint8Array): DnsMessage | DnsMessage[] {
    const now = Math.floor(simulationNowMs() / 1000);
    const auth = authorizeUpdate(raw, this.transferPolicy, this.keyring, now);
    if (auth.rcode !== DnsRcode.NOERROR) {
      return signIfKeyed({
        ...refuseTransfer(query), flags: { ...refuseTransfer(query).flags, rcode: auth.rcode },
      }, auth, now);
    }
    const qtype = query.questions[0].qtype;
    const answers = qtype === RRType.AXFR
      ? buildAxfrAnswers(this.zone)
      : buildIxfrAnswers(this.zone, this.journal, this.clientSerialOf(query));
    const messages = buildTransferMessages(query, answers);
    for (const listener of this.transferListeners) listener(qtype, buildTransferResponse(query, answers));
    return signTransferResponse(messages, auth, now);
  }

  private clientSerialOf(query: DnsMessage): number {
    const soa = query.authorities.find((rr) => rr.data.type === RRType.SOA);
    return soa ? (soa.data as SoaRecordData).serial : -1;
  }
}
