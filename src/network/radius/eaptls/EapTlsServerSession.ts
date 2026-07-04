/**
 * RFC 5216 EAP-TLS — RADIUS-server (EAP server) side of one conversation.
 * Tracked per-State by `RadiusServerAgent`, one instance per in-flight
 * EAP-TLS session, mirroring how EAP-MD5 sessions are tracked there.
 */
import type { EapPacket } from '../eap';
import { FragmentSender, EapTlsReassembler, DEFAULT_EAP_TLS_MTU } from './EapTlsFragmentation';
import {
  type EapTlsClientHello, type EapTlsServerFlight, type EapTlsClientFlight,
  type EapTlsServerFinished, encodeFlight, decodeFlight, computeFinished, randomNonce,
} from './EapTlsHandshake';
import type { EapTlsConfig } from './EapTlsConfig';

type State =
  | 'sent-start' | 'sending-server-flight' | 'awaiting-client-flight'
  | 'sending-server-finished' | 'awaiting-final-ack' | 'done';

export type EapTlsSessionResult = 'accept' | 'reject' | null;

export class EapTlsServerSession {
  private state: State = 'sent-start';
  private clientRandom: string | null = null;
  private readonly serverRandom = randomNonce('srv');
  private outgoing: FragmentSender | null = null;
  private readonly incoming = new EapTlsReassembler();
  private readonly mtu: number;
  private readonly requireClientCert: boolean;

  result: EapTlsSessionResult = null;

  constructor(private readonly config: EapTlsConfig) {
    this.mtu = config.mtu ?? DEFAULT_EAP_TLS_MTU;
    this.requireClientCert = config.requireClientCert ?? true;
  }

  /** The initial EAP-Request/EAP-TLS (TLS Start, no data) that kicks off the conversation. */
  start(identifier: number): EapPacket {
    return {
      type: 'eap', code: 'request', identifier, eapType: 'tls',
      tlsFlags: { length: false, more: false, start: true }, tlsData: '',
    };
  }

  /** Process the peer's latest EAP-Response/EAP-TLS; returns the next EAP-Request (`result` stays null while more rounds are needed — its code is 'success'/'failure' once `result` is set). */
  handle(incoming: EapPacket): EapPacket {
    const nextId = (incoming.identifier + 1) & 0xff;
    const tlsData = incoming.tlsData ?? '';
    const tlsFlags = incoming.tlsFlags ?? { length: false, more: false, start: false };

    if (this.state === 'sent-start') {
      const flightBytes = this.incoming.feed({ tlsData, tlsFlags });
      if (flightBytes === null) return this.ackRequest(nextId);
      let hello: EapTlsClientHello;
      try {
        hello = decodeFlight(flightBytes) as EapTlsClientHello;
      } catch {
        return this.reject(nextId);
      }
      this.clientRandom = hello.random;
      return this.startServerFlight(nextId);
    }

    if (this.state === 'sending-server-flight') {
      this.outgoing!.advance();
      if (this.outgoing!.isLastFragment()) this.state = 'awaiting-client-flight';
      return this.currentFragmentRequest(nextId);
    }

    if (this.state === 'awaiting-client-flight') {
      const flightBytes = this.incoming.feed({ tlsData, tlsFlags });
      if (flightBytes === null) return this.ackRequest(nextId);
      let clientFlight: EapTlsClientFlight;
      try {
        clientFlight = decodeFlight(flightBytes) as EapTlsClientFlight;
      } catch {
        return this.reject(nextId);
      }
      return this.finishHandshake(nextId, clientFlight);
    }

    if (this.state === 'sending-server-finished') {
      this.outgoing!.advance();
      if (this.outgoing!.isLastFragment()) this.state = 'awaiting-final-ack';
      return this.currentFragmentRequest(nextId);
    }

    if (this.state === 'awaiting-final-ack') {
      this.state = 'done';
      this.result = 'accept';
      return { type: 'eap', code: 'success', identifier: nextId };
    }

    return this.reject(nextId);
  }

  private reject(nextId: number): EapPacket {
    this.state = 'done';
    this.result = 'reject';
    return { type: 'eap', code: 'failure', identifier: nextId };
  }

  private startServerFlight(nextId: number): EapPacket {
    const flight: EapTlsServerFlight = {
      kind: 'server-flight', random: this.serverRandom,
      certificate: this.config.serverCert, requestClientCert: this.requireClientCert,
    };
    this.outgoing = FragmentSender.forFlight(encodeFlight(flight), this.mtu);
    this.state = this.outgoing.isLastFragment() ? 'awaiting-client-flight' : 'sending-server-flight';
    return this.currentFragmentRequest(nextId);
  }

  private finishHandshake(nextId: number, clientFlight: EapTlsClientFlight): EapPacket {
    const certOk = this.requireClientCert
      ? (!!clientFlight.certificate && this.config.verifier.verify(clientFlight.certificate).ok)
      : true;
    const expectedFinished = computeFinished(this.clientRandom!, this.serverRandom, 'client');
    const finishedOk = clientFlight.finished === expectedFinished;

    if (!certOk || !finishedOk) {
      return this.reject(nextId);
    }

    const serverFinished: EapTlsServerFinished = {
      kind: 'server-finished', finished: computeFinished(this.clientRandom!, this.serverRandom, 'server'),
    };
    this.outgoing = FragmentSender.forFlight(encodeFlight(serverFinished), this.mtu);
    this.state = this.outgoing.isLastFragment() ? 'awaiting-final-ack' : 'sending-server-finished';
    return this.currentFragmentRequest(nextId);
  }

  private currentFragmentRequest(id: number): EapPacket {
    const frag = this.outgoing!.current();
    return { type: 'eap', code: 'request', identifier: id, eapType: 'tls', ...frag };
  }

  private ackRequest(id: number): EapPacket {
    return {
      type: 'eap', code: 'request', identifier: id, eapType: 'tls',
      tlsFlags: { length: false, more: false, start: false }, tlsData: '',
    };
  }
}
