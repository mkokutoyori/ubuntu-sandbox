import {
  assignEnv, cleanupHostname, isHostnameValid, parseEnvFile, serializeEnvFile, stringHasControlCharacters,
} from './SystemdNames';

export type HostnameSource = 'static' | 'transient' | 'default';
export type WriteOutcome = 'ok' | 'EROFS' | 'EACCES';

export interface BusError {
  readonly name: string;
  readonly message: string;
}

export interface HostnamedFacts {
  readonly kernelName: string;
  readonly kernelRelease: string;
  readonly kernelVersion: string;
  readonly detectedChassis: string | null;
}

export interface HostnamedPlatform {
  readText(path: string): string | null;
  writeText(path: string, text: string): WriteOutcome;
  remove(path: string): WriteOutcome;
  kernelHostname(): string;
  setKernelHostname(name: string): void;
  privileged(): boolean;
  journal(message: string): void;
  nowMs(): number;
  facts(): HostnamedFacts;
}

export const INVALID_ARGS = 'org.freedesktop.DBus.Error.InvalidArgs';
export const INTERACTIVE_AUTHORIZATION_REQUIRED = 'org.freedesktop.DBus.Error.InteractiveAuthorizationRequired';
export const FILE_IS_PROTECTED = 'org.freedesktop.hostname1.FileIsProtected';
export const READ_ONLY_FILESYSTEM = 'org.freedesktop.hostname1.ReadOnlyFilesystem';

export type MachineInfoProperty = 'PRETTY_HOSTNAME' | 'ICON_NAME' | 'CHASSIS' | 'DEPLOYMENT' | 'LOCATION';

export interface MachineInfo {
  readonly PRETTY_HOSTNAME: string | null;
  readonly ICON_NAME: string | null;
  readonly CHASSIS: string | null;
  readonly DEPLOYMENT: string | null;
  readonly LOCATION: string | null;
}

const MACHINE_INFO_KEYS: readonly MachineInfoProperty[] = ['PRETTY_HOSTNAME', 'ICON_NAME', 'CHASSIS', 'DEPLOYMENT', 'LOCATION'];
const MACHINE_INFO_LABEL: Readonly<Record<MachineInfoProperty, string>> = {
  PRETTY_HOSTNAME: 'pretty hostname', ICON_NAME: 'icon name', CHASSIS: 'chassis', DEPLOYMENT: 'deployment', LOCATION: 'location',
};
const VALID_CHASSIS = ['vm', 'container', 'desktop', 'laptop', 'convertible', 'server', 'tablet', 'handset', 'watch', 'embedded'];
const DAEMON_IDLE_MS = 30_000;
const FALLBACK_HOSTNAME = 'localhost';
const DEFAULT_HOSTNAME_HINT = '/run/systemd/default-hostname';

const DMI_CHASSIS: Readonly<Record<number, string>> = {
  0x03: 'desktop', 0x04: 'desktop', 0x06: 'desktop', 0x07: 'desktop', 0x0d: 'desktop', 0x23: 'desktop', 0x24: 'desktop',
  0x08: 'laptop', 0x09: 'laptop', 0x0a: 'laptop', 0x0e: 'laptop', 0x0b: 'handset',
  0x11: 'server', 0x1c: 'server', 0x1d: 'server', 0x1e: 'tablet', 0x1f: 'convertible', 0x20: 'convertible', 0x21: 'embedded', 0x22: 'embedded',
};

const nullIfEmpty = (value: string | null | undefined): string | null => (value === null || value === undefined || value === '' ? null : value);
const busError = (name: string, message: string): BusError => ({ name, message });
const invalidArgument = (message: string): BusError => busError(INVALID_ARGS, message);
const validFilename = (name: string): boolean => name !== '' && name !== '.' && name !== '..' && !name.includes('/') && name.length <= 255;
const validDeployment = (name: string): boolean => /^[A-Za-z0-9\-.:]+$/.test(name);

export class Hostnamed {
  private hostnameSource: HostnameSource | null = null;
  private lastActivityMs = -Infinity;

  constructor(private readonly platform: HostnamedPlatform) {}

  begin(): void {
    const now = this.platform.nowMs();
    if (now - this.lastActivityMs > DAEMON_IDLE_MS) this.hostnameSource = null;
    this.lastActivityMs = now;
  }

  defaultHostname(): string {
    const osRelease = parseEnvFile(this.platform.readText('/etc/os-release') ?? '');
    const configured = osRelease.find((entry) => entry.startsWith('DEFAULT_HOSTNAME='))?.slice('DEFAULT_HOSTNAME='.length);
    return configured !== undefined && isHostnameValid(configured) ? configured : FALLBACK_HOSTNAME;
  }

  staticHostname(): string | null {
    const text = this.platform.readText('/etc/hostname');
    if (text === null) return null;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;
      const cleaned = cleanupHostname(line);
      return isHostnameValid(cleaned, true) ? cleaned : null;
    }
    return null;
  }

  machineInfo(): MachineInfo {
    const entries = parseEnvFile(this.platform.readText('/etc/machine-info') ?? '');
    const valueOf = (key: MachineInfoProperty): string | null =>
      nullIfEmpty(entries.filter((entry) => entry.startsWith(`${key}=`)).map((entry) => entry.slice(key.length + 1)).pop());
    return {
      PRETTY_HOSTNAME: valueOf('PRETTY_HOSTNAME'), ICON_NAME: valueOf('ICON_NAME'), CHASSIS: valueOf('CHASSIS'),
      DEPLOYMENT: valueOf('DEPLOYMENT'), LOCATION: valueOf('LOCATION'),
    };
  }

  hardware(): { vendor: string | null; model: string | null } {
    const entries = parseEnvFile(this.platform.readText('/etc/machine-info') ?? '');
    const valueOf = (key: string): string | null =>
      nullIfEmpty(entries.filter((entry) => entry.startsWith(`${key}=`)).map((entry) => entry.slice(key.length + 1)).pop());
    return { vendor: valueOf('HARDWARE_VENDOR'), model: valueOf('HARDWARE_MODEL') };
  }

  kernelHostname(): string {
    const kernel = this.platform.kernelHostname();
    return kernel === '' || kernel === '(none)' ? this.defaultHostname() : kernel;
  }

  source(): HostnameSource {
    if (this.hostnameSource === null) {
      const kernel = this.platform.kernelHostname();
      const current = kernel === '' || kernel === '(none)' ? null : kernel;
      if (current === this.staticHostname()) this.hostnameSource = 'static';
      else this.hostnameSource = this.platform.readText(DEFAULT_HOSTNAME_HINT)?.replace(/\n$/, '') === current ? 'default' : 'transient';
    }
    return this.hostnameSource;
  }

  chassis(): string | null {
    const configured = this.machineInfo().CHASSIS;
    if (configured !== null) return configured;
    const detected = this.platform.facts().detectedChassis;
    return detected;
  }

  iconName(): string {
    const configured = this.machineInfo().ICON_NAME;
    if (configured !== null) return configured;
    const chassis = this.chassis();
    return chassis === null ? 'computer' : `computer-${chassis}`;
  }

  private authorize(): BusError | null {
    return this.platform.privileged()
      ? null
      : busError(INTERACTIVE_AUTHORIZATION_REQUIRED, 'Interactive authentication required.');
  }

  private updateKernelHostname(transient: string | null): void {
    const staticName = this.staticHostname();
    let name: string;
    let source: HostnameSource;
    if (staticName !== null) {
      name = staticName;
      source = 'static';
    } else if (transient !== null) {
      name = transient;
      source = 'transient';
    } else {
      name = this.defaultHostname();
      source = 'default';
    }
    let changed = false;
    if (this.platform.kernelHostname() !== name) {
      this.platform.setKernelHostname(name);
      changed = true;
    }
    if (this.hostnameSource !== source) {
      this.hostnameSource = source;
      changed = true;
    }
    if (!changed) return;
    this.platform.journal(`Hostname set to <${name}> (${source})`);
    if (source === 'default') this.platform.writeText(DEFAULT_HOSTNAME_HINT, `${name}\n`);
    else this.platform.remove(DEFAULT_HOSTNAME_HINT);
  }

  setHostname(requested: string): BusError | null {
    const name = nullIfEmpty(requested);
    if (name !== null && !isHostnameValid(name)) return invalidArgument(`Invalid hostname '${name}'`);
    const denied = this.authorize();
    if (denied !== null) return denied;
    this.updateKernelHostname(name);
    return null;
  }

  setStaticHostname(requested: string): BusError | null {
    const name = nullIfEmpty(requested);
    if (name === this.staticHostname()) return null;
    if (name !== null && !isHostnameValid(name)) return invalidArgument(`Invalid static hostname '${name}'`);
    const denied = this.authorize();
    if (denied !== null) return denied;
    const written = name === null ? this.platform.remove('/etc/hostname') : this.platform.writeText('/etc/hostname', `${name}\n`);
    if (written === 'EACCES') return busError(FILE_IS_PROTECTED, 'Not allowed to update /etc/hostname.');
    if (written === 'EROFS') return busError(READ_ONLY_FILESYSTEM, '/etc/hostname is in a read-only filesystem.');
    this.updateKernelHostname(null);
    return null;
  }

  setMachineInfo(property: MachineInfoProperty, requested: string): BusError | null {
    const name = nullIfEmpty(requested);
    const info = this.machineInfo();
    if (name === info[property]) return null;
    if (name !== null) {
      if (property === 'ICON_NAME' && !validFilename(name)) return invalidArgument(`Invalid icon name '${name}'`);
      if (property === 'PRETTY_HOSTNAME' && stringHasControlCharacters(name)) return invalidArgument(`Invalid pretty hostname '${name}'`);
      if (property === 'CHASSIS' && !VALID_CHASSIS.includes(name)) return invalidArgument(`Invalid chassis '${name}'`);
      if (property === 'DEPLOYMENT' && !validDeployment(name)) return invalidArgument(`Invalid deployment '${name}'`);
      if (property === 'LOCATION' && stringHasControlCharacters(name)) return invalidArgument(`Invalid location '${name}'`);
    }
    const denied = this.authorize();
    if (denied !== null) return denied;
    let entries = parseEnvFile(this.platform.readText('/etc/machine-info') ?? '');
    const updated: MachineInfo = { ...info, [property]: name };
    for (const key of MACHINE_INFO_KEYS) entries = assignEnv(entries, key, updated[key]);
    const written = entries.length === 0 ? this.platform.remove('/etc/machine-info') : this.platform.writeText('/etc/machine-info', serializeEnvFile(entries));
    if (written === 'EACCES') return busError(FILE_IS_PROTECTED, 'Not allowed to update /etc/machine-info.');
    if (written === 'EROFS') return busError(READ_ONLY_FILESYSTEM, '/etc/machine-info is in a read-only filesystem.');
    this.platform.journal(`Changed ${MACHINE_INFO_LABEL[property]} to '${name ?? 'n/a'}'`);
    return null;
  }

  osRelease(): { prettyName: string | null; cpeName: string | null; homeUrl: string | null; supportEnd: string | null } {
    const entries = parseEnvFile(this.platform.readText('/etc/os-release') ?? '');
    const valueOf = (key: string): string | null => nullIfEmpty(entries.filter((entry) => entry.startsWith(`${key}=`)).map((entry) => entry.slice(key.length + 1)).pop());
    return { prettyName: valueOf('PRETTY_NAME'), cpeName: valueOf('CPE_NAME'), homeUrl: valueOf('HOME_URL'), supportEnd: valueOf('SUPPORT_END') };
  }

  static chassisFromDmiType(type: number): string | null {
    return DMI_CHASSIS[type] ?? null;
  }
}
