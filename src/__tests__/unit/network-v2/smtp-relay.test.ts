import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { SmtpServer } from '@/network/smtp/SmtpServer';
import {
  sortMxByPreference, domainOf, resolveRelayCandidates, relayToRecipient, type DnsLookup, type MxTarget,
} from '@/network/smtp/relay';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

function buildTopology() {
  const pc = new LinuxPC('linux-pc', 'SENDER');
  const primary = new LinuxServer('linux-server', 'MX-PRIMARY');
  const secondary = new LinuxServer('linux-server', 'MX-SECONDARY');
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 0, 0);

  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  primary.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  secondary.configureInterface('eth0', new IPAddress('10.0.1.20'), new SubnetMask('255.255.255.0'));

  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPorts()[0]);
  new Cable('c2').connect(primary.getPort('eth0')!, sw.getPorts()[1]);
  new Cable('c3').connect(secondary.getPort('eth0')!, sw.getPorts()[2]);

  const primaryServer = new SmtpServer(primary.getTcpStack(), { hostname: 'mx1.example.org', localDomains: new Set(['example.org']) });
  primaryServer.start();
  const secondaryServer = new SmtpServer(secondary.getTcpStack(), { hostname: 'mx2.example.org', localDomains: new Set(['example.org']) });
  secondaryServer.start();

  return { pc, primary, secondary };
}

describe('relay.ts pure helpers (RFC 5321 §5)', () => {
  it('sorts MX targets by ascending preference', () => {
    const targets: MxTarget[] = [{ preference: 20, exchange: 'b.example.org' }, { preference: 10, exchange: 'a.example.org' }];
    expect(sortMxByPreference(targets).map((t) => t.exchange)).toEqual(['a.example.org', 'b.example.org']);
  });

  it('extracts the domain from an address', () => {
    expect(domainOf('bob@example.org')).toBe('example.org');
    expect(domainOf('bogus')).toBe('');
  });

  it('resolveRelayCandidates sorts MX records when present', async () => {
    const lookup: DnsLookup = {
      resolveMx: async () => [{ preference: 20, exchange: 'b.example.org' }, { preference: 10, exchange: 'a.example.org' }],
      resolveAddress: async () => '10.0.1.10',
    };
    const candidates = await resolveRelayCandidates(lookup, 'example.org');
    expect(candidates.map((c) => c.hostname)).toEqual(['a.example.org', 'b.example.org']);
  });

  it('resolveRelayCandidates falls back to the domain itself (A/AAAA) when no MX exists', async () => {
    const lookup: DnsLookup = { resolveMx: async () => [], resolveAddress: async () => '10.0.1.10' };
    const candidates = await resolveRelayCandidates(lookup, 'example.org');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].hostname).toBe('example.org');
    expect('fallbackToAddress' in candidates[0].target).toBe(true);
  });
});

describe('relay.ts real outbound relay over TCP (RFC 5321 §5)', () => {
  it('delivers to the (only) MX target', async () => {
    const { pc } = buildTopology();
    const lookup: DnsLookup = {
      resolveMx: async () => [{ preference: 10, exchange: 'mx1.example.org' }],
      resolveAddress: async (host) => (host === 'mx1.example.org' ? '10.0.1.10' : null),
    };
    const attempt = await relayToRecipient(
      pc.getTcpStack(), '10.0.1.2', lookup, 'sender.example.net', 'alice@sender.example.net', 'bob@example.org', 'Subject: hi\r\n\r\nBody',
    );
    expect(attempt.outcome).toBe('delivered');
    expect(attempt.host).toBe('mx1.example.org');
  });

  it('falls back to the second MX target when the first is unresolvable', async () => {
    const { pc } = buildTopology();
    const lookup: DnsLookup = {
      resolveMx: async () => [
        { preference: 10, exchange: 'unreachable.example.org' },
        { preference: 20, exchange: 'mx2.example.org' },
      ],
      resolveAddress: async (host) => {
        if (host === 'mx2.example.org') return '10.0.1.20';
        return null;
      },
    };
    const attempt = await relayToRecipient(
      pc.getTcpStack(), '10.0.1.2', lookup, 'sender.example.net', 'alice@sender.example.net', 'bob@example.org', 'Subject: hi\r\n\r\nBody',
    );
    expect(attempt.outcome).toBe('delivered');
    expect(attempt.host).toBe('mx2.example.org');
  });

  it('falls back to the domain A record when no MX exists at all', async () => {
    const { pc } = buildTopology();
    const lookup: DnsLookup = {
      resolveMx: async () => [],
      resolveAddress: async (host) => (host === 'example.org' ? '10.0.1.10' : null),
    };
    const attempt = await relayToRecipient(
      pc.getTcpStack(), '10.0.1.2', lookup, 'sender.example.net', 'alice@sender.example.net', 'bob@example.org', 'Subject: hi\r\n\r\nBody',
    );
    expect(attempt.outcome).toBe('delivered');
    expect('fallbackToAddress' in attempt.target).toBe(true);
  });

  it('defers when no candidate host resolves to an address', async () => {
    const { pc } = buildTopology();
    const lookup: DnsLookup = { resolveMx: async () => [], resolveAddress: async () => null };
    const attempt = await relayToRecipient(
      pc.getTcpStack(), '10.0.1.2', lookup, 'sender.example.net', 'alice@sender.example.net', 'bob@example.org', 'Subject: hi\r\n\r\nBody',
    );
    expect(attempt.outcome).toBe('deferred');
  });

  it('bounces when the remote server rejects the recipient (RCPT 550, no relay policy match)', async () => {
    const { pc } = buildTopology();
    const lookup: DnsLookup = {
      resolveMx: async () => [{ preference: 10, exchange: 'mx1.example.org' }],
      resolveAddress: async () => '10.0.1.10',
    };
    const attempt = await relayToRecipient(
      pc.getTcpStack(), '10.0.1.2', lookup, 'sender.example.net', 'alice@sender.example.net', 'bob@some-other-domain.example', 'Subject: hi\r\n\r\nBody',
    );
    expect(attempt.outcome).toBe('bounced');
  });
});
