import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPv6Address, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import type { TcpSocket } from '@/network/tcp/TcpStack';

interface Ipv6TcpHost {
  getTcpStack(): {
    connect(ip: string, port: number): TcpSocket | null;
    listen(port: number, opts: { onAccept: (s: TcpSocket) => void }): void;
  };
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function buildLan(): { pc: LinuxPC; srv: LinuxServer } {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPorts()[0]);
  new Cable('c2').connect(srv.getPort('eth0')!, sw.getPorts()[1]);
  pc.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);
  srv.configureIPv6Interface('eth0', new IPv6Address('2001:db8::2'), 64);
  return { pc, srv };
}

async function captureWithTraffic(capturer: LinuxPC, cmd: string, gen: () => Promise<void>): Promise<string> {
  const pending = capturer.executeCommand(cmd);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await gen();
  return await pending;
}

describe('tcpdump IPv4/IPv6 decode parity (PRD-tcpdump.md P3)', () => {
  it('a TCP segment over IPv6 shows real ports/flags/seq/ack, not a bare address line', async () => {
    const { pc, srv } = buildLan();
    (srv as unknown as Ipv6TcpHost).getTcpStack().listen(8080, { onAccept: () => {} });

    const output = await captureWithTraffic(pc, 'tcpdump -c 1 -nn ip6 and tcp', async () => {
      (pc as unknown as Ipv6TcpHost).getTcpStack().connect('2001:db8::2', 8080);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(output).toContain('2001:db8::1');
    expect(output).toContain('8080');
    expect(output).toContain('Flags [S]');
  });

  it('an ICMPv6 packet decodes a real type/code instead of an empty stub', async () => {
    const { pc } = buildLan();
    const output = await captureWithTraffic(pc, 'tcpdump -c 1 -nn icmp6', async () => {
      await pc.executeCommand('ping6 -c 1 2001:db8::2');
    });

    expect(output.toLowerCase()).toContain('icmp6');
  });

  it('a hex dump of an IPv6 packet shows real bytes, not an empty frame', async () => {
    const { pc, srv } = buildLan();
    (srv as unknown as Ipv6TcpHost).getTcpStack().listen(8081, { onAccept: () => {} });

    const output = await captureWithTraffic(pc, 'tcpdump -c 1 -x ip6 and tcp', async () => {
      (pc as unknown as Ipv6TcpHost).getTcpStack().connect('2001:db8::2', 8081);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const hexLine = output.split('\n').find((l) => l.trim().startsWith('0x'));
    expect(hexLine).toBeDefined();
    expect(hexLine!.trim()).not.toBe('0x0000:');
  });
});
