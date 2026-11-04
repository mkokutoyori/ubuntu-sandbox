/*
 * Lab "DNS - Agence bancaire" : does a DNS cache answer, on every machine that holds one, instead of the tree being walked again? The lab is built, then each question is
 * asked twice and the UDP/53 queries are counted on the wire at the machine that asks (a tap on its ports), so that a cache that is displayed but not consulted shows as a query.
 *
 * Measured first (git stash push -- src/network src/powershell): 12 tests, 10 fall. The four names the lab publishes for its site (www, ebanking, agences, api) are CNAMEs, and no cache ever answered one:
 * PC-GUICHET1 asked DC1 again, DC1 asked DNS-RES again, DNS-RES walked root, com and banquehorizon.com again, each time. Also measured: a name that does not exist was asked again and again, to
 * the preferred server and then to the alternate one; `Resolve-DnsName -Type MX` never read the client cache; every new name went back to ROOT-NS and TLD-NS although the delegation of
 * banquehorizon.com was known; `Resolve-DnsName www.banquehorizon.com` printed one A row with TTL 300 while Get-DnsClientCache held the CNAME and the A with TTL 3600; `rndc dumpdb` wrote the
 * zones and never the cache. Since the resolver primes the root like the real named (`. NS` before its first question, recorded in bind-cache-dump-oracle), a cold resolution reaches ROOT-NS twice. The 2 that pass either way are the WITNESS (the tap counts the queries of a cold resolution) and the plain A name (web), which the client cache already answered.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { bench, resetWorld } from './_dnsLabBench';

beforeEach(resetWorld);

const ttlOf = (output: string, type: string): number => Number(new RegExp(`Type\\s*:\\s*${type}\\s*\\nTTL\\s*:\\s*(\\d+)`).exec(output)?.[1] ?? NaN);

describe('Lab DNS - agence bancaire : the caches answer', () => {
  it('WITNESS: the tap counts the queries of a cold resolution down the tree', async () => {
    const lab = await bench();
    const cold = await lab.asked('PC-GUICHET1', 'ps', 'Resolve-DnsName web.banquehorizon.com');
    expect(cold.output).toContain('203.0.113.20');
    expect(cold.sent['PC-GUICHET1']).toBeGreaterThanOrEqual(1);
    expect(cold.sent['DC1']).toBe(1);
    expect(cold.received['ROOT-NS']).toBe(2);
    expect(cold.received['TLD-NS']).toBe(1);
    expect(cold.received['NS1-BANK']).toBe(1);
  });

  it('a plain A name is answered by the client cache the second time', async () => {
    const lab = await bench();
    await lab.asked('PC-GUICHET1', 'ps', 'Resolve-DnsName web.banquehorizon.com');
    const again = await lab.asked('PC-GUICHET1', 'ps', 'Resolve-DnsName web.banquehorizon.com');
    expect(again.output).toContain('203.0.113.20');
    expect(again.sent['PC-GUICHET1']).toBe(0);
  });

  it('a CNAME name (www) is answered by the client cache the second time, with the CNAME and the A row the cache holds', async () => {
    const lab = await bench();
    await lab.asked('PC-GUICHET1', 'ps', 'Resolve-DnsName www.banquehorizon.com');
    const again = await lab.asked('PC-GUICHET1', 'ps', 'Resolve-DnsName www.banquehorizon.com');
    expect(again.sent['PC-GUICHET1']).toBe(0);
    expect(again.output).toMatch(/Type\s*:\s*CNAME/);
    expect(again.output).toMatch(/NameHost\s*:\s*web\.banquehorizon\.com/);
    expect(again.output).toMatch(/IPAddress\s*:\s*203\.0\.113\.20/);
    const cache = await lab.asked('PC-GUICHET1', 'ps', 'Get-DnsClientCache');
    expect(ttlOf(again.output, 'CNAME')).toBe(Number(/Type\s*:\s*CNAME\s*\nStatus\s*:\s*Success\s*\nSection\s*:\s*Answer\s*\nTimeToLive\s*:\s*(\d+)/.exec(cache.output)![1]));
  });

  it('the TTL the client cache holds goes down with the clock, and the answer says the same number', async () => {
    const lab = await bench();
    await lab.asked('PC-GUICHET1', 'ps', 'Resolve-DnsName www.banquehorizon.com');
    await lab.asked('PC-GUICHET1', 'ps', 'Start-Sleep -Seconds 30');
    const again = await lab.asked('PC-GUICHET1', 'ps', 'Resolve-DnsName www.banquehorizon.com');
    expect(ttlOf(again.output, 'CNAME')).toBe(3570);
    expect(ttlOf(again.output, 'A')).toBe(3570);
  });

  it('DC1 answers a second client from its own cache for a CNAME name, without asking DNS-RES', async () => {
    const lab = await bench();
    await lab.asked('PC-GUICHET1', 'ps', 'Resolve-DnsName www.banquehorizon.com');
    const second = await lab.asked('PC-GUICHET2', 'ps', 'Resolve-DnsName www.banquehorizon.com');
    expect(second.output).toContain('203.0.113.20');
    expect(second.received['DC1']).toBe(1);
    expect(second.sent['DC1']).toBe(0);
    expect(second.received['DNS-RES']).toBe(0);
  });

  it('DNS-RES answers a CNAME name from its cache the second time and the TTL goes down', async () => {
    const lab = await bench();
    await lab.asked('PC-CONSEILLER', 'sh', 'dig @10.20.20.53 api.banquehorizon.com +noall +answer');
    await lab.asked('PC-CONSEILLER', 'sh', 'sleep 5');
    const again = await lab.asked('PC-CONSEILLER', 'sh', 'dig @10.20.20.53 api.banquehorizon.com +noall +answer');
    expect(again.sent['DNS-RES']).toBe(0);
    expect(again.output).toMatch(/api\.banquehorizon\.com\.\s+3595\s+IN\s+CNAME\s+web\.banquehorizon\.com\./);
    expect(again.output).toMatch(/web\.banquehorizon\.com\.\s+3595\s+IN\s+A\s+203\.0\.113\.20/);
  });

  it('a new name under a known delegation goes to NS1-BANK and no longer to ROOT-NS or TLD-NS', async () => {
    const lab = await bench();
    await lab.asked('PC-CONSEILLER', 'sh', 'dig @10.20.20.53 www.banquehorizon.com +noall +answer');
    const fresh = await lab.asked('PC-CONSEILLER', 'sh', 'dig @10.20.20.53 ebanking.banquehorizon.com +noall +answer');
    expect(fresh.output).toContain('203.0.113.20');
    expect(fresh.received['NS1-BANK']).toBe(1);
    expect(fresh.received['ROOT-NS']).toBe(0);
    expect(fresh.received['TLD-NS']).toBe(0);
  });

  it('a name that does not exist is cached by the client, shown as NotExist, and asked of the preferred server only once', async () => {
    const lab = await bench();
    const first = await lab.asked('PC-GUICHET1', 'ps', 'Resolve-DnsName nexiste.banquehorizon.com');
    expect(first.output).toContain('DNS name does not exist');
    expect(first.sent['PC-GUICHET1']).toBe(1);
    expect(first.received['DNS-RES']).toBe(1);
    const again = await lab.asked('PC-GUICHET1', 'ps', 'Resolve-DnsName nexiste.banquehorizon.com');
    expect(again.output).toContain('DNS name does not exist');
    expect(again.sent['PC-GUICHET1']).toBe(0);
    const cache = await lab.asked('PC-GUICHET1', 'ps', 'Get-DnsClientCache');
    expect(cache.output).toMatch(/Entry\s*:\s*nexiste\.banquehorizon\.com[\s\S]*?Status\s*:\s*NotExist/);
  });

  it('DNS-RES answers a name that does not exist from its negative cache, with the SOA of the zone in the authority section', async () => {
    const lab = await bench();
    await lab.asked('PC-CONSEILLER', 'sh', 'dig @10.20.20.53 nexiste.banquehorizon.com');
    const again = await lab.asked('PC-CONSEILLER', 'sh', 'dig @10.20.20.53 nexiste.banquehorizon.com');
    expect(again.output).toContain('status: NXDOMAIN');
    expect(again.output).toMatch(/AUTHORITY SECTION:\nbanquehorizon\.com\.\s+3600\s+IN\s+SOA\s+ns1\.banquehorizon\.com\./);
    expect(again.sent['DNS-RES']).toBe(0);
  });

  it('a typed question (MX) is answered by the client cache the second time', async () => {
    const lab = await bench();
    await lab.asked('PC-GUICHET1', 'ps', 'Resolve-DnsName banquehorizon.com -Type MX');
    const again = await lab.asked('PC-GUICHET1', 'ps', 'Resolve-DnsName banquehorizon.com -Type MX');
    expect(again.output).toMatch(/NameExchange\s*:\s*mail\.banquehorizon\.com/);
    expect(again.sent['PC-GUICHET1']).toBe(0);
  });

  it('ping and Test-NetConnection reach a CNAME name through the client cache', async () => {
    const lab = await bench();
    await lab.asked('PC-GUICHET1', 'ps', 'Resolve-DnsName www.banquehorizon.com');
    const ping = await lab.asked('PC-GUICHET1', 'ps', 'ping www.banquehorizon.com -n 1');
    expect(ping.output).toContain('Reply from 203.0.113.20');
    expect(ping.sent['PC-GUICHET1']).toBe(0);
    const probe = await lab.asked('PC-GUICHET1', 'ps', 'Test-NetConnection www.banquehorizon.com -Port 443');
    expect(probe.output).toMatch(/TcpTestSucceeded\s*:\s*True/);
    expect(probe.sent['PC-GUICHET1']).toBe(0);
  });

  it('rndc dumpdb -cache on DNS-RES lists what its cache holds, the CNAME included', async () => {
    const lab = await bench();
    await lab.asked('PC-CONSEILLER', 'sh', 'dig @10.20.20.53 www.banquehorizon.com +noall +answer');
    const dumped = await lab.asked('DNS-RES', 'sh', 'sudo rndc dumpdb -cache; cat /var/cache/bind/named_dump.db');
    expect(dumped.output).toMatch(/; authanswer\nwww\.banquehorizon\.com\.\t3600\tCNAME\tweb\.banquehorizon\.com\./);
    expect(dumped.output).toMatch(/; authanswer\nweb\.banquehorizon\.com\.\t3600\tA\t203\.0\.113\.20/);
  });
});
