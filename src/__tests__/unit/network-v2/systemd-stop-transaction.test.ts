import { describe, it, expect } from 'vitest';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxProcessManager } from '@/network/devices/linux/LinuxProcessManager';
import { LinuxServiceManager } from '@/network/devices/linux/LinuxServiceManager';
import { DependencyGraph } from '@/network/devices/linux/systemd/DependencyGraph';
import { SystemdJobEngine } from '@/network/devices/linux/systemd/SystemdJobEngine';
import type { OperationResult } from '@/network/devices/linux/systemd/JobTypes';

const UNIT_DIR = '/usr/lib/systemd/system';

function writeUnit(vfs: VirtualFileSystem, name: string, body: string): void {
  vfs.writeFile(`${UNIT_DIR}/${name}.service`, body, 0, 0, 0o644);
}

function buildStack(units: Record<string, string>) {
  const vfs = new VirtualFileSystem();
  const sm = new LinuxServiceManager(vfs, new LinuxProcessManager(), { isServer: false });
  for (const [name, body] of Object.entries(units)) writeUnit(vfs, name, body);
  sm.daemonReload();
  return { vfs, sm };
}

function recordingEngine(sm: LinuxServiceManager, activeSeed: string[], deactivated: string[]): SystemdJobEngine {
  const active = new Set(activeSeed);
  return new SystemdJobEngine({
    graph: () => new DependencyGraph(sm.list()),
    isActive: (n) => active.has(n),
    exists: (n) => sm.status(n) !== null,
    activate: (n): OperationResult => { active.add(n); return { ok: true }; },
    deactivate: (n): OperationResult => { active.delete(n); deactivated.push(n); return { ok: true }; },
  });
}

describe('SystemdJobEngine — stop transaction (reverse propagation)', () => {
  it('stops a unit that Requires the target, before the target', () => {
    const { sm } = buildStack({
      app: ['[Unit]', 'Requires=db.service', 'After=db.service', '[Service]', 'ExecStart=/x'].join('\n'),
      db: ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'),
    });
    const deactivated: string[] = [];
    const engine = recordingEngine(sm, ['app', 'db'], deactivated);

    engine.stop('db');

    expect(deactivated).toEqual(['app', 'db']);
  });

  it('propagates a stop to PartOf members', () => {
    const { sm } = buildStack({
      web: ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'),
      logger: ['[Unit]', 'PartOf=web.service', '[Service]', 'ExecStart=/x'].join('\n'),
    });
    const deactivated: string[] = [];
    const engine = recordingEngine(sm, ['web', 'logger'], deactivated);

    engine.stop('web');

    expect(deactivated).toContain('logger');
    expect(deactivated).toContain('web');
    expect(deactivated.indexOf('logger')).toBeLessThan(deactivated.indexOf('web'));
  });

  it('propagates transitively up a Requires chain', () => {
    const { sm } = buildStack({
      app: ['[Unit]', 'Requires=mid.service', 'After=mid.service', '[Service]', 'ExecStart=/x'].join('\n'),
      mid: ['[Unit]', 'Requires=base.service', 'After=base.service', '[Service]', 'ExecStart=/x'].join('\n'),
      base: ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'),
    });
    const deactivated: string[] = [];
    const engine = recordingEngine(sm, ['app', 'mid', 'base'], deactivated);

    engine.stop('base');

    expect(deactivated).toEqual(['app', 'mid', 'base']);
  });

  it('does not stop a Wants dependent when its wanted unit stops', () => {
    const { sm } = buildStack({
      app: ['[Unit]', 'Wants=cache.service', 'After=cache.service', '[Service]', 'ExecStart=/x'].join('\n'),
      cache: ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'),
    });
    const deactivated: string[] = [];
    const engine = recordingEngine(sm, ['app', 'cache'], deactivated);

    engine.stop('cache');

    expect(deactivated).toEqual(['cache']);
  });

  it('only stops active units in the propagation set', () => {
    const { sm } = buildStack({
      app: ['[Unit]', 'Requires=db.service', 'After=db.service', '[Service]', 'ExecStart=/x'].join('\n'),
      db: ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'),
    });
    const deactivated: string[] = [];
    const engine = recordingEngine(sm, ['db'], deactivated);

    engine.stop('db');

    expect(deactivated).toEqual(['db']);
  });
});

describe('systemctl stop — integration through LinuxServiceManager', () => {
  it('stopping a required unit also stops the units that require it', () => {
    const { sm } = buildStack({
      webapp: ['[Unit]', 'Requires=database.service', 'After=database.service', '[Service]', 'ExecStart=/usr/bin/webapp'].join('\n'),
      database: ['[Unit]', '[Service]', 'ExecStart=/usr/bin/db'].join('\n'),
    });
    sm.start('webapp');
    expect(sm.isActive('webapp')).toBe(true);
    expect(sm.isActive('database')).toBe(true);

    const result = sm.stop('database');

    expect(result.ok).toBe(true);
    expect(sm.isActive('database')).toBe(false);
    expect(sm.isActive('webapp')).toBe(false);
  });

  it('stopping a standalone unit leaves unrelated units running', () => {
    const { sm } = buildStack({
      one: ['[Unit]', '[Service]', 'ExecStart=/usr/bin/one'].join('\n'),
      two: ['[Unit]', '[Service]', 'ExecStart=/usr/bin/two'].join('\n'),
    });
    sm.start('one');
    sm.start('two');

    sm.stop('one');

    expect(sm.isActive('one')).toBe(false);
    expect(sm.isActive('two')).toBe(true);
  });
});
