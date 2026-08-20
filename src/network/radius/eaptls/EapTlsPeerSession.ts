/**
 * RFC 5216 EAP-TLS (and, sharing the same outer tunnel mechanics, PEAP and
 * RFC 5281 EAP-TTLS) — peer (supplicant) side, now backed by the real
 * RFC 8446 1-RTT engine (`TlsClientSession`) — see `EapTlsServerSession.ts`
 * for the server side and the round-count note (`PRD-TLS.md` §2.1.14).
 *
 * This simulator has no dedicated "supplicant device" class (see
 * `dot1x-radius-eap.test.ts`'s hand-built EAPOL frames for the same
 * reason with EAP-MD5) — tests drive this session directly, feeding it
 * each EAP-Request the switch/NAS relays and sending back whatever
 * `handle()` returns.
 *
 * Plain EAP-TLS concludes in success/failure right after the tunnel
 * handshake: `TlsClientSession` already sets `result: 'success'`
 * synchronously as soon as it validates the server and builds its own
 * final flight, so this session mirrors that the moment it finishes
 * sending that flight — it never needs to wait for a further server
 * round to learn the outer outcome. PEAP/EAP-TTLS (`innerAuth` set)
 * instead hand off to an inner authentication method once the tunnel is
 * up — see `InnerAuth.ts`. The terminal `result` this session reports for
 * the inner phase is best-effort only (only meaningful if the inner
 * method itself signals an outcome to the peer, which neither
 * `TtlsPapInnerAuthPeer` nor `PeapMd5InnerAuthPeer` do) — the
 * authoritative signal is always the outer, unwrapped EAP-Success/Failure
 * the server sends once its own inner method concludes; callers should
 * check that directly rather than relying on `result` for the inner phase.
 */
import type { EapPacket } from '../eap';
import { FragmentSender, EapTlsReassembler, DEFAULT_EAP_TLS_MTU } from './EapTlsFragmentation';
import { encodeFlight, decodeFlight } from './EapTlsHandshake';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import type { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { InnerAuthPeer } from './InnerAuth';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { fragmentAsRecords, reassembleRecords, type TlsRecord } from '@/network/tls/recordLayer';

type State =
  | 'idle' | 'sending' | 'awaiting-server-flight' | 'awaiting-inner-request' | 'done';

export type EapTlsPeerResult = 'success' | 'failure' | null;

export interface EapTlsPeerOptions {
  readonly mtu?: number;
  readonly eapType?: 'tls' | 'peap' | 'ttls';
  readonly innerAuth?: InnerAuthPeer;
  /** Signs `CertificateVerify` when `clientCert` is set and the server requests it (RFC 8446 §4.4.2) — the real engine needs it even though the old ad hoc model didn't. */
  readonly clientPrivateKey?: PkiPrivateKey;
}

export class EapTlsPeerSession {
  private state: State = 'idle';
  private readonly tls: TlsClientSession;
  private outgoing: FragmentSender | null = null;
  private outgoingFinalState: State = 'done';
  private readonly incoming = new EapTlsReassembler();
  private readonly mtu: number;
  private readonly eapType: 'tls' | 'peap' | 'ttls';
  private readonly innerAuth?: InnerAuthPeer;

  result: EapTlsPeerResult = null;

  constructor(
    clientCert: X509Certificate | null,
    verifier: CertificateVerifier,
    mtuOrOptions: number | EapTlsPeerOptions = DEFAULT_EAP_TLS_MTU,
  ) {
    const opts: EapTlsPeerOptions = typeof mtuOrOptions === 'number' ? { mtu: mtuOrOptions } : mtuOrOptions;
    this.mtu = opts.mtu ?? DEFAULT_EAP_TLS_MTU;
    this.eapType = opts.eapType ?? 'tls';
    this.innerAuth = opts.innerAuth;
    this.tls = new TlsClientSession({
      verifier, clientCert: clientCert ?? undefined, clientPrivateKey: opts.clientPrivateKey,
    });
  }

  /** Process the server's latest EAP-Request; returns the EAP-Response to send back. */
  handle(request: EapPacket): EapPacket {
    const id = request.identifier;
    const tlsData = request.tlsData ?? '';
    const tlsFlags = request.tlsFlags ?? { length: false, more: false, start: false };

    if (this.state === 'idle') {
      return this.sendFlight(id, this.tls.start(), 'awaiting-server-flight');
    }

    if (this.state === 'sending') {
      this.outgoing!.advance();
      if (this.outgoing!.isLastFragment()) {
        this.state = this.outgoingFinalState;
        if (this.state === 'done') this.result = 'success';
      }
      return this.currentFragmentResponse(id);
    }

    if (this.state === 'awaiting-server-flight') {
      const flightBytes = this.incoming.feed({ tlsData, tlsFlags });
      if (flightBytes === null) return this.ackResponse(id);
      let records: readonly TlsRecord[];
      try {
        records = decodeFlight(flightBytes);
      } catch {
        return this.fail(id);
      }
      const reply = this.tls.handle(records);
      if (this.tls.result === 'failure' || !reply) return this.fail(id);
      return this.sendFlight(id, reply, this.innerAuth ? 'awaiting-inner-request' : 'done');
    }

    if (this.state === 'awaiting-inner-request') {
      const flightBytes = this.incoming.feed({ tlsData, tlsFlags });
      if (flightBytes === null) return this.ackResponse(id);
      let innerBytes: Uint8Array;
      try {
        innerBytes = reassembleRecords(decodeFlight(flightBytes), true).plaintext;
      } catch {
        return this.fail(id);
      }
      const { next, result } = this.innerAuth!.handle(innerBytes);
      if (result !== null) this.result = result;
      return this.sendFlight(id, fragmentAsRecords('application_data', next, true), 'awaiting-inner-request');
    }

    return this.ackResponse(id);
  }

  private fail(id: number): EapPacket {
    this.state = 'done';
    this.result = 'failure';
    return this.ackResponse(id);
  }

  private sendFlight(id: number, records: readonly TlsRecord[], finalState: State): EapPacket {
    this.outgoing = FragmentSender.forFlight(encodeFlight(records), this.mtu);
    this.outgoingFinalState = finalState;
    if (this.outgoing.isLastFragment()) {
      this.state = finalState;
      if (finalState === 'done') this.result = 'success';
    } else {
      this.state = 'sending';
    }
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
