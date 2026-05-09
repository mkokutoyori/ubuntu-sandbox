/**
 * FilterChain primitive — Chain of Responsibility, observable.
 *
 * Tested independently of any domain so we know the primitive itself
 * is solid before we build IPSec inbound/outbound chains on top.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  FilterChain,
  makeFilter,
  Continue,
  Accept,
  Transform,
  Drop,
  Reject,
} from '@/network/core/FilterChain';
import { EventBus } from '@/events/EventBus';
import type { DomainEvent } from '@/events/types';

interface Pkt {
  src: string;
  dst: string;
  size: number;
}

const samplePkt: Pkt = { src: '10.0.0.1', dst: '10.0.0.2', size: 100 };

describe('FilterChain — verdicts', () => {
  it('accepts the payload when every filter returns continue', () => {
    const chain = new FilterChain<Pkt>({ chainId: 'test', emitEvents: false });
    chain
      .add(makeFilter('a', () => Continue()))
      .add(makeFilter('b', () => Continue()));

    const outcome = chain.process(samplePkt);
    expect(outcome.verdict).toBe('accepted');
    expect(outcome.payload).toEqual(samplePkt);
    expect(outcome.trace).toEqual(['a', 'b']);
  });

  it('short-circuits on Accept', () => {
    const chain = new FilterChain<Pkt>({ chainId: 'test', emitEvents: false });
    const lastSpy = vi.fn(() => Continue());
    chain
      .add(makeFilter('a', () => Continue()))
      .add(makeFilter('b', (p) => Accept(p)))
      .add(makeFilter('c', lastSpy));

    const outcome = chain.process(samplePkt);
    expect(outcome.verdict).toBe('accepted');
    expect(outcome.decidedBy).toBe('b');
    expect(lastSpy).not.toHaveBeenCalled();
  });

  it('Drop terminates with reason', () => {
    const chain = new FilterChain<Pkt>({ chainId: 'test', emitEvents: false });
    chain
      .add(makeFilter('size-check', (p) => p.size > 50 ? Drop('too big') : Continue()));

    const outcome = chain.process(samplePkt);
    expect(outcome.verdict).toBe('dropped');
    expect(outcome.reason).toBe('too big');
    expect(outcome.decidedBy).toBe('size-check');
  });

  it('Reject terminates with code + reason', () => {
    const chain = new FilterChain<Pkt>({ chainId: 'test', emitEvents: false });
    chain.add(makeFilter('auth', () => Reject('AUTH_FAIL', 'bad HMAC')));

    const outcome = chain.process(samplePkt);
    expect(outcome.verdict).toBe('rejected');
    expect(outcome.code).toBe('AUTH_FAIL');
    expect(outcome.reason).toBe('bad HMAC');
  });

  it('Transform passes a new payload to subsequent filters', () => {
    const chain = new FilterChain<Pkt>({ chainId: 'test', emitEvents: false });
    chain
      .add(makeFilter('decap', (p) => Transform({ ...p, size: p.size - 50 })))
      .add(makeFilter('audit', (p) => p.size === 50 ? Accept(p) : Drop('unexpected')));

    const outcome = chain.process(samplePkt);
    expect(outcome.verdict).toBe('accepted');
    expect(outcome.payload!.size).toBe(50);
  });

  it('a thrown filter is converted to a reject without breaking the API', () => {
    const chain = new FilterChain<Pkt>({ chainId: 'test', emitEvents: false });
    chain.add(makeFilter('boom', () => { throw new Error('explosion'); }));

    expect(() => chain.process(samplePkt)).not.toThrow();
    const outcome = chain.process(samplePkt);
    expect(outcome.verdict).toBe('rejected');
    expect(outcome.code).toBe('FILTER_THREW');
    expect(outcome.reason).toContain('explosion');
  });
});

describe('FilterChain — composition API', () => {
  it('add / addBefore / addAfter / remove / replace', () => {
    const chain = new FilterChain<Pkt>({ chainId: 'test', emitEvents: false });
    chain.add(makeFilter('a', () => Continue()));
    chain.add(makeFilter('c', () => Continue()));
    chain.addBefore('c', makeFilter('b', () => Continue()));
    chain.addAfter('c', makeFilter('d', () => Continue()));
    expect(chain.names()).toEqual(['a', 'b', 'c', 'd']);

    chain.remove('b');
    expect(chain.names()).toEqual(['a', 'c', 'd']);

    chain.replace(makeFilter('c', () => Drop('replaced')));
    expect(chain.process(samplePkt).verdict).toBe('dropped');
  });

  it('add throws on duplicate name', () => {
    const chain = new FilterChain<Pkt>({ chainId: 'test', emitEvents: false });
    chain.add(makeFilter('a', () => Continue()));
    expect(() => chain.add(makeFilter('a', () => Continue()))).toThrow();
  });

  it('addBefore / addAfter throw on missing target', () => {
    const chain = new FilterChain<Pkt>({ chainId: 'test', emitEvents: false });
    expect(() => chain.addBefore('a', makeFilter('b', () => Continue()))).toThrow();
    expect(() => chain.addAfter('a', makeFilter('b', () => Continue()))).toThrow();
  });

  it('replace throws when target name not found', () => {
    const chain = new FilterChain<Pkt>({ chainId: 'test', emitEvents: false });
    expect(() => chain.replace(makeFilter('z', () => Continue()))).toThrow();
  });

  it('remove returns false when name absent', () => {
    const chain = new FilterChain<Pkt>({ chainId: 'test', emitEvents: false });
    expect(chain.remove('nope')).toBe(false);
  });

  it('clear empties the chain', () => {
    const chain = new FilterChain<Pkt>({ chainId: 'test', emitEvents: false });
    chain.add(makeFilter('a', () => Continue()));
    chain.clear();
    expect(chain.size()).toBe(0);
  });
});

describe('FilterChain — bus observability', () => {
  it('emits log events for chain start and completion', () => {
    const bus = new EventBus();
    const trace: DomainEvent[] = [];
    bus.subscribeAll((e) => trace.push(e));

    const chain = new FilterChain<Pkt>({ chainId: 'audit', bus });
    chain.add(makeFilter('always-accept', (p) => Accept(p)));
    chain.process(samplePkt);

    const logs = trace.filter((e) => e.topic === 'log' && e.payload.source === 'filterchain:audit');
    // started + completed:accepted
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs.find(
      (e) => e.topic === 'log' && e.payload.event === 'completed:accepted',
    )).toBeDefined();
  });

  it('emits warn-level log on reject', () => {
    const bus = new EventBus();
    const trace: DomainEvent[] = [];
    bus.subscribeAll((e) => trace.push(e));

    const chain = new FilterChain<Pkt>({ chainId: 'audit', bus });
    chain.add(makeFilter('deny', () => Reject('NO', 'no')));
    chain.process(samplePkt);

    const reject = trace.find(
      (e) =>
        e.topic === 'log' &&
        e.payload.event === 'completed:rejected' &&
        e.payload.level === 'warn',
    );
    expect(reject).toBeDefined();
  });

  it('emitEvents:false silences the chain', () => {
    const bus = new EventBus();
    const trace: DomainEvent[] = [];
    bus.subscribeAll((e) => trace.push(e));

    const chain = new FilterChain<Pkt>({ chainId: 'silent', bus, emitEvents: false });
    chain.add(makeFilter('always-accept', (p) => Accept(p)));
    chain.process(samplePkt);

    expect(trace.filter((e) => e.topic === 'log' && e.payload.source === 'filterchain:silent'))
      .toEqual([]);
  });
});

describe('FilterChain — realistic IPSec-like inbound chain', () => {
  interface InboundCtx {
    spi: number;
    seqNum: number;
    payloadLen: number;
    decryptedPayloadLen?: number;
    fromIp: string;
  }
  const incoming: InboundCtx = {
    spi: 0x100,
    seqNum: 42,
    payloadLen: 1280,
    fromIp: '10.0.0.2',
  };

  it('accepts a normal flow through anti-replay → integrity → decrypt → policy', () => {
    const chain = new FilterChain<InboundCtx>({ chainId: 'ipsec.in', emitEvents: false });
    chain
      .add(makeFilter('anti-replay', (c) => c.seqNum > 0 ? Continue() : Reject('REPLAY', 'seq=0')))
      .add(makeFilter('integrity', () => Continue() /* would HMAC-verify */))
      .add(makeFilter('decrypt', (c) => Transform({ ...c, decryptedPayloadLen: c.payloadLen - 16 })))
      .add(makeFilter('policy', (c) => c.fromIp.startsWith('10.') ? Accept(c) : Reject('POLICY', 'wrong scope')));

    const outcome = chain.process(incoming);
    expect(outcome.verdict).toBe('accepted');
    expect(outcome.payload!.decryptedPayloadLen).toBe(1264);
    expect(outcome.trace).toEqual(['anti-replay', 'integrity', 'decrypt', 'policy']);
    expect(outcome.decidedBy).toBe('policy');
  });

  it('drops a replayed packet at the very first filter (no decrypt cost)', () => {
    const chain = new FilterChain<InboundCtx>({ chainId: 'ipsec.in', emitEvents: false });
    let decryptCalls = 0;
    chain
      .add(makeFilter('anti-replay', (c) => c.seqNum < 0 ? Drop('replay') : Continue()))
      .add(makeFilter('decrypt', () => { decryptCalls++; return Continue(); }));

    const outcome = chain.process({ ...incoming, seqNum: -1 });
    expect(outcome.verdict).toBe('dropped');
    expect(outcome.reason).toBe('replay');
    expect(decryptCalls).toBe(0);
  });

  it('a custom anti-DDoS filter slots in via addBefore() without touching the chain code', () => {
    const chain = new FilterChain<InboundCtx>({ chainId: 'ipsec.in', emitEvents: false });
    chain
      .add(makeFilter('anti-replay', () => Continue()))
      .add(makeFilter('decrypt', () => Continue()));

    // External plug-in: rate limiter inserted before anti-replay.
    const seenSpis = new Set<number>();
    chain.addBefore('anti-replay', makeFilter('rate-limit', (c) => {
      if (seenSpis.has(c.spi)) return Drop('rate-limit');
      seenSpis.add(c.spi);
      return Continue();
    }));

    expect(chain.process(incoming).verdict).toBe('accepted');
    expect(chain.process(incoming).verdict).toBe('dropped');
  });
});
