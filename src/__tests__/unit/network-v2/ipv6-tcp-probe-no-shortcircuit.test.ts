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

function tcpListen(srv: LinuxServer, port: number): void {
  (srv as unknown as { getTcpStack(): { listen(p: number, o: { onAccept: (s: TcpSocket) => void }): void } })
    .getTcpStack().listen(port, { onAccept: () => {} });
}

async function warm(pc: LinuxPC, srv: LinuxServer): Promise<void> {
  await pc.executeCommand('ping6 -c 1 2001:db8::2');
  await srv.executeCommand('ping6 -c 1 2001:db8::1');
}

function buildLan(options: { cabled?: boolean } = {}) {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPorts()[0]);
  if (options.cabled !== false) {
    new Cable('c2').connect(srv.getPort('eth0')!, sw.getPorts()[1]);
  }
  pc.configureIPv6Interface('eth0', new IPv6Address('2001:db8::1'), 64);
  srv.configureIPv6Interface('eth0', new IPv6Address('2001:db8::2'), 64);
  return { pc, srv };
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

describe('IPv6 TCP probe travels the wire (no peer-state short-circuit)', () => {
  it('reports an open port only when a listener is truly reachable', async () => {
    const { pc, srv } = buildLan();
    await warm(pc, srv);
    tcpListen(srv, 8080);

    expect(pc.tcpProbeSyncIPv6('2001:db8::2', 8080)).toBe(true);
  });

  it('reports closed (refused) for a port with no listener', async () => {
    const { pc, srv } = buildLan();
    await warm(pc, srv);

    expect(pc.tcpProbeSyncIPv6('2001:db8::2', 8080)).toBe(false);
    expect(pc.tcpConnectOutcome6(new IPv6Address('2001:db8::2'), 8080)).toBe('refused');
  });

  it('an ip6tables INPUT DROP makes a listening port look filtered (timeout)', async () => {
    const { pc, srv } = buildLan();
    await warm(pc, srv);
    tcpListen(srv, 8080);
    await srv.executeCommand('ip6tables -A INPUT -p tcp --dport 8080 -j DROP');

    expect(pc.tcpProbeSyncIPv6('2001:db8::2', 8080)).toBe(false);
    expect(pc.tcpConnectOutcome6(new IPv6Address('2001:db8::2'), 8080)).toBe('timeout');
  });

  it('an ip6tables INPUT REJECT actively refuses the connection', async () => {
    const { pc, srv } = buildLan();
    await warm(pc, srv);
    tcpListen(srv, 8080);
    await srv.executeCommand('ip6tables -A INPUT -p tcp --dport 8080 -j REJECT');

    expect(pc.tcpConnectOutcome6(new IPv6Address('2001:db8::2'), 8080)).toBe('refused');
  });

  it('times out when the server is not cabled, even though it has a listener', async () => {
    const { pc, srv } = buildLan({ cabled: false });
    tcpListen(srv, 8080);

    expect(pc.tcpProbeSyncIPv6('2001:db8::2', 8080)).toBe(false);
    expect(pc.tcpConnectOutcome6(new IPv6Address('2001:db8::2'), 8080)).toBe('timeout');
  });
});
