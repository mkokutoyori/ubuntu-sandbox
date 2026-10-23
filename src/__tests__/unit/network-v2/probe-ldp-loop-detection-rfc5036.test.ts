/**
 * Probe: LDP loop detection with Path Vector and Hop Count on Label Mapping
 * (docs/rfc/mpls/rfc5036.txt §2.8.2, §3.5.3 Initialization D/PVLim, A.1.7 LMp.3-LMp.8).
 * Chains of routers with loopback LSR ids and static routes as the IGP, one FEC
 * 9.9.9.0/24 owned by the last router (egress). A two-router lab points the FEC
 * at each other to build a real forwarding loop.
 * Unsolicited downstream, independent control, liberal retention only: Label
 * Request propagation (§2.8.1) is not built (see TODO.md [ldp]).
 * Before the change: all 8 cases fail (the loop-detection switch does not exist).
 * The two witnesses prove the lab itself: they run with loop detection off or
 * negotiated off and show the same loop installed, the mappings bare.
 * WITNESS: the same loop without loop detection leaves both bindings installed
 * (the lab does build the loop); loop detection enabled on one end only is not
 * negotiated and leaves the mappings bare.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { configure, ldpChain, lsr, recordSentMessages, type SentMessage } from './_ldp-chain-lab';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { LdpIdentifier } from '@/network/ldp/LdpIdentifier';
import { StatusCode } from '@/network/ldp/LdpMessages';
import { IPAddress } from '@/network/core/types';

let clock: VirtualTimeScheduler;
let sent: SentMessage[];

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
  sent = recordSentMessages();
});
afterEach(() => vi.restoreAllMocks());

interface ChainOptions {
  readonly length: number;
  readonly detection: readonly boolean[];
  readonly egress?: boolean;
  readonly setup?: (routers: CiscoRouter[]) => void;
}

const chain = (options: ChainOptions) => ldpChain(clock, {
  length: options.length, egress: options.egress, setup: options.setup,
  engines: (router, i) => router.getLdpEngine().setLoopDetection(options.detection[i]),
});

async function loop(detection: readonly [boolean, boolean]) {
  const routers = await chain({
    length: 2, detection, egress: false,
    setup: ([first, second]) => {
      void first;
      void second;
    },
  });
  await configure(routers[1], ['ip route 9.9.9.0 255.255.255.0 10.0.0.1']);
  routers[1].getLdpEngine().reconcile();
  clock.advance(60000);
  return routers;
}

const mappingsFor = (from: string, to?: string) => sent.filter(s => s.from === from && (to === undefined || s.to === to) && s.message.kind === 'label-mapping')
  .map(s => s.message).filter(m => m.kind === 'label-mapping' && m.fec[0].kind === 'prefix' && String(m.fec[0].prefix) === '9.9.9.0');

describe('LDP loop detection (RFC 5036 §2.8)', () => {
  it('Initialization carries D=1 and the Path Vector Limit (254, the Cisco default that tracks mpls ldp maxhops) when loop detection is on (§3.5.3)', async () => {
    await chain({ length: 2, detection: [true, true] });
    const init = sent.find(s => s.message.kind === 'initialization')!.message;
    expect(init).toMatchObject({ loopDetection: true, pathVectorLimit: 254 });
  });

  it('the egress sends hop count 1 and no path vector; the next LSR first sends an unknown hop count (0), then 2 with a path vector holding its own id once it has learned the mapping (§2.8.2)', async () => {
    await chain({ length: 3, detection: [true, true, true] });
    expect(mappingsFor(lsr(2))[0]).toMatchObject({ hopCount: 1 });
    expect(mappingsFor(lsr(2))[0]).not.toHaveProperty('pathVector');
    const relayed = mappingsFor(lsr(1), lsr(0)).at(-1);
    expect(mappingsFor(lsr(1), lsr(0))[0]).toMatchObject({ hopCount: 0 });
    expect(relayed).toMatchObject({ hopCount: 2 });
    expect((relayed?.kind === 'label-mapping' ? relayed.pathVector ?? [] : []).map(String)).toEqual([lsr(1)]);
  });

  it('a mapping whose path vector holds the receiver is dropped and answered with a Label Release carrying Loop Detected (LMp.3, LMp.8)', async () => {
    const [first, second] = await loop([true, true]);
    const releases = sent.filter(s => s.message.kind === 'label-release' && s.message.status === StatusCode.LoopDetected);
    expect(releases.length).toBeGreaterThan(0);
    const holds = (router: CiscoRouter, peer: number) => router.getLdpEngine()
      .remoteBindings(LdpIdentifier.of(new IPAddress(lsr(peer)), 0)).has('9.9.9.0/24');
    expect([holds(first, 1), holds(second, 0)].filter(Boolean)).toHaveLength(1);
    expect(first.getLdpEngine().loopsDetected + second.getLdpEngine().loopsDetected).toBeGreaterThan(0);
    expect(first.getLdpEngine().loopsReported + second.getLdpEngine().loopsReported).toBeGreaterThan(0);
  });

  it('the looping mapping is not used for forwarding: no label is installed towards the loop', async () => {
    const [first, second] = await loop([true, true]);
    const labelled = (router: CiscoRouter) => router.getMplsEngine().lfib.ftnEntries().some(e => String(e.prefix) === '9.9.9.0');
    expect(labelled(first) && labelled(second)).toBe(false);
  });

  it('WITNESS: without loop detection the same loop leaves both bindings installed', async () => {
    const [first, second] = await loop([false, false]);
    const labelled = (router: CiscoRouter) => router.getMplsEngine().lfib.ftnEntries().some(e => String(e.prefix) === '9.9.9.0');
    expect(labelled(first)).toBe(true);
    expect(labelled(second)).toBe(true);
    expect(first.getLdpEngine().loopsDetected).toBe(0);
  });

  it('a hop count above the configured maximum is treated as a loop (§2.8.2)', async () => {
    const routers = await chain({ length: 3, detection: [true, true, true], setup: r => { r[2].getLdpEngine().config.maxHopCount = 1; } });
    expect(routers[0].getMplsEngine().lfib.ftnEntries().some(e => String(e.prefix) === '9.9.9.0')).toBe(true);
    const held = [...routers[2].getLdpEngine().remoteBindings(LdpIdentifier.of(new IPAddress(lsr(1)), 0)).keys()];
    expect(held).not.toContain('9.9.9.0/24');
    expect([...routers[1].getLdpEngine().remoteBindings(LdpIdentifier.of(new IPAddress(lsr(2)), 0)).keys()]).toContain('9.9.9.0/24');
  });

  it('a path vector longer than the configured limit is treated as a loop, and an LSR whose own vector would exceed it does not advertise (§3.5.3)', async () => {
    const routers = await chain({ length: 4, detection: [true, true, true, true], setup: r => { r[0].getLdpEngine().config.pathVectorLimit = 1; } });
    const held = [...routers[0].getLdpEngine().remoteBindings(LdpIdentifier.of(new IPAddress(lsr(1)), 0)).keys()];
    expect(held).not.toContain('9.9.9.0/24');
  });

  it('WITNESS: loop detection on one end only is not negotiated, so mappings stay bare', async () => {
    await chain({ length: 3, detection: [true, true, false] });
    const toThird = mappingsFor(lsr(1), lsr(2))[0];
    const toFirst = mappingsFor(lsr(1), lsr(0))[0];
    expect(toFirst).toHaveProperty('hopCount');
    expect(toThird).not.toHaveProperty('hopCount');
    expect(toThird).not.toHaveProperty('pathVector');
  });
});
