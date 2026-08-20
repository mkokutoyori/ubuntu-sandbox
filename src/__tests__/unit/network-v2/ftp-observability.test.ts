import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { FtpServer } from '@/network/ftp/FtpServer';
import { FtpClientSession } from '@/network/ftp/FtpClientSession';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';
import { EventBus } from '@/events/EventBus';
import type { DomainEvent } from '@/events/types';
import { FtpSignalStore, subscribeFtpObservables } from '@/network/ftp/observables';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { FtpServerConfig } from '@/network/ftp/FtpServerSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

function buildTopology(configOverrides: Partial<FtpServerConfig> = {}) {
  const bus = new EventBus();
  const events: DomainEvent[] = [];
  bus.subscribeAll((e) => events.push(e));

  const pc = new WindowsPC('windows-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'FTP1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  const vfs = new VirtualFileSystem();
  vfs.mkdirp('/srv/ftp', 0o755, 1000, 1000);
  vfs.writeFile('/srv/ftp/hello.txt', 'hello ftp world', 1000, 1000, 0o022);
  const fs = new LinuxSftpFSAdapter(vfs, 1000, 1000);

  const users = new Map([['alice', 'wonderland']]);
  const server = new FtpServer(srv.getTcpStack(), '10.0.1.10', { users, fs, rootPath: '/srv/ftp', eventBus: bus, ...configOverrides });
  server.start();

  const client = new FtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2');
  return { pc, srv, vfs, client, bus, events };
}

function login(client: FtpClientSession): void {
  client.connect();
  client.sendCommand({ verb: 'USER', argument: 'alice' });
  client.sendCommand({ verb: 'PASS', argument: 'wonderland' });
}

describe('FTP observability — events.ts (PRD-FTP-SFTP.md §2.1.12)', () => {
  it('emits ftp.control.connected on accept and ftp.control.authenticated on login', () => {
    const { client, events } = buildTopology();
    login(client);

    const connected = events.find((e) => e.topic === 'ftp.control.connected');
    expect(connected).toBeDefined();
    const authenticated = events.find((e) => e.topic === 'ftp.control.authenticated');
    expect(authenticated).toBeDefined();
    expect((authenticated!.payload as { username: string }).username).toBe('alice');
    // Same connection correlator throughout.
    expect((authenticated!.payload as { connectionId: string }).connectionId)
      .toBe((connected!.payload as { connectionId: string }).connectionId);
  });

  it('emits ftp.control.closed on QUIT', () => {
    const { client, events } = buildTopology();
    login(client);
    client.sendCommand({ verb: 'QUIT' });
    const closed = events.find((e) => e.topic === 'ftp.control.closed');
    expect(closed).toBeDefined();
    expect((closed!.payload as { reason: string }).reason).toBe('QUIT');
  });

  it('emits ftp.command.received for every command', () => {
    const { client, events } = buildTopology();
    login(client);
    client.sendCommand({ verb: 'PWD' });
    const verbs = events.filter((e) => e.topic === 'ftp.command.received').map((e) => (e.payload as { verb: string }).verb);
    expect(verbs).toEqual(['USER', 'PASS', 'PWD']);
  });

  it('emits ftp.data.opened/closed around a PASV data channel', () => {
    const { client, events } = buildTopology();
    login(client);
    client.enterPassiveMode();
    client.retrieveFile('hello.txt');

    const opened = events.find((e) => e.topic === 'ftp.data.opened');
    expect(opened).toBeDefined();
    expect((opened!.payload as { mode: string }).mode).toBe('passive');
    const closed = events.find((e) => e.topic === 'ftp.data.closed');
    expect(closed).toBeDefined();
  });

  it('emits ftp.transfer.started/completed for a successful RETR', () => {
    const { client, events } = buildTopology();
    login(client);
    client.enterPassiveMode();
    client.retrieveFile('hello.txt');

    const started = events.find((e) => e.topic === 'ftp.transfer.started');
    expect(started).toBeDefined();
    expect((started!.payload as { verb: string; path: string }).path).toBe('/srv/ftp/hello.txt');
    const completed = events.find((e) => e.topic === 'ftp.transfer.completed');
    expect(completed).toBeDefined();
    expect((completed!.payload as { bytes: number }).bytes).toBe('hello ftp world'.length);
  });

  it('emits ftp.transfer.failed for a RETR with no data channel', () => {
    const { client, events } = buildTopology();
    login(client);
    client.sendCommand({ verb: 'RETR', argument: 'hello.txt' });
    const failed = events.find((e) => e.topic === 'ftp.transfer.failed');
    expect(failed).toBeDefined();
    expect((failed!.payload as { reason: string }).reason).toMatch(/data connection/);
  });

  it('emits ftp.transfer.started/completed for a successful STOR', () => {
    const { client, events, vfs } = buildTopology();
    login(client);
    client.enterPassiveMode();
    client.storeFile('uploaded.txt', 'some bytes');

    const started = events.filter((e) => e.topic === 'ftp.transfer.started');
    expect(started.some((e) => (e.payload as { verb: string }).verb === 'STOR')).toBe(true);
    const completed = events.filter((e) => e.topic === 'ftp.transfer.completed');
    expect(completed.some((e) => (e.payload as { verb: string }).verb === 'STOR')).toBe(true);
    expect(vfs.readFile('/srv/ftp/uploaded.txt')).toBe('some bytes');
  });

  it('emits ftps.tls.established once AUTH TLS completes', () => {
    const ca = CertificateAuthority.generate('CN=obs-test-ca', { now: Date.now() });
    const issued = ca.issueCertificate({ subject: 'CN=ftp.test', notBefore: Date.now() - 1000, notAfter: Date.now() + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => Date.now() });

    const { pc, events } = buildTopology({ ftps: { serverCert: issued.cert, serverPrivateKey: issued.privateKey } });
    const clientWithTls = new FtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2', undefined, { verifier });
    clientWithTls.connect();
    clientWithTls.authTls();

    const established = events.find((e) => e.topic === 'ftps.tls.established');
    expect(established).toBeDefined();
  });

  it('FtpSignalStore aggregates counters from the event bus', () => {
    const { client, bus } = buildTopology();
    const store = new FtpSignalStore();
    subscribeFtpObservables(bus, store);

    login(client);
    client.enterPassiveMode();
    client.retrieveFile('hello.txt');
    client.sendCommand({ verb: 'QUIT' });

    const metrics = store.metrics.get();
    expect(metrics.controlConnected).toBe(1);
    expect(metrics.controlAuthenticated).toBe(1);
    expect(metrics.controlClosed).toBe(1);
    expect(metrics.transfersCompleted).toBe(1);
    expect(metrics.openDataChannels).toBe(0);
  });
});
