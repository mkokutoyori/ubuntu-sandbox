/**
 * Oracle TNS listener ↔ host TCP/IP layer integration.
 *
 * On a real Oracle host the TNS listener (`tnslsnr`) binds the database
 * port (1521) and shows up in `netstat`/`ss` as a LISTEN socket. The
 * lifecycle of that socket must track `lsnrctl start` / `stop`.
 *
 * The bridge is a dedicated adapter (OracleListenerSync) that subscribes
 * to the oracle bus — no coupling between OracleInstance and the network
 * stack. This verifies the socket really opens/closes on the device, not
 * just a cosmetic netstat string.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
import { ORACLE_CONFIG } from '@/terminal/commands/OracleConfig';

const PORT = ORACLE_CONFIG.PORT;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function listenSocket(srv: LinuxServer) {
  return srv.getSocketTable().getAll().find(
    (s) => s.protocol === 'tcp' && s.localPort === PORT && s.state === 'LISTEN',
  );
}

function hasTcpListener(srv: LinuxServer): boolean {
  return srv.getTcpStack().listListeners().some((l) => l.localPort === PORT);
}

describe('TNS listener binds a real TCP socket on the host', () => {
  it('does not bind the port until the listener is started', () => {
    const srv = new LinuxServer('linux-server', 'ora-net1', 100, 100);
    getOracleDatabase(srv.getId());
    expect(listenSocket(srv)).toBeUndefined();
    expect(hasTcpListener(srv)).toBe(false);
  });

  it('binds tcp/1521 as tnslsnr when the listener starts', () => {
    const srv = new LinuxServer('linux-server', 'ora-net2', 100, 100);
    const db = getOracleDatabase(srv.getId());
    db.instance.startListener();

    const sock = listenSocket(srv);
    expect(sock).toBeDefined();
    expect(sock?.processName).toBe('tnslsnr');
    expect(sock?.localAddress).toBe('0.0.0.0');
    expect(hasTcpListener(srv)).toBe(true);
  });

  it('releases the socket when the listener stops', () => {
    const srv = new LinuxServer('linux-server', 'ora-net3', 100, 100);
    const db = getOracleDatabase(srv.getId());
    db.instance.startListener();
    expect(listenSocket(srv)).toBeDefined();

    db.instance.stopListener();
    expect(listenSocket(srv)).toBeUndefined();
    expect(hasTcpListener(srv)).toBe(false);
  });

  it('is idempotent — starting twice does not double-bind (no EADDRINUSE)', () => {
    const srv = new LinuxServer('linux-server', 'ora-net4', 100, 100);
    const db = getOracleDatabase(srv.getId());
    db.instance.startListener();
    // Second start is a no-op at the Oracle level, but the adapter must
    // also be defensive against re-binding the same port.
    expect(() => db.instance.startListener()).not.toThrow();
    const listening = srv.getSocketTable().getAll().filter(
      (s) => s.protocol === 'tcp' && s.localPort === PORT && s.state === 'LISTEN',
    );
    expect(listening).toHaveLength(1);
  });
});

describe('the listener socket is visible through netstat/ss', () => {
  it('appears in `netstat -tlnp` with the tnslsnr program', async () => {
    const srv = new LinuxServer('linux-server', 'ora-net5', 100, 100);
    const db = getOracleDatabase(srv.getId());
    db.instance.startListener();

    const out = await srv.executeCommand('netstat -tlnp');
    expect(out).toContain(`:${PORT}`);
    expect(out).toContain('tnslsnr');
  });

  it('disappears from `ss -tlnp` after the listener stops', async () => {
    const srv = new LinuxServer('linux-server', 'ora-net6', 100, 100);
    const db = getOracleDatabase(srv.getId());
    db.instance.startListener();
    db.instance.stopListener();

    const out = await srv.executeCommand('ss -tlnp');
    expect(out).not.toContain(`:${PORT}`);
  });
});
