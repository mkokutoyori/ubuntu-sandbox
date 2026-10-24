import type { IPAddress } from '../../core/types';

export interface RedirectPolicy {
  sends(iface: string): boolean;
  sharesMedia(iface: string): boolean;
  trustsOnlyListedGateways(iface: string): boolean;
  accepts(iface: string, forwarding: boolean): boolean;
}

export const HOST_REDIRECT_POLICY: RedirectPolicy = {
  sends: () => false,
  sharesMedia: () => true,
  trustsOnlyListedGateways: () => false,
  accepts: () => true,
};

export const REDIRECTS_BEFORE_SILENCE = 9;
export const REDIRECT_LOAD_MS = 20;
export const REDIRECT_SILENCE_MS = REDIRECT_LOAD_MS * 2 ** (REDIRECTS_BEFORE_SILENCE + 1);
const UNSEEN_PEER_AGE_MS = 60_000;

interface RedirectPeer {
  rateLast: number;
  redirects: number;
}

export class RedirectLimiter {
  private readonly peers = new Map<string, RedirectPeer>();

  admit(source: IPAddress, now: number): boolean {
    const key = source.toString();
    const peer = this.peers.get(key) ?? { rateLast: now - UNSEEN_PEER_AGE_MS, redirects: 0 };
    this.peers.set(key, peer);
    if (now > peer.rateLast + REDIRECT_SILENCE_MS) peer.redirects = 0;
    if (peer.redirects >= REDIRECTS_BEFORE_SILENCE) {
      peer.rateLast = now;
      return false;
    }
    if (peer.redirects === 0 || now > peer.rateLast + REDIRECT_LOAD_MS * 2 ** peer.redirects) {
      peer.rateLast = now;
      peer.redirects += 1;
      return true;
    }
    return false;
  }
}

export interface RedirectDueFacts {
  readonly iface: string;
  readonly sourceIsDirectlyConnected: boolean;
  readonly sourceOnLinkWithGateway: boolean;
}

export function redirectIsDue(policy: RedirectPolicy, facts: RedirectDueFacts): boolean {
  return facts.sourceIsDirectlyConnected
    && policy.sends(facts.iface)
    && (policy.sharesMedia(facts.iface) || facts.sourceOnLinkWithGateway);
}

export interface RedirectAdvice {
  readonly arrivedOn: string;
  readonly forwarding: boolean;
  readonly oldGateway: IPAddress;
  readonly newGateway: IPAddress;
  readonly newGatewayUsable: boolean;
  readonly newGatewayOnLinkWithOld: boolean;
  readonly newGatewayListed: boolean;
}

export function redirectIsAcceptable(policy: RedirectPolicy, advice: RedirectAdvice): boolean {
  if (advice.newGateway.equals(advice.oldGateway)) return false;
  if (!policy.accepts(advice.arrivedOn, advice.forwarding)) return false;
  if (!advice.newGatewayUsable) return false;
  if (policy.sharesMedia(advice.arrivedOn)) return true;
  return advice.newGatewayOnLinkWithOld
    && (!policy.trustsOnlyListedGateways(advice.arrivedOn) || advice.newGatewayListed);
}
