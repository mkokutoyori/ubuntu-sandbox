import { describe, it, expect, beforeEach } from 'vitest';
import { IPv6Address, resetCounters } from '@/network/core/types';
import type { UdpDelivery } from '@/network/devices/EndHost';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function buildLan() {
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPorts()[0]);
  new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPorts()[1]);
  pc1.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);
  pc2.configureIPv6Interface('eth0', new IPv6Address('2001:db8::2'), 64);
  return { pc1, pc2 };
}

async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('UDP over IPv6 — real datagram delivery (RFC 8200)', () => {
  it('delivers a datagram to a listener bound on the IPv6 destination port', async () => {
    const { pc1, pc2 } = buildLan();
    const received: UdpDelivery[] = [];
    pc2.udpBind(9999, (delivery) => received.push(delivery));

    const sent = pc1.sendUdpDatagram6(new IPv6Address('2001:db8::2'), 9999, 5555, { text: 'hi6' }, 3);
    await waitUntil(() => received.length > 0);

    expect(sent).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].sourceIP.toString()).toBe('2001:db8::1');
    expect(received[0].udp.sourcePort).toBe(5555);
    expect(received[0].udp.destinationPort).toBe(9999);
    expect(received[0].udp.payload).toEqual({ text: 'hi6' });
  });

  it('supports an IPv6 request/response exchange between two hosts', async () => {
    const { pc1, pc2 } = buildLan();
    const answers: UdpDelivery[] = [];

    pc2.udpBind(7, ({ sourceIP, udp }) => {
      pc2.sendUdpDatagram6(sourceIP as IPv6Address, udp.sourcePort, 7, udp.payload, 4);
    });
    pc1.udpBind(51000, (delivery) => answers.push(delivery));

    pc1.sendUdpDatagram6(new IPv6Address('2001:db8::2'), 7, 51000, 'ping', 4);
    await waitUntil(() => answers.length > 0);

    expect(answers).toHaveLength(1);
    expect(answers[0].udp.payload).toBe('ping');
    expect(answers[0].sourceIP.toString()).toBe('2001:db8::2');
    expect(answers[0].udp.sourcePort).toBe(7);
  });

  it('delivers loopback datagrams locally without touching the wire', () => {
    const { pc1 } = buildLan();
    const received: UdpDelivery[] = [];
    pc1.udpBind(8888, (delivery) => received.push(delivery));

    const sent = pc1.sendUdpDatagram6(new IPv6Address('::1'), 8888, 4444, 'local6', 6);

    expect(sent).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].inPort).toBe('lo');
  });

  it('returns false when no route exists to the destination', () => {
    const { pc1 } = buildLan();
    expect(pc1.sendUdpDatagram6(new IPv6Address('2001:dead::9'), 53, 5353, 'x', 1)).toBe(false);
  });

  it('sendUdpDatagramTo dispatches to the IPv6 path for an IPv6 destination', async () => {
    const { pc1, pc2 } = buildLan();
    const received: UdpDelivery[] = [];
    pc2.udpBind(1234, (delivery) => received.push(delivery));

    pc1.sendUdpDatagramTo(new IPv6Address('2001:db8::2'), 1234, 6000, 'via-dispatch', 12);
    await waitUntil(() => received.length > 0);

    expect(received).toHaveLength(1);
    expect(received[0].sourceIP.toString()).toBe('2001:db8::1');
  });
});

describe('UDP over IPv6 — ICMPv6 port unreachable (RFC 4443 §3.1)', () => {
  it('emits ICMPv6 destination-unreachable when no listener owns the port', async () => {
    const { pc1, pc2 } = buildLan();
    void pc2;
    const errors: string[] = [];
    pc1.getBus().subscribe('host.icmp.echo-failed', (e) => {
      const p = e.payload as { reason?: string };
      if (p.reason) errors.push(p.reason);
    });

    pc1.sendUdpDatagram6(new IPv6Address('2001:db8::2'), 65001, 40000, 'nobody-home', 11);
    await waitUntil(() => errors.length > 0, 2000);

    expect(errors.some((r) => /unreachable/i.test(r))).toBe(true);
  });
});
