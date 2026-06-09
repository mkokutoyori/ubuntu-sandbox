/**
 * DNS over the real simulated network (UDP/53).
 *
 * These tests pin the realism contract introduced by DnsClient /
 * DnsServerEndpoint: name resolution only works when the network path
 * actually works (cable, routing, ARP, daemon listening on UDP/53) —
 * and fails the way real tools fail when it doesn't.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const DNS_CONF = `address=/intranet.lab/10.0.0.80\n`;

async function buildLab() {
  const client = new LinuxPC('linux-pc', 'Client');
  const server = new LinuxPC('linux-pc', 'DNS');
  const sw = new GenericSwitch('switch', 'SW');

  await server.executeCommand('sudo ip addr add 10.0.0.53/24 dev eth0');
  await server.executeCommand('sudo ip link set eth0 up');
  await server.executeCommand(`sudo sh -c 'echo "${DNS_CONF.trim()}" > /etc/dnsmasq.conf'`);
  await server.executeCommand('sudo dnsmasq');

  await client.executeCommand('sudo ip addr add 10.0.0.20/24 dev eth0');
  await client.executeCommand('sudo ip link set eth0 up');
  await client.executeCommand(`sudo sh -c 'echo "nameserver 10.0.0.53" > /etc/resolv.conf'`);

  const cableClient = new Cable('c1');
  cableClient.connect(client.getPort('eth0')!, sw.getPort('eth0')!);
  const cableServer = new Cable('c2');
  cableServer.connect(server.getPort('eth0')!, sw.getPort('eth1')!);

  return { client, server, sw, cableClient, cableServer };
}

describe('DNS over UDP/53 — realism contract', () => {
  it('dig resolves through the network when everything is up', async () => {
    const { client } = await buildLab();
    const out = await client.executeCommand('dig intranet.lab +short');
    expect(out.trim()).toBe('10.0.0.80');
  });

  it('dnsmasq start opens UDP/53 (visible to ss/netstat) and stop closes it', async () => {
    const { server } = await buildLab();
    expect(server.getUdpStack().isListening(53)).toBe(true);
    server.dnsService.stop();
    expect(server.getUdpStack().isListening(53)).toBe(false);
    server.dnsService.start();
    expect(server.getUdpStack().isListening(53)).toBe(true);
  });

  it('reports connection refused when the daemon is stopped (ICMP port unreachable)', async () => {
    const { client, server } = await buildLab();
    server.dnsService.stop();
    const out = await client.executeCommand('dig intranet.lab');
    expect(out).toContain('connection refused');
  });

  it('times out when the cable to the server is unplugged', async () => {
    const { client, cableServer } = await buildLab();
    cableServer.disconnect();
    const out = await client.executeCommand('dig intranet.lab +time=1');
    expect(out).toContain('connection timed out');
  }, 15_000);

  it('ping resolves hostnames via real DNS queries', async () => {
    const { client, server } = await buildLab();
    // intranet.lab → 10.0.0.80 is not assigned; point a record at the DNS host itself
    server.dnsService.addRecord({ name: 'dns.lab', type: 'A', value: '10.0.0.53', ttl: 3600 });
    const out = await client.executeCommand('ping -c 1 dns.lab');
    expect(out).toContain('PING dns.lab (10.0.0.53)');
    expect(out).toContain('1 received');
  });

  it('/etc/hosts wins over DNS (NSS files-first order)', async () => {
    const { client } = await buildLab();
    await client.executeCommand(`sudo sh -c 'echo "10.0.0.99 intranet.lab" >> /etc/hosts'`);
    const out = await client.executeCommand('ping -c 1 intranet.lab');
    // 10.0.0.99 does not exist — hosts-file answer must shadow the DNS record
    expect(out).toContain('PING intranet.lab (10.0.0.99)');
  });

  it('Windows nslookup queries the server over the network', async () => {
    const { sw } = await buildLab();
    const win = new WindowsPC('windows-pc', 'WIN');
    await win.executeCommand('netsh interface ip set address name="eth0" static 10.0.0.30 255.255.255.0 10.0.0.1');
    await win.executeCommand('netsh interface ip set dns name="eth0" static 10.0.0.53');
    new Cable('c3').connect(win.getPort('eth0')!, sw.getPort('eth2')!);

    const out = await win.executeCommand('nslookup intranet.lab');
    expect(out).toContain('Address: 10.0.0.80');
  });

  it('Windows nslookup fails when the Windows client is not cabled', async () => {
    await buildLab();
    const win = new WindowsPC('windows-pc', 'WIN');
    await win.executeCommand('netsh interface ip set address name="eth0" static 10.0.0.30 255.255.255.0 10.0.0.1');
    await win.executeCommand('netsh interface ip set dns name="eth0" static 10.0.0.53');
    // no cable connected on purpose

    const out = await win.executeCommand('nslookup intranet.lab');
    expect(out).not.toContain('Address: 10.0.0.80');
  }, 15_000);
});
