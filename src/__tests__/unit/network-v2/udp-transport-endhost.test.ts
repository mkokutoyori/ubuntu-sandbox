/**
 * UDP socket layer on end hosts (RFC 768, RFC 1122 §4.1.3.1).
 *
 * Before this fix, end hosts had NO UDP delivery path at all: every UDP
 * datagram addressed to a PC was silently discarded — no listener dispatch,
 * no ICMP Port Unreachable for closed ports, nothing visible in netstat.
 *
 * Topology:
 *   PC1 (192.168.1.10/24) ── PC2 (192.168.1.20/24), same subnet.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import type { UdpDelivery } from '@/network/devices/EndHost';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function buildLanTopology() {
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');

  new Cable('pc1-pc2').connect(pc1.getPort('eth0')!, pc2.getPort('eth0')!);

  pc1.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
  pc2.configureInterface('eth0', new IPAddress('192.168.1.20'), new SubnetMask('255.255.255.0'));

  return { pc1, pc2 };
}

/** Poll until the condition holds (ARP resolution is asynchronous). */
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

describe('UDP datagram delivery (RFC 768)', () => {
  it('delivers a datagram to the listener bound on the destination port', async () => {
    const { pc1, pc2 } = buildLanTopology();
    const received: UdpDelivery[] = [];
    pc2.udpBind(9999, (delivery) => received.push(delivery));

    const sent = pc1.sendUdpDatagram(
      new IPAddress('192.168.1.20'), 9999, 5555, { text: 'hello' }, 5,
    );
    await waitUntil(() => received.length > 0);

    expect(sent).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].sourceIP.toString()).toBe('192.168.1.10');
    expect(received[0].udp.sourcePort).toBe(5555);
    expect(received[0].udp.destinationPort).toBe(9999);
    expect(received[0].udp.payload).toEqual({ text: 'hello' });
    expect(received[0].udp.length).toBe(13); // 8-byte header + 5-byte payload
  });

  it('supports request/response exchanges between two hosts', async () => {
    const { pc1, pc2 } = buildLanTopology();
    const answers: UdpDelivery[] = [];

    // PC2 runs a UDP echo service (RFC 862 style).
    pc2.udpBind(7, ({ sourceIP, udp }) => {
      pc2.sendUdpDatagram(sourceIP, udp.sourcePort, 7, udp.payload, 4);
    });
    pc1.udpBind(51000, (delivery) => answers.push(delivery));

    pc1.sendUdpDatagram(new IPAddress('192.168.1.20'), 7, 51000, 'ping', 4);
    await waitUntil(() => answers.length > 0);

    expect(answers).toHaveLength(1);
    expect(answers[0].udp.payload).toBe('ping');
    expect(answers[0].sourceIP.toString()).toBe('192.168.1.20');
    expect(answers[0].udp.sourcePort).toBe(7);
  });

  it('delivers loopback datagrams locally without touching the wire', () => {
    const { pc1 } = buildLanTopology();
    const received: UdpDelivery[] = [];
    pc1.udpBind(8888, (delivery) => received.push(delivery));

    const sent = pc1.sendUdpDatagram(new IPAddress('127.0.0.1'), 8888, 4444, 'local', 5);

    expect(sent).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].inPort).toBe('lo');
  });

  it('returns false when no route exists to the destination', () => {
    const { pc1 } = buildLanTopology();
    // No default gateway: 8.8.8.8 is unroutable.
    expect(pc1.sendUdpDatagram(new IPAddress('8.8.8.8'), 53, 5353, 'x', 1)).toBe(false);
  });
});

describe('Closed UDP ports (RFC 1122 §4.1.3.1)', () => {
  it('replies ICMP Port Unreachable when no listener is bound', async () => {
    const { pc1, pc2 } = buildLanTopology();

    pc1.sendUdpDatagram(new IPAddress('192.168.1.20'), 12345, 5555, 'x', 1);
    await waitUntil(() => Logger.getLogs().some(l => l.event === 'udp:port-unreachable'));

    const log = Logger.getLogs().find(l => l.event === 'udp:port-unreachable');
    expect(log).toBeDefined();
    expect(log!.message).toContain('12345');
    void pc2; // topology endpoint, addressed by IP
  });

  it('stays silent once a listener is bound', async () => {
    const { pc1, pc2 } = buildLanTopology();
    const received: UdpDelivery[] = [];
    pc2.udpBind(12345, (delivery) => received.push(delivery));

    pc1.sendUdpDatagram(new IPAddress('192.168.1.20'), 12345, 5555, 'x', 1);
    await waitUntil(() => received.length > 0);

    expect(Logger.getLogs().some(l => l.event === 'udp:port-unreachable')).toBe(false);
  });
});

describe('UDP port bindings and the socket table', () => {
  it('throws EADDRINUSE when binding an already-bound port', () => {
    const { pc2 } = buildLanTopology();
    pc2.udpBind(9999, () => {});

    expect(() => pc2.udpBind(9999, () => {})).toThrow(/EADDRINUSE/);
  });

  it('allows rebinding after udpClose', () => {
    const { pc2 } = buildLanTopology();
    pc2.udpBind(9999, () => {});
    pc2.udpClose(9999);

    expect(() => pc2.udpBind(9999, () => {})).not.toThrow();
  });

  it('shows the bound port in netstat output', async () => {
    const { pc2 } = buildLanTopology();
    pc2.udpBind(9999, () => {}, 'test-daemon');

    const out = await pc2.executeCommand('netstat -uln');

    expect(out).toContain('9999');
  });
});
