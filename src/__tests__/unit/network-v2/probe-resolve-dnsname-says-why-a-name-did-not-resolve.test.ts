/*
 * Probe — Resolve-DnsName names the real reason a lookup produced nothing, with the Win32 error DnsClient reports.
 *
 * Measured first (a Windows PC, a BIND9 server holding example.com, a zone that refuses this client, and a
 * second address where no DNS server listens): every failure — a name that does not exist, a name that has no
 * record of the asked type, a server that refuses, a server that never answers — printed the same line `Resolve-DnsName : x : DNS name does not exist`, with CategoryInfo `NotSpecified: (:)
 * [Resolve-DnsName], WriteErrorException` and FullyQualifiedErrorId `Microsoft.PowerShell.Commands.WriteErrorException`.
 * A dead server therefore looked like a typo in the name, and `$_.FullyQualifiedErrorId` could not tell the cases apart.
 *
 * Authority: Microsoft Learn, "System Error Codes (9000-11999)" and "(1300-1699)" (WinError.h): DNS_ERROR_RCODE_NAME_ERROR
 * 9003 "DNS name does not exist", DNS_ERROR_RECORD_DOES_NOT_EXIST 9701 "DNS record does not exist",
 * DNS_ERROR_RCODE_REFUSED 9005 "DNS operation refused", DNS_ERROR_RCODE_SERVER_FAILURE 9002 "DNS server failure",
 * DNS_ERROR_RCODE_FORMAT_ERROR 9001, DNS_ERROR_RCODE_NOT_IMPLEMENTED 9004, ERROR_TIMEOUT 1460 "This operation returned because the timeout period expired".
 * The error record's shape (Win32Exception, ResourceUnavailable, `<symbol>,Microsoft.DnsClient.Commands.ResolveDnsName`)
 * is the cmdlet's own, as seen in captured sessions; it is not in a Microsoft page.
 *
 * Discrimination (the probe run on the tree before the change): 6 of the 12 cases fall. The six that pass either way
 * are the WITNESS (the lab answers) and five NON-REGRESSIONS (a name that does not exist says "DNS name does not
 * exist"; -ErrorAction SilentlyContinue stays silent; the reverse lookup keeps its reverse name; a catch block still
 * reads the same message; one dead server then one that answers keeps the answer).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const NAMED_CONF = [
  'options { directory "/var/cache/bind"; recursion no; };',
  'zone "example.com" { type primary; file "/etc/bind/db.example"; };',
  'zone "closed.test" { type primary; file "/etc/bind/db.closed"; allow-query { 10.9.9.9; }; };',
  'zone "0.0.10.in-addr.arpa" { type primary; file "/etc/bind/db.reverse"; };',
  '',
].join('\n');

const ZONE = [
  '$TTL 3600',
  '$ORIGIN example.com.',
  '@ IN SOA ns1.example.com. hostmaster.example.com. ( 1 3600 900 604800 300 )',
  '@ IN NS ns1.example.com.',
  'ns1 IN A 10.0.0.2',
  'web IN A 10.0.0.80',
  '',
].join('\n');

const CLOSED_ZONE = ZONE.replace('$ORIGIN example.com.', '$ORIGIN closed.test.');

const REVERSE_ZONE = [
  '$TTL 3600',
  '$ORIGIN 0.0.10.in-addr.arpa.',
  '@ IN SOA ns1.example.com. hostmaster.example.com. ( 1 3600 900 604800 300 )',
  '@ IN NS ns1.example.com.',
  '2 IN PTR ns1.example.com.',
  '',
].join('\n');

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function lab() {
  const pc = new WindowsPC('windows-pc', 'WIN', 0, 0);
  const srv = new LinuxServer('linux-server', 'NS1', 0, 0);
  pc.powerOn(); srv.powerOn();
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  const vfs = (srv as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
  vfs.writeFile('/etc/bind/named.conf', NAMED_CONF, 0, 0, 0o022);
  vfs.writeFile('/etc/bind/db.example', ZONE, 0, 0, 0o022);
  vfs.writeFile('/etc/bind/db.closed', CLOSED_ZONE, 0, 0, 0o022);
  vfs.writeFile('/etc/bind/db.reverse', REVERSE_ZONE, 0, 0, 0o022);
  await srv.executeCommand('systemctl start named');
  await pc.executeCommand('netsh interface ip set dns name="eth0" static 10.0.0.2');
  const shell = PowerShellSubShell.create(pc as never).subShell;
  const ps = async (line: string): Promise<string> => (await shell.processLine(line)).output.join('\n');
  return { pc, ps };
}

describe('the reason a lookup failed reaches the error', () => {
  it('WITNESS: the lab answers for a name it holds', async () => {
    const { ps } = await lab();
    expect(await ps('(Resolve-DnsName web.example.com).IPAddress')).toBe('10.0.0.80');
  });

  it('NON-REGRESSION: a name that does not exist says "DNS name does not exist"', async () => {
    const { ps } = await lab();
    expect(await ps('Resolve-DnsName nexiste.example.com')).toContain('Resolve-DnsName : nexiste.example.com : DNS name does not exist');
  });

  it('a name with no record of the asked type says "DNS record does not exist"', async () => {
    const { ps } = await lab();
    expect(await ps('Resolve-DnsName web.example.com -Type AAAA')).toContain('web.example.com : DNS record does not exist');
  });

  it('a server that refuses says "DNS operation refused"', async () => {
    const { ps } = await lab();
    expect(await ps('Resolve-DnsName web.closed.test')).toContain('web.closed.test : DNS operation refused');
  });

  it('a server that never answers says the timeout period expired, not that the name is missing', async () => {
    const { ps } = await lab();
    const out = await ps('Resolve-DnsName web.example.com -Server 10.0.0.200');
    expect(out).toContain('web.example.com : This operation returned because the timeout period expired');
    expect(out).not.toContain('DNS name does not exist');
  }, 30000);

  it('the typed lookup against a dead server says the same', async () => {
    const { ps } = await lab();
    expect(await ps('Resolve-DnsName web.example.com -Type MX -Server 10.0.0.200')).toContain('This operation returned because the timeout period expired');
  }, 30000);

  it('NON-REGRESSION: a dead server first and a server that answers second keeps the answer of the second', async () => {
    const { pc, ps } = await lab();
    await pc.executeCommand('netsh interface ip set dns name="eth0" static 10.0.0.200');
    await pc.executeCommand('netsh interface ip add dns name="eth0" 10.0.0.2 index=2');
    expect(await ps('Resolve-DnsName nexiste.example.com')).toContain('DNS name does not exist');
  }, 30000);

  it('NON-REGRESSION: the reverse lookup keeps its reverse name in the message', async () => {
    const { ps } = await lab();
    expect(await ps('Resolve-DnsName 10.0.0.99')).toContain('99.0.0.10.in-addr.arpa : DNS name does not exist');
  });

  it('NON-REGRESSION: -ErrorAction SilentlyContinue stays silent', async () => {
    const { ps } = await lab();
    expect((await ps('Resolve-DnsName nexiste.example.com -ErrorAction SilentlyContinue')).trim()).toBe('');
  });
});

describe('the error record carries the Win32 error', () => {
  it('the error block names the category, the exception type and the symbolic error', async () => {
    const { ps } = await lab();
    const out = await ps('Resolve-DnsName nexiste.example.com');
    expect(out).toContain('CategoryInfo          : ResourceUnavailable: (nexiste.example.com:String) [Resolve-DnsName], Win32Exception');
    expect(out).toContain('FullyQualifiedErrorId : DNS_ERROR_RCODE_NAME_ERROR,Microsoft.DnsClient.Commands.ResolveDnsName');
  });

  it('a catch block sees the symbolic error of a dead server', async () => {
    const { ps } = await lab();
    const out = await ps('try { Resolve-DnsName web.example.com -Server 10.0.0.200 -ErrorAction Stop } catch { $_.FullyQualifiedErrorId }');
    expect(out.trim()).toBe('ERROR_TIMEOUT,Microsoft.DnsClient.Commands.ResolveDnsName');
  }, 30000);

  it('NON-REGRESSION: a catch block still reads "<name> : DNS name does not exist"', async () => {
    const { ps } = await lab();
    expect((await ps('try { Resolve-DnsName nexiste.example.com -ErrorAction Stop } catch { $_.Exception.Message }')).trim())
      .toBe('nexiste.example.com : DNS name does not exist');
  });
});
