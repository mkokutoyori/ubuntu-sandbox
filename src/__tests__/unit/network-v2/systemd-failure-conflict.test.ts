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

function engineOver(sm: LinuxServiceManager, opts: {
  failing?: Set<string>;
  activated?: string[];
  deactivated?: string[];
}): SystemdJobEngine {
  const active = new Set<string>();
  return new SystemdJobEngine({
    graph: () => new DependencyGraph(sm.list()),
    isActive: (n) => active.has(n),
    exists: (n) => sm.status(n) !== null,
    activate: (n): OperationResult => {
      if (opts.failing?.has(n)) return { ok: false, error: `${n} failed` };
      active.add(n);
      opts.activated?.push(n);
      return { ok: true };
    },
    deactivate: (n): OperationResult => {
      active.delete(n);
      opts.deactivated?.push(n);
      return { ok: true };
    },
  });
}

describe('SystemdJobEngine — failure propagation (Requires vs Wants)', () => {
  it('fails the dependent when a Requires dependency fails to activate', () => {
    const { sm } = buildStack({
      app: ['[Unit]', 'Requires=db.service', 'After=db.service', '[Service]', 'ExecStart=/x'].join('\n'),
      db: ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'),
    });
    const activated: string[] = [];
    const engine = engineOver(sm, { failing: new Set(['db']), activated });

    const result = engine.start('app');

    expect(result.ok).toBe(false);
    expect(activated).not.toContain('app');
  });

  it('still starts the dependent when a Wants dependency fails', () => {
    const { sm } = buildStack({
      app: ['[Unit]', 'Wants=cache.service', 'After=cache.service', '[Service]', 'ExecStart=/x'].join('\n'),
      cache: ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'),
    });
    const activated: string[] = [];
    const engine = engineOver(sm, { failing: new Set(['cache']), activated });

    const result = engine.start('app');

    expect(result.ok).toBe(true);
    expect(activated).toContain('app');
  });

  it('propagates a required failure transitively', () => {
    const { sm } = buildStack({
      app: ['[Unit]', 'Requires=mid.service', 'After=mid.service', '[Service]', 'ExecStart=/x'].join('\n'),
      mid: ['[Unit]', 'Requires=base.service', 'After=base.service', '[Service]', 'ExecStart=/x'].join('\n'),
      base: ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'),
    });
    const activated: string[] = [];
    const engine = engineOver(sm, { failing: new Set(['base']), activated });

    const result = engine.start('app');

    expect(result.ok).toBe(false);
    expect(activated).toEqual([]);
  });

  it('BindsTo behaves like Requires for failure propagation', () => {
    const { sm } = buildStack({
      app: ['[Unit]', 'BindsTo=agent.service', 'After=agent.service', '[Service]', 'ExecStart=/x'].join('\n'),
      agent: ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'),
    });
    const activated: string[] = [];
    const engine = engineOver(sm, { failing: new Set(['agent']), activated });

    expect(engine.start('app').ok).toBe(false);
    expect(activated).not.toContain('app');
  });
});

describe('SystemdJobEngine — Conflicts', () => {
  it('stops an active conflicting unit before starting', () => {
    const { sm } = buildStack({
      app: ['[Unit]', 'Conflicts=maint.service', '[Service]', 'ExecStart=/x'].join('\n'),
      maint: ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'),
    });
    const activated: string[] = [];
    const deactivated: string[] = [];
    const engine = engineOver(sm, { activated, deactivated });
    engine.start('maint');

    engine.start('app');

    expect(deactivated).toContain('maint');
    expect(activated).toContain('app');
  });

  it('is symmetric: starting a unit stops one that declares Conflicts against it', () => {
    const { sm } = buildStack({
      app: ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'),
      maint: ['[Unit]', 'Conflicts=app.service', '[Service]', 'ExecStart=/x'].join('\n'),
    });
    const deactivated: string[] = [];
    const engine = engineOver(sm, { deactivated });
    engine.start('maint');

    engine.start('app');

    expect(deactivated).toContain('maint');
  });
});

describe('systemctl start — integration: a failing Requires dependency', () => {
  it('does not activate the unit when its required dependency fails a config check', () => {
    const { sm } = buildStack({
      app: ['[Unit]', 'Requires=guard.service', 'After=guard.service', '[Service]', 'ExecStart=/x'].join('\n'),
      guard: ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n'),
    });
    sm.registerConfigCheck('guard', () => ({ ok: false, error: 'guard misconfigured' }));

    const result = sm.start('app');

    expect(result.ok).toBe(false);
    expect(sm.isActive('app')).toBe(false);
    expect(sm.status('guard')!.state).toBe('failed');
  });
});
