/**
 * HostsFile domain class + cross-OS host-management enhancements.
 *
 * Covers:
 *   HF-01  HostsFile parsing / resolution / serialization
 *   HF-02  HostsFile mutation (withEntry / without) preserves comments
 *   HF-03  Windows hosts file seeded with the machine's own name
 *   HF-04  Windows setHostname re-syncs the hosts file
 *   HF-05  Windows resolveHostname: localhost, own name, custom entry
 *   HF-06  Windows DNS fallback when a name is absent from the hosts file
 *   HF-07  Windows nslookup
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { HostsFile, HostEntry } from '@/network/devices/HostsFile';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════════
// HF-01 — HostsFile parsing / resolution
// ═══════════════════════════════════════════════════════════════════════

describe('HF-01 — HostsFile parsing and resolution', () => {
  it('parses entries, ignoring comments and blank lines', () => {
    const hf = HostsFile.parse('# header\n\n127.0.0.1 localhost\n10.0.0.5 db srv\n');
    expect(hf.entries).toHaveLength(2);
    expect(hf.entries[1].canonicalName).toBe('db');
    expect(hf.entries[1].aliases).toEqual(['srv']);
  });

  it('resolves a name to its IPv4 address (case-insensitive)', () => {
    const hf = HostsFile.parse('10.0.0.5 DbServer\n');
    expect(hf.resolve('dbserver')).toBe('10.0.0.5');
    expect(hf.resolve('missing')).toBeNull();
  });

  it('prefers IPv4 and only returns IPv6 when asked', () => {
    const hf = HostsFile.parse('::1 localhost\n127.0.0.1 localhost\n');
    expect(hf.resolve('localhost', 4)).toBe('127.0.0.1');
    expect(hf.resolve('localhost', 6)).toBe('::1');
  });

  it('reverse-resolves an IP to its record', () => {
    const hf = HostsFile.parse('10.0.0.5 db srv\n');
    expect(hf.reverse('10.0.0.5')?.canonicalName).toBe('db');
    expect(hf.reverse('10.0.0.9')).toBeNull();
  });

  it('strips trailing # comments on an entry line', () => {
    const hf = HostsFile.parse('10.0.0.5 db   # the database\n');
    expect(hf.entries[0].hostnames).toEqual(['db']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// HF-02 — HostsFile mutation
// ═══════════════════════════════════════════════════════════════════════

describe('HF-02 — HostsFile mutation preserves the rest of the file', () => {
  it('withEntry appends without dropping comments', () => {
    const hf = HostsFile.parse('# keep me\n127.0.0.1 localhost\n').withEntry('10.0.0.5', 'db');
    const out = hf.serialize();
    expect(out).toContain('# keep me');
    expect(out).toContain('127.0.0.1');
    expect(out).toMatch(/10\.0\.0\.5\s+db/);
  });

  it('without removes only the matching records', () => {
    const hf = HostsFile.parse('127.0.0.1 localhost\n10.0.0.5 db\n')
      .without((e) => e.hasName('db'));
    expect(hf.resolve('db')).toBeNull();
    expect(hf.resolve('localhost')).toBe('127.0.0.1');
  });

  it('defaultLinux carries loopback + the 127.0.1.1 self entry', () => {
    const hf = HostsFile.defaultLinux('node-a');
    expect(hf.resolve('localhost')).toBe('127.0.0.1');
    expect(hf.resolve('node-a')).toBe('127.0.1.1');
  });

  it('HostEntry exposes canonical name, aliases and family', () => {
    const e = new HostEntry('::1', ['localhost', 'ip6-localhost']);
    expect(e.isIPv6).toBe(true);
    expect(e.canonicalName).toBe('localhost');
    expect(e.aliases).toEqual(['ip6-localhost']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// HF-03/04 — Windows hosts file parity with Linux
// ═══════════════════════════════════════════════════════════════════════

describe('HF-03 — Windows hosts file seeded with the machine name', () => {
  it('seeds the hosts file with localhost and the computer name', async () => {
    const win = new WindowsPC('windows-pc', 'WINBOX');
    const out = await win.executeCommand('type C:\\Windows\\System32\\drivers\\etc\\hosts');
    expect(out).toContain('127.0.0.1');
    expect(out).toContain('localhost');
    expect(out).toContain('WINBOX');
  });
});

describe('HF-04 — Windows setHostname re-syncs the hosts file', () => {
  it('the new computer name resolves after a rename', () => {
    const win = new WindowsPC('windows-pc', 'OLD');
    win.setHostname('NEWNAME');
    expect(win.resolveHostname('NEWNAME')?.toString()).toBe('127.0.0.1');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// HF-05 — Windows resolveHostname
// ═══════════════════════════════════════════════════════════════════════

describe('HF-05 — Windows resolveHostname', () => {
  it('resolves localhost from the seeded hosts file', () => {
    const win = new WindowsPC('windows-pc', 'WIN');
    expect(win.resolveHostname('localhost')?.toString()).toBe('127.0.0.1');
  });

  it('resolves the machine\'s own name to loopback', () => {
    const win = new WindowsPC('windows-pc', 'WIN');
    expect(win.resolveHostname('WIN')?.toString()).toBe('127.0.0.1');
  });

  it('resolves a custom hosts entry', () => {
    const win = new WindowsPC('windows-pc', 'WIN');
    win.addHostsEntry('10.0.1.42', 'fileserver');
    expect(win.resolveHostname('fileserver')?.toString()).toBe('10.0.1.42');
  });

  it('returns null for an unknown name with no DNS', () => {
    const win = new WindowsPC('windows-pc', 'WIN');
    expect(win.resolveHostname('nope.invalid')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// HF-06/07 — Windows DNS fallback + nslookup
// ═══════════════════════════════════════════════════════════════════════

describe('HF-06 — Windows DNS fallback', () => {
  function buildDnsTopology() {
    const win = new WindowsPC('windows-pc', 'WIN');
    const dns = new LinuxServer('DNS1');
    win.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    dns.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(win.getPort('eth0')!, dns.getPort('eth0')!);
    dns.dnsService.addRecord({ name: 'intranet', type: 'A', value: '10.0.1.77', ttl: 3600 });
    dns.dnsService.start();
    return { win, dns };
  }

  it('falls back to the configured DNS server for an unknown name', async () => {
    const { win } = buildDnsTopology();
    await win.executeCommand('netsh interface ip set dns "eth0" static 10.0.1.10');
    expect(win.resolveHostname('intranet')?.toString()).toBe('10.0.1.77');
  });

  it('the hosts file still wins over DNS', async () => {
    const { win } = buildDnsTopology();
    await win.executeCommand('netsh interface ip set dns "eth0" static 10.0.1.10');
    win.addHostsEntry('10.0.1.99', 'intranet');
    expect(win.resolveHostname('intranet')?.toString()).toBe('10.0.1.99');
  });
});

describe('HF-07 — Windows nslookup', () => {
  it('reports an address for a name in the hosts file', async () => {
    const win = new WindowsPC('windows-pc', 'WIN');
    win.addHostsEntry('10.0.1.42', 'fileserver');
    const out = await win.executeCommand('nslookup fileserver');
    expect(out).toContain('10.0.1.42');
    expect(out).toContain('fileserver');
  });

  it('reports a non-existent domain for an unknown name', async () => {
    const win = new WindowsPC('windows-pc', 'WIN');
    const out = await win.executeCommand('nslookup nope.invalid');
    expect(out).toMatch(/can't find|Non-existent domain/i);
  });
});
