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
    expect(response!.rcode).toBe('NXDOMAIN');
    expect(response!.answers).toHaveLength(0);
  }, 15000);

  it('answers NOERROR with the A record for known names', async () => {
    const { pc } = buildDnsTopology();

    const response = await pc.queryDnsServer(new IPAddress('10.0.1.10'), 'webserver', 'A');

    expect(response).not.toBeNull();
    expect(response!.rcode).toBe('NOERROR');
    expect(response!.answers[0].value).toBe('10.0.1.88');
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
