/**
 * Socket table & port numbers — TDD tests.
 *
 * Covers:
 *   SP-01  WellKnownPorts — port range classification (RFC 6335)
 *   SP-02  WellKnownPorts — IANA service name lookup
 *   SP-03  SocketTable — bind (LISTEN)
 *   SP-04  SocketTable — double bind (EADDRINUSE)
 *   SP-05  SocketTable — connect (ESTABLISHED)
 *   SP-06  SocketTable — close
 *   SP-07  SocketTable — ephemeral port allocation
 *   SP-08  SocketTable — queries (getListening / getEstablished / getAll / findByLocalPort)
 *   SP-09  SocketTable — isPortBound
 *   SP-10  EndHost integration — socket table pre-populated per OS
 *   SP-11  Linux netstat — dynamic output from socket table
 *   SP-12  Linux ss — dynamic output from socket table
 *   SP-13  Windows netstat — dynamic output from socket table
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { SocketTable } from '@/network/core/SocketTable';
import {
  getPortRange,
  getServiceName,
  isPrivileged,
  isEphemeral,
  PortRange,
  EPHEMERAL_PORT_MIN,
  EPHEMERAL_PORT_MAX,
} from '@/network/core/WellKnownPorts';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════════
// SP-01 — WellKnownPorts: port range classification (RFC 6335)
// ═══════════════════════════════════════════════════════════════════════

describe('SP-01 — WellKnownPorts: port range classification', () => {

  it('port 0 is well-known', () => {
    expect(getPortRange(0)).toBe(PortRange.WELL_KNOWN);
  });

  it('port 80 is well-known', () => {
    expect(getPortRange(80)).toBe(PortRange.WELL_KNOWN);
  });

  it('port 1023 is the last well-known port', () => {
    expect(getPortRange(1023)).toBe(PortRange.WELL_KNOWN);
  });

  it('port 1024 is the first registered port', () => {
    expect(getPortRange(1024)).toBe(PortRange.REGISTERED);
  });

  it('port 8080 is registered', () => {
    expect(getPortRange(8080)).toBe(PortRange.REGISTERED);
  });

  it('port 49151 is the last registered port', () => {
    expect(getPortRange(49151)).toBe(PortRange.REGISTERED);
  });

  it('port 49152 is the first ephemeral port (RFC 6335)', () => {
    expect(getPortRange(49152)).toBe(PortRange.EPHEMERAL);
  });

  it('port 65535 is the last ephemeral port', () => {
    expect(getPortRange(65535)).toBe(PortRange.EPHEMERAL);
  });

  it('EPHEMERAL_PORT_MIN is 49152', () => {
    expect(EPHEMERAL_PORT_MIN).toBe(49152);
  });

  it('EPHEMERAL_PORT_MAX is 65535', () => {
    expect(EPHEMERAL_PORT_MAX).toBe(65535);
  });

  it('isPrivileged returns true for port < 1024', () => {
    expect(isPrivileged(22)).toBe(true);
    expect(isPrivileged(1023)).toBe(true);
  });

  it('isPrivileged returns false for port >= 1024', () => {
    expect(isPrivileged(1024)).toBe(false);
    expect(isPrivileged(8080)).toBe(false);
  });

  it('isEphemeral returns true for port in [49152, 65535]', () => {
    expect(isEphemeral(49152)).toBe(true);
    expect(isEphemeral(65535)).toBe(true);
    expect(isEphemeral(50000)).toBe(true);
  });

  it('isEphemeral returns false outside ephemeral range', () => {
    expect(isEphemeral(49151)).toBe(false);
    expect(isEphemeral(22)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SP-02 — WellKnownPorts: IANA service name lookup
// ═══════════════════════════════════════════════════════════════════════

describe('SP-02 — WellKnownPorts: IANA service name lookup', () => {

  it('port 22/tcp → ssh', () => {
    expect(getServiceName(22, 'tcp')).toBe('ssh');
  });

  it('port 80/tcp → http', () => {
    expect(getServiceName(80, 'tcp')).toBe('http');
  });

  it('port 443/tcp → https', () => {
    expect(getServiceName(443, 'tcp')).toBe('https');
  });

  it('port 53/tcp → domain', () => {
    expect(getServiceName(53, 'tcp')).toBe('domain');
  });

  it('port 53/udp → domain', () => {
    expect(getServiceName(53, 'udp')).toBe('domain');
  });

  it('port 67/udp → bootps (DHCP server)', () => {
    expect(getServiceName(67, 'udp')).toBe('bootps');
  });

  it('port 68/udp → bootpc (DHCP client)', () => {
    expect(getServiceName(68, 'udp')).toBe('bootpc');
  });

  it('port 1521/tcp → oracle', () => {
    expect(getServiceName(1521, 'tcp')).toBe('oracle');
  });

  it('port 3389/tcp → ms-wbt-server (RDP)', () => {
    expect(getServiceName(3389, 'tcp')).toBe('ms-wbt-server');
  });

  it('port 3306/tcp → mysql', () => {
    expect(getServiceName(3306, 'tcp')).toBe('mysql');
  });

  it('port 5432/tcp → postgresql', () => {
    expect(getServiceName(5432, 'tcp')).toBe('postgresql');
  });

  it('port 500/udp → isakmp (IKE)', () => {
    expect(getServiceName(500, 'udp')).toBe('isakmp');
  });

  it('port 4500/udp → ipsec-nat-t', () => {
    expect(getServiceName(4500, 'udp')).toBe('ipsec-nat-t');
  });

  it('unknown port returns port number as string', () => {
    expect(getServiceName(12345, 'tcp')).toBe('12345');
  });

  it('port 67/tcp returns port number (67 is UDP-only in IANA)', () => {
    expect(getServiceName(67, 'tcp')).toBe('67');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SP-03 — SocketTable: bind (LISTEN)
// ═══════════════════════════════════════════════════════════════════════

describe('SP-03 — SocketTable: bind', () => {

  it('bind TCP creates a LISTEN entry', () => {
    const table = new SocketTable();
    const entry = table.bind('tcp', '0.0.0.0', 22, 985, 'sshd');
    expect(entry.state).toBe('LISTEN');
    expect(entry.protocol).toBe('tcp');
    expect(entry.localPort).toBe(22);
    expect(entry.localAddress).toBe('0.0.0.0');
    expect(entry.remoteAddress).toBe('*');
    expect(entry.remotePort).toBe(0);
  });

  it('bind UDP creates a LISTEN entry', () => {
    const table = new SocketTable();
    const entry = table.bind('udp', '127.0.0.53', 53, 540, 'systemd-resolved');
    expect(entry.state).toBe('LISTEN');
    expect(entry.protocol).toBe('udp');
    expect(entry.localPort).toBe(53);
  });

  it('bind stores pid and processName', () => {
    const table = new SocketTable();
    const entry = table.bind('tcp', '0.0.0.0', 80, 1234, 'nginx');
    expect(entry.pid).toBe(1234);
    expect(entry.processName).toBe('nginx');
  });

  it('bind assigns unique numeric id', () => {
    const table = new SocketTable();
    const e1 = table.bind('tcp', '0.0.0.0', 22, 985, 'sshd');
    const e2 = table.bind('tcp', '0.0.0.0', 80, 1234, 'nginx');
    expect(e1.id).not.toBe(e2.id);
    expect(typeof e1.id).toBe('number');
  });

  it('same port on different protocols does not conflict', () => {
    const table = new SocketTable();
    expect(() => table.bind('tcp', '0.0.0.0', 53, 1, 'named')).not.toThrow();
    expect(() => table.bind('udp', '0.0.0.0', 53, 1, 'named')).not.toThrow();
    expect(table.size).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SP-04 — SocketTable: EADDRINUSE on double bind
// ═══════════════════════════════════════════════════════════════════════

describe('SP-04 — SocketTable: double bind EADDRINUSE', () => {

  it('binding the same port/protocol twice throws EADDRINUSE', () => {
    const table = new SocketTable();
    table.bind('tcp', '0.0.0.0', 80, 1234, 'nginx');
    expect(() => table.bind('tcp', '0.0.0.0', 80, 9999, 'apache')).toThrow('EADDRINUSE');
  });

  it('EADDRINUSE message includes port and protocol', () => {
    const table = new SocketTable();
    table.bind('udp', '0.0.0.0', 53, 540, 'resolved');
    expect(() => table.bind('udp', '0.0.0.0', 53, 999, 'other')).toThrow(/53.*udp|udp.*53/i);
  });

  it('after EADDRINUSE, table still has only the original socket', () => {
    const table = new SocketTable();
    table.bind('tcp', '0.0.0.0', 22, 985, 'sshd');
    try { table.bind('tcp', '0.0.0.0', 22, 999, 'other'); } catch { /* expected */ }
    expect(table.size).toBe(1);
    expect(table.findByLocalPort(22, 'tcp')?.processName).toBe('sshd');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SP-05 — SocketTable: connect (ESTABLISHED)
// ═══════════════════════════════════════════════════════════════════════

describe('SP-05 — SocketTable: connect', () => {

  it('connect creates an ESTABLISHED entry', () => {
    const table = new SocketTable();
    const entry = table.connect('tcp', '10.0.0.1', 54321, '10.0.0.2', 80, 1000, 'curl');
    expect(entry.state).toBe('ESTABLISHED');
    expect(entry.protocol).toBe('tcp');
    expect(entry.remoteAddress).toBe('10.0.0.2');
    expect(entry.remotePort).toBe(80);
  });

  it('connect with localPort=0 auto-allocates an ephemeral port', () => {
    const table = new SocketTable();
    const entry = table.connect('tcp', '10.0.0.1', 0, '10.0.0.2', 443, 1000, 'curl');
    expect(entry.localPort).toBeGreaterThanOrEqual(EPHEMERAL_PORT_MIN);
    expect(entry.localPort).toBeLessThanOrEqual(EPHEMERAL_PORT_MAX);
  });

  it('two connects to same remote allocate different ephemeral ports', () => {
    const table = new SocketTable();
    const e1 = table.connect('tcp', '10.0.0.1', 0, '10.0.0.2', 80, 1000, 'wget');
    const e2 = table.connect('tcp', '10.0.0.1', 0, '10.0.0.2', 80, 1000, 'wget');
    expect(e1.localPort).not.toBe(e2.localPort);
  });

  it('connect stores pid and processName', () => {
    const table = new SocketTable();
    const entry = table.connect('tcp', '10.0.0.1', 55000, '8.8.8.8', 443, 2000, 'firefox');
    expect(entry.pid).toBe(2000);
    expect(entry.processName).toBe('firefox');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SP-06 — SocketTable: close
// ═══════════════════════════════════════════════════════════════════════

describe('SP-06 — SocketTable: close', () => {

  it('close by id removes the socket', () => {
    const table = new SocketTable();
    const entry = table.bind('tcp', '0.0.0.0', 80, 1234, 'nginx');
    expect(table.close(entry.id)).toBe(true);
    expect(table.size).toBe(0);
  });

  it('close returns false for non-existent id', () => {
    const table = new SocketTable();
    expect(table.close(9999)).toBe(false);
  });

  it('after close, the port can be re-bound', () => {
    const table = new SocketTable();
    const entry = table.bind('tcp', '0.0.0.0', 80, 1234, 'nginx');
    table.close(entry.id);
    expect(() => table.bind('tcp', '0.0.0.0', 80, 5678, 'apache2')).not.toThrow();
    expect(table.findByLocalPort(80, 'tcp')?.processName).toBe('apache2');
  });

  it('close also frees the port from isPortBound', () => {
    const table = new SocketTable();
    const entry = table.bind('tcp', '0.0.0.0', 443, 1234, 'nginx');
    table.close(entry.id);
    expect(table.isPortBound(443, 'tcp')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SP-07 — SocketTable: ephemeral port allocation
// ═══════════════════════════════════════════════════════════════════════

describe('SP-07 — SocketTable: ephemeral port allocation', () => {

  it('allocateEphemeralPort returns port in RFC 6335 range [49152, 65535]', () => {
    const table = new SocketTable();
    const port = table.allocateEphemeralPort();
    expect(port).toBeGreaterThanOrEqual(49152);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it('two consecutive calls return different ports', () => {
    const table = new SocketTable();
    // Register first port as bound so allocator skips it
    const p1 = table.allocateEphemeralPort();
    table.bind('tcp', '0.0.0.0', p1, 1, 'proc');
    const p2 = table.allocateEphemeralPort();
    expect(p2).not.toBe(p1);
  });

  it('allocateEphemeralPort never returns an already-bound port', () => {
    const table = new SocketTable();
    // Pre-bind a cluster of ports and verify allocator skips them
    const bound = new Set<number>();
    for (let p = 49152; p <= 49160; p++) {
      table.bind('tcp', '0.0.0.0', p, 1, 'test');
      bound.add(p);
    }
    for (let i = 0; i < 20; i++) {
      const p = table.allocateEphemeralPort();
      expect(bound.has(p)).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SP-08 — SocketTable: queries
// ═══════════════════════════════════════════════════════════════════════

describe('SP-08 — SocketTable: queries', () => {

  it('getListening returns only LISTEN sockets', () => {
    const table = new SocketTable();
    table.bind('tcp', '0.0.0.0', 22, 985, 'sshd');
    table.connect('tcp', '10.0.0.1', 55000, '10.0.0.2', 80, 1, 'curl');
    const listening = table.getListening();
    expect(listening).toHaveLength(1);
    expect(listening[0].localPort).toBe(22);
  });

  it('getEstablished returns only ESTABLISHED sockets', () => {
    const table = new SocketTable();
    table.bind('tcp', '0.0.0.0', 22, 985, 'sshd');
    table.connect('tcp', '10.0.0.1', 55000, '10.0.0.2', 80, 1, 'curl');
    const established = table.getEstablished();
    expect(established).toHaveLength(1);
    expect(established[0].remotePort).toBe(80);
  });

  it('getAll returns all sockets regardless of state', () => {
    const table = new SocketTable();
    table.bind('tcp', '0.0.0.0', 22, 985, 'sshd');
    table.bind('udp', '0.0.0.0', 53, 540, 'resolved');
    table.connect('tcp', '10.0.0.1', 55000, '10.0.0.2', 80, 1, 'curl');
    expect(table.getAll()).toHaveLength(3);
  });

  it('findByLocalPort finds by port and protocol', () => {
    const table = new SocketTable();
    table.bind('tcp', '0.0.0.0', 22, 985, 'sshd');
    table.bind('udp', '0.0.0.0', 53, 540, 'resolved');
    expect(table.findByLocalPort(22, 'tcp')?.processName).toBe('sshd');
    expect(table.findByLocalPort(53, 'udp')?.processName).toBe('resolved');
    expect(table.findByLocalPort(53, 'tcp')).toBeUndefined();
  });

  it('findByLocalPort without protocol matches any', () => {
    const table = new SocketTable();
    table.bind('tcp', '0.0.0.0', 22, 985, 'sshd');
    expect(table.findByLocalPort(22)).toBeDefined();
  });

  it('clear empties the table', () => {
    const table = new SocketTable();
    table.bind('tcp', '0.0.0.0', 22, 985, 'sshd');
    table.bind('udp', '0.0.0.0', 53, 540, 'resolved');
    table.clear();
    expect(table.size).toBe(0);
    expect(table.getAll()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SP-09 — SocketTable: isPortBound
// ═══════════════════════════════════════════════════════════════════════

describe('SP-09 — SocketTable: isPortBound', () => {

  it('returns true for a bound port', () => {
    const table = new SocketTable();
    table.bind('tcp', '0.0.0.0', 22, 985, 'sshd');
    expect(table.isPortBound(22, 'tcp')).toBe(true);
  });

  it('returns false for an unbound port', () => {
    const table = new SocketTable();
    expect(table.isPortBound(80, 'tcp')).toBe(false);
  });

  it('is protocol-specific: TCP binding does not affect UDP', () => {
    const table = new SocketTable();
    table.bind('tcp', '0.0.0.0', 53, 985, 'named');
    expect(table.isPortBound(53, 'tcp')).toBe(true);
    expect(table.isPortBound(53, 'udp')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SP-10 — EndHost integration: socket table pre-populated per OS
// ═══════════════════════════════════════════════════════════════════════

describe('SP-10 — EndHost integration: OS default sockets', () => {

  it('LinuxPC exposes a SocketTable', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(pc.getSocketTable()).toBeInstanceOf(SocketTable);
  });

  it('LinuxPC pre-binds SSH on port 22/tcp', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(pc.getSocketTable().isPortBound(22, 'tcp')).toBe(true);
  });

  it('LinuxPC pre-binds systemd-resolved on port 53/udp', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(pc.getSocketTable().isPortBound(53, 'udp')).toBe(true);
  });

  it('LinuxPC does NOT pre-bind Oracle port 1521', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(pc.getSocketTable().isPortBound(1521, 'tcp')).toBe(false);
  });

  it('LinuxServer pre-binds Oracle TNS listener on port 1521/tcp', () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    expect(srv.getSocketTable().isPortBound(1521, 'tcp')).toBe(true);
  });

  it('LinuxServer SSH socket processName is sshd', () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const ssh = srv.getSocketTable().findByLocalPort(22, 'tcp');
    expect(ssh?.processName).toMatch(/sshd/);
  });

  it('WindowsPC exposes a SocketTable', () => {
    const pc = new WindowsPC('windows-pc', 'WinPC1');
    expect(pc.getSocketTable()).toBeInstanceOf(SocketTable);
  });

  it('WindowsPC pre-binds RDP on port 3389/tcp', () => {
    const pc = new WindowsPC('windows-pc', 'WinPC1');
    expect(pc.getSocketTable().isPortBound(3389, 'tcp')).toBe(true);
  });

  it('WindowsPC pre-binds SMB on port 445/tcp', () => {
    const pc = new WindowsPC('windows-pc', 'WinPC1');
    expect(pc.getSocketTable().isPortBound(445, 'tcp')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SP-11 — Linux netstat: dynamic output from socket table
// ═══════════════════════════════════════════════════════════════════════

describe('SP-11 — Linux netstat: dynamic output from socket table', () => {

  it('netstat shows SSH port 22', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('netstat -tlnp');
    expect(out).toContain(':22');
    expect(out).toContain('LISTEN');
  });

  it('netstat shows sshd as process name for port 22', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('netstat -tlnp');
    expect(out).toMatch(/sshd/);
  });

  it('netstat shows dynamically bound port after table.bind()', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.getSocketTable().bind('tcp', '0.0.0.0', 8080, 1234, 'nginx');
    const out = await pc.executeCommand('netstat -tlnp');
    expect(out).toContain(':8080');
    expect(out).toContain('nginx');
  });

  it('netstat -u shows UDP sockets (port 53)', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('netstat -u');
    expect(out).toContain(':53');
  });

  it('netstat -u does not show TCP port 22', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('netstat -u');
    expect(out).not.toContain(':22');
  });

  it('netstat -t only shows TCP rows (no `udp` proto)', async () => {
    // Real systemd-resolved listens on 127.0.0.53:53 over BOTH tcp and
    // udp — so port 53 is legitimately present in `netstat -t`. The
    // correct guard is on the Proto column: no UDP rows must appear.
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('netstat -t');
    expect(out).not.toMatch(/^udp/m);
  });

  it('LinuxServer netstat shows Oracle port 1521', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const out = await srv.executeCommand('netstat -tlnp');
    expect(out).toContain(':1521');
    expect(out).toContain('LISTEN');
  });

  it('netstat reflects removed socket after close', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const entry = pc.getSocketTable().bind('tcp', '0.0.0.0', 9000, 5000, 'myapp');
    let out = await pc.executeCommand('netstat -tlnp');
    expect(out).toContain(':9000');

    pc.getSocketTable().close(entry.id);
    out = await pc.executeCommand('netstat -tlnp');
    expect(out).not.toContain(':9000');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SP-12 — Linux ss: dynamic output from socket table
// ═══════════════════════════════════════════════════════════════════════

describe('SP-12 — Linux ss: dynamic output from socket table', () => {

  it('ss -tlnp shows SSH port 22', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('ss -tlnp');
    expect(out).toContain('22');
    expect(out).toContain('LISTEN');
  });

  it('ss -tlnp shows dynamically added port', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.getSocketTable().bind('tcp', '0.0.0.0', 8443, 1234, 'nginx');
    const out = await pc.executeCommand('ss -tlnp');
    expect(out).toContain('8443');
  });

  it('ss -ulnp shows UDP port 53', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('ss -ulnp');
    expect(out).toContain('53');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SP-13 — Windows netstat: dynamic output from socket table
// ═══════════════════════════════════════════════════════════════════════

describe('SP-13 — Windows netstat: dynamic output from socket table', () => {

  it('netstat -a shows RDP port 3389', async () => {
    const pc = new WindowsPC('windows-pc', 'WinPC1');
    const out = await pc.executeCommand('netstat -a');
    expect(out).toContain('3389');
    expect(out).toContain('LISTENING');
  });

  it('netstat -a shows SMB port 445', async () => {
    const pc = new WindowsPC('windows-pc', 'WinPC1');
    const out = await pc.executeCommand('netstat -a');
    expect(out).toContain('445');
  });

  it('netstat -a shows dynamically bound port', async () => {
    const pc = new WindowsPC('windows-pc', 'WinPC1');
    pc.getSocketTable().bind('tcp', '0.0.0.0', 8080, 999, 'httpd');
    const out = await pc.executeCommand('netstat -a');
    expect(out).toContain('8080');
  });

  it('netstat output includes Active Connections header', async () => {
    const pc = new WindowsPC('windows-pc', 'WinPC1');
    const out = await pc.executeCommand('netstat -a');
    expect(out).toContain('Active Connections');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SP-14 — Linux ss -s: summary computed from the real socket table
// ═══════════════════════════════════════════════════════════════════════

describe('SP-14 — Linux ss -s: summary from the real socket table', () => {

  it('counts match the live socket table, not canned figures', async () => {
    const pc = new LinuxServer('srv', 'S1');
    const table = pc.getSocketTable();
    const all = table.getAll();
    const tcp = all.filter(s => s.protocol === 'tcp').length;
    const estab = all.filter(s =>
      s.protocol === 'tcp' && s.state === 'ESTABLISHED').length;

    const out = await pc.executeCommand('ss -s');
    expect(out).toContain(`Total: ${all.length}`);
    expect(out).toContain(`TCP:   ${tcp} (estab ${estab},`);
    expect(out).not.toContain('Total: 120');     // the old canned figure
  });

  it('reflects a new listener after a daemon binds a port', async () => {
    const pc = new LinuxServer('srv', 'S1');
    const before = await pc.executeCommand('ss -s');
    const tcpBefore = Number(/TCP:\s+(\d+)/.exec(before)?.[1]);

    pc.getSocketTable().bind('tcp', '0.0.0.0', 8080, 4242, 'webapp');
    const after = await pc.executeCommand('ss -s');
    const tcpAfter = Number(/TCP:\s+(\d+)/.exec(after)?.[1]);
    expect(tcpAfter).toBe(tcpBefore + 1);
  });
});
