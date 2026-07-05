/**
 * RFC 5216 EAP-TLS (and, sharing the same outer tunnel mechanics, PEAP and
 * RFC 5281 EAP-TTLS) — RADIUS-server (EAP server) side of one conversation,
 * now backed by the real RFC 8446 1-RTT engine (`TlsServerSession`,
 * `@/network/tls`) instead of `EapTlsHandshake.ts`'s old ad hoc 2-RTT
 * stand-in (`PRD-TLS.md` §2.1.14). `EapTlsFragmentation.ts`'s RFC 5216
 * §2.1 fragmentation is unchanged — only the content being fragmented
 * differs (real TLS wire records instead of ad hoc flight objects).
 *
 * Because TLS 1.3 bundles the server's Finished into its first flight
 * (unlike the TLS-1.2-shaped exchange RFC 5216 illustrates, where the
 * server's Finished follows the client's in a distinct final round), this
 * outer tunnel now completes in one fewer round trip than before:
 * ClientHello -> ServerHello+cert+Finished -> ClientFinal(+client
 * cert/Finished) -> accept/reject, with no separate "server Finished"
 * round. Neither side here offers more than the default `x25519` group,
 * so `HelloRetryRequest` never triggers in practice — this session does
 * not model that branch.
 *
 * Once the tunnel is up, PEAP/EAP-TTLS's inner authentication rides inside
 * real TLS `application_data` records (`fragmentAsRecords`/
 * `reassembleRecords`) rather than the old bespoke `EapTlsInnerData`
 * wrapper — a fidelity increase, since the inner conversation now
 * genuinely travels inside the tunnel's (simulated) encrypted channel.
 *
 * Tracked per-State by `RadiusServerAgent`, one instance per in-flight
 * session, mirroring how EAP-MD5 sessions are tracked there.
 */
import type { EapPacket } from '../eap';
import { FragmentSender, EapTlsReassembler, DEFAULT_EAP_TLS_MTU } from './EapTlsFragmentation';
import { encodeFlight, decodeFlight } from './EapTlsHandshake';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { fragmentAsRecords, reassembleRecords, type TlsRecord } from '@/network/tls/recordLayer';
import type { EapTlsConfig } from './EapTlsConfig';

type State =
  | 'sent-start' | 'sending' | 'awaiting-client-flight' | 'awaiting-inner-response' | 'done';

export type EapTlsSessionResult = 'accept' | 'reject' | null;

export class EapTlsServerSession {
  private state: State = 'sent-start';
  private readonly tls: TlsServerSession;
  private outgoing: FragmentSender | null = null;
  private outgoingFinalState: State = 'done';
  private readonly incoming = new EapTlsReassembler();
  private readonly mtu: number;
  private readonly eapType: 'tls' | 'peap' | 'ttls';

  result: EapTlsSessionResult = null;

  constructor(private readonly config: EapTlsConfig) {
    this.mtu = config.mtu ?? DEFAULT_EAP_TLS_MTU;
    this.eapType = config.eapType ?? 'tls';
    this.tls = new TlsServerSession({
      serverCert: config.serverCert, serverPrivateKey: config.serverPrivateKey,
      requestClientCert: config.requireClientCert ?? true, verifier: config.verifier,
    });
  }

  /** The initial EAP-Request (TLS Start, no data) that kicks off the conversation. */
  start(identifier: number): EapPacket {
    return {
      type: 'eap', code: 'request', identifier, eapType: this.eapType,
      tlsFlags: { length: false, more: false, start: true }, tlsData: '',
    };
  }

  /** Process the peer's latest EAP-Response; returns the next EAP-Request (`result` stays null while more rounds are needed — its code is 'success'/'failure' once `result` is set). */
  handle(incoming: EapPacket): EapPacket {
    const nextId = (incoming.identifier + 1) & 0xff;
    const tlsData = incoming.tlsData ?? '';
    const tlsFlags = incoming.tlsFlags ?? { length: false, more: false, start: false };

    if (this.state === 'sent-start') {
      const flightBytes = this.incoming.feed({ tlsData, tlsFlags });
      if (flightBytes === null) return this.ackRequest(nextId);
      let records: readonly TlsRecord[];
      try {
        records = decodeFlight(flightBytes);
      } catch {
        return this.reject(nextId);
      }
      const reply = this.tls.handle(records);
      if (this.tls.result === 'reject' || !reply) return this.reject(nextId);
      return this.sendFlight(nextId, reply, 'awaiting-client-flight');
    }

    if (this.state === 'sending') {
      this.outgoing!.advance();
      if (this.outgoing!.isLastFragment()) this.state = this.outgoingFinalState;
      return this.currentFragmentRequest(nextId);
    }

    if (this.state === 'awaiting-client-flight') {
      const flightBytes = this.incoming.feed({ tlsData, tlsFlags });
      if (flightBytes === null) return this.ackRequest(nextId);
      let records: readonly TlsRecord[];
      try {
        records = decodeFlight(flightBytes);
      } catch {
        return this.reject(nextId);
      }
      this.tls.handle(records);
      if (this.tls.result !== 'accept') return this.reject(nextId);
      if (!this.config.innerAuth) {
        this.state = 'done';
        this.result = 'accept';
        return { type: 'eap', code: 'success', identifier: nextId };
      }
      const innerRequest = fragmentAsRecords('application_data', this.config.innerAuth.start(), true);
      return this.sendFlight(nextId, innerRequest, 'awaiting-inner-response');
    }

    if (this.state === 'awaiting-inner-response') {
      const flightBytes = this.incoming.feed({ tlsData, tlsFlags });
      if (flightBytes === null) return this.ackRequest(nextId);
      let innerBytes: Uint8Array;
      try {
        innerBytes = reassembleRecords(decodeFlight(flightBytes), true).plaintext;
      } catch {
        return this.reject(nextId);
      }
      const { next, result } = this.config.innerAuth!.handle(innerBytes);
      if (result !== null) {
        this.state = 'done';
        this.result = result;
        return { type: 'eap', code: result === 'accept' ? 'success' : 'failure', identifier: nextId };
      }
      const innerRequest = fragmentAsRecords('application_data', next!, true);
      return this.sendFlight(nextId, innerRequest, 'awaiting-inner-response');
    }

    return this.reject(nextId);
  }

  private reject(nextId: number): EapPacket {
    this.state = 'done';
    this.result = 'reject';
    return { type: 'eap', code: 'failure', identifier: nextId };
  }

  private sendFlight(nextId: number, records: readonly TlsRecord[], finalState: State): EapPacket {
    this.outgoing = FragmentSender.forFlight(encodeFlight(records), this.mtu);
    this.outgoingFinalState = finalState;
    this.state = this.outgoing.isLastFragment() ? finalState : 'sending';
    return this.currentFragmentRequest(nextId);
  }

  private currentFragmentRequest(id: number): EapPacket {
    const frag = this.outgoing!.current();
    return { type: 'eap', code: 'request', identifier: id, eapType: this.eapType, ...frag };
  }

  private ackRequest(id: number): EapPacket {
    return {
      type: 'eap', code: 'request', identifier: id, eapType: this.eapType,
      tlsFlags: { length: false, more: false, start: false }, tlsData: '',
    };
  }
}
