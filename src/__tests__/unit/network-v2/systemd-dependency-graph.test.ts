import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxProcessManager } from '@/network/devices/linux/LinuxProcessManager';
import { LinuxServiceManager } from '@/network/devices/linux/LinuxServiceManager';
import { DependencyGraph } from '@/network/devices/linux/systemd/DependencyGraph';

const UNIT_DIR = '/usr/lib/systemd/system';

function writeUnit(vfs: VirtualFileSystem, name: string, body: string): void {
  vfs.writeFile(`${UNIT_DIR}/${name}.service`, body, 0, 0, 0o644);
}

describe('systemd DependencyGraph — typed edges (systemd.unit(5))', () => {
  let vfs: VirtualFileSystem;
  let pm: LinuxProcessManager;
  let sm: LinuxServiceManager;

  beforeEach(() => {
    vfs = new VirtualFileSystem();
    pm = new LinuxProcessManager();
    sm = new LinuxServiceManager(vfs, pm, { isServer: false });

    writeUnit(vfs, 'webapp', [
      '[Unit]', 'Description=Web App',
      'Requires=database.service', 'Wants=cache.service',
      'After=database.service cache.service', 'Conflicts=maintenance.service',
      '[Service]', 'ExecStart=/usr/bin/webapp', '[Install]', 'WantedBy=multi-user.target',
    ].join('\n'));
    writeUnit(vfs, 'database', ['[Unit]', 'Description=DB', '[Service]', 'ExecStart=/usr/bin/db'].join('\n'));
    writeUnit(vfs, 'cache', [
      '[Unit]', 'Description=Cache', 'Requires=storage.service',
      '[Service]', 'ExecStart=/usr/bin/cache',
    ].join('\n'));
    writeUnit(vfs, 'storage', ['[Unit]', 'Description=Storage', '[Service]', 'ExecStart=/usr/bin/storage'].join('\n'));
    writeUnit(vfs, 'maintenance', ['[Unit]', 'Description=Maint', '[Service]', 'ExecStart=/usr/bin/maint'].join('\n'));
    writeUnit(vfs, 'logger', [
      '[Unit]', 'Description=Logger', 'PartOf=webapp.service', 'BindsTo=webapp.service',
      '[Service]', 'ExecStart=/usr/bin/logger',
    ].join('\n'));
    sm.daemonReload();
  });

  it('parses Requires/Wants edges (normalised to unit names)', () => {
    const graph = new DependencyGraph(sm.list());
    expect(graph.edges('webapp', 'requires')).toEqual(['database']);
    expect(graph.edges('webapp', 'wants')).toEqual(['cache']);
  });

  it('parses After/Before ordering edges', () => {
    const graph = new DependencyGraph(sm.list());
    expect(graph.edges('webapp', 'after').sort()).toEqual(['cache', 'database']);
  });

  it('parses Conflicts, PartOf and BindsTo edges', () => {
    const graph = new DependencyGraph(sm.list());
    expect(graph.edges('webapp', 'conflicts')).toEqual(['maintenance']);
    expect(graph.edges('logger', 'partOf')).toEqual(['webapp']);
    expect(graph.edges('logger', 'bindsTo')).toEqual(['webapp']);
  });

  it('returns an empty list for a unit with no edge of that kind', () => {
    const graph = new DependencyGraph(sm.list());
    expect(graph.edges('database', 'requires')).toEqual([]);
  });

  it('computes the transitive activation closure (Requires + Wants + BindsTo)', () => {
    const graph = new DependencyGraph(sm.list());
    const closure = graph.activationClosure('webapp');
    expect(closure.has('database')).toBe(true);
    expect(closure.has('cache')).toBe(true);
    expect(closure.has('storage')).toBe(true);
    expect(closure.has('webapp')).toBe(true);
    expect(closure.has('maintenance')).toBe(false);
  });

  it('activation closure of a leaf unit is just itself', () => {
    const graph = new DependencyGraph(sm.list());
    expect([...graph.activationClosure('storage')]).toEqual(['storage']);
  });

  it('reverse activation deps: units that Require or BindTo a target', () => {
    const graph = new DependencyGraph(sm.list());
    expect(graph.activeDependents('database')).toContain('webapp');
    expect(graph.activeDependents('webapp')).toContain('logger');
    expect(graph.activeDependents('cache')).not.toContain('webapp');
  });

  it('does not loop on a dependency cycle in the closure', () => {
    writeUnit(vfs, 'ping', ['[Unit]', 'Requires=pong.service', '[Service]', 'ExecStart=/bin/ping'].join('\n'));
    writeUnit(vfs, 'pong', ['[Unit]', 'Requires=ping.service', '[Service]', 'ExecStart=/bin/pong'].join('\n'));
    sm.daemonReload();
    const graph = new DependencyGraph(sm.list());
    const closure = graph.activationClosure('ping');
    expect(closure.has('ping')).toBe(true);
    expect(closure.has('pong')).toBe(true);
  });
});
