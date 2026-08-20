import { describe, it, expect } from 'vitest';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxProcessManager } from '@/network/devices/linux/LinuxProcessManager';
import { LinuxServiceManager } from '@/network/devices/linux/LinuxServiceManager';
import { cmdSystemctl } from '@/network/devices/linux/LinuxProcessCommands';
import { DependencyGraph } from '@/network/devices/linux/systemd/DependencyGraph';
import { SystemdJobEngine } from '@/network/devices/linux/systemd/SystemdJobEngine';
import { renderDependencyTree } from '@/network/devices/linux/systemd/DependencyTree';
import type { OperationResult } from '@/network/devices/linux/systemd/JobTypes';

const UNIT_DIR = '/usr/lib/systemd/system';
const ETC_DIR = '/etc/systemd/system';

function unitFile(name: string): string {
  return name.endsWith('.target') ? name : `${name}.service`;
}

function buildStack(units: Record<string, string>) {
  const vfs = new VirtualFileSystem();
  const sm = new LinuxServiceManager(vfs, new LinuxProcessManager(), { isServer: false });
  for (const [name, body] of Object.entries(units)) {
    vfs.writeFile(`${UNIT_DIR}/${unitFile(name)}`, body, 0, 0, 0o644);
  }
  sm.daemonReload();
  return { vfs, sm };
}

const SERVICE_BODY = ['[Unit]', '[Service]', 'ExecStart=/x'].join('\n');

describe('systemd targets — loading and activation', () => {
  it('loads .target unit files as first-class units', () => {
    const { sm } = buildStack({
      'apps.target': ['[Unit]', 'Description=App Stack'].join('\n'),
    });

    const u = sm.status('apps.target');

    expect(u).not.toBeNull();
    expect(u!.description).toBe('App Stack');
  });

  it('starting a target pulls its Wants and Requires members', () => {
    const { sm } = buildStack({
      'apps.target': ['[Unit]', 'Wants=web.service', 'Requires=db.service'].join('\n'),
      web: SERVICE_BODY,
      db: SERVICE_BODY,
    });

    const result = sm.start('apps.target');

    expect(result.ok).toBe(true);
    expect(sm.isActive('apps.target')).toBe(true);
    expect(sm.isActive('web')).toBe(true);
    expect(sm.isActive('db')).toBe(true);
  });

  it('an active target has no main process', () => {
    const { sm } = buildStack({
      'apps.target': ['[Unit]', 'Description=App Stack'].join('\n'),
    });

    sm.start('apps.target');

    expect(sm.status('apps.target')!.mainPid).toBeUndefined();
  });

  it('a failing Wants member does not fail the target', () => {
    const { sm } = buildStack({
      'apps.target': ['[Unit]', 'Wants=web.service'].join('\n'),
      web: SERVICE_BODY,
    });
    sm.registerConfigCheck('web', () => ({ ok: false, error: 'broken' }));

    const result = sm.start('apps.target');

    expect(result.ok).toBe(true);
    expect(sm.isActive('apps.target')).toBe(true);
    expect(sm.status('web')!.state).toBe('failed');
  });

  it('a failing Requires member fails the target', () => {
    const { sm } = buildStack({
      'apps.target': ['[Unit]', 'Requires=db.service'].join('\n'),
      db: SERVICE_BODY,
    });
    sm.registerConfigCheck('db', () => ({ ok: false, error: 'broken' }));

    const result = sm.start('apps.target');

    expect(result.ok).toBe(false);
    expect(sm.isActive('apps.target')).toBe(false);
  });

  it('units symlinked in <target>.wants are pulled in when the target starts', () => {
    const { vfs, sm } = buildStack({
      'apps.target': ['[Unit]', 'Description=App Stack'].join('\n'),
      web: SERVICE_BODY,
    });
    vfs.mkdirp(`${ETC_DIR}/apps.target.wants`, 0o755, 0, 0);
    vfs.createSymlink(`${ETC_DIR}/apps.target.wants/web.service`, `${UNIT_DIR}/web.service`, 0, 0);

    sm.start('apps.target');

    expect(sm.isActive('web')).toBe(true);
  });

  it('the default target chain is active after boot', () => {
    const { sm } = buildStack({});

    expect(sm.status('multi-user.target')!.state).toBe('active');
    expect(sm.status('graphical.target')!.state).toBe('active');
  });

  it('an enabled unit is pulled in by starting multi-user.target', () => {
    const { sm } = buildStack({ web: SERVICE_BODY });
    sm.enable('web');
    expect(sm.isActive('web')).toBe(false);

    sm.stop('multi-user.target');
    const result = sm.start('multi-user.target');

    expect(result.ok).toBe(true);
    expect(sm.isActive('web')).toBe(true);
  });
});

describe('SystemdJobEngine — isolate', () => {
  function recordingEngine(sm: LinuxServiceManager, activeSeed: string[], log: { activated: string[]; deactivated: string[] }): SystemdJobEngine {
    const active = new Set(activeSeed);
    return new SystemdJobEngine({
      graph: () => new DependencyGraph(sm.list()),
      isActive: (n) => active.has(n),
      exists: (n) => sm.status(n) !== null,
      activate: (n): OperationResult => { active.add(n); log.activated.push(n); return { ok: true }; },
      deactivate: (n): OperationResult => { active.delete(n); log.deactivated.push(n); return { ok: true }; },
    });
  }

  it('stops active units outside the target closure and keeps members running', () => {
    const { sm } = buildStack({
      'apps.target': ['[Unit]', 'Requires=web.service'].join('\n'),
      web: SERVICE_BODY,
      stray: SERVICE_BODY,
    });
    const log = { activated: [] as string[], deactivated: [] as string[] };
    const engine = recordingEngine(sm, ['web', 'stray'], log);

    const result = engine.isolate('apps.target');

    expect(result.ok).toBe(true);
    expect(log.deactivated).toContain('stray');
    expect(log.deactivated).not.toContain('web');
    expect(log.activated).toEqual(['apps.target']);
  });
});

describe('systemctl isolate — integration', () => {
  const ISOLATABLE = ['[Unit]', 'Requires=web.service', 'AllowIsolate=yes'].join('\n');

  it('refuses a unit without AllowIsolate=yes', () => {
    const { sm } = buildStack({
      'apps.target': ['[Unit]', 'Requires=web.service'].join('\n'),
      web: SERVICE_BODY,
    });

    const result = sm.isolate('apps.target');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Operation refused/);
  });

  it('switches the running set to the target closure', () => {
    const { sm } = buildStack({
      'apps.target': ISOLATABLE,
      web: SERVICE_BODY,
      stray: SERVICE_BODY,
    });
    sm.start('stray');

    const result = sm.isolate('apps.target');

    expect(result.ok).toBe(true);
    expect(sm.isActive('apps.target')).toBe(true);
    expect(sm.isActive('web')).toBe(true);
    expect(sm.isActive('stray')).toBe(false);
  });

  it('is exposed through systemctl isolate', () => {
    const { sm } = buildStack({
      'apps.target': ISOLATABLE,
      web: SERVICE_BODY,
      stray: SERVICE_BODY,
    });
    sm.start('stray');

    const out = cmdSystemctl(['isolate', 'apps.target'], sm);

    expect(out.exitCode).toBe(0);
    expect(sm.isActive('web')).toBe(true);
    expect(sm.isActive('stray')).toBe(false);
  });

  it('reports the refusal through systemctl', () => {
    const { sm } = buildStack({
      'apps.target': ['[Unit]', 'Requires=web.service'].join('\n'),
      web: SERVICE_BODY,
    });

    const out = cmdSystemctl(['isolate', 'apps.target'], sm);

    expect(out.exitCode).toBe(1);
    expect(out.output).toContain('Failed to isolate');
  });
});

describe('systemctl list-dependencies — recursive tree', () => {
  it('renders the requirement tree recursively', () => {
    const { sm } = buildStack({
      app: ['[Unit]', 'Requires=db.service', 'Wants=cache.service', '[Service]', 'ExecStart=/x'].join('\n'),
      db: ['[Unit]', 'Requires=storage.service', '[Service]', 'ExecStart=/x'].join('\n'),
      storage: SERVICE_BODY,
      cache: SERVICE_BODY,
    });

    const out = cmdSystemctl(['list-dependencies', 'app'], sm);

    expect(out.exitCode).toBe(0);
    expect(out.output).toBe([
      'app.service',
      '● ├─db.service',
      '● │ └─storage.service',
      '● └─cache.service',
    ].join('\n'));
  });

  it('defaults to the default target when no unit is given', () => {
    const { sm } = buildStack({});

    const out = cmdSystemctl(['list-dependencies'], sm);

    expect(out.exitCode).toBe(0);
    expect(out.output.startsWith('graphical.target')).toBe(true);
  });

  it('shows wants-dir links under the target', () => {
    const { sm } = buildStack({ web: SERVICE_BODY });
    sm.enable('web');

    const out = cmdSystemctl(['list-dependencies', 'multi-user.target'], sm);

    expect(out.output).toContain('─web.service');
  });

  it('fails on an unknown unit', () => {
    const { sm } = buildStack({});

    const out = cmdSystemctl(['list-dependencies', 'nosuch'], sm);

    expect(out.exitCode).toBe(1);
    expect(out.output).toContain('not found');
  });

  it('guards against dependency cycles', () => {
    const { sm } = buildStack({
      a: ['[Unit]', 'Requires=b.service', '[Service]', 'ExecStart=/x'].join('\n'),
      b: ['[Unit]', 'Requires=a.service', '[Service]', 'ExecStart=/x'].join('\n'),
    });

    const out = renderDependencyTree('a', sm.dependencyGraph());

    expect(out.split('\n').length).toBeLessThan(6);
  });
});
