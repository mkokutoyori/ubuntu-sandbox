/**
 * PRD-Nslookup-Dig-Rndc-Runas.md §1.3 gap #9 / §2.1.5 / P10 — rndc's
 * missing subcommands relative to real `rndc(8)`: stop/halt, dumpdb -all,
 * secroots, validation [on|off|status]. Additive to RndcChannel — the
 * existing status/reload/flush/... branches are untouched (verified by
 * bind9-rndc.test.ts still passing unmodified).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const NS1_IP = '10.0.7.10';

const ZONE_DB = [
  '$ORIGIN example.com.',
  '$TTL 3600',
  '@   IN SOA ns1.example.com. admin.example.com. ( 2024010101 3600 900 604800 300 )',
  '    IN NS  ns1.example.com.',
  'ns1 IN A   10.0.7.10',
  'www IN A   10.0.7.80',
  '',
].join('\n');

function vfsOf(server: LinuxServer): VirtualFileSystem {
  return (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function writeRoot(server: LinuxServer, path: string, content: string): void {
  vfsOf(server).writeFile(path, content, 0, 0, 0o022);
}

async function buildLab(extraOptions = '') {
  const srv = new LinuxServer('NS1');
  srv.configureInterface('eth0', new IPAddress(NS1_IP), new SubnetMask('255.255.255.0'));

  writeRoot(srv, '/etc/bind/named.conf', [
    'options {',
    '  directory "/var/cache/bind";',
    '  recursion no;',
    extraOptions,
    '};',
    'zone "example.com" { type primary; file "/etc/bind/db.example.com"; };',
    '',
  ].join('\n'));
  writeRoot(srv, '/etc/bind/db.example.com', ZONE_DB);
  await srv.executeCommand('systemctl start named');

  return { srv };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('rndc stop/halt (PRD P10)', () => {
  it('rndc stop actually stops the daemon', async () => {
    const { srv } = await buildLab();

    const out = await srv.executeCommand('rndc stop');
    expect(out).toBe('');

    const after = await srv.executeCommand('rndc status');
    expect(after).toContain('connection refused');
  });

  it('rndc halt also stops the daemon', async () => {
    const { srv } = await buildLab();

    const out = await srv.executeCommand('rndc halt');
    expect(out).toBe('');

    const after = await srv.executeCommand('rndc status');
    expect(after).toContain('connection refused');
  });

  it('stopping an already-stopped daemon reports connection refused, not a crash', async () => {
    const { srv } = await buildLab();
    await srv.executeCommand('rndc stop');

    const out = await srv.executeCommand('rndc stop');

    expect(out).toContain('connection refused');
  });
});

describe('rndc dumpdb (PRD P10)', () => {
  it('dumps the loaded zone records to named_dump.db via the Bind9Files API', async () => {
    const { srv } = await buildLab();

    const out = await srv.executeCommand('rndc dumpdb -all');
    expect(out).toBe('');

    const dump = vfsOf(srv).readFile('/var/cache/bind/named_dump.db') ?? '';
    expect(dump).toContain('example.com.');
    expect(dump).toContain('10.0.7.80');
  });

  it('fails cleanly when the server is not running', async () => {
    const { srv } = await buildLab();
    await srv.executeCommand('rndc stop');

    const out = await srv.executeCommand('rndc dumpdb');

    expect(out).toContain('connection refused');
  });
});

describe('rndc secroots (PRD P10)', () => {
  it('writes a secure-roots dump reflecting the current DNSSEC validation state', async () => {
    const { srv } = await buildLab();

    const out = await srv.executeCommand('rndc secroots');
    expect(out).toBe('');

    const dump = vfsOf(srv).readFile('/var/cache/bind/named.secroots') ?? '';
    expect(dump).toContain('Secure roots');
    expect(dump).toContain('no trust anchors configured');
  });

  it('reflects disabled validation in the dump', async () => {
    const { srv } = await buildLab();
    await srv.executeCommand('rndc validation off');

    await srv.executeCommand('rndc secroots');
    const dump = vfsOf(srv).readFile('/var/cache/bind/named.secroots') ?? '';

    expect(dump).toContain('DNSSEC validation is disabled');
  });
});

describe('rndc validation [on|off|status] (PRD P10)', () => {
  it('defaults to enabled and reports it via status', async () => {
    const { srv } = await buildLab();

    const out = await srv.executeCommand('rndc validation status');

    expect(out).toBe('DNSSEC validation is enabled.');
  });

  it('respects dnssec-validation no; from named.conf at load time', async () => {
    const { srv } = await buildLab('  dnssec-validation no;');

    const out = await srv.executeCommand('rndc validation status');

    expect(out).toBe('DNSSEC validation is disabled.');
  });

  it('turns validation off then back on', async () => {
    const { srv } = await buildLab();

    expect(await srv.executeCommand('rndc validation off')).toBe('');
    expect(await srv.executeCommand('rndc validation status')).toBe('DNSSEC validation is disabled.');

    expect(await srv.executeCommand('rndc validation on')).toBe('');
    expect(await srv.executeCommand('rndc validation status')).toBe('DNSSEC validation is enabled.');
  });

  it('bare "rndc validation" (no argument) reports status, matching real rndc', async () => {
    const { srv } = await buildLab();

    const out = await srv.executeCommand('rndc validation');

    expect(out).toBe('DNSSEC validation is enabled.');
  });

  it('rejects an invalid mode', async () => {
    const { srv } = await buildLab();

    const out = await srv.executeCommand('rndc validation bogus');

    expect(out).toBe("rndc: syntax error, unexpected 'bogus'");
  });
});
