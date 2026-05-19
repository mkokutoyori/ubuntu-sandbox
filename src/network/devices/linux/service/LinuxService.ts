/**
 * LinuxService — the systemd **unit** entity.
 *
 * Reactive-refonte counterpart of {@link LinuxProcess}: a real object
 * that owns its declarative spec + runtime state and answers questions
 * about itself. State transitions and event emission remain in
 * {@link LinuxServiceManager} (the aggregate root) so the unit never
 * emits on its own.
 *
 * Structurally implements {@link ServiceUnit}; prototype methods are
 * non-enumerable so existing consumers/tests are unaffected.
 */

import type {
  ServiceUnit, ServiceType, ServiceState, EnabledState, RestartPolicy,
} from '../LinuxServiceManager';

const AUTO_RESTART: ReadonlySet<RestartPolicy> = new Set<RestartPolicy>([
  'always', 'on-failure', 'on-abnormal',
]);

export class LinuxService implements ServiceUnit {
  name!: string;
  description!: string;
  type!: ServiceType;
  execStart!: string;
  execStop?: string;
  execReload?: string;
  user!: string;
  group!: string;
  wantedBy!: string[];
  after!: string[];
  requires!: string[];
  restart!: RestartPolicy;
  loadedFrom!: string;
  state!: ServiceState;
  enabled!: EnabledState;
  mainPid?: number;
  activeSince?: Date;

  constructor(init: ServiceUnit) {
    Object.assign(this, init);
  }

  isActive(): boolean {
    return this.state === 'active';
  }

  isEnabled(): boolean {
    return this.enabled === 'enabled';
  }

  isMasked(): boolean {
    return this.enabled === 'masked';
  }

  /** Whether the supervisor should resurrect this unit after a crash. */
  wantsAutoRestart(): boolean {
    return AUTO_RESTART.has(this.restart);
  }

  /** systemd `Loaded:` parenthetical, e.g. "enabled; preset: enabled". */
  loadStateLabel(): string {
    return `${this.enabled}; preset: enabled`;
  }

  /** Plain serialisable copy (telemetry / UI projections). */
  snapshot(): ServiceUnit {
    return { ...this };
  }
}
