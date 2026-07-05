import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { FtpServer, FTP_CONTROL_PORT } from '@/network/ftp/FtpServer';
import { FtpClientSession } from '@/network/ftp/FtpClientSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

function buildTopology() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('FTP1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  const users = new Map([['alice', 'wonderland']]);
  const server = new FtpServer(srv.getTcpStack(), { users });
  server.start();

  const client = new FtpClientSession(pc.getTcpStack(), '10.0.1.10');
  return { pc, srv, server, client };
}

describe('FTP control channel (RFC 959 §3-5)', () => {
  it('sends an unprompted 220 banner right after the connection is accepted', () => {
    const { client } = buildTopology();
    const banner = client.connect();
    expect(banner?.code).toBe(220);
  });

  it('rejects commands requiring authentication before USER/PASS', () => {
    const { client } = buildTopology();
    client.connect();
    const reply = client.sendCommand({ verb: 'TYPE', argument: 'I' });
    expect(reply?.code).toBe(530);
  });

  it('logs in with a correct USER/PASS pair', () => {
    const { client } = buildTopology();
    client.connect();
    expect(client.sendCommand({ verb: 'USER', argument: 'alice' })?.code).toBe(331);
    expect(client.sendCommand({ verb: 'PASS', argument: 'wonderland' })?.code).toBe(230);
  });

  it('rejects a wrong password and does not authenticate', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'USER', argument: 'alice' });
    const reply = client.sendCommand({ verb: 'PASS', argument: 'not-the-password' });
    expect(reply?.code).toBe(530);
    expect(client.sendCommand({ verb: 'TYPE', argument: 'I' })?.code).toBe(530);
  });

  it('rejects an unknown username the same way as a wrong password (no username disclosure)', () => {
    const { client } = buildTopology();
    client.connect();
    const userReply = client.sendCommand({ verb: 'USER', argument: 'mallory' });
    expect(userReply?.code).toBe(331);
    const passReply = client.sendCommand({ verb: 'PASS', argument: 'anything' });
    expect(passReply?.code).toBe(530);
  });

  it('accepts TYPE/STRU/MODE once authenticated, and rejects unsupported parameters', () => {
    const { client } = buildTopology();
    client.connect();
    client.sendCommand({ verb: 'USER', argument: 'alice' });
    client.sendCommand({ verb: 'PASS', argument: 'wonderland' });

    expect(client.sendCommand({ verb: 'TYPE', argument: 'A' })?.code).toBe(200);
    expect(client.sendCommand({ verb: 'TYPE', argument: 'I' })?.code).toBe(200);
    expect(client.sendCommand({ verb: 'STRU', argument: 'F' })?.code).toBe(200);
    expect(client.sendCommand({ verb: 'STRU', argument: 'R' })?.code).toBe(504);
    expect(client.sendCommand({ verb: 'MODE', argument: 'S' })?.code).toBe(200);
    expect(client.sendCommand({ verb: 'MODE', argument: 'Z' })?.code).toBe(504);
  });

  it('replies to SYST/NOOP without requiring authentication', () => {
    const { client } = buildTopology();
    client.connect();
    expect(client.sendCommand({ verb: 'SYST' })?.code).toBe(215);
    expect(client.sendCommand({ verb: 'NOOP' })?.code).toBe(200);
  });

  it('replies 500 to an unrecognized command', () => {
    const { client } = buildTopology();
    client.connect();
    expect(client.sendCommand({ verb: 'BOGUS' })?.code).toBe(500);
  });

  it('closes the connection on QUIT with a 221 reply', () => {
    const { client } = buildTopology();
    client.connect();
    const reply = client.sendCommand({ verb: 'QUIT' });
    expect(reply?.code).toBe(221);
  });

  it('listens on TCP 21 by default', () => {
    const { srv } = buildTopology();
    const listeners = srv.getTcpStack().listListeners().map((l) => l.localPort);
    expect(listeners).toContain(FTP_CONTROL_PORT);
  });
});

describe('FTP reply codec (RFC 959 §4.2)', () => {
  it('round-trips a single-line reply', async () => {
    const { encodeReply, decodeReply, reply } = await import('@/network/ftp/replies');
    const r = reply(230, 'User alice logged in.');
    const decoded = decodeReply(encodeReply(r));
    expect(decoded).toEqual(r);
  });

  it('round-trips a multi-line reply (§4.2 hyphen/space convention)', async () => {
    const { encodeReply, decodeReply, reply } = await import('@/network/ftp/replies');
    const r = reply(211, 'Extensions supported:', 'SIZE', 'MDTM', 'END');
    const encoded = encodeReply(r);
    expect(encoded.startsWith('211-Extensions supported:\r\n')).toBe(true);
    expect(encoded).toContain('\r\n211 END\r\n');
    const decoded = decodeReply(encoded);
    expect(decoded).toEqual(r);
  });
});
