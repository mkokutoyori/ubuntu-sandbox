import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxProcessManager } from '@/network/devices/linux/LinuxProcessManager';
import { LinuxServiceManager } from '@/network/devices/linux/LinuxServiceManager';
import { DependencyGraph } from '@/network/devices/linux/systemd/DependencyGraph';
import { SystemdJobEngine } from '@/network/devices/linux/systemd/SystemdJobEngine';

const UNIT_DIR = '/usr/lib/systemd/system';

function writeUnit(vfs: VirtualFileSystem, name: string, body: string): void {
  vfs.writeFile(`${UNIT_DIR}/${name}.service`, body, 0, 0, 0o644);
}

function buildStack(units: Record<string, string>) {
  const vfs = new VirtualFileSystem();
  const pm = new LinuxProcessManager();
  const sm = new LinuxServiceManager(vfs, pm, { isServer: false });
  for (const [name, body] of Object.entries(units)) writeUnit(vfs, name, body);
  sm.daemonReload();
  return { vfs, pm, sm };
}

describe('SystemdJobEngine — start transaction (dependency-ordered)', () => {
  let activated: string[];
  let engine: SystemdJobEngine;

  function recordingEngine(sm: LinuxServiceManager): SystemdJobEngine {
    activated = [];
    return new SystemdJobEngine({
      graph: () => new DependencyGraph(sm.list()),
      isActive: (n) => sm.isActive(n),
      exists: (n) => sm.status(n) !== null,
      activate: (n) => { activated.push(n); return { ok: true }; },
      deactivate: () => ({ ok: true }),
    });
  }

  beforeEach(() => { activated = []; });

  it('activates a required dependency before the requesting unit', () => {
    const { sm } = buildStack({
      app: ['[Unit]', 'Requires=db.service', 'After=db.service', '[Service]', 'ExecStart=/x'].join('\n'),
      db: ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'),
    });
    engine = recordingEngine(sm);

    const result = engine.start('app');

    expect(result.ok).toBe(true);
    expect(activated).toEqual(['db', 'app']);
  });

  it('pulls in Wants dependencies as well', () => {
    const { sm } = buildStack({
      app: ['[Unit]', 'Wants=cache.service', 'After=cache.service', '[Service]', 'ExecStart=/x'].join('\n'),
      cache: ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'),
    });
    engine = recordingEngine(sm);

    engine.start('app');

    expect(activated).toEqual(['cache', 'app']);
  });

  it('resolves a transitive chain in order', () => {
    const { sm } = buildStack({
      app: ['[Unit]', 'Requires=mid.service', 'After=mid.service', '[Service]', 'ExecStart=/x'].join('\n'),
      mid: ['[Unit]', 'Requires=base.service', 'After=base.service', '[Service]', 'ExecStart=/x'].join('\n'),
      base: ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'),
    });
    engine = recordingEngine(sm);

    engine.start('app');

    expect(activated).toEqual(['base', 'mid', 'app']);
  });

  it('does not re-activate a unit that is already active', () => {
    const { sm } = buildStack({
      app: ['[Unit]', 'Requires=db.service', 'After=db.service', '[Service]', 'ExecStart=/x'].join('\n'),
      db: ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'),
    });
    sm.start('db');
    engine = recordingEngine(sm);

    engine.start('app');

    expect(activated).toEqual(['app']);
  });

  it('skips ordering-only (After) units that are not pulled in as dependencies', () => {
    const { sm } = buildStack({
      app: ['[Unit]', 'After=other.service', '[Service]', 'ExecStart=/x'].join('\n'),
      other: ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'),
    });
    engine = recordingEngine(sm);

    engine.start('app');

    expect(activated).toEqual(['app']);
  });

  it('fails the transaction when an ordering cycle is present among pulled units', () => {
    const { sm } = buildStack({
      a: ['[Unit]', 'Requires=b.service', 'After=b.service', '[Service]', 'ExecStart=/x'].join('\n'),
      b: ['[Unit]', 'Requires=a.service', 'After=a.service', '[Service]', 'ExecStart=/x'].join('\n'),
    });
    engine = recordingEngine(sm);

    const result = engine.start('a');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cycle/i);
    expect(activated).toEqual([]);
  });
});

describe('systemctl start — integration through LinuxServiceManager', () => {
  it('starting a unit brings up its Requires and Wants dependencies', () => {
    const { sm } = buildStack({
      webapp: ['[Unit]', 'Requires=database.service', 'Wants=cache.service',
        'After=database.service cache.service', '[Service]', 'ExecStart=/x'].join('\n'),
      database: ['[Unit]', '[Service]', 'ExecStart=/usr/bin/db'].join('\n'),
      cache: ['[Unit]', '[Service]', 'ExecStart=/usr/bin/cache'].join('\n'),
    });

    expect(sm.isActive('webapp')).toBe(false);
    const result = sm.start('webapp');

    expect(result.ok).toBe(true);
    expect(sm.isActive('webapp')).toBe(true);
    expect(sm.isActive('database')).toBe(true);
    expect(sm.isActive('cache')).toBe(true);
    expect(sm.status('database')!.mainPid).toBeDefined();
  });

  it('a plain unit with no dependencies still starts exactly as before', () => {
    const { sm } = buildStack({
      solo: ['[Unit]', '[Service]', 'ExecStart=/usr/bin/solo'].join('\n'),
    });

    const result = sm.start('solo');

    expect(result.ok).toBe(true);
    expect(sm.isActive('solo')).toBe(true);
  });
});
