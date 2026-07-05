/**
 * TFTP (RFC 1350 §4-5, RFC 2347-2349) — PRD-FTP-SFTP.md §2.1.13.
 * Fully independent of the FTP/FTPS module: own UDP/69 conversation per
 * transfer, no control channel, no authentication.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { TftpServer, TftpClientSession } from '@/network/tftp/TftpSession';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';
import { encodeTftpPacket, decodeTftpPacket } from '@/network/tftp/codec';
import { EventBus } from '@/events/EventBus';
import type { DomainEvent } from '@/events/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

function buildTopology(
  serverConfigOverrides: Record<string, unknown> = {},
  clientOpts: { timeoutMs?: number; maxRetries?: number } = {},
) {
  const bus = new EventBus();
  const events: DomainEvent[] = [];
  bus.subscribeAll((e) => events.push(e));

  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('TFTP1');
  pc.configureInterface('eth0', new IPAddress('10.0.5.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.5.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  const vfs = new VirtualFileSystem();
  vfs.mkdirp('/srv/tftp', 0o755, 1000, 1000);
  vfs.writeFile('/srv/tftp/hello.txt', 'hello tftp world', 1000, 1000, 0o022);
  const fs = new LinuxSftpFSAdapter(vfs, 1000, 1000);

  const server = new TftpServer(srv, { fs, rootPath: '/srv/tftp', eventBus: bus, ...serverConfigOverrides });
  server.start();

  const client = new TftpClientSession(
    pc, new IPAddress('10.0.5.10'), undefined, clientOpts.timeoutMs, clientOpts.maxRetries,
  );
  return { pc, srv, vfs, server, client, bus, events };
}

describe('TFTP codec (RFC 1350 §5)', () => {
  it('round-trips an RRQ with no options', () => {
    const pkt = encodeTftpPacket({ opcode: 'RRQ', filename: 'a.txt', mode: 'octet' });
    expect(decodeTftpPacket(pkt)).toEqual({ opcode: 'RRQ', filename: 'a.txt', mode: 'octet', options: undefined });
  });

  it('round-trips a WRQ carrying blksize/timeout/tsize options (RFC 2347-2349)', () => {
    const pkt = encodeTftpPacket({
      opcode: 'WRQ', filename: 'b.bin', mode: 'octet',
      options: { blksize: 1024, timeout: 3, tsize: 4096 },
    });
    expect(decodeTftpPacket(pkt)).toEqual({
      opcode: 'WRQ', filename: 'b.bin', mode: 'octet',
      options: { blksize: 1024, timeout: 3, tsize: 4096 },
    });
  });

  it('round-trips a DATA packet with binary content', () => {
    const data = new Uint8Array([0, 1, 2, 255, 254, 10, 13]);
    const pkt = encodeTftpPacket({ opcode: 'DATA', block: 7, data });
    expect(decodeTftpPacket(pkt)).toEqual({ opcode: 'DATA', block: 7, data });
  });

  it('round-trips an ACK packet', () => {
    const pkt = encodeTftpPacket({ opcode: 'ACK', block: 42 });
    expect(decodeTftpPacket(pkt)).toEqual({ opcode: 'ACK', block: 42 });
  });

  it('round-trips an ERROR packet', () => {
    const pkt = encodeTftpPacket({ opcode: 'ERROR', code: 1, message: 'File not found.' });
    expect(decodeTftpPacket(pkt)).toEqual({ opcode: 'ERROR', code: 1, message: 'File not found.' });
  });

  it('round-trips an OACK packet', () => {
    const pkt = encodeTftpPacket({ opcode: 'OACK', options: { blksize: 1024 } });
    expect(decodeTftpPacket(pkt)).toEqual({ opcode: 'OACK', options: { blksize: 1024 } });
  });

  it('rejects a truncated packet', () => {
    expect(decodeTftpPacket(new Uint8Array([0, 3]))).toBeNull();
  });

  it('rejects an unknown opcode', () => {
    expect(decodeTftpPacket(new Uint8Array([0, 99, 0, 1]))).toBeNull();
  });
});

describe('TFTP RRQ/WRQ end-to-end transfer', () => {
  it('downloads a file byte-exact via RRQ (default 512-byte blksize)', async () => {
    const { client } = buildTopology();
    const result = await client.get('hello.txt');
    expect(result.ok).toBe(true);
    expect(result.content).toBe('hello tftp world');
  });

  it('uploads a file byte-exact via WRQ', async () => {
    const { client, vfs } = buildTopology();
    const result = await client.put('uploaded.txt', 'sent via tftp');
    expect(result.ok).toBe(true);
    expect(vfs.readFile('/srv/tftp/uploaded.txt')).toBe('sent via tftp');
  });

  it('RRQ on a nonexistent file fails with File not found', async () => {
    const { client } = buildTopology();
    const result = await client.get('ghost.txt');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/File not found/);
  });

  it('transfers content spanning multiple blocks (negotiated small blksize)', async () => {
    const { client, vfs } = buildTopology();
    const big = 'ABCDEFGHIJ'.repeat(50); // 500 bytes
    await client.put('multi.txt', big, { blksize: 8 });
    expect(vfs.readFile('/srv/tftp/multi.txt')).toBe(big);

    const result = await client.get('multi.txt', { blksize: 8 });
    expect(result.ok).toBe(true);
    expect(result.content).toBe(big);
  });

  it('handles content exactly a multiple of the negotiated blksize (trailing empty block)', async () => {
    const { client, vfs } = buildTopology();
    const exact = 'X'.repeat(16); // exactly 2 blocks of 8
    await client.put('exact.txt', exact, { blksize: 8 });
    expect(vfs.readFile('/srv/tftp/exact.txt')).toBe(exact);

    const result = await client.get('exact.txt', { blksize: 8 });
    expect(result.ok).toBe(true);
    expect(result.content).toBe(exact);
  });

  it('round-trips binary content with embedded nulls', async () => {
    const { client, vfs } = buildTopology();
    const content = 'binary-safe\x00\x01\x02\xff';
    await client.put('bin.dat', content);
    expect(vfs.readFile('/srv/tftp/bin.dat')).toBe(content);
    const result = await client.get('bin.dat');
    expect(result.content).toBe(content);
  });

  it('recovers via retransmission after one dropped server datagram', async () => {
    const { srv, client } = buildTopology({}, { timeoutMs: 50, maxRetries: 3 });
    let dropped = false;
    const original = srv.sendUdpDatagramTo.bind(srv);
    vi.spyOn(srv, 'sendUdpDatagramTo').mockImplementation((...args: Parameters<typeof original>) => {
      if (!dropped) { dropped = true; return true; }
      return original(...args);
    });

    const result = await client.get('hello.txt');
    expect(result.ok).toBe(true);
    expect(result.content).toBe('hello tftp world');
  }, 10000);

  it('gives up after exhausting retries against an unresponsive peer', async () => {
    const { srv, client } = buildTopology({}, { timeoutMs: 20, maxRetries: 2 });
    vi.spyOn(srv, 'sendUdpDatagramTo').mockReturnValue(true); // black hole every server reply
    const result = await client.get('hello.txt');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Timed out/);
  }, 10000);
});

describe('TFTP observability (events.ts)', () => {
  it('emits tftp.transfer.started/completed for a successful RRQ', async () => {
    const { client, events } = buildTopology();
    await client.get('hello.txt');
    const started = events.find((e) => e.topic === 'tftp.transfer.started');
    expect(started).toBeDefined();
    expect((started!.payload as { mode: string }).mode).toBe('rrq');
    const completed = events.find((e) => e.topic === 'tftp.transfer.completed');
    expect(completed).toBeDefined();
    expect((completed!.payload as { bytes: number }).bytes).toBe('hello tftp world'.length);
  });

  it('emits tftp.transfer.failed for a file-not-found RRQ', async () => {
    const { client, events } = buildTopology();
    await client.get('ghost.txt');
    const failed = events.find((e) => e.topic === 'tftp.transfer.failed');
    expect(failed).toBeDefined();
    expect((failed!.payload as { errorCode: number }).errorCode).toBe(1);
  });
});

