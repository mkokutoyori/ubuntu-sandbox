import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

function vfsOf(server: LinuxServer): VirtualFileSystem {
  return (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function writeRoot(server: LinuxServer, path: string, content: string): void {
  vfsOf(server).writeFile(path, content, 0, 0, 0o022);
}

const ZONE_DB = [
  '$ORIGIN example.com.',
  '$TTL 3600',
  '@   IN SOA ns1.example.com. admin.example.com. ( 2024010101 3600 900 604800 300 )',
  '    IN NS  ns1.example.com.',
  'ns1 IN A   10.0.1.10',
  'www IN A   10.0.1.80',
  '',
].join('\n');

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('named-checkconf', () => {
  it('is silent on a valid configuration', async () => {
    const srv = new LinuxServer('NS1');
    writeRoot(srv, '/etc/bind/named.conf', 'options { recursion no; };');

    const out = await srv.executeCommand('named-checkconf');

    expect(out).toBe('');
  });

  it('follows include directives like the Ubuntu default layout', async () => {
    const srv = new LinuxServer('NS1');
    writeRoot(srv, '/etc/bind/named.conf',
      'include "/etc/bind/named.conf.options";\ninclude "/etc/bind/named.conf.local";\n');
    writeRoot(srv, '/etc/bind/named.conf.options', 'options { directory "/var/cache/bind"; };');
    writeRoot(srv, '/etc/bind/named.conf.local',
      'zone "example.com" { type primary; file "/etc/bind/db.example"; };');

    const out = await srv.executeCommand('named-checkconf');

    expect(out).toBe('');
  });

  it('reports syntax errors with file and line', async () => {
    const srv = new LinuxServer('NS1');
    writeRoot(srv, '/etc/bind/named.conf', 'options {\n  recursion no\n};');

    const out = await srv.executeCommand('named-checkconf');

    expect(out).toContain("/etc/bind/named.conf:3: missing ';' before '}'");
  });

  it('reports semantic errors in included files under their own name', async () => {
    const srv = new LinuxServer('NS1');
    writeRoot(srv, '/etc/bind/named.conf', 'include "/etc/bind/named.conf.local";');
    writeRoot(srv, '/etc/bind/named.conf.local', 'zone "lan" { type primary; };');

    const out = await srv.executeCommand('named-checkconf');

    expect(out).toContain("/etc/bind/named.conf.local:1: zone 'lan': missing 'file' entry");
  });

  it('reports a missing configuration file', async () => {
    const srv = new LinuxServer('NS1');

    const out = await srv.executeCommand('named-checkconf');

    expect(out).toContain("open: /etc/bind/named.conf: file not found");
  });

  it('checks an alternative file passed as argument', async () => {
    const srv = new LinuxServer('NS1');
    writeRoot(srv, '/tmp/test.conf', 'optionz { };');

    const out = await srv.executeCommand('named-checkconf /tmp/test.conf');

    expect(out).toContain("/tmp/test.conf:1: unknown option 'optionz'");
  });

  it('loads primary zones with -z and prints their serial', async () => {
    const srv = new LinuxServer('NS1');
    writeRoot(srv, '/etc/bind/named.conf',
      'zone "example.com" { type primary; file "/etc/bind/db.example"; };');
    writeRoot(srv, '/etc/bind/db.example', ZONE_DB);

    const out = await srv.executeCommand('named-checkconf -z');

    expect(out).toContain('zone example.com/IN: loaded serial 2024010101');
  });

  it('reports a zone file that fails to load with -z', async () => {
    const srv = new LinuxServer('NS1');
    writeRoot(srv, '/etc/bind/named.conf',
      'zone "example.com" { type primary; file "/etc/bind/db.example"; };');

    const out = await srv.executeCommand('named-checkconf -z');

    expect(out).toContain(
      'zone example.com/IN: loading from master file /etc/bind/db.example failed: file not found',
    );
  });
});
