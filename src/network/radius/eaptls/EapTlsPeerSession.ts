/**
 * RFC 5216 EAP-TLS — peer (supplicant) side of one conversation. This
 * simulator has no dedicated "supplicant device" class (see
 * `dot1x-radius-eap.test.ts`'s hand-built EAPOL frames for the same
 * reason with EAP-MD5) — tests drive this session directly, feeding it
 * each EAP-Request the switch/NAS relays and sending back whatever
 * `handle()` returns.
 */
import type { EapPacket } from '../eap';
import { FragmentSender, EapTlsReassembler, DEFAULT_EAP_TLS_MTU } from './EapTlsFragmentation';
import {
  type EapTlsServerFlight, type EapTlsClientFlight, type EapTlsServerFinished,
  encodeFlight, decodeFlight, computeFinished, randomNonce,
} from './EapTlsHandshake';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { CertificateVerifier } from '@/network/pki/CertificateVerifier';

type State =
  | 'idle' | 'sending-client-hello' | 'awaiting-server-flight'
  | 'sending-client-flight' | 'awaiting-server-finished' | 'done';

export type EapTlsPeerResult = 'success' | 'failure' | null;

export class EapTlsPeerSession {
  private state: State = 'idle';
  private readonly clientRandom = randomNonce('cli');
  private serverRandom: string | null = null;
  private outgoing: FragmentSender | null = null;
  private readonly incoming = new EapTlsReassembler();
  private readonly mtu: number;

  result: EapTlsPeerResult = null;

  constructor(
    private readonly clientCert: X509Certificate | null,
    private readonly verifier: CertificateVerifier,
    mtu: number = DEFAULT_EAP_TLS_MTU,
  ) {
    this.mtu = mtu;
  }

  /** Process the server's latest EAP-Request/EAP-TLS; returns the EAP-Response to send back. */
  handle(request: EapPacket): EapPacket {
    const id = request.identifier;
    const tlsData = request.tlsData ?? '';
    const tlsFlags = request.tlsFlags ?? { length: false, more: false, start: false };

    if (this.state === 'idle') {
      const hello = { kind: 'client-hello' as const, random: this.clientRandom };
      this.outgoing = FragmentSender.forFlight(encodeFlight(hello), this.mtu);
      this.state = this.outgoing.isLastFragment() ? 'awaiting-server-flight' : 'sending-client-hello';
      return this.currentFragmentResponse(id);
    }

    if (this.state === 'sending-client-hello') {
      this.outgoing!.advance();
      if (this.outgoing!.isLastFragment()) this.state = 'awaiting-server-flight';
      return this.currentFragmentResponse(id);
    }

    if (this.state === 'awaiting-server-flight') {
      const flightBytes = this.incoming.feed({ tlsData, tlsFlags });
      if (flightBytes === null) return this.ackResponse(id);
      let flight: EapTlsServerFlight;
      try {
        flight = decodeFlight(flightBytes) as EapTlsServerFlight;
      } catch {
        this.state = 'done';
        this.result = 'failure';
        return this.ackResponse(id);
      }
      this.serverRandom = flight.random;
      if (!this.verifier.verify(flight.certificate).ok) {
        this.state = 'done';
        this.result = 'failure';
        return this.ackResponse(id);
      }
      return this.startClientFlight(id, flight);
    }

    if (this.state === 'sending-client-flight') {
      this.outgoing!.advance();
      if (this.outgoing!.isLastFragment()) this.state = 'awaiting-server-finished';
      return this.currentFragmentResponse(id);
    }

    if (this.state === 'awaiting-server-finished') {
      const flightBytes = this.incoming.feed({ tlsData, tlsFlags });
      if (flightBytes === null) return this.ackResponse(id);
      this.state = 'done';
      try {
        const finished = decodeFlight(flightBytes) as EapTlsServerFinished;
        const expected = computeFinished(this.clientRandom, this.serverRandom!, 'server');
        this.result = finished.finished === expected ? 'success' : 'failure';
      } catch {
        this.result = 'failure';
      }
      return this.ackResponse(id);
    }

    return this.ackResponse(id);
  }

  private startClientFlight(id: number, serverFlight: EapTlsServerFlight): EapPacket {
    const clientFlight: EapTlsClientFlight = {
      kind: 'client-flight',
      certificate: serverFlight.requestClientCert ? this.clientCert : null,
      finished: computeFinished(this.clientRandom, this.serverRandom!, 'client'),
    };
    this.outgoing = FragmentSender.forFlight(encodeFlight(clientFlight), this.mtu);
    this.state = this.outgoing.isLastFragment() ? 'awaiting-server-finished' : 'sending-client-flight';
    return this.currentFragmentResponse(id);
  }

  private currentFragmentResponse(id: number): EapPacket {
    const frag = this.outgoing!.current();
    return { type: 'eap', code: 'response', identifier: id, eapType: 'tls', ...frag };
  }

  private ackResponse(id: number): EapPacket {
    return {
      type: 'eap', code: 'response', identifier: id, eapType: 'tls',
      tlsFlags: { length: false, more: false, start: false }, tlsData: '',
    };
  }
}
