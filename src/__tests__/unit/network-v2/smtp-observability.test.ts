import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EventBus } from '@/events/EventBus';
import type { DomainEvent } from '@/events/types';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { SmtpServer, type SmtpServerOptions } from '@/network/smtp/SmtpServer';
import { SmtpClientSession } from '@/network/smtp/SmtpClientSession';
import type { SmtpServerConfig } from '@/network/smtp/SmtpServerSession';
import { SmtpSignalStore, subscribeSmtpObservables } from '@/network/smtp/observables';
import { relayToRecipient, type DnsLookup } from '@/network/smtp/relay';
import { DeliveryQueue } from '@/network/smtp/queue';
import { buildDsnForFailedDelivery } from '@/network/smtp/dsn';
import { deliverLocalMessage } from '@/network/smtp/localDelivery';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

function buildTopology(config: Partial<SmtpServerConfig> = {}, opts: SmtpServerOptions = {}) {
  const bus = new EventBus();
  const events: DomainEvent[] = [];
  bus.subscribeAll((e) => events.push(e));

  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'MAIL1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  const users = new Map([['alice', 'Wonderland1']]);
  const server = new SmtpServer(srv.getTcpStack(), { hostname: 'mail.example.com', users, allowPlainTextAuth: true, eventBus: bus, ...config }, 25, opts);
  server.start();

  const client = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2');
  return { pc, srv, client, bus, events };
}

describe('SMTP observability — events.ts inline emission (§2.1.15)', () => {
  it('emits smtp.session.opened on accept', () => {
    const { client, events } = buildTopology();
    client.connect();
    expect(events.some((e) => e.topic === 'smtp.session.opened')).toBe(true);
  });

  it('emits smtp.command.received for each command', () => {
    const { client, events } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    const cmds = events.filter((e) => e.topic === 'smtp.command.received');
    expect(cmds.length).toBeGreaterThanOrEqual(1);
  });

  it('emits smtp.mail.accepted on a successful MAIL FROM and smtp.mail.rejected on a bad-sequence MAIL', () => {
    const { client, events } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    expect(events.some((e) => e.topic === 'smtp.mail.rejected')).toBe(true);

    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    expect(events.some((e) => e.topic === 'smtp.mail.accepted')).toBe(true);
  });

  it('emits smtp.auth.succeeded and smtp.auth.failed', () => {
    const { client, events } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    client.authPlain('alice', 'WrongPassword');
    expect(events.some((e) => e.topic === 'smtp.auth.failed')).toBe(true);

    client.authPlain('alice', 'Wonderland1');
    expect(events.some((e) => e.topic === 'smtp.auth.succeeded')).toBe(true);
  });

  it('emits smtp.session.closed on QUIT', () => {
    const { client, events } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'QUIT' });
    expect(events.some((e) => e.topic === 'smtp.session.closed')).toBe(true);
  });
});

describe('SMTP observability — delivery/queue/DSN events across modules', () => {
  it('deliverLocalMessage() emits smtp.delivery.local', () => {
    const bus = new EventBus();
    const events: DomainEvent[] = [];
    bus.subscribeAll((e) => events.push(e));
    const vfs = new VirtualFileSystem();

    deliverLocalMessage(vfs, 'bob@example.org', { envelopeFrom: 'alice@example.org', receivedAt: 0, rawMessage: 'hi' }, { uid: 1000, gid: 1000 }, bus);
    expect(events.some((e) => e.topic === 'smtp.delivery.local')).toBe(true);
  });

  it('relayToRecipient() emits smtp.delivery.relayed on success', async () => {
    const bus = new EventBus();
    const events: DomainEvent[] = [];
    bus.subscribeAll((e) => events.push(e));

    const pc = new LinuxPC('linux-pc', 'SENDER');
    const mx = new LinuxServer('linux-server', 'MX');
    const sw = new GenericSwitch('switch-generic', 'SW1', 8, 0, 0);
    pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    mx.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(pc.getPort('eth0')!, sw.getPorts()[0]);
    new Cable('c2').connect(mx.getPort('eth0')!, sw.getPorts()[1]);
    new SmtpServer(mx.getTcpStack(), { hostname: 'mx.example.org', localDomains: new Set(['example.org']) }).start();

    const lookup: DnsLookup = { resolveMx: async () => [], resolveAddress: async () => '10.0.1.10' };
    await relayToRecipient(pc.getTcpStack(), '10.0.1.2', lookup, 'sender.net', 'alice@sender.net', 'bob@example.org', 'Subject: hi\r\n\r\nBody', bus);
    expect(events.some((e) => e.topic === 'smtp.delivery.relayed')).toBe(true);
  });

  it('DeliveryQueue emits smtp.queue.retried on a deferred attempt and smtp.queue.expired once abandoned', async () => {
    const bus = new EventBus();
    const events: DomainEvent[] = [];
    bus.subscribeAll((e) => events.push(e));

    const pc = new LinuxPC('linux-pc', 'SENDER');
    const scheduler = new VirtualTimeScheduler();
    const lookup: DnsLookup = { resolveMx: async () => [], resolveAddress: async () => null };
    const queue = new DeliveryQueue({
      tcpStack: pc.getTcpStack(), localIp: '10.0.1.2', lookup, scheduler, eventBus: bus,
      schedule: { baseDelayMs: 1000, backoffMultiplier: 2, maxTotalDurationMs: 3000 },
    });
    queue.enqueue('bob@example.org', 'alice@sender.net', 'body', 'sender.net');

    scheduler.advance(1000);
    await queue.tick();
    expect(events.some((e) => e.topic === 'smtp.queue.retried')).toBe(true);

    scheduler.advance(3000);
    await queue.tick();
    expect(events.some((e) => e.topic === 'smtp.queue.expired')).toBe(true);
  });

  it('buildDsnForFailedDelivery() emits smtp.dsn.generated when a DSN is actually produced', () => {
    const bus = new EventBus();
    const events: DomainEvent[] = [];
    bus.subscribeAll((e) => events.push(e));

    buildDsnForFailedDelivery('alice@example.org', 'bob@remote.example', '550 5.1.1', { notify: [] }, undefined, bus);
    expect(events.some((e) => e.topic === 'smtp.dsn.generated')).toBe(true);
  });

  it('buildDsnForFailedDelivery() does not emit smtp.dsn.generated when suppressed (anti-loop)', () => {
    const bus = new EventBus();
    const events: DomainEvent[] = [];
    bus.subscribeAll((e) => events.push(e));

    buildDsnForFailedDelivery('', 'bob@remote.example', '550 5.1.1', { notify: [] }, undefined, bus);
    expect(events.some((e) => e.topic === 'smtp.dsn.generated')).toBe(false);
  });
});

describe('SmtpSignalStore aggregate metrics (§2.1.15)', () => {
  it('subscribeSmtpObservables() aggregates session/command/mail/auth counters from a live session', () => {
    const bus = new EventBus();
    const store = new SmtpSignalStore();
    subscribeSmtpObservables(bus, store);

    const pc = new LinuxPC('linux-pc', 'PC1');
    const srv = new LinuxServer('linux-server', 'MAIL1');
    pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
    const server = new SmtpServer(srv.getTcpStack(), { hostname: 'mail.example.com', eventBus: bus });
    server.start();
    const client = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2');

    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });

    const metrics = store.metrics.get();
    expect(metrics.sessionsOpened).toBe(1);
    expect(metrics.commandsReceived).toBeGreaterThanOrEqual(2);
    expect(metrics.mailAccepted).toBe(1);
  });
});
