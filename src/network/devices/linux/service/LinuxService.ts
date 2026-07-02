/**
 * LinuxService — Linux-flavoured {@link OSService}.
 *
 * Adds systemd-specific behaviour on top of the cross-OS base:
 *   - `props` is mandatory-shaped (no undefined access)
 *   - `wantsAutoRestart` honours the Linux subset of restart policies
 *   - DEFAULT_SHOW_KEYS for `systemctl show <unit>` formatting
 *   - structurally compatible with the legacy ServiceUnit interface
 *
 * State transitions stay in {@link LinuxServiceManager} (aggregate
 * root + event publisher).
 */

import { OSService } from '../../os/OSService';
import type {
  ServiceUnit, ServiceType, ServiceState, EnabledState, RestartPolicy,
} from '../LinuxServiceManager';

const AUTO_RESTART: ReadonlySet<RestartPolicy> = new Set<RestartPolicy>([
  'always', 'on-failure', 'on-abnormal',
]);

export class LinuxService extends OSService implements ServiceUnit {
  // Re-declare with the Linux-specific narrowed types from the legacy
  // ServiceUnit interface, so existing consumers stay type-safe.
  declare type: ServiceType;
  declare state: ServiceState;
  declare enabled: EnabledState;
  declare restart: RestartPolicy;
  dynamicUser: boolean;

  constructor(init: ServiceUnit) {
    super({
      name: init.name,
      description: init.description,
      type: init.type as ServiceType,
      execStart: init.execStart,
      execStop: init.execStop,
      execReload: init.execReload,
      user: init.user,
      group: init.group,
      wantedBy: init.wantedBy,
      wants: init.wants,
      after: init.after,
      before: init.before,
      requires: init.requires,
      bindsTo: init.bindsTo,
      partOf: init.partOf,
      conflicts: init.conflicts,
      restart: init.restart as RestartPolicy,
      loadedFrom: init.loadedFrom,
      state: init.state as ServiceState,
      enabled: init.enabled as EnabledState,
      props: init.props,
    });
    if (init.mainPid !== undefined) this.mainPid = init.mainPid;
    if (init.activeSince !== undefined) this.activeSince = init.activeSince;
    this.dynamicUser = init.dynamicUser ?? false;
  }

  /** Linux supervisor only resurrects these three restart policies. */
  wantsAutoRestart(): boolean { return AUTO_RESTART.has(this.restart); }

  /** A reasonable default property set for `systemctl show <unit>`. */
  static readonly DEFAULT_SHOW_KEYS = [
    'Id', 'Description', 'LoadState', 'ActiveState', 'SubState',
    'UnitFileState', 'MainPID', 'Type', 'User', 'ExecStart', 'Restart',
    'FragmentPath',
  ];

  /**
   * Persist a runtime resource-control override (systemctl set-property).
   * Mirrors well-known keys into typed fields via the base implementation.
   */
  override setProperty(key: string, value: string): void {
    super.setProperty(key, value);
  }

  /** Plain ServiceUnit-shaped snapshot for telemetry / UI projections. */
  snapshot(): ServiceUnit {
    return { ...this } as unknown as ServiceUnit;
  }
}
