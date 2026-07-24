import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { SmtpServer } from '@/network/smtp/SmtpServer';
import type { DnsLookup } from '@/network/smtp/relay';
import {
  DeliveryQueue, computeNextAttemptDelay, hasExpired, DEFAULT_RETRY_SCHEDULE, type RetrySchedule, type QueuedDelivery,
} from '@/network/smtp/queue';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

function buildTopology() {
  const pc = new LinuxPC('linux-pc', 'SENDER');
  const mx = new LinuxPC('linux-pc', 'MX');
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 0, 0);

  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  mx.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));

  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPorts()[0]);
  new Cable('c2').connect(mx.getPort('eth0')!, sw.getPorts()[1]);

  const server = new SmtpServer(mx.getTcpStack(), { hostname: 'mx.example.org', localDomains: new Set(['example.org']) });
  server.start();

  return { pc };
}

const FAST_SCHEDULE: RetrySchedule = { baseDelayMs: 1000, backoffMultiplier: 2, maxTotalDurationMs: 5000 };

describe('queue.ts retry math', () => {
  it('grows the delay exponentially with each attempt', () => {
    expect(computeNextAttemptDelay(0, FAST_SCHEDULE)).toBe(1000);
    expect(computeNextAttemptDelay(1, FAST_SCHEDULE)).toBe(2000);
    expect(computeNextAttemptDelay(2, FAST_SCHEDULE)).toBe(4000);
  });

  it('flags an entry as expired once now reaches expiresAt', () => {
    const entry: QueuedDelivery = {
      recipient: 'bob@example.org', envelopeFrom: 'alice@sender.net', rawMessage: '', heloDomain: 'sender.net',
      attempts: 0, firstAttemptAt: 0, nextAttemptAt: 0, expiresAt: 5000,
    };
    expect(hasExpired(entry, 4999)).toBe(false);
    expect(hasExpired(entry, 5000)).toBe(true);
  });

  it('uses sane real-world defaults', () => {
    expect(DEFAULT_RETRY_SCHEDULE.baseDelayMs).toBeGreaterThan(0);
    expect(DEFAULT_RETRY_SCHEDULE.maxTotalDurationMs).toBeGreaterThan(DEFAULT_RETRY_SCHEDULE.baseDelayMs);
  });
});

describe('DeliveryQueue scheduling (RFC 5321 §4.5.4.1)', () => {
  it('enqueue() sets nextAttemptAt/expiresAt from the scheduler clock, not real time', () => {
    const scheduler = new VirtualTimeScheduler();
    const { pc } = buildTopology();
    const lookup: DnsLookup = { resolveMx: async () => [], resolveAddress: async () => null };
    const queue = new DeliveryQueue({ tcpStack: pc.getTcpStack(), localIp: '10.0.1.2', lookup, scheduler, schedule: FAST_SCHEDULE });

    const entry = queue.enqueue('bob@example.org', 'alice@sender.net', 'Subject: hi\r\n\r\nBody', 'sender.net');
    expect(entry.nextAttemptAt).toBe(1000);
    expect(entry.expiresAt).toBe(5000);
    expect(queue.size()).toBe(1);
  });

  it('does not attempt a retry before the scheduled deadline', async () => {
    const scheduler = new VirtualTimeScheduler();
    const { pc } = buildTopology();
    let lookupCalls = 0;
    const lookup: DnsLookup = { resolveMx: async () => { lookupCalls++; return []; }, resolveAddress: async () => null };
    const queue = new DeliveryQueue({ tcpStack: pc.getTcpStack(), localIp: '10.0.1.2', lookup, scheduler, schedule: FAST_SCHEDULE });
    queue.enqueue('bob@example.org', 'alice@sender.net', 'body', 'sender.net');

    scheduler.advance(500);
    await queue.tick();

    expect(lookupCalls).toBe(0);
    expect(queue.size()).toBe(1);
    expect(queue.peekAll()[0].attempts).toBe(0);
  });

  it('retries with growing delay on a temporary (deferred) failure', async () => {
    const scheduler = new VirtualTimeScheduler();
    const { pc } = buildTopology();
    const lookup: DnsLookup = { resolveMx: async () => [], resolveAddress: async () => null };
    const queue = new DeliveryQueue({ tcpStack: pc.getTcpStack(), localIp: '10.0.1.2', lookup, scheduler, schedule: FAST_SCHEDULE });
    queue.enqueue('bob@example.org', 'alice@sender.net', 'body', 'sender.net');

    scheduler.advance(1000);
    await queue.tick();
    expect(queue.peekAll()[0].attempts).toBe(1);
    const firstRetryAt = queue.peekAll()[0].nextAttemptAt;
    expect(firstRetryAt).toBe(1000 + 2000);
  });

  it('generates a DSN-worthy expiry once the total retry duration is exhausted', async () => {
    const scheduler = new VirtualTimeScheduler();
    const { pc } = buildTopology();
    const lookup: DnsLookup = { resolveMx: async () => [], resolveAddress: async () => null };
    let expired: QueuedDelivery | null = null;
    const queue = new DeliveryQueue({
      tcpStack: pc.getTcpStack(), localIp: '10.0.1.2', lookup, scheduler, schedule: FAST_SCHEDULE,
      onExpired: (e) => { expired = e; },
    });
    queue.enqueue('bob@example.org', 'alice@sender.net', 'body', 'sender.net');

    scheduler.advance(1000);
    await queue.tick();
    scheduler.advance(3000);
    await queue.tick();

    expect(queue.size()).toBe(0);
    expect(expired).not.toBeNull();
    expect((expired as unknown as QueuedDelivery).recipient).toBe('bob@example.org');
  });

  it('delivers successfully once the target becomes reachable, removing the entry and firing onDelivered', async () => {
    const scheduler = new VirtualTimeScheduler();
    const { pc } = buildTopology();
    const lookup: DnsLookup = {
      resolveMx: async () => [{ preference: 10, exchange: 'mx.example.org' }],
      resolveAddress: async () => '10.0.1.10',
    };
    let delivered: QueuedDelivery | null = null;
    const queue = new DeliveryQueue({
      tcpStack: pc.getTcpStack(), localIp: '10.0.1.2', lookup, scheduler, schedule: FAST_SCHEDULE,
      onDelivered: (e) => { delivered = e; },
    });
    queue.enqueue('bob@example.org', 'alice@sender.net', 'Subject: hi\r\n\r\nBody', 'sender.net');

    scheduler.advance(1000);
    await queue.tick();

    expect(queue.size()).toBe(0);
    expect(delivered).not.toBeNull();
  });
});
