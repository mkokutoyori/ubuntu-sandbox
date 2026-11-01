/*
 * Probe — Get-DnsServerCache and Set-DnsServerCache exist, keep their settings in the DNS Parameters registry key, and
 * the Windows DNS server's cache obeys every one of them.
 *
 * Measured first (a Windows DNS server recursing from a root hint to a second Windows DNS server holding lab.test,
 * a UDP client asking): neither cmdlet existed; the cache kept every record for the full TTL the zone advertised (an
 * hour, a day or a year alike), kept a negative answer for the SOA minimum (an hour) instead of the 15 minutes the
 * server ceiling allows, never refused an overwrite, cached empty (NODATA) answers whatever the setting, grew without
 * a size bound, and admitted nothing from a response beyond the answer.
 *
 * Authority: Microsoft Learn, DnsServer module, Get-DnsServerCache and Set-DnsServerCache (MaxTtl 0 to 2592000 seconds,
 * default one day, 0 caches nothing; MaxNegativeTtl 1 to 2592000 seconds, default 15 minutes; LockingPercent, default
 * 100: the server does not overwrite a cached entry for that share of its TTL; PollutionProtection: false caches every
 * response, true only the records of the same DNS subtree; StoreEmptyAuthenticationResponse, default True, RFC 2308;
 * MaxKBSize, the size of the memory cache); dnscmd /config in the official documentation (maxcachettl, maxnegativecachettl,
 * maxcachesize, secureresponses). Not sourced: the registry value names CacheLockingPercent, StoreEmptyAuthenticationResponse
 * and IgnorePolicies, the unset default of MaxKBSize (rendered 0: no ceiling), the oldest-first eviction, and the wording
 * of an out-of-range refusal (the standard ValidateRange text, the pages give the ranges in prose only).
 *
 * Discrimination (the probe run on the tree before the change): 14 of the 22 cases fall. The eight that pass either
 * way are the WITNESS (the lab resolves and lists the cache), four NON-REGRESSIONS (a negative answer is still served
 * inside the default ceiling and inside a shortened one; an empty answer is cached by default; with no size ceiling
 * every name stays cached) and three CONTROLS (protection on keeps unrelated records out, with or without locking; a
 * live entry stays).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const PARAMETERS = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\DNS\\Parameters';
const CACHE_IP = '10.0.1.10';
const AUTHORITY_IP = '10.0.1.30';
const CLIENT_IP = '10.0.1.2';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

const run = async (server: WindowsServer, line: string): Promise<string> =>
  (await PowerShellSubShell.create(server).subShell.processLine(line)).output.join('\n');

function question(qname: string, qtype: number): DnsMessage {
  return {
    id: Math.floor(Math.random() * 60000),
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [{ qname, qtype, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

async function lab() {
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  const cache = new WindowsServer('WNS1');
  const authority = new WindowsServer('WNS3');
  const client = new LinuxPC('linux-pc', 'PC1');
  const mask = new SubnetMask('255.255.255.0');
  [cache, authority, client].forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress([CACHE_IP, AUTHORITY_IP, CLIENT_IP][index]), mask);
  });
  for (const server of [cache, authority]) {
    server.setCurrentUser('Administrator');
    await run(server, 'Install-WindowsFeature DNS');
  }
  await run(authority, 'Add-DnsServerPrimaryZone -Name lab.test');
  await run(authority, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name www -IPv4Address 10.0.9.1 -TimeToLive 01:00:00');
  await run(authority, 'Add-DnsServerResourceRecordMX -ZoneName lab.test -Name mail -MailExchange www.lab.test -Preference 10');
  await run(cache, 'foreach ($h in Get-DnsServerRootHint) { Remove-DnsServerRootHint -NameServer $h.NameServer -Force }');
  await run(cache, `Add-DnsServerRootHint -NameServer a.root.test -IPAddress ${AUTHORITY_IP}`);
  const ask = (qname: string, qtype: number = RRType.A) => queryDnsOverUdp(client, new IPAddress(CACHE_IP), question(qname, qtype), 53, 9000);
  const cached = (name: string, type: string, column: 'TimeToLive' | 'RecordData') =>
    run(cache, `(Show-DnsServerCache | Where-Object { $_.HostName -eq "${name}" -and $_.RecordType -eq "${type}" }).${column}`);
  return { cache, authority, ask, cached };
}

describe('the settings surface', () => {
  it('Get-DnsServerCache reports the documented defaults', async () => {
    const { cache } = await lab();
    const out = await run(cache, 'Get-DnsServerCache');
    expect(out).toMatch(/MaxTTL\s+:\s+1\.00:00:00/);
    expect(out).toMatch(/MaxNegativeTTL\s+:\s+00:15:00/);
    expect(out).toMatch(/EnablePollutionProtection\s+:\s+True/);
    expect(out).toMatch(/LockingPercent\s+:\s+100/);
    expect(out).toMatch(/StoreEmptyAuthenticationResponse\s+:\s+True/);
  });

  it('Set-DnsServerCache writes the DNS Parameters registry values and Get-DnsServerCache reads them back', async () => {
    const { cache } = await lab();
    await run(cache, 'Set-DnsServerCache -MaxTtl 00:10:00 -MaxNegativeTtl 00:02:00 -LockingPercent 50 -MaxKBSize 2048 -PollutionProtection $false -StoreEmptyAuthenticationResponse $false');
    const registry = await cache.executeCommand(`reg query ${PARAMETERS}`);
    expect(registry).toMatch(/MaxCacheTtl\s+REG_DWORD\s+0x258/);
    expect(registry).toMatch(/MaxNegativeCacheTtl\s+REG_DWORD\s+0x78/);
    expect(registry).toMatch(/CacheLockingPercent\s+REG_DWORD\s+0x32/);
    expect(registry).toMatch(/MaxCacheSize\s+REG_DWORD\s+0x800/);
    expect(registry).toMatch(/SecureResponses\s+REG_DWORD\s+0x0/);
    const out = await run(cache, 'Get-DnsServerCache');
    expect(out).toMatch(/MaxTTL\s+:\s+00:10:00/);
    expect(out).toMatch(/MaxNegativeTTL\s+:\s+00:02:00/);
    expect(out).toMatch(/MaxKBSize\s+:\s+2048/);
    expect(out).toMatch(/EnablePollutionProtection\s+:\s+False/);
    expect(out).toMatch(/StoreEmptyAuthenticationResponse\s+:\s+False/);
  });

  it('a value written with reg.exe is the setting Get-DnsServerCache reports', async () => {
    const { cache } = await lab();
    await cache.executeCommand(`reg add ${PARAMETERS} /v MaxCacheTtl /t REG_DWORD /d 1200 /f`);
    expect(await run(cache, 'Get-DnsServerCache')).toMatch(/MaxTTL\s+:\s+00:20:00/);
  });

  it('values outside the documented ranges are refused and change nothing', async () => {
    const { cache } = await lab();
    expect(await run(cache, 'Set-DnsServerCache -LockingPercent 101')).toContain("Cannot validate argument on parameter 'LockingPercent'");
    expect(await run(cache, 'Set-DnsServerCache -MaxTtl 31.00:00:00')).toContain('greater than the maximum allowed range of 30.00:00:00');
    expect(await run(cache, 'Set-DnsServerCache -MaxNegativeTtl 00:00:00')).toContain('less than the minimum allowed range of 00:00:01');
    const out = await run(cache, 'Get-DnsServerCache');
    expect(out).toMatch(/MaxTTL\s+:\s+1\.00:00:00/);
    expect(out).toMatch(/LockingPercent\s+:\s+100/);
  });

  it('-PassThru returns the settings and IgnorePolicies is kept', async () => {
    const { cache } = await lab();
    const out = await run(cache, 'Set-DnsServerCache -IgnorePolicies $true -PassThru');
    expect(out).toMatch(/IgnorePolicies\s+:\s+True/);
    expect(await run(cache, 'Get-DnsServerCache')).toMatch(/IgnorePolicies\s+:\s+True/);
  });
});

describe('the TTL ceiling', () => {
  it('WITNESS: a resolved name is cached with the TTL the zone advertises', async () => {
    const { ask, cached } = await lab();
    expect((await ask('www.lab.test'))?.answers).toHaveLength(1);
    expect((await cached('www.lab.test', 'A', 'TimeToLive')).trim()).toBe('3600');
  });

  it('-MaxTtl lowers the TTL of what is cached', async () => {
    const { cache, ask, cached } = await lab();
    await run(cache, 'Set-DnsServerCache -MaxTtl 00:10:00');
    await ask('www.lab.test');
    expect((await cached('www.lab.test', 'A', 'TimeToLive')).trim()).toBe('600');
  });

  it('-MaxTtl 0 caches nothing and the client still gets its answer', async () => {
    const { cache, ask, cached } = await lab();
    await run(cache, 'Set-DnsServerCache -MaxTtl 00:00:00');
    expect((await ask('www.lab.test'))?.answers).toHaveLength(1);
    expect((await cached('www.lab.test', 'A', 'TimeToLive')).trim()).toBe('');
  });
});

describe('negative answers', () => {
  async function ghostThenRecord(settings: string, stepSeconds: number) {
    const { cache, authority, ask } = await lab();
    if (settings !== '') await run(cache, `Set-DnsServerCache ${settings}`);
    expect((await ask('ghost.lab.test'))?.flags.rcode).toBe(DnsRcode.NXDOMAIN);
    await run(authority, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name ghost -IPv4Address 10.0.9.7');
    cache._stepSystemClock(stepSeconds * 1000);
    return ask('ghost.lab.test');
  }

  it('the default 15 minute ceiling ends a negative answer that the zone would keep for an hour', async () => {
    expect((await ghostThenRecord('', 901))?.answers).toHaveLength(1);
  });

  it('NON-REGRESSION: inside the ceiling the negative answer is still served from the cache', async () => {
    expect((await ghostThenRecord('', 60))?.flags.rcode).toBe(DnsRcode.NXDOMAIN);
  });

  it('-MaxNegativeTtl shortens it further', async () => {
    expect((await ghostThenRecord('-MaxNegativeTtl 00:01:00', 61))?.answers).toHaveLength(1);
  });

  it('NON-REGRESSION: a shortened ceiling still holds the answer until it is reached', async () => {
    expect((await ghostThenRecord('-MaxNegativeTtl 00:01:00', 59))?.flags.rcode).toBe(DnsRcode.NXDOMAIN);
  });

  async function emptyThenRecord(settings: string) {
    const { cache, authority, ask } = await lab();
    if (settings !== '') await run(cache, `Set-DnsServerCache ${settings}`);
    const first = await ask('www.lab.test', RRType.AAAA);
    expect(first?.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(first?.answers).toHaveLength(0);
    await run(authority, 'Add-DnsServerResourceRecordAAAA -ZoneName lab.test -Name www -IPv6Address 2001:db8::1');
    return ask('www.lab.test', RRType.AAAA);
  }

  it('NON-REGRESSION: an empty authoritative answer is cached by default (RFC 2308)', async () => {
    expect((await emptyThenRecord(''))?.answers).toHaveLength(0);
  });

  it('-StoreEmptyAuthenticationResponse $false stops caching it', async () => {
    expect((await emptyThenRecord('-StoreEmptyAuthenticationResponse $false'))?.answers).toHaveLength(1);
  });
});

describe('the size of the cache', () => {
  async function askMany(settings: string) {
    const { cache, authority, ask } = await lab();
    await run(authority, '1..60 | ForEach-Object { Add-DnsServerResourceRecordA -ZoneName lab.test -Name ("h{0:D2}" -f $_) -IPv4Address "10.0.9.$_" }');
    if (settings !== '') await run(cache, `Set-DnsServerCache ${settings}`);
    for (let n = 1; n <= 60; n++) await ask(`h${String(n).padStart(2, '0')}.lab.test`);
    const held = Number((await run(cache, '(Show-DnsServerCache).Count')).trim());
    return { held, cache };
  }

  it('NON-REGRESSION: with no ceiling every answered name stays cached', async () => {
    expect((await askMany('')).held).toBe(60);
  });

  it('-MaxKBSize bounds what the cache holds and drops the oldest records first', async () => {
    const { held, cache } = await askMany('-MaxKBSize 1');
    expect(held).toBeGreaterThan(10);
    expect(held).toBeLessThan(45);
    expect((await run(cache, '(Show-DnsServerCache | Where-Object { $_.HostName -eq "h60.lab.test" }).RecordData')).trim()).toBe('10.0.9.60');
    expect((await run(cache, '(Show-DnsServerCache | Where-Object { $_.HostName -eq "h01.lab.test" }).RecordData')).trim()).toBe('');
  });
});

describe('pollution protection and cache locking', () => {
  async function carriedOverwrite(settings: string, stepSeconds: number) {
    const { cache, authority, ask, cached } = await lab();
    if (settings !== '') await run(cache, `Set-DnsServerCache ${settings}`);
    await ask('www.lab.test');
    await run(authority, 'Remove-DnsServerResourceRecord -ZoneName lab.test -Name www -RRType A -Force');
    await run(authority, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name www -IPv4Address 10.0.9.2 -TimeToLive 01:00:00');
    cache._stepSystemClock(stepSeconds * 1000);
    await ask('mail.lab.test', RRType.MX);
    return (await cached('www.lab.test', 'A', 'RecordData')).trim();
  }

  it('CONTROL: with protection on, a record that only rides in the additional section is not cached', async () => {
    const { ask, cached } = await lab();
    await ask('mail.lab.test', RRType.MX);
    expect((await cached('mail.lab.test', 'MX', 'RecordData')).trim()).toBe('www.lab.test');
    expect((await cached('www.lab.test', 'A', 'RecordData')).trim()).toBe('');
  });

  it('-PollutionProtection $false caches the records a response carries besides its answer', async () => {
    const { cache, ask, cached } = await lab();
    await run(cache, 'Set-DnsServerCache -PollutionProtection $false');
    await ask('mail.lab.test', RRType.MX);
    expect((await cached('www.lab.test', 'A', 'RecordData')).trim()).toBe('10.0.9.1');
  });

  it('CONTROL: a live entry is locked, so a carried record cannot replace it', async () => {
    expect(await carriedOverwrite('-PollutionProtection $false', 0)).toBe('10.0.9.1');
  });

  it('-LockingPercent 0 lets the carried record replace the live entry', async () => {
    expect(await carriedOverwrite('-PollutionProtection $false -LockingPercent 0', 0)).toBe('10.0.9.2');
  });

  it('CONTROL: with protection on, nothing is carried in whatever the locking says', async () => {
    expect(await carriedOverwrite('-LockingPercent 0', 0)).toBe('10.0.9.1');
  });

  it('-LockingPercent 50 holds the entry for half of its TTL and no longer', async () => {
    expect(await carriedOverwrite('-PollutionProtection $false -LockingPercent 50', 1700)).toBe('10.0.9.1');
    resetCounters(); resetDeviceCounters(); Logger.clear();
    expect(await carriedOverwrite('-PollutionProtection $false -LockingPercent 50', 1900)).toBe('10.0.9.2');
  });
});
