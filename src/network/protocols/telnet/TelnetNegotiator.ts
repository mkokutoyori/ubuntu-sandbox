/**
 * TelnetNegotiator — RFC 855 option state machine for one connection.
 *
 * The rule that matters and is easy to get wrong: an answer is only sent
 * when the option's state actually changes. Acknowledging a `DO` that is
 * already enabled makes the peer acknowledge back, and the two ends loop
 * forever (RFC 854, "the possibility of a negotiation loop"). A refusal
 * of an option this end does not implement is likewise sent once, not on
 * every repetition.
 */

import {
  DO, DONT, WILL, WONT,
  encodeNegotiation,
  type TelnetNegotiation,
  type TelnetVerb,
} from './TelnetCodec';

export interface TelnetOptionPolicy {
  /** Options this end enables on itself, offered as `WILL` and granted on a peer's `DO`. */
  readonly offer: readonly number[];
  /** Options this end asks the peer to enable, sent as `DO` and granted on a peer's `WILL`. */
  readonly request: readonly number[];
}

export class TelnetNegotiator {
  private readonly localEnabled = new Set<number>();
  private readonly remoteEnabled = new Set<number>();
  private readonly localPending = new Set<number>();
  private readonly remotePending = new Set<number>();
  private readonly localRefused = new Set<number>();
  private readonly remoteRefused = new Set<number>();

  constructor(private readonly policy: TelnetOptionPolicy) {}

  /** The `DO`/`WILL` block this end sends as soon as the connection opens. */
  openingOffer(): string {
    const out: string[] = [];
    for (const option of this.policy.request) {
      this.remotePending.add(option);
      out.push(encodeNegotiation(DO, option));
    }
    for (const option of this.policy.offer) {
      this.localPending.add(option);
      out.push(encodeNegotiation(WILL, option));
    }
    return out.join('');
  }

  /** Answers to the peer's negotiations, concatenated; empty when nothing changed. */
  respond(negotiations: readonly TelnetNegotiation[]): string {
    const out: string[] = [];
    for (const n of negotiations) {
      const reply = this.respondOne(n.verb, n.option);
      if (reply) out.push(reply);
    }
    return out.join('');
  }

  isLocalEnabled(option: number): boolean { return this.localEnabled.has(option); }
  isRemoteEnabled(option: number): boolean { return this.remoteEnabled.has(option); }

  private respondOne(verb: TelnetVerb, option: number): string | null {
    switch (verb) {
      case DO: return this.onDo(option);
      case DONT: return this.onDont(option);
      case WILL: return this.onWill(option);
      case WONT: return this.onWont(option);
      default: return null;
    }
  }

  private onDo(option: number): string | null {
    if (!this.policy.offer.includes(option)) {
      if (this.localRefused.has(option)) return null;
      this.localRefused.add(option);
      return encodeNegotiation(WONT, option);
    }
    const acknowledgesOurOffer = this.localPending.delete(option);
    if (this.localEnabled.has(option)) return null;
    this.localEnabled.add(option);
    return acknowledgesOurOffer ? null : encodeNegotiation(WILL, option);
  }

  private onDont(option: number): string | null {
    const acknowledgesOurOffer = this.localPending.delete(option);
    if (this.localEnabled.delete(option)) return encodeNegotiation(WONT, option);
    if (acknowledgesOurOffer || this.localRefused.has(option)) return null;
    this.localRefused.add(option);
    return encodeNegotiation(WONT, option);
  }

  private onWill(option: number): string | null {
    if (!this.policy.request.includes(option)) {
      if (this.remoteRefused.has(option)) return null;
      this.remoteRefused.add(option);
      return encodeNegotiation(DONT, option);
    }
    const acknowledgesOurRequest = this.remotePending.delete(option);
    if (this.remoteEnabled.has(option)) return null;
    this.remoteEnabled.add(option);
    return acknowledgesOurRequest ? null : encodeNegotiation(DO, option);
  }

  private onWont(option: number): string | null {
    const acknowledgesOurRequest = this.remotePending.delete(option);
    if (this.remoteEnabled.delete(option)) return encodeNegotiation(DONT, option);
    if (acknowledgesOurRequest || this.remoteRefused.has(option)) return null;
    this.remoteRefused.add(option);
    return encodeNegotiation(DONT, option);
  }
}
