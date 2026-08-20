import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Table {
  bind(protocol: 'tcp' | 'udp', addr: string, port: number, pid?: number, name?: string, banner?: string, opts?: { reuseAddr?: boolean }): { id: number; state: string };
  startTimeWait(id: number, ms?: number): boolean;
  close(id: number): boolean;
  getAll(): Array<{ id: number; localPort: number; state: string; protocol: string }>;
  setTcpTwReuse(v: boolean): void;
  getTcpTwReuse(): boolean;
  setTimeWaitDuration(ms: number): void;
}

function tbl(server: LinuxServer): Table {
  return (server as unknown as { executor: { socketTable: Table } }).executor.socketTable;
}

function makeServer(): LinuxServer {
  const s = new LinuxServer('linux-server', 'srv', 0, 0);
  s.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  return s;
}

describe('Scénario 4 — TIME_WAIT et SO_REUSEADDR / tcp_tw_reuse', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('un bind normal réussit, un second bind sur le même port échoue avec EADDRINUSE', async () => {
    const s = makeServer();
    const t = tbl(s);
    t.bind('tcp', '0.0.0.0', 8080, 1, 'myapp');
    expect(() => t.bind('tcp', '0.0.0.0', 8080, 2, 'myapp2')).toThrow(/EADDRINUSE/);
  });

  it('un socket fermé passe en TIME_WAIT, visible via ss -tan', async () => {
    const s = makeServer();
    const t = tbl(s);
    const e = t.bind('tcp', '0.0.0.0', 8080, 1, 'myapp');
    t.startTimeWait(e.id);
    const ss = await s.executeCommand('ss -tan');
    expect(ss).toMatch(/TIME[-_]WAIT/i);
    expect(ss).toMatch(/:8080/);
  });

  it('rebind pendant TIME_WAIT échoue avec EADDRINUSE (comportement par défaut sans SO_REUSEADDR)', async () => {
    const s = makeServer();
    const t = tbl(s);
    const e = t.bind('tcp', '0.0.0.0', 8080, 1, 'myapp');
    t.startTimeWait(e.id);
    expect(() => t.bind('tcp', '0.0.0.0', 8080, 2, 'myapp2')).toThrow(/EADDRINUSE/);
  });

  it('rebind pendant TIME_WAIT réussit si SO_REUSEADDR est passé au bind', async () => {
    const s = makeServer();
    const t = tbl(s);
    const e = t.bind('tcp', '0.0.0.0', 8080, 1, 'myapp');
    t.startTimeWait(e.id);
    const again = t.bind('tcp', '0.0.0.0', 8080, 2, 'myapp2', undefined, { reuseAddr: true });
    expect(again.state).toBe('LISTEN');
  });

  it('sysctl -w net.ipv4.tcp_tw_reuse=1 active la réutilisation globale des ports TIME_WAIT', async () => {
    const s = makeServer();
    const t = tbl(s);
    const out = await s.executeCommand('sysctl -w net.ipv4.tcp_tw_reuse=1');
    expect(out).toMatch(/net\.ipv4\.tcp_tw_reuse = 1/);
    expect(t.getTcpTwReuse()).toBe(true);
    const e = t.bind('tcp', '0.0.0.0', 8080, 1, 'myapp');
    t.startTimeWait(e.id);
    const again = t.bind('tcp', '0.0.0.0', 8080, 2, 'myapp2');
    expect(again.state).toBe('LISTEN');
  });

  it('sysctl net.ipv4.tcp_tw_reuse (lecture seule) reflète l\'état courant', async () => {
    const s = makeServer();
    tbl(s).setTcpTwReuse(true);
    const read = await s.executeCommand('sysctl net.ipv4.tcp_tw_reuse');
    expect(read).toMatch(/net\.ipv4\.tcp_tw_reuse = 1/);
  });

  it('après expiration du timer TIME_WAIT (2*MSL = 60s), le port se libère et un rebind ordinaire réussit', async () => {
    const s = makeServer();
    const t = tbl(s);
    t.setTimeWaitDuration(60_000);
    const e = t.bind('tcp', '0.0.0.0', 8080, 1, 'myapp');
    t.startTimeWait(e.id);
    expect(() => t.bind('tcp', '0.0.0.0', 8080, 2, 'myapp2')).toThrow(/EADDRINUSE/);
    await vi.advanceTimersByTimeAsync(60_000);
    const again = t.bind('tcp', '0.0.0.0', 8080, 2, 'myapp2');
    expect(again.state).toBe('LISTEN');
    const all = t.getAll().filter(x => x.localPort === 8080);
    expect(all.every(x => x.state !== 'TIME_WAIT')).toBe(true);
  });

  it('les entrées TIME_WAIT n\'apparaissent plus dans ss -tan une fois expirées', async () => {
    const s = makeServer();
    const t = tbl(s);
    t.setTimeWaitDuration(30_000);
    const e = t.bind('tcp', '0.0.0.0', 8080, 1, 'myapp');
    t.startTimeWait(e.id);
    const during = await s.executeCommand('ss -tan');
    expect(during).toMatch(/TIME[-_]WAIT/i);
    await vi.advanceTimersByTimeAsync(30_000);
    const after = await s.executeCommand('ss -tan');
    expect(after).not.toMatch(/8080\s+.*TIME[-_]WAIT/i);
  });
});
