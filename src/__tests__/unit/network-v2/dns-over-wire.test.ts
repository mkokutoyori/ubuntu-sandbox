/**
 * DNS resolution over the simulated network (UDP/53).
 *
 * Before this fix, hostname resolution located the DNS server through the
 * Equipment registry and called its query() method directly: a DNS server
 * with an unplugged cable, no route, or a firewall dropping UDP 53 still
 * answered. Resolution now sends real UDP datagrams through the topology.
 *
 * Topology:
 *   PC1 (10.0.1.2/24) ── DNS1 LinuxServer (10.0.1.10/24, dnsmasq, UDP 53)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType } from '@/network/dns/wire/RRType';
import type { ARecordData } from '@/network/dns/wire/ResourceRecord';

function buildDnsTopology(options: { cabled?: boolean } = {}) {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('DNS1');

  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));

  if (options.cabled !== false) {
    new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  }

  srv.dnsService.addRecord({ name: 'webserver', type: 'A', value: '10.0.1.88', ttl: 3600 });
  srv.dnsService.start();

  return { pc, srv };
}

async function configureResolver(pc: LinuxPC, serverIP = '10.0.1.10'): Promise<void> {
  await pc.executeCommand(`sudo sh -c 'echo "nameserver ${serverIP}" > /etc/resolv.conf'`);
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('DNS over UDP/53 — nominal path', () => {
  it('resolves a hostname through the wire and pings it', async () => {
    const { pc } = buildDnsTopology();
    await configureResolver(pc);

    const out = await pc.executeCommand('ping -c 1 webserver');

    expect(out).toContain('10.0.1.88');
    expect(out).not.toContain('Name or service not known');
  }, 15000);

  it('binds UDP 53 on the server when dnsmasq starts, frees it on stop', () => {
    const { srv } = buildDnsTopology();

    expect(srv.getSocketTable().isPortBound(53, 'udp')).toBe(true);
    srv.dnsService.stop();
    expect(srv.getSocketTable().isPortBound(53, 'udp')).toBe(false);
  });

  it('answers NXDOMAIN for unknown names', async () => {
    const { pc, srv } = buildDnsTopology();
    void srv;

    const response = await pc.queryDnsServer(new IPAddress('10.0.1.10'), 'nope.invalid', 'A');

    expect(response).not.toBeNull();
    expect(response!.flags.rcode).toBe(DnsRcode.NXDOMAIN);
    expect(response!.answers).toHaveLength(0);
  }, 15000);

  it('answers NOERROR with the A record for known names', async () => {
    const { pc } = buildDnsTopology();

    const response = await pc.queryDnsServer(new IPAddress('10.0.1.10'), 'webserver', 'A');

    expect(response).not.toBeNull();
    expect(response!.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(response!.answers[0].data.type).toBe(RRType.A);
    expect((response!.answers[0].data as ARecordData).address.toString()).toBe('10.0.1.88');
  }, 15000);
});

describe('DNS over UDP/53 — failure realism', () => {
  it('fails to resolve when the DNS server is not cabled', async () => {
    const { pc } = buildDnsTopology({ cabled: false });
    await configureResolver(pc);

    const out = await pc.executeCommand('ping -c 1 webserver');

    expect(out).toContain('Name or service not known');
  }, 15000);

  it('fails to resolve when the server firewall drops UDP 53', async () => {
    const { pc, srv } = buildDnsTopology();
    await configureResolver(pc);
    await srv.executeCommand('sudo iptables -A INPUT -p udp --dport 53 -j DROP');

    const out = await pc.executeCommand('ping -c 1 webserver');

    expect(out).toContain('Name or service not known');
  }, 15000);

  it('fails to resolve once the DNS service is stopped', async () => {
    const { pc, srv } = buildDnsTopology();
    await configureResolver(pc);
    srv.dnsService.stop();

    const out = await pc.executeCommand('ping -c 1 webserver');

    expect(out).toContain('Name or service not known');
  }, 15000);

  it('fails to resolve when /etc/resolv.conf points to a non-existent server', async () => {
    const { pc } = buildDnsTopology();
    await configureResolver(pc, '10.0.1.250');

    const out = await pc.executeCommand('ping -c 1 webserver');

    expect(out).toContain('Name or service not known');
  }, 15000);
});

describe('dig / nslookup / host over UDP/53', () => {
  it('dig resolves through the wire (+short and full output)', async () => {
    const { pc, srv } = buildDnsTopology();
    srv.dnsService.addRecord({ name: 'web.example.lan', type: 'A', value: '10.0.1.99', ttl: 3600 });

    const short = await pc.executeCommand('dig @10.0.1.10 web.example.lan +short');
    expect(short.trim()).toBe('10.0.1.99');

    const full = await pc.executeCommand('dig @10.0.1.10 web.example.lan');
    expect(full).toContain('status: NOERROR');
    expect(full).toContain('SERVER: 10.0.1.10#53');
    expect(full).toContain('10.0.1.99');
  }, 15000);

  it('dig times out when the server is not cabled', async () => {
    const { pc } = buildDnsTopology({ cabled: false });

    const out = await pc.executeCommand('dig @10.0.1.10 webserver.example');

    expect(out).toContain('connection timed out; no servers could be reached');
  }, 15000);

  it('nslookup answers through the wire', async () => {
    const { pc, srv } = buildDnsTopology();
    srv.dnsService.addRecord({ name: 'app.lan', type: 'A', value: '10.0.1.77', ttl: 3600 });

    const out = await pc.executeCommand('nslookup app.lan 10.0.1.10');

    expect(out).toContain('10.0.1.77');
    expect(out).toContain('Server:\t\t10.0.1.10');
  }, 15000);

  it('nslookup reports a timeout when the DNS service is stopped', async () => {
    const { pc, srv } = buildDnsTopology();
    srv.dnsService.stop();

    const out = await pc.executeCommand('nslookup app.lan 10.0.1.10');

    expect(out).toContain('connection timed out');
  }, 15000);

  it('host resolves through the wire and reports NXDOMAIN', async () => {
    const { pc, srv } = buildDnsTopology();
    srv.dnsService.addRecord({ name: 'db.lan', type: 'A', value: '10.0.1.66', ttl: 3600 });

    const found = await pc.executeCommand('host db.lan 10.0.1.10');
    expect(found).toContain('db.lan has address 10.0.1.66');

    const missing = await pc.executeCommand('host nothere.lan 10.0.1.10');
    expect(missing).toContain('not found: 3(NXDOMAIN)');
  }, 15000);

  it('Windows nslookup goes over the wire too', async () => {
    const { srv } = buildDnsTopology();
    const { WindowsPC } = await import('@/network/devices/WindowsPC');
    const win = new WindowsPC('windows-pc', 'WIN1');
    win.configureInterface('eth0', new IPAddress('10.0.1.30'), new SubnetMask('255.255.255.0'));
    new Cable('c-win').connect(win.getPort('eth1')!, srv.getPort('eth1')!);
    // Use the directly-cabled subnet via eth1 addressing
    win.configureInterface('eth1', new IPAddress('10.0.2.30'), new SubnetMask('255.255.255.0'));
    srv.configureInterface('eth1', new IPAddress('10.0.2.10'), new SubnetMask('255.255.255.0'));

    const out = await win.executeCommand('nslookup webserver 10.0.2.10');

    expect(out).toContain('10.0.1.88');
  }, 15000);
});
