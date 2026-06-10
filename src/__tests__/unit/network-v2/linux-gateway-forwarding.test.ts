/**
 * Linux gateway conformance (RFC 1812 §5.3.1) — a host with
 * net.ipv4.ip_forward=1 acts as a router: it forwards, decrements
 * TTL, and SIGNALS TTL expiry with ICMP Time Exceeded (so traceroute
 * through a Linux NAT gateway shows the gateway hop instead of `* * *`).
 *
 * Topology:
 *   SRC (10.0.1.2) ── GW LinuxServer (eth0 10.0.1.1 / eth1 10.0.2.1) ── DST (10.0.2.2)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function buildLinuxGatewayChain() {
  const src = new LinuxPC('linux-pc', 'SRC');
  const gw = new LinuxServer('linux-server', 'GW');
  const dst = new LinuxPC('linux-pc', 'DST');

  src.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  gw.configureInterface('eth0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
  gw.configureInterface('eth1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));
  dst.configureInterface('eth0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));

  src.setDefaultGateway(new IPAddress('10.0.1.1'));
  dst.setDefaultGateway(new IPAddress('10.0.2.1'));

  new Cable('c1').connect(src.getPort('eth0')!, gw.getPort('eth0')!);
  new Cable('c2').connect(gw.getPort('eth1')!, dst.getPort('eth0')!);

  await gw.executeCommand('sysctl -w net.ipv4.ip_forward=1');
  return { src, gw, dst };
}

describe('Linux gateway — IPv4 forwarding & TTL handling', () => {
  it('forwards packets end-to-end when ip_forward=1', async () => {
    const { src } = await buildLinuxGatewayChain();
    const out = await src.executeCommand('ping -c 1 10.0.2.2');
    expect(out).toContain('1 received');
  });

  it('answers TTL expiry with ICMP Time Exceeded instead of a silent drop', async () => {
    const { src } = await buildLinuxGatewayChain();
    // TTL 1: the packet dies at the gateway — the gateway must SAY so.
    const out = await src.executeCommand('ping -c 1 -t 1 10.0.2.2');
    expect(out).toMatch(/Time to live exceeded/i);
    expect(out).toContain('10.0.1.1');   // the gateway identifies itself
  });

  it('traceroute through the Linux gateway lists it as a hop', async () => {
    const { src } = await buildLinuxGatewayChain();
    const out = await src.executeCommand('traceroute -I 10.0.2.2');
    expect(out).toContain('10.0.1.1');   // gateway hop (TTL=1 probe)
    expect(out).toContain('10.0.2.2');   // destination reached
  });

  it('does NOT forward when ip_forward stays 0 (true host behaviour)', async () => {
    const src = new LinuxPC('linux-pc', 'SRC2');
    const gw = new LinuxServer('linux-server', 'GW2');
    const dst = new LinuxPC('linux-pc', 'DST2');
    src.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    gw.configureInterface('eth0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    gw.configureInterface('eth1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));
    dst.configureInterface('eth0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
    src.setDefaultGateway(new IPAddress('10.0.1.1'));
    dst.setDefaultGateway(new IPAddress('10.0.2.1'));
    new Cable('c1').connect(src.getPort('eth0')!, gw.getPort('eth0')!);
    new Cable('c2').connect(gw.getPort('eth1')!, dst.getPort('eth0')!);

    const out = await src.executeCommand('ping -c 1 10.0.2.2');
    expect(out).not.toContain('1 received');
  });
});
