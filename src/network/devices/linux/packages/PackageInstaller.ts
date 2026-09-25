import type { VirtualFileSystem } from '../VirtualFileSystem';
import type { UseraddOptions } from '../LinuxUserManager';
import { VSFTPD_CONF_PATH, VSFTPD_UPSTREAM_SAMPLE_CONF } from '../ftp/LinuxVsftpdService';
import type { PackageEntry } from './PackageDatabase';
import { recordPackageState, type PackageStateHost } from './PackageState';

export interface PackageHost extends PackageStateHost {
  readonly vfs: VirtualFileSystem;
  readonly serviceMgr: PackageStateHost['serviceMgr'] & {
    installPackagedUnit(name: string): boolean;
    removePackagedUnit(name: string): void;
    daemonReload(): void;
    enable(name: string): unknown;
    disable(name: string): unknown;
    start(name: string): unknown;
    stop(name: string): unknown;
  };
  readonly userMgr: {
    getUser(name: string): { gid: number } | undefined;
    useradd(name: string, options: UseraddOptions): unknown;
  };
}

const BIND9_DEFAULT_FILES: ReadonlyArray<readonly [string, string]> = [
  ['/etc/bind/named.conf',
    'include "/etc/bind/named.conf.options";\n' +
    'include "/etc/bind/named.conf.local";\n'],
  ['/etc/bind/named.conf.options',
    'options {\n' +
    '\tdirectory "/var/cache/bind";\n' +
    '\n' +
    '\tdnssec-validation auto;\n' +
    '\n' +
    '\tlisten-on-v6 { any; };\n' +
    '};\n'],
  ['/etc/bind/named.conf.local', ''],
];

function provisionBind9(host: PackageHost): void {
  if (!host.vfs.exists('/etc/bind')) host.vfs.mkdirp('/etc/bind', 0o755, 0, 0);
  if (!host.vfs.exists('/var/cache/bind')) host.vfs.mkdirp('/var/cache/bind', 0o775, 0, 0);
  for (const [path, content] of BIND9_DEFAULT_FILES) {
    if (host.vfs.readFile(path) == null) host.vfs.writeFile(path, content, 0, 0, 0o022);
  }
}

function provisionVsftpd(host: PackageHost): void {
  if (!host.userMgr.getUser('ftp')) {
    host.userMgr.useradd('ftp', { r: true, M: true, d: '/srv/ftp', s: '/usr/sbin/nologin' });
  }
  const ftp = host.userMgr.getUser('ftp');
  if (!host.vfs.exists('/srv/ftp')) host.vfs.mkdirp('/srv/ftp', 0o755, 0, ftp?.gid ?? 0);
  if (host.vfs.readFile(VSFTPD_CONF_PATH) == null) {
    host.vfs.writeFile(VSFTPD_CONF_PATH, VSFTPD_UPSTREAM_SAMPLE_CONF, 0, 0, 0o022);
  }
}

const PROVISIONERS: Readonly<Record<string, (host: PackageHost) => void>> = {
  bind9: provisionBind9,
  vsftpd: provisionVsftpd,
};

export function installPackage(host: PackageHost, entry: PackageEntry): void {
  PROVISIONERS[entry.name]?.(host);
  const units = entry.units ?? [];
  for (const unit of units) host.serviceMgr.installPackagedUnit(unit);
  host.serviceMgr.daemonReload();
  for (const unit of units) {
    host.serviceMgr.enable(unit);
    host.serviceMgr.start(unit);
  }
  recordPackageState(host, entry, 'installed');
}

export function removePackage(host: PackageHost, entry: PackageEntry, purge: boolean): void {
  const units = entry.units ?? [];
  for (const unit of units) {
    host.serviceMgr.stop(unit);
    host.serviceMgr.disable(unit);
    host.serviceMgr.removePackagedUnit(unit);
  }
  host.serviceMgr.daemonReload();
  if (purge) {
    for (const file of entry.files ?? []) {
      if (host.vfs.exists(file)) host.vfs.deleteFile(file);
    }
  }
  recordPackageState(host, entry, purge ? undefined : 'config-files');
}
