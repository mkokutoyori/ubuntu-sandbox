/**
 * Port ⇄ service ⇄ process ⇄ filesystem coherence — integration tests.
 *
 * Covers:
 *   - ServicePortProjection: a service's listening sockets are bound on
 *     start and released on stop, reactively, on the kernel SocketTable
 *   - the linux.port.bound / linux.port.released event stream and its
 *     PortActivityLogProjection consumer
 *   - filesystem coherence: /etc/services (IANA database) and the
 *     generated /proc/net/{tcp,udp} views
 *   - end-to-end on a real LinuxServer: `systemctl start/stop` moves ports
 *     in and out of `netstat`
 *   - Windows: `WindowsServiceManager` keeps the socket table coherent and
 *     the drivers\etc\services file is the full IANA registry
 */

import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { SocketTable } from '@/network/core/SocketTable';
import { EventBus } from '@/events/EventBus';
import { ServicePortProjection } from '@/network/devices/linux/ports/ServicePortProjection';
import { PortActivityLogProjection } from '@/network/devices/linux/ports/PortActivityLogProjection';
import type { ServicePortSource } from '@/network/devices/linux/ports/ServicePortProjection';
import type { ServicePortBinding } from '@/network/devices/linux/LinuxServiceManager';
import { WindowsServiceManager } from '@/network/devices/windows/WindowsServiceManager';
import { WindowsServicePortProjection } from '@/network/devices/windows/WindowsServicePortProjection';
import type { DomainEvent } from '@/events/types';

// ─── Helpers ────────────────────────────────────────────────────────────

/** Collect the payloads of every event published on a given topic. */
function capture<T extends DomainEvent['topic']>(bus: EventBus, topic: T) {
  const payloads: Array<Extract<DomainEvent, { topic: T }>['payload']> = [];
  bus.subscribe(topic, (e) => payloads.push(e.payload));
  return payloads;
}

/** A fixed port source for ServicePortProjection unit tests. */
function fakeSource(bindings: Record<string, ServicePortBinding>): ServicePortSource {
  return {
    getPortBinding: (name) => bindings[name],
    activePortBindings: () => Object.values(bindings),
  };
}

/** Publish a service-lifecycle event. */
function emitLifecycle(
  bus: EventBus,
  topic: 'linux.service.started' | 'linux.service.stopped' | 'linux.service.restarted',
  name: string,
): void {
  bus.publish({ topic, payload: { deviceId: 'dev-1', name, state: 'active', type: 'simple' } });
}

// ═══════════════════════════════════════════════════════════════════
// ServicePortProjection — reactive socket-table coherence
// ═══════════════════════════════════════════════════════════════════

describe('ServicePortProjection', () => {
  it('binds a service listening port when the service starts', () => {
    const bus = new EventBus();
    const table = new SocketTable();
    const source = fakeSource({
      nginx: { name: 'nginx', mainPid: 1234, processName: 'nginx', sockets: [{ port: 80, protocol: 'tcp' }] },
    });
    new ServicePortProjection(bus, 'dev-1', table, source);

    emitLifecycle(bus, 'linux.service.started', 'nginx');
    expect(table.isPortBound(80, 'tcp')).toBe(true);
    expect(table.findByLocalPort(80)?.processName).toBe('nginx');
  });

  it('releases the port when the service stops', () => {
    const bus = new EventBus();
    const table = new SocketTable();
    const source = fakeSource({
      nginx: { name: 'nginx', mainPid: 1234, processName: 'nginx', sockets: [{ port: 80, protocol: 'tcp' }] },
    });
    new ServicePortProjection(bus, 'dev-1', table, source);

    emitLifecycle(bus, 'linux.service.started', 'nginx');
    emitLifecycle(bus, 'linux.service.stopped', 'nginx');
    expect(table.isPortBound(80, 'tcp')).toBe(false);
  });

  it('reconciles already-active services on construction', () => {
    const bus = new EventBus();
    const table = new SocketTable();
    const source = fakeSource({
      mysql: { name: 'mysql', mainPid: 900, processName: 'mysqld', sockets: [{ port: 3306, protocol: 'tcp' }] },
    });
    new ServicePortProjection(bus, 'dev-1', table, source);

    expect(table.isPortBound(3306, 'tcp')).toBe(true);
  });

  it('publishes linux.port.bound / linux.port.released events', () => {
    const bus = new EventBus();
    const table = new SocketTable();
    const bound = capture(bus, 'linux.port.bound');
    const released = capture(bus, 'linux.port.released');
    const source = fakeSource({
      nginx: { name: 'nginx', mainPid: 1234, processName: 'nginx', sockets: [{ port: 80, protocol: 'tcp' }] },
    });
    new ServicePortProjection(bus, 'dev-1', table, source);

    emitLifecycle(bus, 'linux.service.started', 'nginx');
    emitLifecycle(bus, 'linux.service.stopped', 'nginx');

    expect(bound.some((p) => p.port === 80 && p.serviceName === 'nginx')).toBe(true);
    expect(released.some((p) => p.port === 80)).toBe(true);
  });

  it('never touches the ssh listener (config-driven, owned elsewhere)', () => {
    const bus = new EventBus();
    const table = new SocketTable();
    const source = fakeSource({
      ssh: { name: 'ssh', mainPid: 985, processName: 'sshd', sockets: [{ port: 22, protocol: 'tcp' }] },
    });
    new ServicePortProjection(bus, 'dev-1', table, source);

    emitLifecycle(bus, 'linux.service.started', 'ssh');
    expect(table.isPortBound(22, 'tcp')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// PortActivityLogProjection — reactive log consumer
// ═══════════════════════════════════════════════════════════════════

describe('PortActivityLogProjection', () => {
  it('logs a daemon-facility line when a port is bound', () => {
    const bus = new EventBus();
    const logged: Array<{ tag: string; message: string }> = [];
    const fakeLog = { logDaemon: (tag: string, message: string) => logged.push({ tag, message }) };
    new PortActivityLogProjection(bus, fakeLog as never, 'dev-1');

    bus.publish({
      topic: 'linux.port.bound',
      payload: { deviceId: 'dev-1', port: 80, protocol: 'tcp', address: '0.0.0.0', processName: 'nginx', serviceName: 'nginx' },
    });

    expect(logged).toHaveLength(1);
    expect(logged[0].message).toContain('Listening on TCP 0.0.0.0:80');
  });

  it('ignores events from another device', () => {
    const bus = new EventBus();
    const logged: string[] = [];
    const fakeLog = { logDaemon: (_t: string, m: string) => logged.push(m) };
    new PortActivityLogProjection(bus, fakeLog as never, 'dev-1');

    bus.publish({
      topic: 'linux.port.bound',
      payload: { deviceId: 'other', port: 80, protocol: 'tcp', address: '0.0.0.0', processName: 'nginx' },
    });
    expect(logged).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// End-to-end — LinuxServer
// ═══════════════════════════════════════════════════════════════════

describe('Linux end-to-end port coherence', () => {
  it('makes a service port appear in netstat once started', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('systemctl start apache2');

    const netstat = await srv.executeCommand('netstat -tln');
    expect(netstat).toContain(':80');
  });

  it('removes the port from netstat once the service is stopped', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('systemctl start apache2');
    await srv.executeCommand('systemctl stop apache2');

    const netstat = await srv.executeCommand('netstat -tln');
    expect(netstat).not.toContain(':80');
  });

  it('seeds /etc/services from the IANA registry', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const services = await srv.executeCommand('cat /etc/services');
    expect(services).toContain('ssh');
    expect(services).toContain('22/tcp');
    expect(services).toContain('443/tcp');
  });

  it('exposes the live socket table through /proc/net/tcp', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const procNet = await srv.executeCommand('cat /proc/net/tcp');
    expect(procNet).toContain('local_address');
    // sshd is bound on :22 at boot — 0x0016.
    expect(procNet).toContain(':0016');
  });

  it('resolves a service through getent services', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const out = await srv.executeCommand('getent services ssh');
    expect(out).toContain('22');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Windows port coherence
// ═══════════════════════════════════════════════════════════════════

describe('Windows port coherence', () => {
  it('releases a service port on stop and rebinds it on start, reactively', () => {
    const mgr = new WindowsServiceManager();
    const table = new SocketTable();
    table.bind('tcp', '0.0.0.0', 445, 4, 'System');
    const bus = new EventBus();
    mgr.attachBus(bus, 'win-1');
    // The reactive consumer keeps the socket table coherent with sc/net.
    new WindowsServicePortProjection(bus, 'win-1', table);

    expect(mgr.stopService('LanmanServer', true)).toBe('');
    expect(table.isPortBound(445, 'tcp')).toBe(false);

    expect(mgr.startService('LanmanServer', true)).toBe('');
    expect(table.isPortBound(445, 'tcp')).toBe(true);
  });

  it('ships the full IANA registry as the drivers\\etc\\services file', async () => {
    const { WindowsPC } = await import('@/network/devices/WindowsPC');
    const pc = new WindowsPC('win-pc', 'WIN1');
    const services = await pc.executeCommand('type C:\\Windows\\System32\\drivers\\etc\\services');
    expect(services).toContain('ssh');
    expect(services).toContain('3306/tcp');
  });
});
