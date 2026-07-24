import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { SmtpServer } from '@/network/smtp/SmtpServer';
import { SmtpClientSession } from '@/network/smtp/SmtpClientSession';
import { SmtpServerSession, type SmtpServerConfig } from '@/network/smtp/SmtpServerSession';
import { toBase64, decodePlainResponse, decodeCramMd5Response, computeCramMd5Digest } from '@/network/smtp/auth';
import { extractReceivedChain } from '@/network/smtp/trace';

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

describe('SMTP AUTH helper functions (RFC 4954/4616/2195)', () => {
  it('decodes an AUTH PLAIN response', () => {
    const b64 = toBase64('\0alice\0Wonderland1');
    expect(decodePlainResponse(b64)).toEqual({ authzid: '', authcid: 'alice', password: 'Wonderland1' });
  });

  it('returns null for a malformed AUTH PLAIN response', () => {
    expect(decodePlainResponse(toBase64('not-enough-fields'))).toBeNull();
  });

  it('decodes a CRAM-MD5 response and matches the expected digest', () => {
    const challenge = '<123.456@mail.example.com>';
    const digest = computeCramMd5Digest(challenge, 'Wonderland1');
    const response = toBase64(`alice ${digest}`);
    const decoded = decodeCramMd5Response(response);
    expect(decoded).toEqual({ username: 'alice', digest });
  });
});

describe('SMTP AUTH capability gating', () => {
  it('does not advertise AUTH when neither TLS nor plaintext auth is allowed', () => {
    const { client } = buildTopology({ allowPlainTextAuth: false });
    client.connect();
    const r = client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    expect(r!.lines.some((l) => l.startsWith('AUTH'))).toBe(false);
  });

  it('advertises AUTH PLAIN LOGIN CRAM-MD5 once plaintext auth is explicitly allowed', () => {
    const { client } = buildTopology();
    client.connect();
    const r = client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    expect(r!.lines).toContain('AUTH PLAIN LOGIN CRAM-MD5');
  });

  it('rejects AUTH with 503 when not advertised', () => {
    const { client } = buildTopology({ allowPlainTextAuth: false });
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    const r = client.sendCommand({ verb: 'AUTH', argument: 'PLAIN AAAA' });
    expect(r?.code).toBe(503);
  });
});

describe('SMTP AUTH PLAIN (RFC 4616)', () => {
  it('authenticates with a valid initial response', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    const r = client.authPlain('alice', 'Wonderland1');
    expect(r?.code).toBe(235);
  });

  it('rejects an invalid password with 535', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    const r = client.authPlain('alice', 'WrongPassword');
    expect(r?.code).toBe(535);
  });

  it('supports the continuation form (no initial response)', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    const prompt = client.sendCommand({ verb: 'AUTH', argument: 'PLAIN' });
    expect(prompt?.code).toBe(334);
  });
});

describe('SMTP AUTH LOGIN', () => {
  it('authenticates via the two-step username/password dialogue', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    const r = client.authLogin('alice', 'Wonderland1');
    expect(r?.code).toBe(235);
  });

  it('rejects an invalid password with 535', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    const r = client.authLogin('alice', 'WrongPassword');
    expect(r?.code).toBe(535);
  });
});

describe('SMTP AUTH CRAM-MD5 (RFC 2195)', () => {
  it('authenticates via challenge/response without ever sending the password in clear', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    const r = client.authCramMd5('alice', 'Wonderland1');
    expect(r?.code).toBe(235);
  });

  it('rejects a wrong password with 535', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    const r = client.authCramMd5('alice', 'WrongPassword');
    expect(r?.code).toBe(535);
  });
});

describe('SMTP AUTH session semantics', () => {
  it('rejects a second AUTH once already authenticated with 503', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'EHLO', argument: 'client.example.org' });
    client.authPlain('alice', 'Wonderland1');
    const r = client.sendCommand({ verb: 'AUTH', argument: 'PLAIN AAAA' });
    expect(r?.code).toBe(503);
  });

  it("'*' cancels an in-progress AUTH LOGIN exchange", () => {
    const session = new SmtpServerSession({ hostname: 'mail.example.com', users: new Map([['alice', 'Wonderland1']]), allowPlainTextAuth: true });
    session.handle({ verb: 'EHLO', argument: 'client.example.org' });
    session.handle({ verb: 'AUTH', argument: 'LOGIN' });
    expect(session.isAwaitingAuthContinuation()).toBe(true);

    const r = session.handleAuthContinuation('*');
    expect(r.code).toBe(501);
    expect(session.isAwaitingAuthContinuation()).toBe(false);
  });

  it('a Received: header on an authenticated session carries ESMTPA', () => {
    const session = new SmtpServerSession({ hostname: 'mail.example.com', users: new Map([['alice', 'Wonderland1']]), allowPlainTextAuth: true }, '203.0.113.5');
    session.handle({ verb: 'EHLO', argument: 'client.example.org' });
    const authReply = session.handle({
      verb: 'AUTH', argument: `PLAIN ${toBase64('\0alice\0Wonderland1')}`,
    })[0];
    expect(authReply.code).toBe(235);

    session.handle({ verb: 'MAIL', argument: 'FROM:<alice@example.org>' });
    session.handle({ verb: 'RCPT', argument: 'TO:<bob@example.org>' });
    session.handle({ verb: 'DATA' });
    session.handleDataBody('Subject: hi\r\n\r\nBody\r\n.\r\n');

    const chain = extractReceivedChain(session.lastDelivered!.rawMessage);
    expect(chain[0]).toContain('with ESMTPA');
  });
});
