/*
 * Probe - resolved.conf and its drop-ins are read by the one systemd configuration reader (conf-parser.c, as journald.conf is), with the
 * grammar of resolved-conf.c / resolve-util.c (systemd 255): DNS= and FallbackDNS= accumulate, an empty value clears, 0.0.0.0 and our own
 * stub addresses are dropped, duplicates move to the end, ADDRESS[:PORT][%IFACE][#NAME] is the word, Domains= takes "~" routing domains and
 * "*", LLMNR/MulticastDNS/DNSSEC/DNSOverTLS/Cache/DNSStubListener take their string tables or a boolean, a wrong value is reported with the
 * file and line and ignored.  What each key then decides on the simulated host: ReadEtcHosts= (answers "synthetic" from /etc/hosts before
 * the network), DNSStubListener= and DNSStubListenerExtra= (which sockets listen), ResolveUnicastSingleLabel= (a single-label name is not
 * sent to a unicast server), CacheFromLocalhost= and StaleRetentionSec= (what the cache keeps and serves).  The same lexer now serves the
 * networkd files (with their drop-ins, the later assignment winning for a scalar) and the .dnssd files and the unit parser.
 * No oracle: systemd-resolved is not installed in the recording container, so the grammar is the source's, read from the v255 tag.
 * Measured before the change (modules absent, git stash push -u -- src/network): the file does not load, so all 23 cases fall.  The four
 * WITNESSES (a plain DNS= server, the default stub on 127.0.0.53, a name resolving through the upstream with the cache disabled, and the
 * default of ReadEtcHosts/StaleRetentionSec) only prove the lab itself is sound; the old parser did read DNS=, Domains=, LLMNR=,
 * MulticastDNS=, DNSSEC=, DNSOverTLS= and Cache= from the main file, and nothing else.
 *
 * The last block of the file (31 cases in all) pins what the service keeps now that it stores its answers in the DnsCache the DNS servers and the Windows client share, by the rules
 * of resolved-dns-cache.c: a name that does not exist lives min(SOA TTL, SOA minimum) and needs the SOA, a zero TTL is not kept, a positive entry is capped at two hours while the first
 * reply is handed over whole, a SERVFAIL lives ten seconds, the next server of the list is tried when one stays silent, Cache=no-negative forgets the negative answers only, and the
 * target of a CNAME is answered from what the alias brought.  Measured with git stash push -- src/network src/powershell: 14 of the 31 fall.  The 8 cases of that block all fall (the old
 * service kept no negative answer, no SERVFAIL, asked the first server only, and could not follow a CNAME); the 6 older cases fall only because the fake upstream now speaks in records
 * and a rcode instead of a list of addresses, which is the interface they were adapted to, not a defect they pin.
 */
import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { readResolvedConfig } from '@/network/devices/linux/net/ResolvedConfig';
import { ResolvedService, type ResolvedDeps, type UpstreamAnswer } from '@/network/devices/linux/net/ResolvedService';
import { makeARecord, makeCnameRecord, makeNsRecord, makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import { discoverNetworkdFiles, getAll } from '@/network/devices/linux/net/NetworkdFiles';
import { parseUnitFile } from '@/network/devices/linux/LinuxServiceManager';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

function source(files: Record<string, string>): { readFile(path: string): string | null; listDirectory(path: string): Array<{ name: string }> | null } {
  return {
    readFile: (path) => files[path] ?? null,
    listDirectory: (path) => {
      const prefix = `${path}/`;
      const names = Object.keys(files).filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/')).map((file) => ({ name: file.slice(prefix.length) }));
      return names.length === 0 ? null : names;
    },
  };
}

const read = (main: string, extra: Record<string, string> = {}, cmdline = '') => readResolvedConfig(source({ '/etc/systemd/resolved.conf': main, ...extra }), cmdline);

describe('the grammar of resolved.conf', () => {
  it('witness: a plain DNS= server is read', () => {
    expect(read('[Resolve]\nDNS=192.0.2.1\n').config.dnsServers).toEqual(['192.0.2.1']);
  });

  it('DNS= accumulates, an empty value clears, our stub addresses and 0.0.0.0 are dropped, a duplicate moves to the end', () => {
    const { config } = read('[Resolve]\nDNS=192.0.2.1 192.0.2.2\nDNS=127.0.0.53 0.0.0.0 127.0.0.54 192.0.2.1\n');
    expect(config.dnsServers).toEqual(['192.0.2.2', '192.0.2.1']);
    expect(read('[Resolve]\nDNS=192.0.2.1\nDNS=\nDNS=198.51.100.1\n').config.dnsServers).toEqual(['198.51.100.1']);
  });

  it('a server word carries a port, an interface and a name, in the order systemd prints them, and 53 and 853 are the default', () => {
    const { config } = read('[Resolve]\nDNS=192.0.2.1:5353 [2001:db8::1]:853 [2001:db8::2]:5353%eth0#dns.example 192.0.2.9:53#cloudflare-dns.com\n');
    expect(config.dnsServers).toEqual(['192.0.2.1:5353', '2001:db8::1', '[2001:db8::2]:5353%eth0#dns.example', '192.0.2.9#cloudflare-dns.com']);
  });

  it('a bad server is reported by name and does not stop the next one', () => {
    const { config, diagnostics } = read('[Resolve]\nDNS=zorglub 192.0.2.7\n');
    expect(config.dnsServers).toEqual(['192.0.2.7']);
    expect(diagnostics.map((d) => d.message)).toEqual(["Failed to add DNS server address 'zorglub', ignoring: Invalid argument"]);
  });

  it('Domains= takes routing domains, "*" and the root as "~.", and refuses a bad label', () => {
    const { config, diagnostics } = read('[Resolve]\nDomains=corp.example ~lab.example *\nDomains=~corp.example bad..name\n');
    expect(config.domains).toEqual(['~lab.example', '~.', '~corp.example']);
    expect(diagnostics.map((d) => d.message)).toEqual(["Failed to add search domain 'bad..name', ignoring: Invalid argument"]);
  });

  it('the string tables accept their words and a boolean, and report the rest with the file and line', () => {
    const text = '[Resolve]\nLLMNR=resolve\nMulticastDNS=true\nDNSSEC=allow-downgrade\nDNSOverTLS=opportunistic\nCache=no-negative\nDNSStubListener=udp\n';
    const { config } = read(text);
    expect([config.llmnr, config.mdns, config.dnssec, config.dnsOverTls, config.cacheMode, config.dnsStubListener]).toEqual(['resolve', 'yes', 'allow-downgrade', 'opportunistic', 'no-negative', 'udp']);
    const wrong = read('[Resolve]\nLLMNR=maybe\nDNSSEC=sometimes\nCache=perhaps\n');
    expect(wrong.diagnostics.map((d) => d.message)).toEqual([
      '/etc/systemd/resolved.conf:2: Failed to parse resolve support setting, ignoring: maybe',
      '/etc/systemd/resolved.conf:3: Failed to parse DNSSEC mode setting, ignoring: sometimes',
      '/etc/systemd/resolved.conf:4: Failed to parse DNS cache mode setting, ignoring: perhaps',
    ]);
    expect(wrong.config.llmnr).toBe('yes');
  });

  it('the booleans, the time span and the extra stub listeners are read', () => {
    const { config } = read('[Resolve]\nReadEtcHosts=no\nResolveUnicastSingleLabel=yes\nCacheFromLocalhost=yes\nStaleRetentionSec=2min\nDNSStubListenerExtra=udp:127.0.0.1:5353\nDNSStubListenerExtra=192.0.2.10\n');
    expect([config.readEtcHosts, config.resolveUnicastSingleLabel, config.cacheFromLocalhost, config.staleRetentionUsec]).toEqual([false, true, true, 120_000_000]);
    expect(config.dnsStubListenerExtra).toEqual([{ mode: 'udp', address: '127.0.0.1', port: 5353 }, { mode: 'yes', address: '192.0.2.10', port: 53 }]);
  });

  it('drop-ins are merged by name over the main file, /etc masking /usr/lib, and an unknown key is reported', () => {
    const files = {
      '/etc/systemd/resolved.conf.d/10-a.conf': '[Resolve]\nDNS=198.51.100.1\nZorglub=1\n',
      '/usr/lib/systemd/resolved.conf.d/10-a.conf': '[Resolve]\nDNS=203.0.113.1\n',
      '/usr/lib/systemd/resolved.conf.d/05-b.conf': '[Resolve]\nLLMNR=no\n',
    };
    const { config, diagnostics } = read('[Resolve]\nDNS=192.0.2.1\n', files);
    expect(config.dnsServers).toEqual(['192.0.2.1', '198.51.100.1']);
    expect(config.llmnr).toBe('no');
    expect(diagnostics.map((d) => d.message)).toEqual(["/etc/systemd/resolved.conf.d/10-a.conf:3: Unknown key name 'Zorglub' in section 'Resolve', ignoring."]);
  });

  it('the kernel command line adds nameserver= and domain=', () => {
    const { config } = read('[Resolve]\n', {}, 'ro quiet nameserver=198.51.100.53 domain=lab.example');
    expect([config.dnsServers, config.domains]).toEqual([['198.51.100.53'], ['lab.example']]);
  });
});

function answerWith(address: string): UpstreamAnswer {
  return { answers: [makeARecord('a.example', 60, address)], authorities: [], rcode: 0 };
}

function fakeService(overrides: Partial<ResolvedDeps> & { upstream?: (server: string, name: string) => UpstreamAnswer | null } = {}): { service: ResolvedService; asked: string[]; clock: { now: number } } {
  const asked: string[] = [];
  const clock = { now: 1_000_000 };
  const deps: ResolvedDeps = {
    queryUpstream: async (server, name) => { asked.push(`${server}:${name}`); return overrides.upstream ? overrides.upstream(server, name) : answerWith('10.0.0.1'); },
    queryUpstreamSync: (server, name) => { asked.push(`${server}:${name}`); return overrides.upstream ? overrides.upstream(server, name) : answerWith('10.0.0.1'); },
    now: () => clock.now,
    ...overrides,
  };
  return { service: new ResolvedService(deps), asked, clock };
}

function configure(service: ResolvedService, text: string): void {
  service.setGlobal(read(`[Resolve]\n${text}`).config);
}

describe('what the keys decide in the resolver', () => {
  it('witness: a name resolves through the upstream when the cache is disabled, every time', async () => {
    const { service, asked } = fakeService();
    configure(service, 'DNS=192.0.2.1\nCache=no\n');
    await service.resolve('a.example');
    await service.resolve('a.example');
    expect(asked).toEqual(['192.0.2.1:a.example', '192.0.2.1:a.example']);
  });

  it('ReadEtcHosts= answers from /etc/hosts before the network, with the synthetic origin, and NODATA for the other family', async () => {
    const { service, asked } = fakeService({ hostsLookup: (name, qtype) => (name === 'lab.example' ? { known: true, addresses: qtype === 'A' ? ['10.9.9.9'] : [] } : { known: false, addresses: [] }) });
    configure(service, 'DNS=192.0.2.1\n');
    const a = await service.resolve('lab.example');
    expect([a.addresses, a.origin, a.verdict]).toEqual([['10.9.9.9'], 'hosts', 'answer']);
    const aaaa = await service.resolve('lab.example', 'AAAA');
    expect([aaaa.addresses, aaaa.origin, aaaa.verdict]).toEqual([[], 'hosts', 'nodata']);
    expect(asked).toEqual([]);
    configure(service, 'DNS=192.0.2.1\nReadEtcHosts=no\n');
    expect((await service.resolve('lab.example')).origin).toBe('network');
  });

  it('ResolveUnicastSingleLabel= keeps a single-label name off the unicast servers unless it is yes', async () => {
    const { service, asked } = fakeService();
    configure(service, 'DNS=192.0.2.1\n');
    expect((await service.resolve('printer')).addresses).toEqual([]);
    expect(asked).toEqual([]);
    configure(service, 'DNS=192.0.2.1\nResolveUnicastSingleLabel=yes\n');
    expect((await service.resolve('printer')).addresses).toEqual(['10.0.0.1']);
  });

  it('CacheFromLocalhost= decides whether an answer from a loopback server is kept', async () => {
    const asking = async (extra: string): Promise<number> => {
      const { service, asked } = fakeService();
      configure(service, `DNS=127.0.0.1\n${extra}`);
      await service.resolve('a.example');
      await service.resolve('a.example');
      return asked.length;
    };
    expect(await asking('')).toBe(2);
    expect(await asking('CacheFromLocalhost=yes\n')).toBe(1);
  });

  it('StaleRetentionSec= serves an expired answer while the server is unreachable, within the window only', async () => {
    let reachable = true;
    const { service, clock } = fakeService({ upstream: () => (reachable ? answerWith('10.0.0.1') : null) });
    configure(service, 'DNS=192.0.2.1\nStaleRetentionSec=120\n');
    await service.resolve('a.example');
    reachable = false;
    clock.now += 61_000;
    const stale = await service.resolve('a.example');
    expect([stale.addresses, stale.origin]).toEqual([['10.0.0.1'], 'cache']);
    clock.now += 200_000;
    expect((await service.resolve('a.example')).addresses).toEqual([]);
  });

  it('without StaleRetentionSec= an expired answer is not served when the server is unreachable', async () => {
    let reachable = true;
    const { service, clock } = fakeService({ upstream: () => (reachable ? answerWith('10.0.0.1') : null) });
    configure(service, 'DNS=192.0.2.1\n');
    await service.resolve('a.example');
    reachable = false;
    clock.now += 61_000;
    expect((await service.resolve('a.example')).addresses).toEqual([]);
  });
});

const NXDOMAIN_RCODE = 3;
const SERVFAIL_RCODE = 2;

function soaOf(ttl: number, minimum: number) {
  return makeSoaRecord('example', ttl, { mname: 'ns.example.', rname: 'hostmaster.example.', serial: 1, refresh: 7200, retry: 900, expire: 1209600, minimum });
}

describe('what the shared cache keeps, by the rules of resolved-dns-cache.c', () => {
  it('a name that does not exist is kept for the smaller of the SOA TTL and its minimum, no longer', async () => {
    const { service, asked, clock } = fakeService({ upstream: () => ({ answers: [], authorities: [soaOf(3600, 60)], rcode: NXDOMAIN_RCODE }) });
    configure(service, 'DNS=192.0.2.1\n');
    const first = await service.resolve('absent.example');
    expect([first.verdict, first.authorities.length]).toEqual(['nxdomain', 1]);
    clock.now += 59_000;
    const kept = await service.resolve('absent.example');
    expect([kept.verdict, kept.origin, kept.authorities[0].ttl]).toEqual(['nxdomain', 'cache', 1]);
    clock.now += 2_000;
    await service.resolve('absent.example');
    expect(asked).toHaveLength(2);
  });

  it('an answer without a SOA is not kept', async () => {
    const { service, asked } = fakeService({ upstream: () => ({ answers: [], authorities: [], rcode: NXDOMAIN_RCODE }) });
    configure(service, 'DNS=192.0.2.1\n');
    await service.resolve('absent.example');
    await service.resolve('absent.example');
    expect(asked).toHaveLength(2);
  });

  it('a record with a TTL of zero is not kept', async () => {
    const { service, asked } = fakeService({ upstream: () => ({ answers: [makeARecord('a.example', 0, '10.0.0.1')], authorities: [], rcode: 0 }) });
    configure(service, 'DNS=192.0.2.1\n');
    await service.resolve('a.example');
    await service.resolve('a.example');
    expect(asked).toHaveLength(2);
  });

  it('a record that claims a day is kept two hours at most, and the first reply is still handed over whole', async () => {
    const { service, asked, clock } = fakeService({ upstream: () => ({ answers: [makeARecord('a.example', 86400, '10.0.0.1')], authorities: [], rcode: 0 }) });
    configure(service, 'DNS=192.0.2.1\n');
    expect((await service.resolve('a.example')).records[0].ttl).toBe(86400);
    clock.now += 7_199_000;
    const kept = await service.resolve('a.example');
    expect([kept.origin, kept.records[0].ttl]).toEqual(['cache', 1]);
    clock.now += 2_000;
    await service.resolve('a.example');
    expect(asked).toHaveLength(2);
  });

  it('a SERVFAIL is kept ten seconds', async () => {
    const { service, asked, clock } = fakeService({ upstream: () => ({ answers: [], authorities: [], rcode: SERVFAIL_RCODE }) });
    configure(service, 'DNS=192.0.2.1\n');
    expect((await service.resolve('a.example')).verdict).toBe('failure');
    clock.now += 9_000;
    const kept = await service.resolve('a.example');
    expect([kept.verdict, kept.origin]).toEqual(['failure', 'cache']);
    clock.now += 2_000;
    await service.resolve('a.example');
    expect(asked).toHaveLength(2);
  });

  it('the second server of the list answers when the first one does not, and says so', async () => {
    const { service, asked } = fakeService({ upstream: (server) => (server === '192.0.2.1' ? null : answerWith('10.0.0.2')) });
    configure(service, 'DNS=192.0.2.1 192.0.2.2\n');
    const outcome = await service.resolve('a.example');
    expect([outcome.addresses, outcome.server]).toEqual([['10.0.0.2'], '192.0.2.2']);
    expect(asked).toEqual(['192.0.2.1:a.example', '192.0.2.2:a.example']);
  });

  it('Cache=no-negative keeps the answers and forgets the names that do not exist', async () => {
    const { service, asked } = fakeService({ upstream: (_server, name) => (name === 'a.example' ? answerWith('10.0.0.1') : { answers: [], authorities: [soaOf(3600, 3600)], rcode: NXDOMAIN_RCODE }) });
    configure(service, 'DNS=192.0.2.1\nCache=no-negative\n');
    await service.resolve('a.example');
    await service.resolve('a.example');
    await service.resolve('absent.example');
    await service.resolve('absent.example');
    expect(asked).toEqual(['192.0.2.1:a.example', '192.0.2.1:absent.example', '192.0.2.1:absent.example']);
  });

  it('the target of a CNAME is answered from what the alias brought', async () => {
    const { service, asked } = fakeService({ upstream: () => ({ answers: [makeCnameRecord('www.example', 60, 'web.example.'), makeARecord('web.example', 60, '10.0.0.7')], authorities: [], rcode: 0 }) });
    configure(service, 'DNS=192.0.2.1\n');
    const alias = await service.resolve('www.example');
    expect([alias.addresses, alias.records.map((rr) => rr.data.type)]).toEqual([['10.0.0.7'], [5, 1]]);
    const target = await service.resolve('web.example');
    expect([target.addresses, target.origin]).toEqual([['10.0.0.7'], 'cache']);
    expect(asked).toHaveLength(1);
  });
});

const NS_SET = (ttl: number) => [makeNsRecord('example', ttl, 'ns1.example.')];
const GLUE = (ttl: number) => [makeARecord('ns1.example', ttl, '192.0.2.53')];

describe('what the stub hands over, as the real systemd-resolved 255 did (resolved-stub-oracle)', () => {
  it('the first reply passes the authority and additional sections of the upstream on, TTLs untouched', async () => {
    const { service } = fakeService({ upstream: () => ({ answers: [makeARecord('a.example', 3600, '10.0.0.1')], authorities: NS_SET(3579), additionals: GLUE(3579), rcode: 0 }) });
    configure(service, 'DNS=192.0.2.1\n');
    const first = await service.resolve('a.example');
    expect([first.records[0].ttl, first.authorities[0].ttl, first.additionals[0].ttl]).toEqual([3600, 3579, 3579]);
  });

  it('served from the cache, every record of the reply carries the smallest remaining TTL of the message it was kept with', async () => {
    const { service, clock } = fakeService({ upstream: () => ({ answers: [makeARecord('a.example', 3600, '10.0.0.1')], authorities: NS_SET(3579), additionals: GLUE(3579), rcode: 0 }) });
    configure(service, 'DNS=192.0.2.1\n');
    await service.resolve('a.example');
    clock.now += 6_000;
    const again = await service.resolve('a.example');
    expect(again.origin).toBe('cache');
    expect([again.records[0].ttl, again.authorities[0].ttl, again.additionals[0].ttl]).toEqual([3573, 3573, 3573]);
  });

  it('an alias whose target holds nothing is served with one TTL for the CNAME and the SOA', async () => {
    const { service, clock } = fakeService({ upstream: () => ({ answers: [makeCnameRecord('www.example', 3600, 'web.example.')], authorities: [soaOf(3595, 3600)], rcode: 0 }) });
    configure(service, 'DNS=192.0.2.1\n');
    await service.resolve('www.example', 'AAAA');
    clock.now += 6_000;
    const again = await service.resolve('www.example', 'AAAA');
    expect([again.verdict, again.origin, again.records[0].ttl, again.authorities[0].ttl]).toEqual(['nodata', 'cache', 3589, 3589]);
  });

  it('the server that answered after the first one stayed silent becomes the current server, and the next name goes straight to it', async () => {
    const { service, asked } = fakeService({ upstream: (server) => (server === '192.0.2.1' ? null : answerWith('10.0.0.2')) });
    configure(service, 'DNS=192.0.2.1 192.0.2.2\n');
    expect(service.currentServerOf(null)).toBe('192.0.2.1');
    await service.resolve('a.example');
    expect(service.currentServerOf(null)).toBe('192.0.2.2');
    await service.resolve('b.example');
    expect(asked).toEqual(['192.0.2.1:a.example', '192.0.2.2:a.example', '192.0.2.2:b.example']);
  });
});

async function resolvedHost(body: string): Promise<LinuxServer> {
  const host = new LinuxServer('linux-server', 'resolved-lab', 0, 0);
  host.powerOn();
  await host.executeCommand('mkdir -p /etc/systemd/resolved.conf.d');
  await host.executeCommand(`printf '[Resolve]\\n${body}\\n' > /etc/systemd/resolved.conf.d/zz-probe.conf`);
  await host.executeCommand('systemctl restart systemd-resolved');
  return host;
}

describe('on a simulated host', () => {
  it('witness: the default stub listens on 127.0.0.53, UDP and TCP', async () => {
    const host = await resolvedHost('DNS=192.0.2.1');
    const sockets = await host.executeCommand('ss -ulntp');
    expect(sockets).toMatch(/udp.*127\.0\.0\.53(%lo)?:53/i);
    expect(sockets).toMatch(/tcp.*127\.0\.0\.53(%lo)?:53/i);
  }, 60_000);

  it('DNSStubListener=no closes both sockets and DNSStubListener=udp keeps only the datagram one', async () => {
    const none = await resolvedHost('DNSStubListener=no');
    expect(await none.executeCommand('ss -ulntp')).not.toMatch(/127\.0\.0\.53(%lo)?:53/);
    const udp = await resolvedHost('DNSStubListener=udp');
    const sockets = await udp.executeCommand('ss -ulntp');
    expect(sockets).toMatch(/udp.*127\.0\.0\.53(%lo)?:53/i);
    expect(sockets).not.toMatch(/tcp.*127\.0\.0\.53(%lo)?:53/i);
  }, 60_000);

  it('DNSStubListenerExtra= opens one more listener', async () => {
    const host = await resolvedHost('DNSStubListenerExtra=udp:127.0.0.1:5353');
    expect(await host.executeCommand('ss -ulnp')).toMatch(/127\.0\.0\.1:5353/);
  }, 60_000);

  it('a name from /etc/hosts is answered by resolvectl as synthetic data, and ReadEtcHosts=no sends it to the network', async () => {
    const host = await resolvedHost('DNS=192.0.2.1');
    await host.executeCommand("echo '10.9.9.9 labhost' >> /etc/hosts");
    const answered = await host.executeCommand('resolvectl query labhost');
    expect(answered).toContain('labhost: 10.9.9.9');
    expect(answered).toContain('-- Data from: synthetic');
    const refusing = await resolvedHost('DNS=192.0.2.1\\nReadEtcHosts=no');
    await refusing.executeCommand("echo '10.9.9.9 labhost' >> /etc/hosts");
    expect(await refusing.executeCommand('resolvectl query labhost')).not.toContain('10.9.9.9');
  }, 60_000);

  it('a wrong value is written to the journal by systemd-resolved with the file and the line', async () => {
    const host = await resolvedHost('DNSSEC=sometimes');
    expect(await host.executeCommand('journalctl --no-pager -t systemd-resolved')).toContain('/etc/systemd/resolved.conf.d/zz-probe.conf:2: Failed to parse DNSSEC mode setting, ignoring: sometimes');
  }, 60_000);

  it('resolvectl status names a server with its port and name as systemd does', async () => {
    const host = await resolvedHost('DNS=192.0.2.1:5353#dns.example');
    expect(await host.executeCommand('resolvectl status')).toContain('192.0.2.1:5353#dns.example');
  }, 60_000);
});

describe('one lexer for the systemd files', () => {
  it('a networkd drop-in adds to a list key and overrides a scalar one, /etc masking /usr/lib by name', () => {
    const vfs = new VirtualFileSystem();
    vfs.mkdirp('/etc/systemd/network/10-eth0.network.d', 0o755, 0, 0);
    vfs.mkdirp('/usr/lib/systemd/network/10-eth0.network.d', 0o755, 0, 0);
    vfs.writeFile('/etc/systemd/network/10-eth0.network', '[Match]\nName=eth0\n[Network]\nDHCP=no\nDNS=192.0.2.1\n', 0, 0, 0o022);
    vfs.writeFile('/etc/systemd/network/10-eth0.network.d/override.conf', '[Network]\nDHCP=yes\nDNS=198.51.100.1\n', 0, 0, 0o022);
    vfs.writeFile('/usr/lib/systemd/network/10-eth0.network.d/override.conf', '[Network]\nDNS=203.0.113.1\n', 0, 0, 0o022);
    const [file] = discoverNetworkdFiles(vfs);
    expect(getAll(file, 'Network', 'DNS')).toEqual(['192.0.2.1', '198.51.100.1']);
    expect(file.sections.get('Network')?.get('DHCP')).toEqual(['no', 'yes']);
  });

  it('a continuation line joins in a unit file as in a networkd file', () => {
    expect(parseUnitFile('[Service]\nExecStart=/bin/true \\\n  --flag\n').execStart).toBe('/bin/true    --flag');
    const vfs = new VirtualFileSystem();
    vfs.mkdirp('/etc/systemd/network', 0o755, 0, 0);
    vfs.writeFile('/etc/systemd/network/20-a.network', '[Match]\nName=eth0\n[Network]\nDNS=192.0.2.1 \\\n198.51.100.1\n', 0, 0, 0o022);
    expect(getAll(discoverNetworkdFiles(vfs)[0], 'Network', 'DNS').join(' ')).toContain('198.51.100.1');
  });
});
