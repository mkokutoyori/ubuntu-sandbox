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

const VALID_ZONE = [
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

describe('named-checkzone', () => {
  it('loads a valid zone and prints its serial then OK', async () => {
    const srv = new LinuxServer('NS1');
    writeRoot(srv, '/etc/bind/db.example', VALID_ZONE);

    const out = await srv.executeCommand('named-checkzone example.com /etc/bind/db.example');

    expect(out).toContain('zone example.com/IN: loaded serial 2024010101');
    expect(out.trim().endsWith('OK')).toBe(true);
  });

  it('reports a missing zone file', async () => {
    const srv = new LinuxServer('NS1');

    const out = await srv.executeCommand('named-checkzone example.com /etc/bind/db.absent');

    expect(out).toContain(
      'zone example.com/IN: loading from master file /etc/bind/db.absent failed: file not found',
    );
    expect(out).not.toContain('OK');
  });

  it('reports a zone file without SOA', async () => {
    const srv = new LinuxServer('NS1');
    writeRoot(srv, '/etc/bind/db.broken', '$ORIGIN example.com.\n$TTL 3600\nwww IN A 10.0.1.80\n');

    const out = await srv.executeCommand('named-checkzone example.com /etc/bind/db.broken');

    expect(out).toContain('zone example.com/IN:');
    expect(out).toContain('SOA');
    expect(out).not.toContain('OK');
  });

  it('prints usage when arguments are missing', async () => {
    const srv = new LinuxServer('NS1');

    const out = await srv.executeCommand('named-checkzone example.com');

    expect(out).toContain('usage:');
  });

  it('strips the trailing dot from the zone name', async () => {
    const srv = new LinuxServer('NS1');
    writeRoot(srv, '/etc/bind/db.example', VALID_ZONE);

    const out = await srv.executeCommand('named-checkzone example.com. /etc/bind/db.example');

    expect(out).toContain('zone example.com/IN: loaded serial 2024010101');
  });
});
