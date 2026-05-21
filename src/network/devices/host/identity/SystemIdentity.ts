/**
 * SystemIdentity — the aggregate model of a host's system identity.
 *
 * Binds the OS release and kernel sub-models together with the host-level
 * identity attributes a real machine carries: the SMBIOS-independent
 * `machine-id`, the per-boot `boot-id`, the time zone, the locale and
 * keymap, and the `hostnamectl` chassis / virtualization / icon metadata.
 *
 * It is the single source of truth behind `hostnamectl`, `timedatectl`,
 * `uname`, `/etc/machine-id`, `/etc/os-release`, `/etc/timezone`,
 * `/etc/default/locale` and `/proc/version`.
 *
 * The hostname itself is intentionally *not* owned here — it is managed
 * through `/etc/hostname` and the device profile — but it is accepted as a
 * parameter by the renderers so their output is complete.
 *
 * The mutable attributes (`timezone`, `locale`, `keymap`, `machineId`) have
 * setters that publish `host.identity.changed` on the event bus, so on-disk
 * projections and observers stay coherent.
 */

import type { IEventBus } from '@/events/EventBus';
import type { HostIdentityField } from '../events';
import { OsRelease } from './OsRelease';
import { KernelInfo } from './KernelInfo';

/** `hostnamectl` chassis classification. */
export type ChassisClass =
  | 'desktop' | 'laptop' | 'server' | 'vm' | 'container' | 'tablet' | 'handset';

export interface SystemIdentityInit {
  machineId?: string;
  bootId?: string;
  os?: OsRelease;
  kernel?: KernelInfo;
  timezone?: string;
  locale?: string;
  keymap?: string;
  chassis?: ChassisClass;
  iconName?: string;
  virtualization?: string;
}

export class SystemIdentity {
  /** Stable install identifier (`/etc/machine-id`) — 32 lower-case hex chars. */
  machineId: string;
  /** Per-boot identifier — 32 lower-case hex chars. */
  bootId: string;
  os: OsRelease;
  kernel: KernelInfo;
  /** IANA time-zone name, e.g. `Etc/UTC`. */
  timezone: string;
  /** Locale, e.g. `en_US.UTF-8`. */
  locale: string;
  /** Console keymap, e.g. `us`. */
  keymap: string;
  chassis: ChassisClass;
  iconName: string;
  /** Detected virtualization technology (`kvm`, `none`, …). */
  virtualization: string;

  private bus: IEventBus | null = null;
  private deviceId = '';

  constructor(init: SystemIdentityInit = {}) {
    this.machineId = init.machineId ?? '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
    this.bootId = init.bootId ?? 'f9e8d7c6b5a4039281706f5e4d3c2b1a';
    this.os = init.os ?? OsRelease.ubuntu();
    this.kernel = init.kernel ?? KernelInfo.ubuntu();
    this.timezone = init.timezone ?? 'Etc/UTC';
    this.locale = init.locale ?? 'en_US.UTF-8';
    this.keymap = init.keymap ?? 'us';
    this.chassis = init.chassis ?? 'vm';
    this.iconName = init.iconName ?? 'computer-vm';
    this.virtualization = init.virtualization ?? 'kvm';
  }

  /** Stock Ubuntu identity preset. */
  static ubuntu(): SystemIdentity {
    return new SystemIdentity();
  }

  /**
   * Windows identity preset. The OS-release / kernel sub-models hold the
   * Windows equivalents (NT kernel, edition string) — their Linux-specific
   * renderers (`/etc/os-release`, `/proc/version`) simply go unused on a
   * Windows host, which reads the data fields directly for `systeminfo`.
   */
  static windows(): SystemIdentity {
    return new SystemIdentity({
      os: new OsRelease({
        id: 'windows',
        idLike: '',
        name: 'Microsoft Windows',
        prettyName: 'Microsoft Windows 10 Pro',
        version: '10.0.22631 N/A Build 22631',
        versionId: '22631',
        versionCodename: '22H2',
      }),
      kernel: new KernelInfo({
        sysname: 'Windows_NT',
        release: '10.0.22631',
        version: '10.0.22631.0',
        operatingSystem: 'Windows',
      }),
      chassis: 'desktop',
      iconName: 'computer',
    });
  }

  /** Attach the owning device's event bus so identity changes are observable. */
  attachBus(bus: IEventBus, deviceId: string): void {
    this.bus = bus;
    this.deviceId = deviceId;
  }

  // ─── Mutators (publish host.identity.changed) ──────────────────────────

  setTimezone(timezone: string): void {
    this.change('timezone', this.timezone, timezone, () => { this.timezone = timezone; });
  }

  setLocale(locale: string): void {
    this.change('locale', this.locale, locale, () => { this.locale = locale; });
  }

  setKeymap(keymap: string): void {
    this.change('keymap', this.keymap, keymap, () => { this.keymap = keymap; });
  }

  setMachineId(machineId: string): void {
    this.change('machine-id', this.machineId, machineId, () => { this.machineId = machineId; });
  }

  // ─── Renderers ─────────────────────────────────────────────────────────

  /** `LANG=`-style content of `/etc/default/locale`. */
  toLocaleConf(): string {
    return `LANG=${this.locale}\n`;
  }

  /** Render the `hostnamectl` status report. */
  toHostnamectl(hostname: string): string {
    return [
      `   Static hostname: ${hostname}`,
      `         Icon name: ${this.iconName}`,
      `           Chassis: ${this.chassis}`,
      `        Machine ID: ${this.machineId}`,
      `           Boot ID: ${this.bootId}`,
      `    Virtualization: ${this.virtualization}`,
      `  Operating System: ${this.os.prettyName}`,
      `            Kernel: ${this.kernel.sysname} ${this.kernel.release}`,
      `      Architecture: ${this.kernel.machine}`,
    ].join('\n');
  }

  /** Render the `timedatectl` status report. */
  toTimedatectl(now: Date = new Date()): string {
    const stamp = formatTimestamp(now);
    return [
      `               Local time: ${stamp} UTC`,
      `           Universal time: ${stamp} UTC`,
      `                 RTC time: ${stamp}`,
      `                Time zone: ${this.timezone} (UTC, +0000)`,
      `System clock synchronized: yes`,
      `              NTP service: active`,
      `          RTC in local TZ: no`,
    ].join('\n');
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private change(field: HostIdentityField, from: string, to: string, apply: () => void): void {
    if (from === to) return;
    apply();
    this.bus?.publish({
      topic: 'host.identity.changed',
      payload: { deviceId: this.deviceId, field, from, to },
    });
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `Tue 2026-05-21 14:00:00` — the `timedatectl` timestamp shape. */
function formatTimestamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-` +
    `${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
