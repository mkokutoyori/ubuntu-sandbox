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
import { TimeZone } from '../../../core/time/TimeZone';

/** Le clavier que Debian declare par defaut dans `/etc/default/keyboard`. */
const X11_MODEL = 'pc105';

/** Ce que la table verticale de systemd ecrit a la place d'un champ vide. */
const UNSET = '(unset)';

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

  /**
   * Windows Server 2022 Standard identity preset — the server counterpart
   * of {@link windows}. Every consumer that currently reads `identity.os`
   * (systeminfo, wmic, the registry, `Get-ComputerInfo`) picks this up
   * automatically once `EndHost` selects it for a `windows-server` device,
   * so the four sources stay coherent instead of hardcoding "Windows 10"
   * independently.
   */
  static windowsServer(): SystemIdentity {
    return new SystemIdentity({
      os: new OsRelease({
        id: 'windows-server',
        idLike: '',
        name: 'Microsoft Windows Server',
        prettyName: 'Microsoft Windows Server 2022 Standard',
        version: '10.0.20348 N/A Build 20348',
        versionId: '20348',
        versionCodename: '21H2',
      }),
      kernel: new KernelInfo({
        sysname: 'Windows_NT',
        release: '10.0.20348',
        version: '10.0.20348.0',
        operatingSystem: 'Windows',
      }),
      chassis: 'server',
      iconName: 'computer-server',
    });
  }

  /** Attach the owning device's event bus so identity changes are observable. */
  attachBus(bus: IEventBus, deviceId: string): void {
    this.bus = bus;
    this.deviceId = deviceId;
  }

  // ─── Mutators (publish host.identity.changed) ──────────────────────────

  getTimeZone(): TimeZone {
    return TimeZone.parse(this.timezone) ?? TimeZone.UTC;
  }

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

  /**
   * La banniere que le MOTD, `/etc/issue` et la connexion SSH portent.
   * Elle etait ecrite QUATRE fois en dur — avec un `5.15.0-91-generic`
   * et un `Ubuntu 22.04.3 LTS` que ni `uname -r` ni `lsb_release` ne
   * disaient : un operateur qui ouvrait une session lisait une machine,
   * et `uname -a` lui en montrait une autre.
   */
  welcomeBanner(): string {
    return `Welcome to ${this.os.prettyName} (GNU/Linux ${this.kernel.release} ${this.kernel.machine})`;
  }

  /** `/etc/issue`, ce que getty imprime avant l'invite de connexion. */
  toIssue(): string {
    return `${this.os.prettyName} \\n \\l\n\n`;
  }

  /** `/etc/issue.net`, la meme sans les echappements de getty. */
  toIssueNet(): string {
    return `${this.os.prettyName}\n`;
  }

  /** Le `/etc/default/keyboard` de Debian, que `localectl` lit pour X11. */
  toKeyboardConf(): string {
    return [
      `XKBMODEL="${X11_MODEL}"`,
      `XKBLAYOUT="${this.keymap}"`,
      'XKBVARIANT=""',
      'XKBOPTIONS=""',
      '',
      'BACKSPACE="guess"',
      '',
    ].join('\n');
  }

  /**
   * Le rapport de `localectl status`. Les intitules et les champs
   * conditionnels sont ceux de `print_status_info` (systemd v255,
   * `src/locale/localectl.c`) : `VC Toggle Keymap`, `X11 Variant` et
   * `X11 Options` ne paraissent que renseignes, et un champ vide rend
   * `(unset)`. L'alignement est celui de `hostnamectl` ci-dessous, la
   * vue soeur.
   */
  toLocalectl(): string {
    const champs: Array<[string, string]> = [
      ['System Locale', `LANG=${this.locale}`],
      ['VC Keymap', UNSET],
      ['X11 Layout', this.keymap],
      ['X11 Model', X11_MODEL],
    ];
    const largeur = Math.max(...champs.map(([nom]) => nom.length)) + 2;
    return champs.map(([nom, valeur]) => `${nom.padStart(largeur)}: ${valeur}`).join('\n');
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
