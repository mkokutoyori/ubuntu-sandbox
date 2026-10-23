/**
 * Probe: LDP Downstream On Demand label distribution
 * (docs/rfc/mpls/rfc5036.txt §2.6.3, §3.5.3 A bit, §3.5.7 Label Request, §3.5.9 Label Abort
 * Request, Appendix A.1.1-A.1.3, Label No Route procedure).
 * Chains of routers with loopback LSR ids and static routes as the IGP, one FEC
 * 9.9.9.0/24 owned by the last router. Both ends configured Downstream On
 * Demand, independent control unless stated.
 * Before the change: all 9 cases fail (the discipline switch does not exist, so
 * the lab cannot even be built). The witness, a session between a Downstream On
 * Demand LSR and a Downstream Unsolicited one, shows the lab refuses what the
 * standard says this LSR cannot accept (§3.5.3).
 * The Request Retry procedure is time-driven: a No Route answer is retried
 * after the configured delay (60 s), not on every reconcile.
 * Not built: Label Request propagation with Hop Count / Path Vector
 * (§2.8.1) and the downstream half of Abort for requests that this LSR also
 * needs for itself (see TODO.md [ldp]).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { LdpIdentifier } from '@/network/ldp/LdpIdentifier';
import { StatusCode } from '@/network/ldp/LdpMessages';
import { IPAddress } from '@/network/core/types';
import { configure, ldpChain, lsr, recordSentMessages, type SentMessage } from './_ldp-chain-lab';

let clock: VirtualTimeScheduler;
let sent: SentMessage[];

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
  sent = recordSentMessages();
});
afterEach(() => vi.restoreAllMocks());

const onDemand = (router: CiscoRouter) => router.getLdpEngine().setAdvertisementMode('on-demand');
const chain = (length: number, extra?: (router: CiscoRouter, index: number) => void) => ldpChain(clock, {
  length, engines: (router, i) => { onDemand(router); extra?.(router, i); },
});
const nineNine = (s: SentMessage) => (s.message.kind === 'label-request' || s.message.kind === 'label-mapping')
  && s.message.fec[0].kind === 'prefix' && String(s.message.fec[0].prefix) === '9.9.9.0';
const holds = (router: CiscoRouter, peer: number) => router.getLdpEngine()
  .remoteBindings(LdpIdentifier.of(new IPAddress(lsr(peer)), 0)).has('9.9.9.0/24');
const labelled = (router: CiscoRouter) => router.getMplsEngine().lfib.ftnEntries().some(e => String(e.prefix) === '9.9.9.0');

describe('LDP Downstream On Demand (RFC 5036)', () => {
  it('Initialization carries A=1 when configured, and both ends negotiate on-demand (§3.5.3)', async () => {
    const [first] = await chain(2);
    expect(sent.find(s => s.message.kind === 'initialization')!.message).toMatchObject({ advertisementMode: 'on-demand' });
    expect(first.getLdpEngine().sessions()[0].negotiated?.advertisementMode).toBe('on-demand');
  });

  it('the ingress asks for the label: a Label Request goes to the next hop before any mapping for the FEC (LRq, A.1.2)', async () => {
    await chain(2);
    const first = sent.findIndex(nineNine);
    expect(sent[first].message.kind).toBe('label-request');
    expect(sent[first].from).toBe(lsr(0));
    expect(sent[first].to).toBe(lsr(1));
  });

  it('the downstream LSR does not advertise unsolicited: its only mapping for the FEC answers the request id (§2.6.3)', async () => {
    await chain(2);
    const request = sent.find(s => nineNine(s) && s.message.kind === 'label-request')!.message;
    const mappings = sent.filter(s => nineNine(s) && s.message.kind === 'label-mapping' && s.from === lsr(1));
    expect(mappings).toHaveLength(1);
    expect(mappings[0].message).toMatchObject({ requestMessageId: request.id });
  });

  it('the answered request installs the label for forwarding on the requester', async () => {
    const [first, second] = await chain(2);
    expect(holds(first, 1)).toBe(true);
    expect(labelled(first)).toBe(true);
    expect(labelled(second)).toBe(false);
  });

  it('across three routers every LSR asks its own next hop and the LSP is labelled end to end', async () => {
    const [first, second] = await chain(3);
    expect(labelled(first)).toBe(true);
    expect(labelled(second)).toBe(true);
    expect(sent.filter(s => s.message.kind === 'label-request' && nineNine(s)).map(s => `${s.from}>${s.to}`).sort())
      .toEqual([`${lsr(0)}>${lsr(1)}`, `${lsr(1)}>${lsr(2)}`]);
  });

  it('a request for a FEC the peer cannot route is answered No Route, and retried only after the delay (Label No Route, Request Retry)', async () => {
    const routers = await chain(2);
    await configure(routers[0], ['ip route 8.8.8.0 255.255.255.0 10.0.0.2']);
    routers[0].getLdpEngine().reconcile();
    clock.advance(30000);
    const requests = () => sent.filter(s => s.message.kind === 'label-request' && s.message.fec[0].kind === 'prefix' && String(s.message.fec[0].prefix) === '8.8.8.0');
    expect(requests()).toHaveLength(1);
    const refusal = sent.find(s => s.message.kind === 'notification' && s.message.statusCode === StatusCode.NoRoute)!;
    expect(refusal.message).toMatchObject({ referencedMessageId: requests()[0].message.id });
    await configure(routers[1], ['interface Loopback8', 'ip address 8.8.8.1 255.255.255.0', 'exit']);
    routers[1].getLdpEngine().reconcile();
    clock.advance(120000);
    expect(requests()).toHaveLength(2);
    expect(routers[0].getLdpEngine().remoteBindings(LdpIdentifier.of(new IPAddress(lsr(1)), 0)).has('8.8.8.0/24')).toBe(true);
  });

  it('ordered control: a request that cannot be answered yet stays pending and is answered when the next hop maps (LRq.9, LMp.29)', async () => {
    const routers = await chain(3, (router, i) => {
      router.getLdpEngine().config.controlMode = 'ordered';
      if (i === 2) router.getLdpEngine().setGloballyEnabled(false);
    });
    expect(holds(routers[0], 1)).toBe(false);
    expect(sent.some(s => s.from === lsr(1) && s.to === lsr(0) && nineNine(s) && s.message.kind === 'label-mapping')).toBe(false);
    routers[2].getLdpEngine().setGloballyEnabled(true);
    clock.advance(60000);
    const request = sent.find(s => s.from === lsr(0) && s.message.kind === 'label-request' && nineNine(s))!.message;
    const answer = sent.find(s => s.from === lsr(1) && s.to === lsr(0) && nineNine(s) && s.message.kind === 'label-mapping')!.message;
    expect(answer).toMatchObject({ requestMessageId: request.id });
    expect(holds(routers[0], 1)).toBe(true);
  });

  it('a Label Abort Request on a pending request is answered Label Request Aborted and the request is never answered (§3.5.9, LAbR.3)', async () => {
    const routers = await chain(3, (router, i) => {
      router.getLdpEngine().config.controlMode = 'ordered';
      if (i === 2) router.getLdpEngine().setGloballyEnabled(false);
    });
    const request = sent.find(s => s.from === lsr(0) && s.message.kind === 'label-request' && nineNine(s))!.message;
    await configure(routers[0], ['no ip route 9.9.9.0 255.255.255.0 10.0.0.2']);
    routers[0].getLdpEngine().reconcile();
    const abort = sent.find(s => s.message.kind === 'label-abort-request')!;
    expect(abort).toMatchObject({ from: lsr(0), to: lsr(1) });
    expect(abort.message).toMatchObject({ requestMessageId: request.id });
    expect(sent.find(s => s.message.kind === 'notification' && s.message.statusCode === StatusCode.LabelRequestAborted)!.message)
      .toMatchObject({ requestMessageId: request.id });
    routers[2].getLdpEngine().setGloballyEnabled(true);
    clock.advance(60000);
    expect(sent.some(s => s.from === lsr(1) && s.to === lsr(0) && nineNine(s) && s.message.kind === 'label-mapping')).toBe(false);
  });

  it('WITNESS: a Downstream On Demand LSR refuses a session with a Downstream Unsolicited one (§3.5.3)', async () => {
    const routers = await ldpChain(clock, { length: 2, engines: (router, i) => { if (i === 0) onDemand(router); } });
    expect(routers[0].getLdpEngine().sessions().filter(s => s.state === 'operational')).toHaveLength(0);
  });
});
