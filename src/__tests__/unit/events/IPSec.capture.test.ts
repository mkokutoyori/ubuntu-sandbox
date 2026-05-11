/**
 * Phase 4b2-IPSec.deeper — IPSecCaptureActor + DPD events.
 *
 * Tests the opt-in IPSec recorder + the DPD reactive emissions.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IPSecEngine } from '@/network/ipsec/IPSecEngine';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EventBus } from '@/events/EventBus';
import { IPSecCaptureActor } from '@/network/ipsec/actors';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function buildEngine(): { router: CiscoRouter; engine: IPSecEngine; bus: EventBus } {
  EquipmentRegistry.resetInstance();
  const bus = new EventBus();
  const router = new CiscoRouter('R1');
  const engine = new IPSecEngine(router);
  engine.setEventBus(bus);
  return { router, engine, bus };
}

describe('IPSecCaptureActor — opt-in tcpdump-like recorder', () => {
  it('records inbound and outbound chain outcomes', () => {
    const { engine, bus } = buildEngine();
    const capture = new IPSecCaptureActor(bus);
    capture.start();

    engine.runInboundChain({
      spi: 0x100,
      seqNum: 42,
      payloadLen: 1280,
      fromIp: '10.0.0.2',
      toIp: '10.0.0.1',
      mode: 'tunnel',
    });
    engine.runOutboundChain({
      fromIp: '10.0.0.1',
      toIp: '10.0.0.2',
      payloadLen: 1280,
      spdVerdict: 'protect',
      outboundSpi: 0x200,
    });

    const cap = capture.getCapture();
    expect(cap.find((c) => c.kind === 'inbound-outcome')).toBeDefined();
    expect(cap.find((c) => c.kind === 'outbound-outcome')).toBeDefined();
  });

  it('filters by kind', () => {
    const { engine, bus } = buildEngine();
    const capture = new IPSecCaptureActor(bus);
    capture.start();

    engine.runInboundChain({
      spi: 0x100,
      seqNum: 42,
      payloadLen: 1280,
      fromIp: '10.0.0.2',
      toIp: '10.0.0.1',
    });
    engine.runOutboundChain({
      fromIp: '10.0.0.1',
      toIp: '10.0.0.2',
      payloadLen: 1280,
    });

    expect(capture.getCapture({ kind: 'inbound-outcome' })).toHaveLength(1);
    expect(capture.getCapture({ kind: 'outbound-outcome' })).toHaveLength(1);
  });

  it('filters by deviceId for multi-engine capture', () => {
    EquipmentRegistry.resetInstance();
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const e1 = new IPSecEngine(r1);
    const e2 = new IPSecEngine(r2);
    e1.setEventBus(bus);
    e2.setEventBus(bus);

    const capture = new IPSecCaptureActor(bus);
    capture.start();

    e1.runInboundChain({
      spi: 0x100, seqNum: 1, payloadLen: 100,
      fromIp: 'a', toIp: 'b',
    });
    e2.runInboundChain({
      spi: 0x200, seqNum: 1, payloadLen: 100,
      fromIp: 'c', toIp: 'd',
    });

    expect(capture.getCapture({ deviceId: r1.id })).toHaveLength(1);
    expect(capture.getCapture({ deviceId: r2.id })).toHaveLength(1);
    expect(capture.getCapture()).toHaveLength(2);
  });

  it('records SA install / delete events', () => {
    const { engine, bus, router } = buildEngine();
    const capture = new IPSecCaptureActor(bus);
    capture.start();

    bus.publish({
      topic: 'ipsec.ike.sa-installed',
      payload: {
        deviceId: router.id,
        peerIp: '10.0.0.2',
        localIp: '10.0.0.1',
        version: 1,
        lifetimeSec: 86400,
      },
    });
    bus.publish({
      topic: 'ipsec.sa.installed',
      payload: {
        deviceId: router.id,
        peerIp: '10.0.0.2',
        spiInbound: 0x100,
        spiOutbound: 0x200,
        protocol: 'esp',
        mode: 'tunnel',
        encryption: 'aes',
        integrity: 'sha',
      },
    });

    expect(capture.getCapture({ kind: 'ike-sa-installed' })).toHaveLength(1);
    expect(capture.getCapture({ kind: 'ipsec-sa-installed' })).toHaveLength(1);
    void engine;
  });

  it('records DPD events', () => {
    const { engine, bus, router } = buildEngine();
    const capture = new IPSecCaptureActor(bus);
    capture.start();

    bus.publish({
      topic: 'ipsec.dpd.request-sent',
      payload: { deviceId: router.id, peerIp: '10.0.0.2', attempt: 1 },
    });
    bus.publish({
      topic: 'ipsec.dpd.peer-down',
      payload: { deviceId: router.id, peerIp: '10.0.0.2', retries: 3 },
    });

    expect(capture.getCapture({ kind: 'dpd-request' })).toHaveLength(1);
    expect(capture.getCapture({ kind: 'dpd-peer-down' })).toHaveLength(1);
    void engine;
  });

  it('caps the buffer at maxEntries', () => {
    const { engine, bus } = buildEngine();
    const capture = new IPSecCaptureActor(bus, 4);
    capture.start();

    for (let i = 0; i < 10; i++) {
      engine.runInboundChain({
        spi: i, seqNum: i, payloadLen: 100,
        fromIp: 'a', toIp: 'b',
      });
    }

    expect(capture.size()).toBeLessThanOrEqual(4 + 1);
    expect(capture.size()).toBeGreaterThan(0);
  });

  it('clear() empties the buffer but keeps subscriptions live', () => {
    const { engine, bus } = buildEngine();
    const capture = new IPSecCaptureActor(bus);
    capture.start();

    engine.runInboundChain({
      spi: 0x100, seqNum: 1, payloadLen: 100,
      fromIp: 'a', toIp: 'b',
    });
    expect(capture.size()).toBe(1);

    capture.clear();
    expect(capture.size()).toBe(0);

    engine.runInboundChain({
      spi: 0x101, seqNum: 1, payloadLen: 100,
      fromIp: 'a', toIp: 'b',
    });
    expect(capture.size()).toBe(1);
  });

  it('stop() unsubscribes — no further captures', () => {
    const { engine, bus } = buildEngine();
    const capture = new IPSecCaptureActor(bus);
    capture.start();

    engine.runInboundChain({
      spi: 0x100, seqNum: 1, payloadLen: 100,
      fromIp: 'a', toIp: 'b',
    });
    expect(capture.size()).toBe(1);

    capture.stop();
    engine.runInboundChain({
      spi: 0x101, seqNum: 1, payloadLen: 100,
      fromIp: 'a', toIp: 'b',
    });
    expect(capture.size()).toBe(1); // unchanged
  });
});
