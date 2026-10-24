import { describe, it, expect } from 'vitest';
import { IPAddress } from '@/network/core/types';
import {
  HOST_REDIRECT_POLICY, REDIRECTS_BEFORE_SILENCE, REDIRECT_LOAD_MS, REDIRECT_SILENCE_MS, RedirectLimiter,
  redirectIsAcceptable, redirectIsDue, type RedirectPolicy,
} from '@/network/layers/internet/IcmpRedirect';

const sender = new IPAddress('10.0.0.2');
const secondSender = new IPAddress('10.0.0.3');

const policy = (overrides: Partial<RedirectPolicy> = {}): RedirectPolicy => ({
  sends: () => true,
  sharesMedia: () => true,
  trustsOnlyListedGateways: () => false,
  accepts: () => true,
  ...overrides,
});

describe('the redirect limiter is ip_rt_send_redirect : nine redirects with exponential back-off, then silence', () => {
  it('has the constants of the kernel : 9 redirects, 20 ms load, and a silence of 20 load periods shifted by 10', () => {
    expect(REDIRECTS_BEFORE_SILENCE).toBe(9);
    expect(REDIRECT_LOAD_MS).toBe(20);
    expect(REDIRECT_SILENCE_MS).toBe(20480);
  });

  it('admits a packet every second at 0 to 5, then at 7, 10 and 16, and nothing after the ninth', () => {
    const limiter = new RedirectLimiter();
    const admitted = Array.from({ length: 24 }, (_, second) => limiter.admit(sender, second * 1000));
    const at = admitted.flatMap((yes, second) => (yes ? [second] : []));
    expect(at).toEqual([0, 1, 2, 3, 4, 5, 7, 10, 16]);
  });

  it('refuses a second packet inside the load period of the first and admits it right after', () => {
    const limiter = new RedirectLimiter();
    expect(limiter.admit(sender, 1000)).toBe(true);
    expect(limiter.admit(sender, 1040)).toBe(false);
    expect(limiter.admit(sender, 1041)).toBe(true);
  });

  it('doubles the load period at every redirect', () => {
    const limiter = new RedirectLimiter();
    limiter.admit(sender, 0);
    limiter.admit(sender, 41);
    expect(limiter.admit(sender, 41 + 80)).toBe(false);
    expect(limiter.admit(sender, 41 + 81)).toBe(true);
    expect(limiter.admit(sender, 41 + 81 + 160)).toBe(false);
    expect(limiter.admit(sender, 41 + 81 + 161)).toBe(true);
  });

  it('keeps every sender on its own account', () => {
    const limiter = new RedirectLimiter();
    expect(limiter.admit(sender, 0)).toBe(true);
    expect(limiter.admit(sender, 10)).toBe(false);
    expect(limiter.admit(secondSender, 10)).toBe(true);
  });

  it('forgets a sender that was quiet for longer than the silence, and keeps one that was not', () => {
    const exhausted = (): RedirectLimiter => {
      const limiter = new RedirectLimiter();
      for (let second = 0; second < 24; second++) limiter.admit(sender, second * 1000);
      return limiter;
    };
    expect(exhausted().admit(sender, 23_000 + REDIRECT_SILENCE_MS)).toBe(false);
    expect(exhausted().admit(sender, 23_000 + REDIRECT_SILENCE_MS + 1)).toBe(true);
    const chatty = exhausted();
    let now = 23_000;
    for (let round = 0; round < 5; round++) {
      now += REDIRECT_SILENCE_MS;
      expect(chatty.admit(sender, now)).toBe(false);
    }
  });

  it('counts the silence from the last refused packet, not from the last redirect', () => {
    const limiter = new RedirectLimiter();
    for (let second = 0; second < 17; second++) limiter.admit(sender, second * 1000);
    expect(limiter.admit(sender, 17_000)).toBe(false);
    expect(limiter.admit(sender, 17_000 + REDIRECT_SILENCE_MS)).toBe(false);
    expect(limiter.admit(sender, 17_000 + 2 * REDIRECT_SILENCE_MS + 1)).toBe(true);
  });
});

describe('a redirect is due when the source is directly connected and the interface sends them', () => {
  const facts = { iface: 'eth0', sourceIsDirectlyConnected: true, sourceOnLinkWithGateway: false };

  it('is due on shared media for a directly connected source', () => {
    expect(redirectIsDue(policy(), facts)).toBe(true);
  });

  it('is not due when the source is behind a gateway', () => {
    expect(redirectIsDue(policy(), { ...facts, sourceIsDirectlyConnected: false })).toBe(false);
  });

  it('is not due when the interface does not send redirects', () => {
    expect(redirectIsDue(policy({ sends: () => false }), facts)).toBe(false);
  });

  it('asks the interface it was given, not another', () => {
    const asked: string[] = [];
    redirectIsDue(policy({ sends: (iface) => { asked.push(iface); return true; }, sharesMedia: (iface) => { asked.push(iface); return true; } }), facts);
    expect(asked).toEqual(['eth0', 'eth0']);
  });

  it.each([
    [true, false, true],
    [false, true, true],
    [false, false, false],
  ])('shared media %s with the gateway on the source link %s makes the redirect due: %s', (shared, onLink, due) => {
    expect(redirectIsDue(policy({ sharesMedia: () => shared }), { ...facts, sourceOnLinkWithGateway: onLink })).toBe(due);
  });

  it('never makes an end host send one', () => {
    expect(redirectIsDue(HOST_REDIRECT_POLICY, facts)).toBe(false);
  });
});

describe('a redirect is acceptable as __ip_do_redirect decides', () => {
  const advice = {
    arrivedOn: 'eth0',
    forwarding: false,
    oldGateway: new IPAddress('10.0.0.1'),
    newGateway: new IPAddress('10.0.0.254'),
    newGatewayUsable: true,
    newGatewayOnLinkWithOld: true,
    newGatewayListed: true,
  };

  it('is accepted on shared media for a usable gateway', () => {
    expect(redirectIsAcceptable(policy(), advice)).toBe(true);
  });

  it('is refused when it names the gateway that sent it', () => {
    expect(redirectIsAcceptable(policy(), { ...advice, newGateway: advice.oldGateway })).toBe(false);
  });

  it('is refused when the interface does not accept redirects', () => {
    expect(redirectIsAcceptable(policy({ accepts: () => false }), advice)).toBe(false);
  });

  it('hands the forwarding state to the interface', () => {
    const seen: boolean[] = [];
    redirectIsAcceptable(policy({ accepts: (_iface, forwarding) => { seen.push(forwarding); return true; } }), { ...advice, forwarding: true });
    expect(seen).toEqual([true]);
  });

  it('is refused when the new gateway is not unicast, local or routable', () => {
    expect(redirectIsAcceptable(policy(), { ...advice, newGatewayUsable: false })).toBe(false);
  });

  it('is refused off shared media when the new gateway is not on the link of the old one', () => {
    const apart = policy({ sharesMedia: () => false });
    expect(redirectIsAcceptable(apart, { ...advice, newGatewayOnLinkWithOld: false })).toBe(false);
    expect(redirectIsAcceptable(apart, advice)).toBe(true);
  });

  it('is refused off shared media, with secure_redirects, when the new gateway is not a configured one', () => {
    const secure = policy({ sharesMedia: () => false, trustsOnlyListedGateways: () => true });
    expect(redirectIsAcceptable(secure, { ...advice, newGatewayListed: false })).toBe(false);
    expect(redirectIsAcceptable(secure, advice)).toBe(true);
  });

  it('does not look at secure_redirects on shared media', () => {
    const secure = policy({ trustsOnlyListedGateways: () => true });
    expect(redirectIsAcceptable(secure, { ...advice, newGatewayListed: false, newGatewayOnLinkWithOld: false })).toBe(true);
  });

  it('is what an end host without a kernel policy does : accept', () => {
    expect(redirectIsAcceptable(HOST_REDIRECT_POLICY, advice)).toBe(true);
    expect(redirectIsAcceptable(HOST_REDIRECT_POLICY, { ...advice, newGatewayOnLinkWithOld: false, newGatewayListed: false })).toBe(true);
  });

  it('gives an end host the whole of the media, no secure_redirects check, and no redirect to send', () => {
    expect(HOST_REDIRECT_POLICY.sharesMedia('eth0')).toBe(true);
    expect(HOST_REDIRECT_POLICY.trustsOnlyListedGateways('eth0')).toBe(false);
    expect(HOST_REDIRECT_POLICY.accepts('eth0', false)).toBe(true);
    expect(HOST_REDIRECT_POLICY.sends('eth0')).toBe(false);
  });
});
