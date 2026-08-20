/**
 * SFTP observability — events.ts/observables.ts (PRD-FTP-SFTP.md
 * §2.1.18/P17). `SftpWireSession` emits `sftp.packet.*`/
 * `sftp.handle.*`/`sftp.transfer.progress` on a real `EventBus`,
 * mirroring `ftp-observability.test.ts`'s style.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';
import { SshUserContext } from '@/network/protocols/ssh/SshUserContext';
import { SftpWireSession } from '@/network/protocols/ssh/sftp/SftpWireSession';
import { EventBus } from '@/events/EventBus';
import type { DomainEvent } from '@/events/types';
import { SftpSignalStore, subscribeSftpObservables } from '@/network/protocols/ssh/sftp/observables';

beforeEach(() => {
  resetCounters();
});

function buildSession() {
  const bus = new EventBus();
  const events: DomainEvent[] = [];
  bus.subscribeAll((e) => events.push(e));

  const vfs = new VirtualFileSystem();
  vfs.mkdirp('/home/alice', 0o755, 1000, 1000);
  vfs.writeFile('/home/alice/hello.txt', 'hello sftp observability', 1000, 1000, 0o022);
  const fs = new LinuxSftpFSAdapter(vfs, 1000, 1000);
  const userCtx = new SshUserContext('alice', 1000, 1000, [], '/home/alice');
  const session = new SftpWireSession({ vfs: fs, userCtx, rootPath: '/home/alice', eventBus: bus });
  return { vfs, session, bus, events };
}

describe('SFTP observability — events.ts (PRD-FTP-SFTP.md §2.1.18/P17)', () => {
  it('emits sftp.packet.received/sent for every handled packet, correlated by sessionId', () => {
    const { session, events } = buildSession();
    session.handle({ type: 'INIT', version: 6 });

    const received = events.find((e) => e.topic === 'sftp.packet.received');
    const sent = events.find((e) => e.topic === 'sftp.packet.sent');
    expect(received).toBeDefined();
    expect(sent).toBeDefined();
    expect((received!.payload as { packetType: string }).packetType).toBe('INIT');
    expect((sent!.payload as { packetType: string }).packetType).toBe('VERSION');
    expect((received!.payload as { sessionId: string }).sessionId)
      .toBe((sent!.payload as { sessionId: string }).sessionId);
  });

  it('emits sftp.packet.received/sent with the correlated requestId', () => {
    const { session, events } = buildSession();
    session.handle({ type: 'STAT', requestId: 42, path: 'hello.txt' });

    const received = events.find((e) => e.topic === 'sftp.packet.received' && (e.payload as { requestId?: number }).requestId === 42);
    const sent = events.find((e) => e.topic === 'sftp.packet.sent' && (e.payload as { requestId?: number }).requestId === 42);
    expect(received).toBeDefined();
    expect(sent).toBeDefined();
  });

  it('emits sftp.handle.opened on OPEN and sftp.handle.closed on CLOSE, same handle', () => {
    const { session, events } = buildSession();
    const openReply = session.handle({ type: 'OPEN', requestId: 1, filename: 'hello.txt', pflags: 0x01, attrs: {} });
    const handle = (openReply as { handle: string }).handle;
    session.handle({ type: 'CLOSE', requestId: 2, handle });

    const opened = events.find((e) => e.topic === 'sftp.handle.opened');
    const closed = events.find((e) => e.topic === 'sftp.handle.closed');
    expect(opened).toBeDefined();
    expect((opened!.payload as { handle: string; kind: string; path: string }).handle).toBe(handle);
    expect((opened!.payload as { kind: string }).kind).toBe('file-read');
    expect((opened!.payload as { path: string }).path).toBe('/home/alice/hello.txt');
    expect(closed).toBeDefined();
    expect((closed!.payload as { handle: string }).handle).toBe(handle);
  });

  it('emits sftp.handle.opened for OPENDIR too', () => {
    const { session, events } = buildSession();
    session.handle({ type: 'OPENDIR', requestId: 1, path: '.' });
    const opened = events.find((e) => e.topic === 'sftp.handle.opened');
    expect(opened).toBeDefined();
    expect((opened!.payload as { kind: string }).kind).toBe('dir');
  });

  it('emits sftp.transfer.progress with the real byte count on READ', () => {
    const { session, events } = buildSession();
    const openReply = session.handle({ type: 'OPEN', requestId: 1, filename: 'hello.txt', pflags: 0x01, attrs: {} });
    const handle = (openReply as { handle: string }).handle;
    session.handle({ type: 'READ', requestId: 2, handle, offset: 0, length: 512 });

    const progress = events.find((e) => e.topic === 'sftp.transfer.progress');
    expect(progress).toBeDefined();
    expect((progress!.payload as { bytesTransferred: number }).bytesTransferred).toBe('hello sftp observability'.length);
  });

  it('emits sftp.transfer.progress with the real byte count on WRITE', () => {
    const { session, events } = buildSession();
    const openReply = session.handle({ type: 'OPEN', requestId: 1, filename: 'uploaded.txt', pflags: 0x02, attrs: {} });
    const handle = (openReply as { handle: string }).handle;
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    session.handle({ type: 'WRITE', requestId: 2, handle, offset: 0, data });

    const progress = events.find((e) => e.topic === 'sftp.transfer.progress');
    expect(progress).toBeDefined();
    expect((progress!.payload as { bytesTransferred: number }).bytesTransferred).toBe(5);
  });

  it('SftpSignalStore aggregates counters from the event bus', () => {
    const { session, bus } = buildSession();
    const store = new SftpSignalStore();
    subscribeSftpObservables(bus, store);

    const openReply = session.handle({ type: 'OPEN', requestId: 1, filename: 'hello.txt', pflags: 0x01, attrs: {} });
    const handle = (openReply as { handle: string }).handle;
    session.handle({ type: 'READ', requestId: 2, handle, offset: 0, length: 512 });
    session.handle({ type: 'CLOSE', requestId: 3, handle });

    const metrics = store.metrics.get();
    expect(metrics.handlesOpened).toBe(1);
    expect(metrics.handlesClosed).toBe(1);
    expect(metrics.openHandles).toBe(0);
    expect(metrics.bytesTransferred).toBe('hello sftp observability'.length);
    expect(metrics.packetsReceived).toBeGreaterThanOrEqual(3);
    expect(metrics.packetsSent).toBe(metrics.packetsReceived);
  });

  it('works with no eventBus configured at all (observability is optional)', () => {
    const vfs = new VirtualFileSystem();
    vfs.mkdirp('/home/alice', 0o755, 1000, 1000);
    vfs.writeFile('/home/alice/hello.txt', 'hi', 1000, 1000, 0o022);
    const fs = new LinuxSftpFSAdapter(vfs, 1000, 1000);
    const userCtx = new SshUserContext('alice', 1000, 1000, [], '/home/alice');
    const session = new SftpWireSession({ vfs: fs, userCtx, rootPath: '/home/alice' });
    expect(() => session.handle({ type: 'INIT', version: 6 })).not.toThrow();
  });
});
