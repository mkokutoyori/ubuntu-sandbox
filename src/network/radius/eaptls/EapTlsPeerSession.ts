/**
 * RFC 5216 EAP-TLS (and, sharing the same outer tunnel mechanics, PEAP and
 * RFC 5281 EAP-TTLS) — peer (supplicant) side of one conversation. This
 * simulator has no dedicated "supplicant device" class (see
 * `dot1x-radius-eap.test.ts`'s hand-built EAPOL frames for the same
 * reason with EAP-MD5) — tests drive this session directly, feeding it
 * each EAP-Request the switch/NAS relays and sending back whatever
 * `handle()` returns.
 *
 * Plain EAP-TLS concludes in success/failure right after the tunnel
 * handshake. PEAP/EAP-TTLS (`innerAuth` set) instead hand off to an inner
 * authentication method once the tunnel is up — see `InnerAuth.ts`. The
 * terminal `result` this session reports for the inner phase is
 * best-effort only (only meaningful if the inner method itself signals an
 * outcome to the peer, which neither `TtlsPapInnerAuthPeer` nor
 * `PeapMd5InnerAuthPeer` do) — the authoritative signal is always the
 * outer, unwrapped EAP-Success/Failure the server sends once its own
 * inner method concludes; callers should check that directly rather than
 * relying on `result` for the inner phase.
 */
import type { EapPacket } from '../eap';
import { FragmentSender, EapTlsReassembler, DEFAULT_EAP_TLS_MTU } from './EapTlsFragmentation';
import {
  type EapTlsServerFlight, type EapTlsClientFlight, type EapTlsServerFinished, type EapTlsInnerData,
  encodeFlight, decodeFlight, computeFinished, randomNonce,
} from './EapTlsHandshake';
import { bytesToHex, hexToBytes } from '@/crypto/encoding';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { InnerAuthPeer } from './InnerAuth';

type State =
  | 'idle' | 'sending-client-hello' | 'awaiting-server-flight'
  | 'sending-client-flight' | 'awaiting-server-finished'
  | 'awaiting-inner-request' | 'sending-inner-response' | 'done';

export type EapTlsPeerResult = 'success' | 'failure' | null;

export interface EapTlsPeerOptions {
  readonly mtu?: number;
  readonly eapType?: 'tls' | 'peap' | 'ttls';
  readonly innerAuth?: InnerAuthPeer;
}

export class EapTlsPeerSession {
  private state: State = 'idle';
  private readonly clientRandom = randomNonce('cli');
  private serverRandom: string | null = null;
  private outgoing: FragmentSender | null = null;
  private readonly incoming = new EapTlsReassembler();
  private readonly mtu: number;
  private readonly eapType: 'tls' | 'peap' | 'ttls';
  private readonly innerAuth?: InnerAuthPeer;

  result: EapTlsPeerResult = null;

  constructor(
    private readonly clientCert: X509Certificate | null,
    private readonly verifier: CertificateVerifier,
    mtuOrOptions: number | EapTlsPeerOptions = DEFAULT_EAP_TLS_MTU,
  ) {
    const opts: EapTlsPeerOptions = typeof mtuOrOptions === 'number' ? { mtu: mtuOrOptions } : mtuOrOptions;
    this.mtu = opts.mtu ?? DEFAULT_EAP_TLS_MTU;
    this.eapType = opts.eapType ?? 'tls';
    this.innerAuth = opts.innerAuth;
  }

  /** Process the server's latest EAP-Request; returns the EAP-Response to send back. */
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
      try {
        const finished = decodeFlight(flightBytes) as EapTlsServerFinished;
        const expected = computeFinished(this.clientRandom, this.serverRandom!, 'server');
        if (finished.finished !== expected) {
          this.state = 'done';
          this.result = 'failure';
          return this.ackResponse(id);
        }
      } catch {
        this.state = 'done';
        this.result = 'failure';
        return this.ackResponse(id);
      }
      if (!this.innerAuth) {
        this.state = 'done';
        this.result = 'success';
      } else {
        this.state = 'awaiting-inner-request';
      }
      return this.ackResponse(id);
    }

    if (this.state === 'awaiting-inner-request') {
      const flightBytes = this.incoming.feed({ tlsData, tlsFlags });
      if (flightBytes === null) return this.ackResponse(id);
      let innerBytes: Uint8Array;
      try {
        innerBytes = hexToBytes((decodeFlight(flightBytes) as EapTlsInnerData).hex);
      } catch {
        this.state = 'done';
        this.result = 'failure';
        return this.ackResponse(id);
      }
      const { next, result } = this.innerAuth!.handle(innerBytes);
      if (result !== null) this.result = result;
      return this.sendInnerResponse(id, next);
    }

    if (this.state === 'sending-inner-response') {
      this.outgoing!.advance();
      if (this.outgoing!.isLastFragment()) this.state = 'awaiting-inner-request';
      return this.currentFragmentResponse(id);
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

  private sendInnerResponse(id: number, bytes: Uint8Array): EapPacket {
    const inner: EapTlsInnerData = { kind: 'inner-data', hex: bytesToHex(bytes) };
    this.outgoing = FragmentSender.forFlight(encodeFlight(inner), this.mtu);
    this.state = this.outgoing.isLastFragment() ? 'awaiting-inner-request' : 'sending-inner-response';
    return this.currentFragmentResponse(id);
  }

  private currentFragmentResponse(id: number): EapPacket {
    const frag = this.outgoing!.current();
    return { type: 'eap', code: 'response', identifier: id, eapType: this.eapType, ...frag };
  }

  private ackResponse(id: number): EapPacket {
    return {
      type: 'eap', code: 'response', identifier: id, eapType: this.eapType,
      tlsFlags: { length: false, more: false, start: false }, tlsData: '',
    };
  }
}
