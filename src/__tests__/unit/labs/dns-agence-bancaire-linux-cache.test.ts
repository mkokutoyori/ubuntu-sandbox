/*
 * Lab "DNS - Agence bancaire", the Linux workstation (PC-CONSEILLER): does the DNS cache of an Ubuntu client answer? On Ubuntu `/etc/resolv.conf` points at the stub of systemd-resolved
 * (127.0.0.53), which takes the DNS servers and the domain from the DHCP lease through networkd, forwards every question to them and keeps the answers by their own TTL. The lab builds the workstation
 * with netplan DHCP and the symbolic link Ubuntu ships, then every question is asked twice and the UDP/53 queries are counted on the wire at the workstation's port (the loopback leg to the stub
 * is not counted: it is the same machine), so that a cache that exists but is not consulted shows as a query.
 *
 * Measured first (git stash push -- src/network src/powershell, 14 tests): resolved held no server (the lease reached /etc/resolv.conf and never the service: `resolvectl status` had no Link section and
 * `resolvectl query` answered `Name or service not known` without sending a packet), the stub answered A and AAAA only (an MX question got an empty NOERROR), turned `www` into an A record owned
 * by `www` with a TTL of 60 and no CNAME, kept nothing about a name that does not exist, and a lease or a netplan apply rewrote the file the link pointed at. Before the change 12 of the 14 fall; the two
 * that pass either way are the WITNESS on the resolv.conf link, which the lab builder writes, and the localhost/hosts test, which never leaves the machine.
 * Reference for the behaviour: systemd's resolved-dns-cache.c (a positive entry lives min(TTL) capped at 2 hours, a negative one min(SOA TTL, SOA minimum) and needs the SOA, nothing is cached with a zero
 * TTL) and scripts/oracle/record_resolved_stub.py, which asked a real systemd-resolved 255 the same questions over the same tree (oracle test: resolved-stub-oracle.test.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { bench, resetWorld } from './_dnsLabBench';

beforeEach(resetWorld);

const ASK = 'PC-CONSEILLER';

describe('Lab DNS - agence bancaire : the Linux workstation keeps a DNS cache', () => {
  it('WITNESS: the workstation reads the stub of systemd-resolved, as Ubuntu does', async () => {
    const lab = await bench();
    const file = await lab.asked(ASK, 'sh', 'ls -l /etc/resolv.conf; cat /etc/resolv.conf');
    expect(file.output).toContain('/run/systemd/resolve/stub-resolv.conf');
    expect(file.output).toContain('nameserver 127.0.0.53');
  });

  it('resolved took the DNS servers and the domain of the DHCP lease', async () => {
    const lab = await bench();
    const status = await lab.asked(ASK, 'sh', 'resolvectl status');
    expect(status.output).toMatch(/Link \d+ \(eth0\)/);
    expect(status.output).toMatch(/DNS Servers:\s+10\.20\.20\.10 10\.20\.20\.53/);
    expect(status.output).toMatch(/DNS Domain:\s+horizon\.local/);
  });

  it('the file that points at the stub is not rewritten by the lease', async () => {
    const lab = await bench();
    await lab.asked(ASK, 'sh', 'sudo netplan apply');
    const file = await lab.asked(ASK, 'sh', 'cat /etc/resolv.conf');
    expect(file.output).toContain('nameserver 127.0.0.53');
    expect(file.output).not.toContain('nameserver 10.20.20.10');
  });

  it('dig shows the CNAME and the address of a CNAME name, asked of the stub, and the second answer comes from the cache', async () => {
    const lab = await bench();
    const first = await lab.asked(ASK, 'sh', 'dig www.banquehorizon.com');
    expect(first.output).toContain('SERVER: 127.0.0.53#53');
    expect(first.output).toMatch(/www\.banquehorizon\.com\.\s+3600\s+IN\s+CNAME\s+web\.banquehorizon\.com\./);
    expect(first.output).toMatch(/web\.banquehorizon\.com\.\s+3600\s+IN\s+A\s+203\.0\.113\.20/);
    expect(first.sent[ASK]).toBe(1);
    await lab.asked(ASK, 'sh', 'sleep 5');
    const again = await lab.asked(ASK, 'sh', 'dig www.banquehorizon.com +noall +answer');
    expect(again.sent[ASK]).toBe(0);
    expect(again.output).toMatch(/www\.banquehorizon\.com\.\s+3595\s+IN\s+CNAME/);
    expect(again.output).toMatch(/web\.banquehorizon\.com\.\s+3595\s+IN\s+A\s+203\.0\.113\.20/);
  });

  it('getent, ping and curl go through the same cache: one question for the three', async () => {
    const lab = await bench();
    const first = await lab.asked(ASK, 'sh', 'getent hosts www.banquehorizon.com');
    expect(first.output).toContain('203.0.113.20');
    expect(first.sent[ASK]).toBeGreaterThanOrEqual(1);
    const ping = await lab.asked(ASK, 'sh', 'ping -n -c 1 www.banquehorizon.com');
    expect(ping.output).toContain('1 received');
    expect(ping.sent[ASK]).toBe(0);
    const curl = await lab.asked(ASK, 'sh', "curl -sk https://www.banquehorizon.com/ -o /dev/null -w '%{http_code}'");
    expect(curl.output).toBe('200');
    expect(curl.sent[ASK]).toBe(0);
  });

  it('a name that does not exist is kept: NXDOMAIN with the SOA, the second time without a packet, TTL going down', async () => {
    const lab = await bench();
    const first = await lab.asked(ASK, 'sh', 'dig nexiste.banquehorizon.com');
    expect(first.output).toContain('status: NXDOMAIN');
    expect(first.output).toMatch(/banquehorizon\.com\.\s+3600\s+IN\s+SOA\s+ns1\.banquehorizon\.com\./);
    expect(first.sent[ASK]).toBe(1);
    await lab.asked(ASK, 'sh', 'sleep 5');
    const again = await lab.asked(ASK, 'sh', 'dig nexiste.banquehorizon.com');
    expect(again.sent[ASK]).toBe(0);
    expect(again.output).toContain('status: NXDOMAIN');
    expect(again.output).toMatch(/banquehorizon\.com\.\s+3595\s+IN\s+SOA/);
  });

  it('a name without an address of that family (AAAA) is kept: NOERROR, no answer, the SOA', async () => {
    const lab = await bench();
    await lab.asked(ASK, 'sh', 'dig web.banquehorizon.com AAAA');
    const again = await lab.asked(ASK, 'sh', 'dig web.banquehorizon.com AAAA');
    expect(again.output).toContain('status: NOERROR');
    expect(again.output).toMatch(/ANSWER: 0/);
    expect(again.output).toMatch(/banquehorizon\.com\.\s+\d+\s+IN\s+SOA/);
    expect(again.sent[ASK]).toBe(0);
  });

  it('the stub forwards every type, not only A and AAAA: MX is answered, then kept', async () => {
    const lab = await bench();
    const first = await lab.asked(ASK, 'sh', 'dig banquehorizon.com MX +short');
    expect(first.output).toContain('10 mail.banquehorizon.com.');
    expect(first.output).toContain('20 mail2.banquehorizon.com.');
    expect(first.sent[ASK]).toBe(1);
    const again = await lab.asked(ASK, 'sh', 'dig banquehorizon.com MX +short');
    expect(again.output).toContain('10 mail.banquehorizon.com.');
    expect(again.sent[ASK]).toBe(0);
  });

  it('TXT, NS, SOA, SRV and PTR are forwarded too', async () => {
    const lab = await bench();
    const txt = await lab.asked(ASK, 'sh', 'dig banquehorizon.com TXT +short');
    expect(txt.output).toContain('"v=spf1 mx -all"');
    const ns = await lab.asked(ASK, 'sh', 'dig banquehorizon.com NS +short');
    expect(ns.output).toContain('ns1.banquehorizon.com.');
    const soa = await lab.asked(ASK, 'sh', 'dig banquehorizon.com SOA +short');
    expect(soa.output).toContain('ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101');
    const srv = await lab.asked(ASK, 'sh', 'dig _imaps._tcp.banquehorizon.com SRV +short');
    expect(srv.output).toContain('0 1 993 mail.banquehorizon.com.');
    const ptr = await lab.asked(ASK, 'sh', 'dig -x 203.0.113.20 +short');
    expect(ptr.output).toContain('web.banquehorizon.com.');
  });

  it('resolvectl query resolves through the link servers and says where the answer came from', async () => {
    const lab = await bench();
    const first = await lab.asked(ASK, 'sh', 'resolvectl query www.banquehorizon.com');
    expect(first.output).toContain('203.0.113.20');
    expect(first.output).toMatch(/Information acquired via protocol DNS/);
    expect(first.output).toMatch(/Data from:\s+network/);
    const again = await lab.asked(ASK, 'sh', 'resolvectl query www.banquehorizon.com');
    expect(again.output).toMatch(/Data from:\s+cache/);
    expect(again.sent[ASK]).toBe(0);
  });

  it('resolvectl statistics counts the hits and the size of the cache, and flush-caches empties it', async () => {
    const lab = await bench();
    await lab.asked(ASK, 'sh', 'dig www.banquehorizon.com +short');
    await lab.asked(ASK, 'sh', 'dig www.banquehorizon.com +short');
    const stats = await lab.asked(ASK, 'sh', 'resolvectl statistics');
    expect(stats.output).toMatch(/Cache Hits:\s+[1-9]/);
    expect(stats.output).toMatch(/Current Cache Size:\s+[1-9]/);
    await lab.asked(ASK, 'sh', 'sudo resolvectl flush-caches');
    const flushed = await lab.asked(ASK, 'sh', 'resolvectl statistics');
    expect(flushed.output).toMatch(/Current Cache Size:\s+0/);
    const cold = await lab.asked(ASK, 'sh', 'dig www.banquehorizon.com +short');
    expect(cold.sent[ASK]).toBe(1);
  });

  it('DC1 is asked once for a name two workstations want, by the first of them only', async () => {
    const lab = await bench();
    await lab.asked('PC-GUICHET1', 'ps', 'Resolve-DnsName www.banquehorizon.com');
    const fromLinux = await lab.asked(ASK, 'sh', 'dig www.banquehorizon.com +short');
    expect(fromLinux.output).toContain('203.0.113.20');
    expect(fromLinux.sent[ASK]).toBe(1);
    expect(fromLinux.sent['DC1']).toBe(0);
  });

  it('when DC1 stops answering, the stub moves to DNS-RES, reports it as the current server and goes straight to it for the next name', async () => {
    const lab = await bench();
    await lab.asked('DC1', 'ps', 'Stop-Service DNS');
    const failover = await lab.asked(ASK, 'sh', 'dig api.banquehorizon.com +short');
    expect(failover.output).toContain('203.0.113.20');
    expect(failover.sent[ASK]).toBe(2);
    const status = await lab.asked(ASK, 'sh', 'resolvectl status');
    expect(status.output).toMatch(/Current DNS Server:\s+10\.20\.20\.53/);
    const next = await lab.asked(ASK, 'sh', 'dig agences.banquehorizon.com +short');
    expect(next.output).toContain('203.0.113.20');
    expect(next.sent[ASK]).toBe(1);
  });

  it('a name under the domain of the lease is completed by the search list the stub publishes', async () => {
    const lab = await bench();
    const short = await lab.asked(ASK, 'sh', 'getent hosts intranet');
    expect(short.output).toContain('10.20.20.10');
  });

  it('the stub answers localhost and the names of /etc/hosts without leaving the machine', async () => {
    const lab = await bench();
    const local = await lab.asked(ASK, 'sh', 'getent hosts localhost');
    expect(local.output).toContain('127.0.0.1');
    expect(local.sent[ASK]).toBe(0);
  });
});
