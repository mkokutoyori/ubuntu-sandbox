/*
 * named-checkconf -z against the real tool (BIND 9.18.39, bind9utils of Ubuntu 24.04), run on a named.conf of five primary zones and one secondary: a valid zone, an A with a byte of 999, a zone
 * without NS record, a zone whose file does not exist, a CNAME next to an A, a zone with a name outside it (a warning that does not stop the load) and a secondary zone, which -z does not load.
 * The tool prints, for each zone in file order, what named-checkzone prints (the locator `dns_rdata_fromtext: <file>:4: near '192.0.2.999': bad dotted quad`, the line that names the reason, the
 * `not loaded due to errors.` line, the warnings) and then, for a zone that failed, a last line `_default/<zone>/IN: <reason>` where the reason is the one of the load (`bad dotted quad`,
 * `file not found`, `CNAME and other data`) or `bad zone` for the checks made after the load (`has no NS records`, `has 0 SOA records`).
 * The exit status is read too (`; echo rc=$?`): 1 when a zone is not loaded, 0 otherwise.
 * Measured before the change (git stash push -- src/network src/powershell): all 6 tests fall (the old command printed `loading from master file F failed: <message>` alone, with no locator, no
 * `not loaded due to errors.` and no `_default/` line, and answered 1 for a zone that loaded, which fails the WITNESS too once the exit status is read)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const SOA = '@ IN SOA ns1.example.com. h.example.com. ( 1 2 3 4 5 )';
const ZONES: Readonly<Record<string, string>> = {
  ok: `$TTL 3600\n${SOA}\n  IN NS ns1.example.com.\nns1 IN A 192.0.2.1\n`,
  bad: `$TTL 3600\n${SOA}\n  IN NS ns1.example.com.\nns1 IN A 192.0.2.999\nwww IN A 192.0.2.2\n`,
  nons: `$TTL 3600\n${SOA}\nns1 IN A 192.0.2.1\n`,
  cname: `$TTL 3600\n${SOA}\n  IN NS ns1.example.com.\nns1 IN A 192.0.2.1\nwww IN CNAME ns1\nwww IN A 192.0.2.5\n`,
  outside: `$TTL 3600\n${SOA}\n  IN NS ns1.example.com.\nns1 IN A 192.0.2.1\nwww IN MX 10 ns1\nother.org. IN A 1.2.3.4\n`,
};

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function checked(zones: readonly string[]): Promise<string> {
  const server = new LinuxServer('linux-server', 'NS1');
  const vfs = (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
  const conf = zones.map((name) => `zone "${name}.com" { type primary; file "/etc/bind/db.${name}"; };`);
  for (const name of zones) if (ZONES[name] !== undefined) vfs.writeFile(`/etc/bind/db.${name}`, ZONES[name], 0, 0, 0o022);
  vfs.writeFile('/etc/bind/named.conf', `${conf.join('\n')}\nzone "sec.com" { type secondary; primaries { 10.0.0.1; }; file "/etc/bind/db.sec"; };\n`, 0, 0, 0o022);
  return (await server.executeCommand('named-checkconf -z; echo rc=$?')).trimEnd();
}

describe('named-checkconf -z against the real tool', () => {
  it('WITNESS: a valid zone is loaded and the secondary zone is not read', async () => {
    expect(await checked(['ok'])).toBe('zone ok.com/IN: loaded serial 1\nrc=0');
  });

  it('an address with a byte of 999 prints the locator, the reason, the refusal and the _default line', async () => {
    expect(await checked(['bad'])).toBe([
      "dns_rdata_fromtext: /etc/bind/db.bad:4: near '192.0.2.999': bad dotted quad",
      'zone bad.com/IN: loading from master file /etc/bind/db.bad failed: bad dotted quad',
      'zone bad.com/IN: not loaded due to errors.',
      '_default/bad.com/IN: bad dotted quad',
      'rc=1',
    ].join('\n'));
  });

  it('a zone without NS record ends on bad zone', async () => {
    expect(await checked(['nons'])).toBe([
      'zone nons.com/IN: has no NS records',
      'zone nons.com/IN: not loaded due to errors.',
      '_default/nons.com/IN: bad zone',
      'rc=1',
    ].join('\n'));
  });

  it('a missing file ends on the reason of the load', async () => {
    expect(await checked(['absent'])).toBe([
      'zone absent.com/IN: loading from master file /etc/bind/db.absent failed: file not found',
      'zone absent.com/IN: not loaded due to errors.',
      '_default/absent.com/IN: file not found',
      'rc=1',
    ].join('\n'));
  });

  it('a CNAME next to another type is refused with the owner name', async () => {
    expect(await checked(['cname'])).toBe([
      'dns_master_load: /etc/bind/db.cname:6: www.cname.com: CNAME and other data',
      'zone cname.com/IN: loading from master file /etc/bind/db.cname failed: CNAME and other data',
      'zone cname.com/IN: not loaded due to errors.',
      '_default/cname.com/IN: CNAME and other data',
      'rc=1',
    ].join('\n'));
  });

  it('a name outside the zone is ignored with a warning and the zone is loaded', async () => {
    expect(await checked(['outside'])).toBe([
      '/etc/bind/db.outside:6: ignoring out-of-zone data (other.org)',
      'zone outside.com/IN: loaded serial 1',
      'rc=0',
    ].join('\n'));
  });
});
