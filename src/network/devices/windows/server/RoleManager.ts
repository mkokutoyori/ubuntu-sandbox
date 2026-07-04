/**
 * RoleManager — Server Manager's role/feature model (PRD-Windows-Server.md
 * §5 P2). Tracks install state for the features in `featureCatalog` and
 * wires each feature's install/uninstall to real `WindowsServiceManager`
 * entries, so `Get-Service`/`sc query` agree with `Get-WindowsFeature`
 * about what's running.
 *
 * Only `WindowsServer` owns an instance — `WindowsPC.getRoleManager()`
 * returns null, which is what makes `Get/Install/Uninstall-WindowsFeature`
 * fall through to the "not recognized" cmdlet-not-found path on a client,
 * exactly like real Windows (the ServerManager module ships on Server only).
 */

import type { WindowsServiceManager, ServiceStartType } from '../WindowsServiceManager';
import { WINDOWS_FEATURE_CATALOG, type WindowsFeatureDef } from './featureCatalog';

export type FeatureInstallState = 'Installed' | 'Available';

export interface WindowsFeatureView {
  readonly name: string;
  readonly displayName: string;
  readonly installState: FeatureInstallState;
  readonly psModule?: string;
}

export interface FeatureOpResult {
  readonly ok: boolean;
  readonly message: string;
  readonly changed: readonly WindowsFeatureView[];
}

const ROLE_SERVICE_START_TYPE: ServiceStartType = 'Automatic';

export class RoleManager {
  private readonly installed = new Set<string>();

  constructor(
    private readonly services: WindowsServiceManager,
    private readonly catalog: readonly WindowsFeatureDef[] = WINDOWS_FEATURE_CATALOG,
  ) {}

  private find(name: string): WindowsFeatureDef | undefined {
    const lower = name.toLowerCase();
    return this.catalog.find(f => f.name.toLowerCase() === lower);
  }

  private toView(f: WindowsFeatureDef): WindowsFeatureView {
    return {
      name: f.name,
      displayName: f.displayName,
      installState: this.installed.has(f.name.toLowerCase()) ? 'Installed' : 'Available',
      psModule: f.psModule,
    };
  }

  isInstalled(name: string): boolean {
    const f = this.find(name);
    return f !== undefined && this.installed.has(f.name.toLowerCase());
  }

  listFeatures(): WindowsFeatureView[] {
    return this.catalog.map(f => this.toView(f));
  }

  getFeature(name: string): WindowsFeatureView | null {
    const f = this.find(name);
    return f ? this.toView(f) : null;
  }

  /**
   * Bring up the service(s) a feature needs. Built-in services (LanmanServer,
   * Spooler) already exist on every device — just ensure Running/Automatic.
   * Role-only services (NTDS, DNS, DHCPServer, IAS, W3SVC…) are created here.
   */
  private bringUpService(name: string, isAdmin: boolean): void {
    const existing = this.services.getService(name);
    if (!existing) {
      this.services.createService(name, {
        binaryPath: `C:\\Windows\\System32\\svchost.exe -k ${name.toLowerCase()}`,
        startType: ROLE_SERVICE_START_TYPE,
      }, isAdmin);
    } else if (existing.startType !== ROLE_SERVICE_START_TYPE) {
      this.services.setStartType(name, ROLE_SERVICE_START_TYPE, isAdmin);
    }
    this.services.startService(name, isAdmin);
  }

  /** Stop/remove a role's service — but never touch OS built-ins a role doesn't own exclusively. */
  private retireService(name: string, isAdmin: boolean): void {
    const svc = this.services.getService(name);
    if (!svc || svc.builtIn) return;
    this.services.stopService(name, isAdmin);
    this.services.deleteService(name, isAdmin);
  }

  install(
    name: string,
    opts: { includeManagementTools?: boolean } = {},
    isAdmin: boolean = true,
  ): FeatureOpResult {
    const f = this.find(name);
    if (!f) {
      return {
        ok: false,
        message: `Install-WindowsFeature : The term '${name}' is not a recognized Windows feature name.`,
        changed: [],
      };
    }
    if (!isAdmin) {
      return { ok: false, message: 'Install-WindowsFeature : Access is denied.', changed: [] };
    }
    const changed: WindowsFeatureDef[] = [];
    if (!this.installed.has(f.name.toLowerCase())) {
      this.installed.add(f.name.toLowerCase());
      for (const svcName of f.services) this.bringUpService(svcName, isAdmin);
      changed.push(f);
    }
    if (opts.includeManagementTools && f.managementToolsFeature) {
      const mgmt = this.find(f.managementToolsFeature);
      if (mgmt && !this.installed.has(mgmt.name.toLowerCase())) {
        this.installed.add(mgmt.name.toLowerCase());
        for (const svcName of mgmt.services) this.bringUpService(svcName, isAdmin);
        changed.push(mgmt);
      }
    }
    return { ok: true, message: 'Success', changed: changed.map(c => this.toView(c)) };
  }

  uninstall(name: string, isAdmin: boolean = true): FeatureOpResult {
    const f = this.find(name);
    if (!f) {
      return {
        ok: false,
        message: `Uninstall-WindowsFeature : The term '${name}' is not a recognized Windows feature name.`,
        changed: [],
      };
    }
    if (!isAdmin) {
      return { ok: false, message: 'Uninstall-WindowsFeature : Access is denied.', changed: [] };
    }
    if (!this.installed.has(f.name.toLowerCase())) {
      return { ok: true, message: 'Success', changed: [] };
    }
    this.installed.delete(f.name.toLowerCase());
    for (const svcName of f.services) this.retireService(svcName, isAdmin);
    return { ok: true, message: 'Success', changed: [this.toView(f)] };
  }
}
