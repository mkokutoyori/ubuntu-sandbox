/**
 * EAP-TLS (RFC 5216 §2.1) fragmentation and reassembly — a "flight" (a
 * bundle of TLS handshake messages sent together, e.g. ServerHello +
 * Certificate + CertificateRequest + ServerHelloDone) is serialized to
 * bytes elsewhere (`EapTlsHandshake.ts`) and chopped here into MTU-sized
 * Type-Data chunks with the L/M/S flag byte. Either direction can fragment
 * — the EAP server's outgoing flights and the peer's outgoing flights are
 * both handled by the same `FragmentSender`/`EapTlsReassembler` pair.
 *
 * Per RFC 5216 §2.1: whichever side receives a fragment with the M
 * (More-Fragments) bit set must reply with an empty EAP packet of its own
 * type/code (an ACK) before the sender transmits the next fragment — the
 * session state machines in `EapTlsServerSession`/`EapTlsPeerSession` drive
 * that ping-pong; this module only knows how to slice/reassemble bytes.
 */
import { bytesToHex, hexToBytes } from '@/crypto/encoding';

export interface EapTlsFragmentFields {
  tlsFlags: { length: boolean; more: boolean; start: boolean };
  tlsMessageLength?: number;
  tlsData: string;
}

/**
 * Default max TLS Data bytes per fragment. Real EAP-TLS implementations
 * commonly fragment at ~1000-1400 bytes, but this simulator carries EAP
 * packets inside RADIUS's EAP-Message (79) attribute, and RFC 2865's
 * 253-byte single-attribute-value limit isn't fragmented across repeated
 * attributes here (`codec.ts`'s `tlv()` — a separate, RADIUS-layer
 * limitation, not an EAP-TLS one) — so every encoded EAP-TLS packet,
 * fragment or not, must itself stay under ~253 raw bytes. 200 bytes of
 * TLS Data leaves headroom for the EAP + Type-Data header on every fragment.
 */
export const DEFAULT_EAP_TLS_MTU = 200;

/** Splits `data` into the ordered sequence of Type-Data fragments a sender transmits for one flight. A single-fragment flight carries no Length field (not needed when there's nothing to reassemble across). */
export function fragmentFlight(data: Uint8Array, mtu: number = DEFAULT_EAP_TLS_MTU): EapTlsFragmentFields[] {
  if (data.length <= mtu) {
    return [{ tlsFlags: { length: false, more: false, start: false }, tlsData: bytesToHex(data) }];
  }
  const fragments: EapTlsFragmentFields[] = [];
  for (let offset = 0; offset < data.length; offset += mtu) {
    const chunk = data.subarray(offset, offset + mtu);
    const isFirst = offset === 0;
    const isLast = offset + mtu >= data.length;
    fragments.push({
      tlsFlags: { length: isFirst, more: !isLast, start: false },
      tlsMessageLength: isFirst ? data.length : undefined,
      tlsData: bytesToHex(chunk),
    });
  }
  return fragments;
}

/** Hands out one fragment at a time, tracking whether the sender is still owed a fragment-ACK before sending the next. */
export class FragmentSender {
  private index = 0;

  constructor(private readonly fragments: EapTlsFragmentFields[]) {}

  static forFlight(data: Uint8Array, mtu: number = DEFAULT_EAP_TLS_MTU): FragmentSender {
    return new FragmentSender(fragmentFlight(data, mtu));
  }

  /** The next fragment to send, or null once all have been sent (caller should not call again). */
  current(): EapTlsFragmentFields {
    return this.fragments[this.index];
  }

  /** True once the just-returned `current()` was the flight's last fragment. */
  isLastFragment(): boolean {
    return this.index >= this.fragments.length - 1;
  }

  /** Advance to the next fragment after the peer's ACK arrives. */
  advance(): void {
    if (this.index < this.fragments.length - 1) this.index++;
  }
}

/** Accumulates incoming Type-Data fragments for one flight until the last one (M unset) arrives. */
export class EapTlsReassembler {
  private chunks: Uint8Array[] = [];

  /** True while a fragment with M set has been received and the sender still owes more (caller should send an empty ACK and wait). */
  get awaitingMore(): boolean {
    return this._awaitingMore;
  }

  private _awaitingMore = false;

  /** Feed one incoming fragment. Returns the fully reassembled flight once the last fragment (M unset) arrives, otherwise null. */
  feed(fields: Pick<EapTlsFragmentFields, 'tlsData' | 'tlsFlags'>): Uint8Array | null {
    this.chunks.push(hexToBytes(fields.tlsData));
    this._awaitingMore = fields.tlsFlags.more;
    if (this._awaitingMore) return null;
    const total = this.chunks.reduce((sum, c) => sum + c.length, 0);
    const full = new Uint8Array(total);
    let offset = 0;
    for (const c of this.chunks) { full.set(c, offset); offset += c.length; }
    this.chunks = [];
    return full;
  }
}
