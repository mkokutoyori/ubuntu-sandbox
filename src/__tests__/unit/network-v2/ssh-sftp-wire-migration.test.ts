/**
 * SFTP-over-SSH real wire migration (PRD-FTP-SFTP.md §2.1.20/P19).
 * `SshSftpChannel.ts` now speaks the real `SSH_FXP_*` wire protocol
 * (`SftpWireCodec.ts`/`SftpWireSession.ts`) framed as a `\0`-tagged
 * binary sub-channel (`SftpChannelFraming.ts`) instead of a JSON
 * `{op, ...}` envelope, while the server's shared JSON control
 * messages (auth/shell/exec) are untouched. This file proves the new
 * encoding is genuinely on the wire — behavioral regression coverage
 * for `SftpSession`'s public surface already lives in `ssh-sftp.test.ts`
 * and stays green unmodified.
 *
 * Le transport est desormais celui de la RFC 4253 : apres l'echange
 * d'identifications et de KEXINIT, chaque paquet est scelle en
 * aes128-gcm@openssh.com sous des cles derivees de l'echange curve25519.
 * Un releve brut du flux TCP ne montre donc plus que des paquets
 * chiffres. Ce que ce fichier prouve n'a pas change -- SFTP parle bien le
 * codec binaire et non une enveloppe JSON -- mais le point d'observation
 * descend d'un cran : on lit les charges utiles que chaque extremite
 * remet a son transport (`SshTransport.send`) AVANT le chiffrement, et on
 * reassemble les fragments du message local 192 qui les porte.
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
import { decodeSftpChannelFrame, isSftpChannelFrame } from '@/network/protocols/ssh/channels/SftpChannelFraming';
import { decodeSftpWirePacket } from '@/network/protocols/ssh/sftp/SftpWireCodec';
import { SshTransport } from '@/network/protocols/ssh/transport/SshTransport';
import { SSH_MSG_LOCAL_LEGACY_FRAME } from '@/network/protocols/ssh/transport/SshMessageNumbers';
import { bytesToUtf8 } from '@/crypto/encoding';

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
  const pending: Record<'client' | 'server', Uint8Array[]> = { client: [], server: [] };
  const send = SshTransport.prototype.send;
  vi.spyOn(SshTransport.prototype, 'send').mockImplementation(function (this: SshTransport, payload: Uint8Array) {
    const role = (this as unknown as { config: { role: 'client' | 'server' } }).config.role;
    if (payload[0] === SSH_MSG_LOCAL_LEGACY_FRAME) {
      pending[role].push(payload.slice(2));
      if (payload[1] === 0) {
        const parts = pending[role].splice(0);
        const whole = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let offset = 0;
        for (const p of parts) { whole.set(p, offset); offset += p.length; }
        sinks[role].push(bytesToUtf8(whole));
      }
    }
    send.call(this, payload);
  });
}

afterEach(() => { vi.restoreAllMocks(); });

function wirePacketTypes(payloads: readonly string[]): string[] {
  const types: string[] = [];
  for (const p of payloads) {
    if (!isSftpChannelFrame(p)) continue;
    const { wireBytes } = decodeSftpChannelFrame(p);
    const pkt = decodeSftpWirePacket(wireBytes);
    if (pkt) types.push(pkt.type);
  }
  return types;
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
    // Every message on the wire is either a real `\0`-tagged frame or valid JSON control text — never a mix.
    for (const p of [...clientToServer, ...serverToClient]) {
      if (isSftpChannelFrame(p)) continue;
      expect(() => JSON.parse(p)).not.toThrow();
    }
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

  it('df() deliberately keeps using the legacy JSON envelope (no real SFTP wire representation exists for it)', async () => {
    const { session, clientToServer } = buildTopology();
    await session.connect(`alice@${REMOTE_IP}`);
    clientToServer.length = 0;
    const out = session.df(undefined, false);
    expect(out).toContain('Size');

    expect(wirePacketTypes(clientToServer)).toHaveLength(0);
    const jsonMessages = clientToServer.filter((p) => !isSftpChannelFrame(p));
    expect(jsonMessages.some((p) => { try { return JSON.parse(p).op === 'df'; } catch { return false; } })).toBe(true);
  });
});
