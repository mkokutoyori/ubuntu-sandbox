/**
 * PRD-Windows-Server.md §5 P2 — RoleManager unit tests (no PowerShell layer).
 * Exercises install/uninstall against the real WindowsServiceManager, and
 * dependency-injects a synthetic catalog to prove the mechanism generically
 * (the real featureCatalog roles are flat/independent — see its docstring).
 */
import { describe, it, expect } from 'vitest';
import { WindowsServiceManager } from '@/network/devices/windows/WindowsServiceManager';
import { RoleManager } from '@/network/devices/windows/server/RoleManager';
import { WINDOWS_FEATURE_CATALOG } from '@/network/devices/windows/server/featureCatalog';
import type { WindowsFeatureDef } from '@/network/devices/windows/server/featureCatalog';

describe('RoleManager — real feature catalog', () => {
  it('every feature starts Available', () => {
    const rm = new RoleManager(new WindowsServiceManager());
    for (const f of rm.listFeatures()) {
      expect(f.installState).toBe('Available');
    }
    expect(rm.listFeatures().map(f => f.name)).toContain('FS-FileServer');
  });

  it('install FS-FileServer ensures LanmanServer is Running without recreating it', () => {
    const svc = new WindowsServiceManager();
    const before = svc.getService('LanmanServer');
    expect(before?.builtIn).toBe(true);
    const rm = new RoleManager(svc);

    const res = rm.install('FS-FileServer');
    expect(res.ok).toBe(true);
    expect(rm.getFeature('FS-FileServer')?.installState).toBe('Installed');
    expect(svc.getService('LanmanServer')?.state).toBe('Running');
    expect(svc.getService('LanmanServer')?.builtIn).toBe(true);
  });

  it('install DNS creates and starts a new DNS service', () => {
    const svc = new WindowsServiceManager();
    expect(svc.getService('DNS')).toBeUndefined();
    const rm = new RoleManager(svc);

    rm.install('DNS');
    const dns = svc.getService('DNS');
    expect(dns).toBeDefined();
    expect(dns?.state).toBe('Running');
    expect(dns?.builtIn).toBe(false);
  });

  it('uninstall DNS stops and removes the role-owned service', () => {
    const svc = new WindowsServiceManager();
    const rm = new RoleManager(svc);
    rm.install('DNS');
    rm.uninstall('DNS');
    expect(rm.getFeature('DNS')?.installState).toBe('Available');
    expect(svc.getService('DNS')).toBeUndefined();
  });

  it('uninstall FS-FileServer never deletes the built-in LanmanServer service', () => {
    const svc = new WindowsServiceManager();
    const rm = new RoleManager(svc);
    rm.install('FS-FileServer');
    rm.uninstall('FS-FileServer');
    expect(rm.getFeature('FS-FileServer')?.installState).toBe('Available');
    expect(svc.getService('LanmanServer')).toBeDefined();
  });

  it('install with -IncludeManagementTools also installs the companion RSAT feature', () => {
    const rm = new RoleManager(new WindowsServiceManager());
    const res = rm.install('AD-Domain-Services', { includeManagementTools: true });
    expect(res.ok).toBe(true);
    expect(rm.getFeature('AD-Domain-Services')?.installState).toBe('Installed');
    expect(rm.getFeature('RSAT-AD-PowerShell')?.installState).toBe('Installed');
  });

  it('installing AD-Domain-Services without the flag leaves RSAT uninstalled', () => {
    const rm = new RoleManager(new WindowsServiceManager());
    rm.install('AD-Domain-Services');
    expect(rm.getFeature('RSAT-AD-PowerShell')?.installState).toBe('Available');
  });

  it('installing an unknown feature name fails without touching services', () => {
    const rm = new RoleManager(new WindowsServiceManager());
    const res = rm.install('Not-A-Real-Feature');
    expect(res.ok).toBe(false);
    expect(res.changed).toEqual([]);
  });

  it('install/uninstall refuse when isAdmin is false', () => {
    const svc = new WindowsServiceManager();
    const rm = new RoleManager(svc);
    const res = rm.install('DNS', {}, false);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/access is denied/i);
    expect(svc.getService('DNS')).toBeUndefined();

    rm.install('DNS', {}, true);
    const res2 = rm.uninstall('DNS', false);
    expect(res2.ok).toBe(false);
    expect(svc.getService('DNS')).toBeDefined();
  });

  it('re-installing an already-installed feature is a no-op (idempotent)', () => {
    const svc = new WindowsServiceManager();
    const rm = new RoleManager(svc);
    rm.install('DNS');
    const res = rm.install('DNS');
    expect(res.changed).toEqual([]);
  });

  it('the real catalog names match every PRD §2.1.2 role plus the RSAT tool feature and every PRD-Windows-Server-Advanced.md additive role', () => {
    const names = WINDOWS_FEATURE_CATALOG.map(f => f.name).sort();
    expect(names).toEqual([
      'AD-Domain-Services', 'DHCP', 'DNS', 'FS-FileServer',
      'NPAS', 'Print-Services', 'RSAT-AD-PowerShell', 'Web-Server',
      'AD-Certificate', 'FS-DFS-Namespace', 'FS-DFS-Replication', 'Failover-Clustering', 'UpdateServices',
    ].sort());
  });
});

describe('RoleManager — synthetic catalog (proves generic dependency-free install/uninstall)', () => {
  const CATALOG: readonly WindowsFeatureDef[] = [
    { name: 'Foo-Role', displayName: 'Foo Role', featureType: 'Role', services: ['FooSvc'] },
    { name: 'Bar-Role', displayName: 'Bar Role', featureType: 'Role', services: [] },
  ];

  it('lists exactly the injected catalog', () => {
    const rm = new RoleManager(new WindowsServiceManager(), CATALOG);
    expect(rm.listFeatures().map(f => f.name)).toEqual(['Foo-Role', 'Bar-Role']);
  });

  it('a feature with no services installs/uninstalls cleanly', () => {
    const rm = new RoleManager(new WindowsServiceManager(), CATALOG);
    expect(rm.install('Bar-Role').ok).toBe(true);
    expect(rm.getFeature('Bar-Role')?.installState).toBe('Installed');
    expect(rm.uninstall('Bar-Role').ok).toBe(true);
    expect(rm.getFeature('Bar-Role')?.installState).toBe('Available');
  });
});
