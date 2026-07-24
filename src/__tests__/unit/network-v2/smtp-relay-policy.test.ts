import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { SmtpServer } from '@/network/smtp/SmtpServer';
import { SmtpClientSession } from '@/network/smtp/SmtpClientSession';
import type { SmtpServerConfig } from '@/network/smtp/SmtpServerSession';
import { isLocalDomain, isPostmasterAddress, evaluateRcpt } from '@/network/smtp/relayPolicy';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

function buildTopology(config: Partial<SmtpServerConfig> = {}) {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxPC('linux-pc', 'MAIL1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  const users = new Map([['alice', 'Wonderland1']]);
  const server = new SmtpServer(srv.getTcpStack(), { hostname: 'mail.example.com', users, allowPlainTextAuth: true, ...config });
  server.start();

  const client = new SmtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2');
  return { client };
}

async function primeTransaction(client: SmtpClientSession) {
  client.connect();
  client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
  client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
}

describe('relayPolicy.ts helper functions', () => {
  it('is case-insensitive for domain matching', () => {
    const domains = new Set(['example.org']);
    expect(isLocalDomain('Example.ORG', domains)).toBe(true);
    expect(isLocalDomain('other.org', domains)).toBe(false);
  });

  it('recognizes postmaster with and without a domain', () => {
    expect(isPostmasterAddress('postmaster')).toBe(true);
    expect(isPostmasterAddress('postmaster@example.org')).toBe(true);
    expect(isPostmasterAddress('Postmaster@Example.ORG')).toBe(true);
    expect(isPostmasterAddress('alice@example.org')).toBe(false);
  });

  it('evaluates a local domain recipient as accept-local regardless of authentication', () => {
    const domains = new Set(['example.org']);
    expect(evaluateRcpt('bob@example.org', domains, false)).toBe('accept-local');
    expect(evaluateRcpt('bob@example.org', domains, true)).toBe('accept-local');
  });

  it('denies a remote domain recipient without authentication', () => {
    const domains = new Set(['example.org']);
    expect(evaluateRcpt('bob@remote.example', domains, false)).toBe('deny-relay');
  });

  it('accepts a remote domain recipient once authenticated', () => {
    const domains = new Set(['example.org']);
    expect(evaluateRcpt('bob@remote.example', domains, true)).toBe('accept-authenticated-relay');
  });

  it('always accepts postmaster, even for a remote/unauthenticated session', () => {
    const domains = new Set(['example.org']);
    expect(evaluateRcpt('postmaster', domains, false)).toBe('accept-postmaster');
  });
});

describe('SMTP anti-open-relay policy (RFC 5321, operational best practice)', () => {
  it('always accepts RCPT TO for a local domain', async () => {
    const { client } = buildTopology({ localDomains: new Set(['example.org']) });
    await primeTransaction(client);
    const r = client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    expect(r?.code).toBe(250);
  });

  it('denies RCPT TO for a remote domain without authentication (550 5.7.1)', async () => {
    const { client } = buildTopology({ localDomains: new Set(['example.org']) });
    await primeTransaction(client);
    const r = client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@remote.example>' });
    expect(r?.code).toBe(550);
    expect(r?.enhancedCode).toBe('5.7.1');
  });

  it('accepts RCPT TO for a remote domain once authenticated', () => {
    const { client } = buildTopology({ localDomains: new Set(['example.org']) });
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    client.authPlain('alice', 'Wonderland1');
    client.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    const r = client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@remote.example>' });
    expect(r?.code).toBe(250);
  });

  it('accepts RCPT TO:<postmaster> even without any local user account of that name', async () => {
    const { client } = buildTopology({ localDomains: new Set(['example.org']) });
    await primeTransaction(client);
    const r = client.sendCommand({ verb: 'RCPT', argument: 'TO:<postmaster>' });
    expect(r?.code).toBe(250);
  });

  it('does not enforce any relay policy when localDomains is left unconfigured', async () => {
    const { client } = buildTopology();
    await primeTransaction(client);
    const r = client.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@anywhere.example>' });
    expect(r?.code).toBe(250);
  });
});
