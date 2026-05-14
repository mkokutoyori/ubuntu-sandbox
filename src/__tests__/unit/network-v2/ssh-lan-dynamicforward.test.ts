/**
 * SSH LAN — dynamic forwarding (`ssh -D`, SOCKS proxy).
 *
 * OpenSSH `-D [bindAddress:]localPort` opens a SOCKS4/5 proxy on the
 * local machine. Applications speaking SOCKS connect to that port and
 * negotiate the target host/port through SOCKS; the SSH client then
 * tunnels each connection through the SSH server.
 *
 * Scope (parser + SOCKS5 handshake stub — full byte bridging not
 * exercised here, the listener / SOCKS replies are):
 *  - D1..D3 : parseDynamicForwardSpec parses `port` / `bind:port` / rejects.
 *  - D4..D5 : parseSshArgs collects multiple `-D` and `-o DynamicForward=`.
 *  - D6     : SshDynamicForwarder.register() leaves a listener.
 *  - D7     : dispose() unregisters.
 *  - D8     : SOCKS5 greeting receives the canonical `0x05 0x00` reply.
 *  - D9     : SOCKS5 CONNECT extracts the target host/port.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { Equipment } from '@/network';
import {
  parseDynamicForwardSpec,
  parseSshArgs,
} from '@/terminal/sessions/sshArgs';
import { SshDynamicForwarder } from '@/network/protocols/ssh/SshDynamicForwarder';
import {
  buildLan,
  assignIps,
  type SshLan,
  PC2_IP,
} from './ssh-lan-fixtures';

describe('SSH LAN — dynamic forwarding (`ssh -D`)', () => {
  let lan: SshLan;

  beforeEach(async () => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    Equipment.clearRegistry();
    lan = buildLan();
    await assignIps(lan);
  });

  // ─── parser ───────────────────────────────────────────────────

  // D1
  it('D1 — parseDynamicForwardSpec accepts a bare port', () => {
    expect(parseDynamicForwardSpec('1080')).toEqual({
      socksPort: 1080,
      bindAddress: null,
    });
  });

  // D2
  it('D2 — parseDynamicForwardSpec accepts `bindAddress:port`', () => {
    expect(parseDynamicForwardSpec('127.0.0.1:1080')).toEqual({
      socksPort: 1080,
      bindAddress: '127.0.0.1',
    });
  });

  // D3
  it('D3 — parseDynamicForwardSpec rejects malformed input', () => {
    expect(parseDynamicForwardSpec('')).toBeNull();
    expect(parseDynamicForwardSpec('not-a-port')).toBeNull();
    expect(parseDynamicForwardSpec('0')).toBeNull();
    expect(parseDynamicForwardSpec('a:b:c')).toBeNull();
  });

  // D4
  it('D4 — parseSshArgs collects multiple `-D` entries', () => {
    const parsed = parseSshArgs([
      '-D', '1080',
      '-D', '1.2.3.4:1081',
      'user@10.0.0.2',
    ]);
    expect(parsed!.dynamicForwards).toEqual([
      { socksPort: 1080, bindAddress: null },
      { socksPort: 1081, bindAddress: '1.2.3.4' },
    ]);
  });

  // D5
  it('D5 — `-o DynamicForward=...` adds to the same list', () => {
    const parsed = parseSshArgs([
      '-o', 'DynamicForward=1080',
      'user@10.0.0.2',
    ]);
    expect(parsed!.dynamicForwards).toEqual([
      { socksPort: 1080, bindAddress: null },
    ]);
  });

  // ─── listener registration ────────────────────────────────────

  // D6
  it('D6 — register() leaves a TCP listener on the local device', () => {
    const fwd = new SshDynamicForwarder(lan.pc1, null, {
      socksPort: 1080,
      bindAddress: null,
      sshHost: PC2_IP,
    });
    fwd.register();
    expect(isPortListening(lan.pc1, 1080)).toBe(true);
    expect(fwd.getSpec().socksPort).toBe(1080);
  });

  // D7
  it('D7 — dispose() unregisters the listener', () => {
    const fwd = new SshDynamicForwarder(lan.pc1, null, {
      socksPort: 1080,
      bindAddress: null,
      sshHost: PC2_IP,
    });
    fwd.register();
    expect(isPortListening(lan.pc1, 1080)).toBe(true);
    fwd.dispose();
    expect(isPortListening(lan.pc1, 1080)).toBe(false);
  });

  // ─── SOCKS5 handshake ─────────────────────────────────────────

  // D8
  it('D8 — SOCKS5 greeting `0x05 0x01 0x00` receives the `0x05 0x00` reply', () => {
    const fwd = new SshDynamicForwarder(lan.pc1, null, {
      socksPort: 1080,
      bindAddress: null,
      sshHost: PC2_IP,
    });
    const conn = makeFakeConn();
    fwd.handleAcceptForTest(conn as never);
    // Client sends version=5, nmethods=1, methods=[0x00] (no auth).
    conn.emit('\x05\x01\x00');
    expect(conn.lastWrite).toBe('\x05\x00');
  });

  // D9
  it('D9 — SOCKS5 CONNECT extracts the target host:port', () => {
    const fwd = new SshDynamicForwarder(lan.pc1, null, {
      socksPort: 1080,
      bindAddress: null,
      sshHost: PC2_IP,
    });
    const conn = makeFakeConn();
    fwd.handleAcceptForTest(conn as never);
    // Greeting first.
    conn.emit('\x05\x01\x00');
    // CONNECT request: ver=5, cmd=1 (connect), rsv=0, atyp=3 (domain),
    // len=11, domain="example.com", port=80 (0x0050).
    const domain = 'example.com';
    const req =
      '\x05\x01\x00\x03' +
      String.fromCharCode(domain.length) +
      domain +
      '\x00\x50';
    conn.emit(req);
    expect(fwd.getLastConnectTarget()).toEqual({
      host: 'example.com',
      port: 80,
    });
    // Server response starts with version 5 + status 0x00 (succeeded).
    expect(conn.lastWrite!.charCodeAt(0)).toBe(0x05);
    expect(conn.lastWrite!.charCodeAt(1)).toBe(0x00);
  });
});

function isPortListening(device: unknown, port: number): boolean {
  const listeners = (device as { tcpListeners?: Map<number, unknown> })
    .tcpListeners;
  return listeners?.has(port) ?? false;
}

function makeFakeConn() {
  let onDataHandler: ((d: string) => void) | null = null;
  const conn = {
    lastWrite: undefined as string | undefined,
    writes: [] as string[],
    write: vi.fn((data: string) => {
      conn.lastWrite = data;
      conn.writes.push(data);
    }),
    onData: vi.fn((handler: (d: string) => void) => {
      onDataHandler = handler;
      return () => {
        onDataHandler = null;
      };
    }),
    close: vi.fn(),
    emit(data: string) {
      onDataHandler?.(data);
    },
  };
  return conn;
}
