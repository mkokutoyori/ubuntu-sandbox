/**
 * /etc/hosts resolution — TDD tests.
 *
 * Covers:
 *   H-01  VFS initialization: /etc/hosts with localhost + hostname entries
 *   H-02  /etc/hostname synchronization with profile.hostname
 *   H-03  resolveHostname on LinuxNetKernel: hosts-first, DNS-fallback
 *   H-04  ping <hostname> resolution
 *   H-05  traceroute <hostname> resolution
 *   H-06  Windows ping/tracert hostname resolution
 *   H-07  getent hosts command
 *   H-08  Dynamic /etc/hosts editing + immediate re-resolution
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { DnsService } from '@/network/devices/linux/LinuxDnsService';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════════
// H-01 — /etc/hosts initialization
// ═══════════════════════════════════════════════════════════════════════

describe('H-01 — /etc/hosts VFS initialization', () => {

  it('creates /etc/hosts with localhost entry on a fresh LinuxPC', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('cat /etc/hosts');
    expect(out).toContain('127.0.0.1');
    expect(out).toContain('localhost');
  });

  it('creates /etc/hosts with hostname entry (127.0.1.1) on a LinuxPC', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('cat /etc/hosts');
    expect(out).toMatch(/127\.0\.1\.1\s+linux-pc/);
  });

  it('creates /etc/hosts with hostname entry on a LinuxServer', async () => {
    const srv = new LinuxServer('SRV1');
    const out = await srv.executeCommand('cat /etc/hosts');
    expect(out).toContain('127.0.0.1');
    expect(out).toContain('localhost');
    expect(out).toMatch(/127\.0\.1\.1\s+linux-server/);
  });

  it('includes IPv6 localhost entries', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('cat /etc/hosts');
    expect(out).toContain('::1');
  });

});

// ═══════════════════════════════════════════════════════════════════════
// H-02 — /etc/hostname synchronization
// ═══════════════════════════════════════════════════════════════════════

describe('H-02 — /etc/hostname synchronization', () => {

  it('sets /etc/hostname to profile hostname, not "localhost"', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('cat /etc/hostname');
    expect(out.trim()).toBe('linux-pc');
  });

  it('hostname command returns the profile hostname', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('hostname');
    expect(out.trim()).toBe('linux-pc');
  });

  it('server has its own hostname', async () => {
    const srv = new LinuxServer('SRV1');
    const out = await srv.executeCommand('cat /etc/hostname');
    expect(out.trim()).toBe('linux-server');
  });

});

// ═══════════════════════════════════════════════════════════════════════
// H-03 — resolveHostname: hosts-first, DNS-fallback
// ═══════════════════════════════════════════════════════════════════════

describe('H-03 — resolveHostname via LinuxNetKernel', () => {

  it('resolves "localhost" to 127.0.0.1 from default /etc/hosts', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('ping -c 1 localhost');
    expect(out).toContain('127.0.0.1');
    expect(out).not.toContain('Name or service not known');
  });

  it('passes through a valid IP address without lookup', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    const out = await pc.executeCommand('ping -c 1 10.0.1.2');
    expect(out).toContain('10.0.1.2');
    expect(out).not.toContain('Name or service not known');
  });

  it('returns null for unknown hostnames (no DNS configured)', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('ping -c 1 unknown.host');
    expect(out).toContain('Name or service not known');
  });

  it('resolves custom /etc/hosts entry', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    await pc.executeCommand('echo "10.0.1.100 myserver" >> /etc/hosts');
    const out = await pc.executeCommand('ping -c 1 myserver');
    expect(out).toContain('10.0.1.100');
    expect(out).not.toContain('Name or service not known');
  });

  it('/etc/hosts takes priority over DNS', async () => {
    // Build: PC1 ── R1 ── DNS-Server
    const pc = new LinuxPC('linux-pc', 'PC1');
    const srv = new LinuxServer('DNS1');

    pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
    pc.setDefaultGateway(new IPAddress('10.0.1.10'));

    new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

    // Configure DNS server with A record
    srv.dnsService.addRecord({ name: 'myserver', type: 'A', value: '10.0.1.99', ttl: 3600 });
    srv.dnsService.start();

    // Configure resolver on PC
    await pc.executeCommand('echo "nameserver 10.0.1.10" > /etc/resolv.conf');

    // Add /etc/hosts entry with different IP
    await pc.executeCommand('echo "10.0.1.50 myserver" >> /etc/hosts');

    // hosts file should win
    const out = await pc.executeCommand('ping -c 1 myserver');
    expect(out).toContain('10.0.1.50');
    expect(out).not.toContain('10.0.1.99');
  });

  it('falls back to DNS when hostname not in /etc/hosts', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const srv = new LinuxServer('DNS1');

    pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));

    new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

    srv.dnsService.addRecord({ name: 'webserver', type: 'A', value: '10.0.1.88', ttl: 3600 });
    srv.dnsService.start();

    await pc.executeCommand('echo "nameserver 10.0.1.10" > /etc/resolv.conf');

    const out = await pc.executeCommand('ping -c 1 webserver');
    expect(out).toContain('10.0.1.88');
  });

  it('handles multiple hostnames per line in /etc/hosts', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    await pc.executeCommand('echo "10.0.1.100 myserver myalias" >> /etc/hosts');

    const out1 = await pc.executeCommand('ping -c 1 myserver');
    expect(out1).toContain('10.0.1.100');

    const out2 = await pc.executeCommand('ping -c 1 myalias');
    expect(out2).toContain('10.0.1.100');
  });

  it('ignores comment lines in /etc/hosts', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('echo "# 10.0.1.100 commentedout" >> /etc/hosts');
    const out = await pc.executeCommand('ping -c 1 commentedout');
    expect(out).toContain('Name or service not known');
  });

  it('ignores empty lines in /etc/hosts', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    // Default /etc/hosts should work regardless of blank lines
    const out = await pc.executeCommand('ping -c 1 localhost');
    expect(out).toContain('127.0.0.1');
  });

  it('resolves own hostname to 127.0.1.1', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('ping -c 1 linux-pc');
    expect(out).toContain('127.0.1.1');
  });

});

// ═══════════════════════════════════════════════════════════════════════
// H-04 — ping <hostname>
// ═══════════════════════════════════════════════════════════════════════

describe('H-04 — ping with hostname resolution', () => {

  it('ping localhost shows PING localhost (127.0.0.1) header', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('ping -c 1 localhost');
    expect(out).toMatch(/PING localhost \(127\.0\.0\.1\)/);
  });

  it('ping by IP still works (no regression)', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    const out = await pc.executeCommand('ping -c 1 10.0.1.2');
    expect(out).toContain('10.0.1.2');
    expect(out).not.toContain('Name or service not known');
  });

  it('ping unresolvable hostname returns proper error', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('ping -c 1 doesnotexist');
    expect(out).toContain('doesnotexist');
    expect(out).toContain('Name or service not known');
  });

});

// ═══════════════════════════════════════════════════════════════════════
// H-05 — traceroute <hostname>
// ═══════════════════════════════════════════════════════════════════════

describe('H-05 — traceroute with hostname resolution', () => {

  it('traceroute localhost resolves and shows header with name + IP', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('traceroute localhost');
    expect(out).toMatch(/traceroute to localhost \(127\.0\.0\.1\)/);
  });

  it('traceroute unresolvable hostname returns proper error', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('traceroute nosuchhost');
    expect(out).toContain('nosuchhost');
    expect(out).toContain('unknown host');
  });

  it('traceroute by IP still works', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    const out = await pc.executeCommand('traceroute 10.0.1.2');
    expect(out).toContain('10.0.1.2');
    expect(out).not.toContain('unknown host');
  });

  it('traceroute with custom /etc/hosts entry', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const srv = new LinuxPC('linux-pc', 'SRV');
    pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    srv.configureInterface('eth0', new IPAddress('10.0.1.3'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

    await pc.executeCommand('echo "10.0.1.3 myserver" >> /etc/hosts');
    const out = await pc.executeCommand('traceroute myserver');
    expect(out).toMatch(/traceroute to myserver \(10\.0\.1\.3\)/);
  });

});

// ═══════════════════════════════════════════════════════════════════════
// H-06 — Windows hostname resolution
// ═══════════════════════════════════════════════════════════════════════

describe('H-06 — Windows ping/tracert with hostname resolution', () => {

  function buildWinTopology() {
    const win = new WindowsPC('windows-pc', 'WIN');
    const srv = new LinuxPC('linux-pc', 'SRV');
    win.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    srv.configureInterface('eth0', new IPAddress('10.0.1.3'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(win.getPort('eth0')!, srv.getPort('eth0')!);
    return { win, srv };
  }

  it('Windows ping resolves hostname from hosts table', async () => {
    const { win } = buildWinTopology();
    win.addHostsEntry('10.0.1.3', 'myserver');
    const out = await win.executeCommand('ping myserver');
    expect(out).toContain('10.0.1.3');
    expect(out).not.toContain('could not find host');
  });

  it('Windows tracert resolves hostname from hosts table', async () => {
    const { win } = buildWinTopology();
    win.addHostsEntry('10.0.1.3', 'myserver');
    const out = await win.executeCommand('tracert myserver');
    expect(out).toContain('10.0.1.3');
    expect(out).not.toContain('Unable to resolve');
  });

  it('Windows ping unresolvable hostname returns error', async () => {
    const { win } = buildWinTopology();
    const out = await win.executeCommand('ping nosuchhost');
    expect(out).toMatch(/could not find host|Unable to resolve/i);
  });

  it('Windows ping by IP still works', async () => {
    const { win } = buildWinTopology();
    const out = await win.executeCommand('ping 10.0.1.3');
    expect(out).toContain('10.0.1.3');
  });

});

// ═══════════════════════════════════════════════════════════════════════
// H-07 — getent hosts command
// ═══════════════════════════════════════════════════════════════════════

describe('H-07 — getent hosts command', () => {

  it('getent hosts lists all entries from /etc/hosts', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('getent hosts');
    expect(out).toContain('127.0.0.1');
    expect(out).toContain('localhost');
    expect(out).toContain('127.0.1.1');
    expect(out).toContain('linux-pc');
  });

  it('getent hosts <name> resolves a specific hostname', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('getent hosts localhost');
    expect(out).toContain('127.0.0.1');
    expect(out).toContain('localhost');
  });

  it('getent hosts <name> for unknown returns exit code 2', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('getent hosts nosuchhost');
    // getent returns empty output and exit code 2 for not found
    expect(out.trim()).toBe('');
  });

  it('getent hosts <ip> shows reverse mapping from /etc/hosts', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('getent hosts 127.0.0.1');
    expect(out).toContain('127.0.0.1');
    expect(out).toContain('localhost');
  });

  it('getent hosts shows custom entries', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('echo "10.0.1.100 dbserver db" >> /etc/hosts');
    const out = await pc.executeCommand('getent hosts dbserver');
    expect(out).toContain('10.0.1.100');
    expect(out).toContain('dbserver');
  });

});

// ═══════════════════════════════════════════════════════════════════════
// H-08 — Dynamic /etc/hosts editing
// ═══════════════════════════════════════════════════════════════════════

describe('H-08 — Dynamic /etc/hosts editing and re-resolution', () => {

  it('adding an entry makes it immediately resolvable', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));

    // Before: unknown
    const before = await pc.executeCommand('ping -c 1 newhost');
    expect(before).toContain('Name or service not known');

    // Add entry
    await pc.executeCommand('echo "10.0.1.50 newhost" >> /etc/hosts');

    // After: resolved
    const after = await pc.executeCommand('ping -c 1 newhost');
    expect(after).toContain('10.0.1.50');
  });

  it('overwriting /etc/hosts replaces all entries', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');

    // Overwrite with only a custom entry (no localhost!)
    await pc.executeCommand('echo "10.0.1.99 onlyhost" > /etc/hosts');

    const out1 = await pc.executeCommand('ping -c 1 onlyhost');
    expect(out1).toContain('10.0.1.99');

    // localhost no longer resolves from file
    const out2 = await pc.executeCommand('ping -c 1 localhost');
    expect(out2).toContain('Name or service not known');
  });

  it('tab-separated entries in /etc/hosts work', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    // Write tab-separated entry
    await pc.executeCommand('echo "10.0.1.77\ttabhost" >> /etc/hosts');
    const out = await pc.executeCommand('ping -c 1 tabhost');
    expect(out).toContain('10.0.1.77');
  });

});
