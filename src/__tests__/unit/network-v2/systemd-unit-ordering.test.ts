import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxProcessManager } from '@/network/devices/linux/LinuxProcessManager';
import { LinuxServiceManager } from '@/network/devices/linux/LinuxServiceManager';
import { DependencyGraph } from '@/network/devices/linux/systemd/DependencyGraph';
import { orderUnits } from '@/network/devices/linux/systemd/UnitOrdering';

const UNIT_DIR = '/usr/lib/systemd/system';

function writeUnit(vfs: VirtualFileSystem, name: string, body: string): void {
  vfs.writeFile(`${UNIT_DIR}/${name}.service`, body, 0, 0, 0o644);
}

function before(a: string[], x: string, y: string): boolean {
  return a.indexOf(x) < a.indexOf(y);
}

describe('systemd UnitOrdering — topological sort (After/Before)', () => {
  let vfs: VirtualFileSystem;
  let sm: LinuxServiceManager;

  beforeEach(() => {
    vfs = new VirtualFileSystem();
    sm = new LinuxServiceManager(vfs, new LinuxProcessManager(), { isServer: false });
  });

  it('orders a unit after the units named in After=', () => {
    writeUnit(vfs, 'app', ['[Unit]', 'After=db.service cache.service', '[Service]', 'ExecStart=/x'].join('\n'));
    writeUnit(vfs, 'db', ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'));
    writeUnit(vfs, 'cache', ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'));
    sm.daemonReload();
    const graph = new DependencyGraph(sm.list());

    const { order, cycle } = orderUnits(['app', 'db', 'cache'], graph);

    expect(cycle).toBeNull();
    expect(before(order, 'db', 'app')).toBe(true);
    expect(before(order, 'cache', 'app')).toBe(true);
  });

  it('honours Before= as the mirror of After=', () => {
    writeUnit(vfs, 'early', ['[Unit]', 'Before=late.service', '[Service]', 'ExecStart=/x'].join('\n'));
    writeUnit(vfs, 'late', ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'));
    sm.daemonReload();
    const graph = new DependencyGraph(sm.list());

    const { order } = orderUnits(['early', 'late'], graph);

    expect(before(order, 'early', 'late')).toBe(true);
  });

  it('produces a stable order for a diamond dependency', () => {
    writeUnit(vfs, 'base', ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'));
    writeUnit(vfs, 'left', ['[Unit]', 'After=base.service', '[Service]', 'ExecStart=/x'].join('\n'));
    writeUnit(vfs, 'right', ['[Unit]', 'After=base.service', '[Service]', 'ExecStart=/x'].join('\n'));
    writeUnit(vfs, 'top', ['[Unit]', 'After=left.service right.service', '[Service]', 'ExecStart=/x'].join('\n'));
    sm.daemonReload();
    const graph = new DependencyGraph(sm.list());

    const { order, cycle } = orderUnits(['top', 'left', 'right', 'base'], graph);

    expect(cycle).toBeNull();
    expect(order[0]).toBe('base');
    expect(order[order.length - 1]).toBe('top');
    expect(before(order, 'base', 'left')).toBe(true);
    expect(before(order, 'right', 'top')).toBe(true);
  });

  it('ignores ordering edges to units outside the transaction set', () => {
    writeUnit(vfs, 'app', ['[Unit]', 'After=network.target absent.service', '[Service]', 'ExecStart=/x'].join('\n'));
    sm.daemonReload();
    const graph = new DependencyGraph(sm.list());

    const { order, cycle } = orderUnits(['app'], graph);

    expect(cycle).toBeNull();
    expect(order).toEqual(['app']);
  });

  it('detects an ordering cycle instead of looping', () => {
    writeUnit(vfs, 'a', ['[Unit]', 'After=b.service', '[Service]', 'ExecStart=/x'].join('\n'));
    writeUnit(vfs, 'b', ['[Unit]', 'After=c.service', '[Service]', 'ExecStart=/x'].join('\n'));
    writeUnit(vfs, 'c', ['[Unit]', 'After=a.service', '[Service]', 'ExecStart=/x'].join('\n'));
    sm.daemonReload();
    const graph = new DependencyGraph(sm.list());

    const { cycle } = orderUnits(['a', 'b', 'c'], graph);

    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThan(0);
    expect(['a', 'b', 'c'].some((u) => cycle!.includes(u))).toBe(true);
  });

  it('orders independent units deterministically by name', () => {
    writeUnit(vfs, 'zeta', ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'));
    writeUnit(vfs, 'alpha', ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'));
    sm.daemonReload();
    const graph = new DependencyGraph(sm.list());

    const { order } = orderUnits(['zeta', 'alpha'], graph);

    expect(order).toEqual(['alpha', 'zeta']);
  });
});
