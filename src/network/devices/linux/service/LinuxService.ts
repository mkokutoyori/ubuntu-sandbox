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
  props?: Record<string, string>;

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

  private subState(): string {
    if (this.state === 'active') return this.type === 'oneshot' ? 'exited' : 'running';
    if (this.state === 'failed') return 'failed';
    return 'dead';
  }

  private loadState(): string {
    return this.enabled === 'masked' ? 'masked' : 'loaded';
  }

  /** Resolve a `systemctl show -p KEY` value (override wins over derived). */
  effectiveProp(key: string): string {
    const override = this.props?.[key];
    if (override !== undefined) return override;
    switch (key) {
      case 'Id': return `${this.name}.service`;
      case 'Names': return `${this.name}.service`;
      case 'Description': return this.description;
      case 'MainPID': return String(this.mainPid ?? 0);
      case 'ActiveState': return this.state;
      case 'SubState': return this.subState();
      case 'LoadState': return this.loadState();
      case 'UnitFileState': return this.enabled;
      case 'Type': return this.type;
      case 'User': return this.user;
      case 'ExecStart': return this.execStart;
      case 'Restart': return this.restart;
      case 'FragmentPath': return this.loadedFrom;
      case 'WantedBy': return this.wantedBy.join(' ');
      case 'After': return this.after.join(' ');
      case 'CPUQuota': return this.props?.CPUQuota ?? '';
      case 'MemoryMax': return this.props?.MemoryMax ?? 'infinity';
      case 'TasksMax': return this.props?.TasksMax ?? '4915';
      default: return this.props?.[key] ?? '';
    }
  }

  /** Persist a runtime resource-control override (systemctl set-property). */
  setProperty(key: string, value: string): void {
    (this.props ??= {})[key] = value;
  }

  /** A reasonable default property set for `systemctl show <unit>`. */
  static readonly DEFAULT_SHOW_KEYS = [
    'Id', 'Description', 'LoadState', 'ActiveState', 'SubState',
    'UnitFileState', 'MainPID', 'Type', 'User', 'ExecStart', 'Restart',
    'FragmentPath',
  ];

  /** Plain serialisable copy (telemetry / UI projections). */
  snapshot(): ServiceUnit {
    return { ...this };
  }
}
