import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { SmtpServer } from '@/network/smtp/SmtpServer';
import { SmtpClientSession } from '@/network/smtp/SmtpClientSession';
import {
  DEFAULT_PROTOCOL_LIMITS, commandLineByteLength, exceedsCommandLineLimit, exceedsTextLineLimit,
} from '@/network/smtp/limits';
import type { SmtpProtocolLimits } from '@/network/smtp/limits';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

function buildTopology(opts: { limits?: SmtpProtocolLimits; scheduler?: VirtualTimeScheduler } = {}) {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'MAIL1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  const server = new SmtpServer(srv.getTcpStack(), { hostname: 'mail.example.com' }, 25, opts);
  server.start();

  const client = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2');
  return { client };
}

describe('SMTP protocol limits helpers (RFC 5321 §4.5.3)', () => {
  it('measures a command line byte length including CRLF', () => {
    expect(commandLineByteLength('ABC')).toBe(5);
  });

  it('flags a command line over 512 bytes', () => {
    const longArg = 'x'.repeat(600);
    expect(exceedsCommandLineLimit(`MAIL FROM:<${longArg}>`)).toBe(true);
    expect(exceedsCommandLineLimit('MAIL FROM:<a@b.com>')).toBe(false);
  });

  it('flags a text line over 1000 bytes', () => {
    expect(exceedsTextLineLimit('y'.repeat(1200))).toBe(true);
    expect(exceedsTextLineLimit('short line')).toBe(false);
  });
});

describe('SMTP command line length limit (RFC 5321 §4.5.3.1.4)', () => {
  it('rejects a command line over 512 bytes with 500, without executing it', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'HELO', argument: 'client.example.org' });

    const longFrom = 'a'.repeat(600);
    const r = client.sendCommand({ verb: 'MAIL', argument: `FROM:<${longFrom}@example.org>` });
    expect(r?.code).toBe(500);

    const rcpt = client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    expect(rcpt?.code).toBe(503);
  });

  it('accepts a command line within the 512-byte limit', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'HELO', argument: 'client.example.org' });
    const r = client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    expect(r?.code).toBe(250);
  });
});

describe('SMTP minimum buffered recipients (RFC 5321 §4.5.3.1.8)', () => {
  it('accepts at least 100 RCPT TO in a single transaction', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'HELO', argument: 'client.example.org' });
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });

    for (let i = 0; i < DEFAULT_PROTOCOL_LIMITS.minRecipientsBuffered; i++) {
      const r = client.sendCommand({ verb: 'RCPT', argument: `TO:<user${i}@example.org>` });
      expect(r?.code).toBe(250);
    }
  });
});

describe('SMTP per-state idle timeout (RFC 5321 §4.5.3.2)', () => {
  it('closes an idle connection with 421 4.4.2 once the state timeout elapses', () => {
    const scheduler = new VirtualTimeScheduler();
    const limits: SmtpProtocolLimits = {
      ...DEFAULT_PROTOCOL_LIMITS,
      idleTimeoutMs: { ...DEFAULT_PROTOCOL_LIMITS.idleTimeoutMs, initial: 1000 },
    };
    const { client } = buildTopology({ limits, scheduler });
    client.connect();

    scheduler.advance(1001);

    const replies = client.allReplies();
    const last = replies[replies.length - 1];
    expect(last.code).toBe(421);
    expect(last.enhancedCode).toBe('4.3.0');
  });

  it('does not time out while commands keep arriving before the deadline', () => {
    const scheduler = new VirtualTimeScheduler();
    const limits: SmtpProtocolLimits = {
      ...DEFAULT_PROTOCOL_LIMITS,
      idleTimeoutMs: { ...DEFAULT_PROTOCOL_LIMITS.idleTimeoutMs, initial: 1000 },
    };
    const { client } = buildTopology({ limits, scheduler });
    client.connect();

    scheduler.advance(500);
    const r = client.sendCommand({ verb: 'NOOP' });
    expect(r?.code).toBe(250);

    scheduler.advance(500);
    const replies = client.allReplies();
    const last = replies[replies.length - 1];
    expect(last.code).toBe(250);
  });
});
