import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IPv6Address, MACAddress, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import type { TcpSocket } from '@/network/tcp/TcpStack';

let scheduler: VirtualTimeScheduler;

interface Peer {
  getTcpStack(): {
    connect(ip: string, port: number, opts?: {
      onOpen?: (s: TcpSocket) => void; onData?: (d: unknown) => void; onClose?: () => void;
    }): TcpSocket | null;
    listen(port: number, opts: { onAccept: (s: TcpSocket) => void }): void;
    listListeners(): Array<{ localPort: number }>;
  };
}

function tcp(host: LinuxPC | LinuxServer): Peer['getTcpStack'] extends () => infer R ? R : never {
  return (host as unknown as Peer).getTcpStack();
}

async function warmNeighbors(pc: LinuxPC, srv: LinuxServer, pcIp: string, srvIp: string): Promise<void> {
  await pc.executeCommand(`ping6 -c 1 ${srvIp}`);
  await srv.executeCommand(`ping6 -c 1 ${pcIp}`);
}

function buildLan() {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPorts()[0]);
  new Cable('c2').connect(srv.getPort('eth0')!, sw.getPorts()[1]);
  pc.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);
  srv.configureIPv6Interface('eth0', new IPv6Address('2001:db8::2'), 64);
  return { pc, srv };
}

async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(() => {
  scheduler = new VirtualTimeScheduler();
  __setDefaultScheduler(scheduler);
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

afterEach(() => {
  __setDefaultScheduler(null);
});

describe('TCP over IPv6 — real handshake (RFC 9293)', () => {
  it('establishes a connection to an IPv6 listener and marks the socket ipv6', async () => {
    const { pc, srv } = buildLan();
    await warmNeighbors(pc, srv, '2001:db8::1', '2001:db8::2');

    let accepted: TcpSocket | null = null;
    tcp(srv).listen(8080, { onAccept: (s) => { accepted = s; } });

    const sock = tcp(pc).connect('2001:db8::2', 8080)!;

    expect(sock).not.toBeNull();
    expect(sock.state).toBe('established');
    expect(sock.family).toBe('ipv6');
    await waitUntil(() => accepted !== null);
    expect(accepted).not.toBeNull();
    expect(accepted!.family).toBe('ipv6');
  });

  it('carries application data both ways over IPv6', async () => {
    const { pc, srv } = buildLan();
    await warmNeighbors(pc, srv, '2001:db8::1', '2001:db8::2');

    const serverGot: string[] = [];
    const clientGot: string[] = [];
    tcp(srv).listen(9000, {
      onAccept: (s) => {
        s.onData((d) => { serverGot.push(String(d)); s.send('pong6'); });
      },
    });

    const sock = tcp(pc).connect('2001:db8::2', 9000, { onData: (d) => clientGot.push(String(d)) })!;
    sock.send('ping6');
    await waitUntil(() => clientGot.length > 0);

    expect(serverGot).toContain('ping6');
    expect(clientGot).toContain('pong6');
  });

  it('refuses (RST) a connection to a port with no IPv6 listener', async () => {
    const { pc, srv } = buildLan();
    await warmNeighbors(pc, srv, '2001:db8::1', '2001:db8::2');

    const outcome = pc.tcpConnectOutcome6(new IPv6Address('2001:db8::2'), 4444);
    expect(outcome).toBe('refused');
  });

  it('times out when no cabled path reaches the IPv6 destination', () => {
    const { pc } = buildLan();
    const outcome = pc.tcpConnectOutcome6(new IPv6Address('2001:dead::9'), 80);
    expect(outcome).toBe('timeout');
  });

  it('a dual-stack :: listener accepts an IPv6 connection', async () => {
    const { pc, srv } = buildLan();
    await warmNeighbors(pc, srv, '2001:db8::1', '2001:db8::2');

    let accepted = false;
    tcp(srv).listen(7000, { onAccept: () => { accepted = true; } }, '::');

    const sock = tcp(pc).connect('2001:db8::2', 7000)!;
    await waitUntil(() => accepted);

    expect(sock.state).toBe('established');
    expect(accepted).toBe(true);
  });
});
