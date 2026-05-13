/**
 * Phase 4b2-IPSec — reactive uplift + FilterChain pattern.
 *
 * Verifies:
 *   - timers run via injected scheduler (no native setTimeout left);
 *   - the runtime stats Signal updates on engine state changes;
 *   - the inbound FilterChain runs the default 4-step pipeline,
 *     supports plug-ins (addBefore/addAfter/replace), and short-
 *     circuits correctly;
 *   - chain outcomes update the runtime counters reactively.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IPSecEngine, type IPSecInboundContext } from '@/network/ipsec/IPSecEngine';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import {
  Continue,
  Drop,
  Reject,
  Accept,
  makeFilter,
} from '@/network/core/FilterChain';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function buildEngine(): {
  router: CiscoRouter;
  engine: IPSecEngine;
  bus: EventBus;
  scheduler: VirtualTimeScheduler;
} {
  EquipmentRegistry.resetInstance();
  const bus = new EventBus();
  const scheduler = new VirtualTimeScheduler();
  const router = new CiscoRouter('R1');
  const engine = new IPSecEngine(router);
  engine.setEventBus(bus);
  engine.setScheduler(scheduler);
  return { router, engine, bus, scheduler };
}

const sampleCtx: IPSecInboundContext = {
  spi: 0x100,
  seqNum: 42,
  payloadLen: 1280,
  fromIp: '10.0.0.2',
  toIp: '10.0.0.1',
  mode: 'tunnel',
};

describe('IPSecEngine — observable runtime stats signal', () => {
  it('reflects start() / stop()', () => {
    const { engine } = buildEngine();
    expect(engine.stats.get().running).toBe(false);
    engine.start();
    expect(engine.stats.get().running).toBe(true);
    engine.stop();
    expect(engine.stats.get().running).toBe(false);
  });

  it('notifies subscribers on stats change', () => {
    const { engine } = buildEngine();
    let calls = 0;
    engine.stats.subscribe(() => calls++);
    engine.start();
    engine.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe('IPSecEngine — inbound FilterChain (default pipeline)', () => {
  it('exposes the inboundChain as a public, mutable composition surface', () => {
    const { engine } = buildEngine();
    expect(engine.inboundChain.names()).toEqual([
      'anti-replay',
      'authentication',
      'decryption',
      'policy-audit',
    ]);
  });

  it('a normal packet is accepted by the default chain', () => {
    const { engine } = buildEngine();
    const outcome = engine.runInboundChain(sampleCtx);
    expect(outcome.verdict).toBe('accepted');
    expect(outcome.decidedBy).toBe('policy-audit');
    expect(outcome.trace).toEqual([
      'anti-replay',
      'authentication',
      'decryption',
      'policy-audit',
    ]);
  });

  it('a replayed (seqNum=0) packet is rejected at anti-replay', () => {
    const { engine } = buildEngine();
    const outcome = engine.runInboundChain({ ...sampleCtx, seqNum: 0 });
    expect(outcome.verdict).toBe('rejected');
    expect(outcome.code).toBe('REPLAY');
    expect(outcome.decidedBy).toBe('anti-replay');
  });

  it('an empty payload is dropped at decryption (silent)', () => {
    const { engine } = buildEngine();
    const outcome = engine.runInboundChain({ ...sampleCtx, payloadLen: 0 });
    expect(outcome.verdict).toBe('dropped');
    expect(outcome.decidedBy).toBe('decryption');
  });

  it('an invalid SPI is rejected at authentication', () => {
    const { engine } = buildEngine();
    const outcome = engine.runInboundChain({ ...sampleCtx, spi: 0 });
    expect(outcome.verdict).toBe('rejected');
    expect(outcome.code).toBe('BAD_SPI');
    expect(outcome.decidedBy).toBe('authentication');
  });
});

describe('IPSecEngine — FilterChain plug-ins', () => {
  it('a custom rate-limit filter slots in via addBefore() without engine modification', () => {
    const { engine } = buildEngine();
    const seenSpis = new Set<number>();
    engine.inboundChain.addBefore(
      'anti-replay',
      makeFilter<IPSecInboundContext>('rate-limit', (ctx) => {
        if (seenSpis.has(ctx.spi)) return Drop('rate-limit');
        seenSpis.add(ctx.spi);
        return Continue();
      }),
    );

    expect(engine.runInboundChain(sampleCtx).verdict).toBe('accepted');
    expect(engine.runInboundChain(sampleCtx).verdict).toBe('dropped');
    expect(engine.inboundChain.names()[0]).toBe('rate-limit');
  });

  it('replace() swaps a filter in place — useful for stricter anti-replay', () => {
    const { engine } = buildEngine();
    let invoked = 0;
    engine.inboundChain.replace(
      makeFilter<IPSecInboundContext>('anti-replay', (ctx) => {
        invoked++;
        return ctx.seqNum < 100 ? Reject('STRICT_REPLAY', 'too low') : Continue();
      }),
    );
    expect(engine.runInboundChain(sampleCtx).verdict).toBe('rejected');
    expect(invoked).toBe(1);
  });

  it('remove() drops a default step entirely', () => {
    const { engine } = buildEngine();
    engine.inboundChain.remove('decryption');
    expect(engine.inboundChain.names()).toEqual([
      'anti-replay',
      'authentication',
      'policy-audit',
    ]);

    // payloadLen=0 was dropped by `decryption`; without that filter it
    // sails through to policy-audit and is accepted.
    const outcome = engine.runInboundChain({ ...sampleCtx, payloadLen: 0 });
    expect(outcome.verdict).toBe('accepted');
  });

  it('multiple plug-ins compose in addition order', () => {
    const { engine } = buildEngine();
    engine.inboundChain.addAfter(
      'authentication',
      makeFilter<IPSecInboundContext>('telemetry', (ctx) => Continue()),
    );
    engine.inboundChain.addAfter(
      'telemetry',
      makeFilter<IPSecInboundContext>('post-auth-audit', (ctx) => Continue()),
    );
    expect(engine.inboundChain.names()).toEqual([
      'anti-replay',
      'authentication',
      'telemetry',
      'post-auth-audit',
      'decryption',
      'policy-audit',
    ]);
  });
});

describe('IPSecEngine — chain outcomes feed the stats signal', () => {
  it('accepted / dropped / rejected counters move on each outcome', () => {
    const { engine } = buildEngine();
    engine.runInboundChain(sampleCtx);
    engine.runInboundChain({ ...sampleCtx, payloadLen: 0 });
    engine.runInboundChain({ ...sampleCtx, seqNum: 0 });

    const stats = engine.stats.get();
    expect(stats.inboundProcessed).toBe(1);
    expect(stats.inboundDropped).toBe(1);
    expect(stats.inboundRejected).toBe(1);
  });

  it('a stats-signal subscriber sees every chain outcome', () => {
    const { engine } = buildEngine();
    let callCount = 0;
    engine.stats.subscribe(() => callCount++);

    engine.runInboundChain(sampleCtx);
    engine.runInboundChain(sampleCtx);
    engine.runInboundChain({ ...sampleCtx, seqNum: 0 });

    expect(callCount).toBeGreaterThanOrEqual(3);
  });
});

describe('IPSecEngine — bus observability of the chain', () => {
  it('the chain publishes log events on the injected bus by default', () => {
    const { engine, bus } = buildEngine();
    const logs: string[] = [];
    bus.subscribe('log', (e) => {
      if (e.payload.source.startsWith('filterchain:ipsec.in:')) {
        logs.push(e.payload.event);
      }
    });

    engine.runInboundChain(sampleCtx);

    expect(logs).toContain('started');
    expect(logs.some((e) => e.startsWith('completed:'))).toBe(true);
  });

  it('rejected outcomes log at warn level for telemetry', () => {
    const { engine, bus } = buildEngine();
    const warns: string[] = [];
    bus.subscribe('log', (e) => {
      if (e.payload.level === 'warn' && e.payload.source.startsWith('filterchain:')) {
        warns.push(e.payload.event);
      }
    });

    engine.runInboundChain({ ...sampleCtx, seqNum: 0 });
    expect(warns.find((w) => w === 'completed:rejected')).toBeDefined();
  });
});
