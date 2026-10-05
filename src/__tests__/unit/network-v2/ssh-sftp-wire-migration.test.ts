/**
 * SFTP-over-SSH on the real wire (PRD-FTP-SFTP.md §2.1.20/P19).
 * `SshSftpChannel` opens a `session` channel (RFC 4254 §6.1), asks for the
 * `sftp` subsystem (§6.5) and exchanges `SSH_FXP_*` packets
 * (`SftpWireCodec.ts`) as the data of that channel -- no JSON envelope,
 * no local framing. `df` is the OpenSSH `statvfs@openssh.com` extension
 * carried by SSH_FXP_EXTENDED / SSH_FXP_EXTENDED_REPLY.
 *
 * The transport is RFC 4253: a raw TCP capture shows only sealed packets,
 * so the observation point is each end's `SshTransport.send` BEFORE
 * encryption. The CHANNEL_DATA payloads of each role are reassembled into
 * length-prefixed SFTP packets and their types recorded.
 *
 * Before this change the file asserted `\0`-tagged frames carried in the
 * local message 192 and a JSON `{op:'df'}` envelope; the df case encoded
 * that legacy premise and now asserts the EXTENDED packet instead.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { TcpConnector } from '@/network/tcp/types';
import { MockTcpConnection } from './MockTcpConnection';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxUserManager } from '@/network/devices/linux/LinuxUserManager';
import { LinuxSshServerContext } from '@/network/protocols/ssh/server/LinuxSshServerContext';
import { SshServerHandler } from '@/network/protocols/ssh/server/SshServerHandler';
import { SftpSession } from '@/network/protocols/ssh/sftp/SftpSession';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { decodeSftpWirePacket } from '@/network/protocols/ssh/sftp/SftpWireCodec';
import { SshTransport } from '@/network/protocols/ssh/transport/SshTransport';
import { decodeConnectionMessage } from '@/network/protocols/ssh/connection/ConnectionMessages';
import { SSH_MSG_CHANNEL_DATA } from '@/network/protocols/ssh/transport/SshMessageNumbers';

const REMOTE_IP = '10.0.0.2';
const LOCAL_IP = '10.0.0.1';

function buildTopology(files: Record<string, string> = {}) {
  const vfs = new VirtualFileSystem();
  const userManager = new LinuxUserManager(vfs);
  userManager.useradd('alice', { m: true, s: '/bin/bash' });
  userManager.setPassword('alice', 'secret');
  for (const [path, content] of Object.entries(files)) vfs.writeFile(path, content, 1000, 1000, 0o022);
  const context = new LinuxSshServerContext(vfs, userManager, 'remote-host', { permitRootLogin: true });
  const handler = new SshServerHandler(context);

  const clientToServer: string[] = [];
  const serverToClient: string[] = [];
  const rawWire: string[] = [];
  observeUpperLayer({ client: clientToServer, server: serverToClient });

  const bridge: { server: MockTcpConnection | null } = { server: null };
  const client = new MockTcpConnection(LOCAL_IP, 49000, REMOTE_IP, 22, 100, (seg) => {
    if (seg.payload != null) {
      rawWire.push(String(seg.payload));
      bridge.server?.receiveData(String(seg.payload));
    }
  });
  const server = new MockTcpConnection(REMOTE_IP, 22, LOCAL_IP, 49000, 200, (seg) => {
    if (seg.payload != null) {
      rawWire.push(String(seg.payload));
      client.receiveData(String(seg.payload));
    }
  });
  bridge.server = server;
  handler.register(server, LOCAL_IP);

  const connector: TcpConnector = async (host) => (host === REMOTE_IP ? client : null);
  const localVfs = new VirtualFileSystem();
  const session = new SftpSession({
    tcpConnector: connector,
    localVfs,
    localUser: 'root',
    localUid: 0,
    localGid: 0,
    localCwd: '/root',
    knownHostsPath: '/root/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler('secret'),
    homeDirectory: '/root',
  });
  return { session, vfs, localVfs, clientToServer, serverToClient, rawWire };
}

function observeUpperLayer(sinks: Record<'client' | 'server', string[]>): void {
  const pending: Record<'client' | 'server', Uint8Array> = { client: new Uint8Array(0), server: new Uint8Array(0) };
  const send = SshTransport.prototype.send;
  vi.spyOn(SshTransport.prototype, 'send').mockImplementation(function (this: SshTransport, payload: Uint8Array) {
    const role = (this as unknown as { config: { role: 'client' | 'server' } }).config.role;
    if (payload[0] === SSH_MSG_CHANNEL_DATA) {
      const message = decodeConnectionMessage(payload);
      if (message?.kind === 'data') {
        const merged = new Uint8Array(pending[role].length + message.data.length);
        merged.set(pending[role]);
        merged.set(message.data, pending[role].length);
        pending[role] = merged;
        while (pending[role].length >= 4) {
          const bytes = pending[role];
          const length = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
          if (bytes.length < 4 + length) break;
          const packet = decodeSftpWirePacket(bytes.subarray(0, 4 + length));
          if (packet) sinks[role].push(packet.type);
          pending[role] = bytes.slice(4 + length);
        }
      }
    }
    send.call(this, payload);
  });
}

afterEach(() => { vi.restoreAllMocks(); });

function wirePacketTypes(packetTypes: readonly string[]): string[] {
  return [...packetTypes];
}

describe('SFTP-over-SSH speaks the real SSH_FXP_* wire protocol (§2.1.20/P19)', () => {
  it('the raw TCP stream carries only the RFC 4253 identification and sealed packets — WITNESS of the observation point', async () => {
    const { session, rawWire } = buildTopology();
    await session.connect(`alice@${REMOTE_IP}`);

    const stream = rawWire.join('');
    expect(stream.startsWith('SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.6\r\n')).toBe(true);
    expect(stream).not.toContain('"op"');
  });

  it('the channel-open handshake is a real binary INIT/VERSION exchange, not JSON', async () => {
    const { session, clientToServer, serverToClient } = buildTopology();
    await session.connect(`alice@${REMOTE_IP}`);

    expect(wirePacketTypes(clientToServer)).toContain('INIT');
    expect(wirePacketTypes(serverToClient)).toContain('VERSION');
  });

  it('get() drives a real OPEN(read)/READ/CLOSE sequence on the wire', async () => {
    const { session, clientToServer } = buildTopology({ '/home/alice/hello.txt': 'hello wire migration' });
    await session.connect(`alice@${REMOTE_IP}`);
    clientToServer.length = 0;
    const out = session.get('hello.txt');
    expect(out).toContain('hello.txt');

    const types = wirePacketTypes(clientToServer);
    expect(types).toContain('OPEN');
    expect(types).toContain('READ');
    expect(types).toContain('CLOSE');
  });

  it('put() drives a real OPEN(write)/WRITE/CLOSE sequence, and the file really lands on the server', async () => {
    const { session, vfs, localVfs, clientToServer } = buildTopology();
    await session.connect(`alice@${REMOTE_IP}`);
    localVfs.writeFile('/root/local.txt', 'uploaded via real wire', 0, 0, 0o022);
    clientToServer.length = 0;

    const out = session.put('local.txt', 'uploaded.txt');
    expect(out).toContain('uploaded.txt');
    expect(vfs.readFile('/home/alice/uploaded.txt')).toBe('uploaded via real wire');

    const types = wirePacketTypes(clientToServer);
    expect(types).toContain('OPEN');
    expect(types).toContain('WRITE');
    expect(types).toContain('CLOSE');
  });

  it('ls() drives a real OPENDIR/READDIR/CLOSE sequence', async () => {
    const { session, clientToServer } = buildTopology({ '/home/alice/a.txt': 'A' });
    await session.connect(`alice@${REMOTE_IP}`);
    clientToServer.length = 0;
    const out = session.ls([], new Set());
    expect(out).toContain('a.txt');

    const types = wirePacketTypes(clientToServer);
    expect(types).toContain('OPENDIR');
    expect(types).toContain('READDIR');
    expect(types).toContain('CLOSE');
  });

  it('mkdir/rm/rmdir/rename/chmod/chown/stat each produce a real single wire op', async () => {
    const { session, clientToServer } = buildTopology({ '/home/alice/target.txt': 'x' });
    await session.connect(`alice@${REMOTE_IP}`);

    clientToServer.length = 0;
    expect(session.mkdir('newdir')).toBe('');
    expect(wirePacketTypes(clientToServer)).toContain('MKDIR');

    clientToServer.length = 0;
    expect(session.chmod('600', 'target.txt')).toContain('Changing mode');
    expect(wirePacketTypes(clientToServer)).toContain('SETSTAT');

    clientToServer.length = 0;
    expect(session.stat('target.txt')).toContain('Size:');
    expect(wirePacketTypes(clientToServer)).toContain('STAT');

    clientToServer.length = 0;
    expect(session.rename('target.txt', 'renamed.txt')).toBe('');
    expect(wirePacketTypes(clientToServer)).toContain('RENAME');

    clientToServer.length = 0;
    expect(session.rm('renamed.txt')).toBe('');
    expect(wirePacketTypes(clientToServer)).toContain('REMOVE');

    clientToServer.length = 0;
    expect(session.rmdir('newdir')).toBe('');
    expect(wirePacketTypes(clientToServer)).toContain('RMDIR');
  });

  it('version() is answered from the real INIT/VERSION handshake, still reporting v3 (OpenSSH-compatible default)', async () => {
    const { session, clientToServer } = buildTopology();
    await session.connect(`alice@${REMOTE_IP}`);
    clientToServer.length = 0;
    expect(session.version()).toBe('SFTP protocol version 3');
    // No new wire round trip needed for `version` — the earlier handshake already answered it.
    expect(wirePacketTypes(clientToServer)).toHaveLength(0);
  });

  it('df() is the statvfs@openssh.com extension: one EXTENDED request answered by one EXTENDED_REPLY', async () => {
    const { session, clientToServer, serverToClient } = buildTopology();
    await session.connect(`alice@${REMOTE_IP}`);
    clientToServer.length = 0;
    serverToClient.length = 0;
    const out = session.df(undefined, false);
    expect(out).toContain('Size');

    expect(wirePacketTypes(clientToServer)).toEqual(['EXTENDED']);
    expect(wirePacketTypes(serverToClient)).toEqual(['EXTENDED_REPLY']);
  });
});
