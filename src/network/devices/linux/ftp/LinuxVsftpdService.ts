
import type { TcpStack } from '@/network/tcp/TcpStack';
import type { PortSpec } from '@/network/core/ports/PortNumber';
import type { ListenerIdentity } from '@/network/tcp/ListenerSocketSink';
import type { VirtualFileSystem } from '../VirtualFileSystem';
import type { ServiceSocketServer } from '../ports/ServiceSocketServer';
import { FtpServer } from '@/network/ftp/FtpServer';
import type { FtpServerConfig, FtpUserSession, FtpWriteVerb } from '@/network/ftp/FtpServerSession';
import type { ISftpFileSystem, SftpDirEntry } from '@/network/protocols/ssh/sftp/ISftpFileSystem';
import type { INode } from '../VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';
import { PermissionCheckingFSDecorator } from '@/network/protocols/ssh/sftp/PermissionCheckingFSDecorator';
import { ChrootedSftpFileSystem } from '@/network/protocols/ssh/sftp/ChrootedSftpFileSystem';
import { SshUserContext } from '@/network/protocols/ssh/SshUserContext';
import { VSFTPD_LISTEN_BACKLOG } from '../ports/ListenBacklogs';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

export const VSFTPD_CONF_PATH = '/etc/vsftpd.conf';
export const VSFTPD_VERSION = '3.0.5';

export const VSFTPD_UPSTREAM_SAMPLE_CONF = [
  '# Example config file /etc/vsftpd.conf',
  '#',
  '# The default compiled in settings are fairly paranoid. This sample file',
  '# loosens things up a bit, to make the ftp daemon more usable.',
  '# Please see vsftpd.conf.5 for all compiled in defaults.',
  '#',
  '# READ THIS: This example file is NOT an exhaustive list of vsftpd options.',
  '# Please read the vsftpd.conf.5 manual page to get a full idea of vsftpd\'s',
  '# capabilities.',
  '#',
  '# Allow anonymous FTP? (Beware - allowed by default if you comment this out).',
  'anonymous_enable=YES',
  '#',
  '# Uncomment this to allow local users to log in.',
  '#local_enable=YES',
  '#',
  '# Uncomment this to enable any form of FTP write command.',
  '#write_enable=YES',
  '#',
  '# Uncomment this to allow the anonymous FTP user to upload files. This only',
  '# has an effect if the above global write enable is activated. Also, you will',
  '# obviously need to create a directory writable by the FTP user.',
  '#anon_upload_enable=YES',
  '#',
  '# Uncomment this if you want the anonymous FTP user to be able to create',
  '# new directories.',
  '#anon_mkdir_write_enable=YES',
  '#',
  '# Activate directory messages - messages given to remote users when they',
  '# go into a certain directory.',
  'dirmessage_enable=YES',
  '#',
  '# Activate logging of uploads/downloads.',
  'xferlog_enable=YES',
  '#',
  '# Make sure PORT transfer connections originate from port 20 (ftp-data).',
  'connect_from_port_20=YES',
  '#',
  '# When "listen" directive is enabled, vsftpd runs in standalone mode and',
  '# listens on IPv4 sockets. This directive cannot be used in conjunction',
  '# with the listen_ipv6 directive.',
  'listen=YES',
  '#',
  '# Name of the PAM service vsftpd authenticates local users against.',
  'pam_service_name=vsftpd',
  '',
].join('\n');

const BOOLEAN_DEFAULTS: Readonly<Record<string, boolean>> = {
  anonymous_enable: true,
  local_enable: false,
  write_enable: false,
  anon_upload_enable: false,
  anon_mkdir_write_enable: false,
  anon_other_write_enable: false,
  chroot_local_user: false,
  port_enable: true,
  pasv_enable: true,
  connect_from_port_20: false,
  port_promiscuous: false,
  pasv_promiscuous: false,
  download_enable: true,
  dirlist_enable: true,
};

const NUMBER_DEFAULTS: Readonly<Record<string, number>> = {
  pasv_min_port: 5001,
  pasv_max_port: 0,
  ftp_data_port: 20,
};

const STRING_DEFAULTS: Readonly<Record<string, string | null>> = {
  anon_root: null,
  ftp_username: 'ftp',
  ftpd_banner: null,
  pam_service_name: 'ftp',
  pasv_address: null,
};

const HARMLESS_DIRECTIVES: ReadonlySet<string> = new Set([
  'dirmessage_enable', 'xferlog_enable', 'xferlog_std_format',
  'listen', 'listen_ipv6', 'use_localtime', 'secure_chroot_dir',
]);

export interface VsftpdSettings {
  readonly flags: Readonly<Record<string, boolean>>;
  readonly strings: Readonly<Record<string, string | null>>;
  readonly numbers: Readonly<Record<string, number>>;
}

export type VsftpdConfResult =
  | { readonly ok: true; readonly settings: VsftpdSettings }
  | { readonly ok: false; readonly error: string };

export function parseVsftpdConf(text: string): VsftpdConfResult {
  const flags: Record<string, boolean> = { ...BOOLEAN_DEFAULTS };
  const strings: Record<string, string | null> = { ...STRING_DEFAULTS };
  const numbers: Record<string, number> = { ...NUMBER_DEFAULTS };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) return { ok: false, error: `500 OOPS: missing value in config file for: ${line}` };
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key in BOOLEAN_DEFAULTS) {
      const upper = value.toUpperCase();
      if (upper !== 'YES' && upper !== 'NO' && upper !== 'TRUE' && upper !== 'FALSE' && value !== '1' && value !== '0') {
        return { ok: false, error: `500 OOPS: bad bool value in config file for: ${key}` };
      }
      flags[key] = upper === 'YES' || upper === 'TRUE' || value === '1';
    } else if (key in NUMBER_DEFAULTS) {
      numbers[key] = value.startsWith('0') ? parseInt(value, 8) || 0 : parseInt(value, 10) || 0;
    } else if (key in STRING_DEFAULTS) {
      if (key === 'pasv_address' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
        return { ok: false, error: 'vsftpd: invalid pasv_address' };
      }
      strings[key] = value;
    } else if (!HARMLESS_DIRECTIVES.has(key)) {
      return { ok: false, error: `vsftpd: ${key} is not supported by this simulator` };
    }
  }
  return { ok: true, settings: { flags, strings, numbers } };
}

export interface VsftpdAccount {
  readonly username: string;
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
}

export interface VsftpdHost {
  readonly vfs: VirtualFileSystem;
  nowMs(): number;
  tcpStack(): TcpStack;
  account(username: string): VsftpdAccount | null;
  groupsOf(username: string): readonly number[];
  authenticate(service: string, username: string, password: string): boolean;
}

function isAnonymous(username: string): boolean {
  const upper = username.toUpperCase();
  return upper === 'FTP' || upper === 'ANONYMOUS';
}

export class LinuxVsftpdService implements ServiceSocketServer {
  private server: FtpServer | null = null;

  constructor(private readonly host: VsftpdHost) {}

  loadSettings(): VsftpdConfResult {
    const text = this.host.vfs.readFile(VSFTPD_CONF_PATH);
    if (text === null) return { ok: false, error: `500 OOPS: cannot open config file:${VSFTPD_CONF_PATH}` };
    return parseVsftpdConf(text);
  }

  open(spec: PortSpec, identity?: ListenerIdentity): boolean {
    const loaded = this.loadSettings();
    if (!loaded.ok) return false;
    this.server?.stop();
    this.server = new FtpServer(this.host.tcpStack(), '0.0.0.0', this.configFrom(loaded.settings), spec.port);
    this.server.start(identity, VSFTPD_LISTEN_BACKLOG);
    return true;
  }

  close(): void {
    this.server?.stop();
    this.server = null;
  }

  private configFrom(settings: VsftpdSettings): FtpServerConfig {
    const { flags, strings, numbers } = settings;
    return {
      users: new Map(),
      fs: this.fileSystemAs(0, 0, 'root', '/'),
      rejectUser: (username) => (!flags.local_enable && !isAnonymous(username)
        ? 'This FTP server is anonymous only.' : null),
      authenticate: (username, password) => {
        if (isAnonymous(username)) return flags.anonymous_enable && this.anonymousAccount(strings) !== null;
        return flags.local_enable && this.host.account(username) !== null
          && this.host.authenticate(strings.pam_service_name ?? 'ftp', username, password);
      },
      sessionFor: (username) => this.sessionFor(username, flags, strings),
      permitsWrite: (username, verb) => permitsWrite(flags, isAnonymous(username), verb),
      listLine: (entry) => this.listLine(entry, this.host.nowMs()),
      commandEnabled: (verb) => commandEnabled(flags, verb),
      dataPolicy: {
        activeSourcePort: flags.connect_from_port_20 ? numbers.ftp_data_port : null,
        passiveRange: passiveRange(numbers),
        passiveAddress: strings.pasv_address ?? null,
        activeAnyPeer: flags.port_promiscuous,
        passiveAnyPeer: flags.pasv_promiscuous,
        random: Math.random,
      },
      messages: {
        greeting: strings.ftpd_banner ?? `(vsFTPd ${VSFTPD_VERSION})`,
        passwordRequired: 'Please specify the password.',
        loggedIn: 'Login successful.',
        portOk: 'PORT command successful. Consider using PASV.',
        currentDirectory: (path) => `"${path}" is the current directory`,
        typeSet: (type) => (type === 'A' ? 'Switching to ASCII mode.' : 'Switching to Binary mode.'),
        opening: (_type, name, size) => `Opening BINARY mode data connection for ${name} (${size} bytes).`,
        storeOk: 'Ok to send data.',
        sizeFailed: 'Could not get file size.',
        openFailed: 'Failed to open file.',
        noDataChannel: 'Use PORT or PASV first.',
        dataConnectFailed: 'Failed to establish connection.',
        eprtOk: 'EPRT command successful. Consider using EPSV.',
      },
    };
  }

  private listLine(entry: SftpDirEntry, now: number): string {
    const permissions = this.host.vfs.formatPermissions({ type: entry.type, permissions: entry.mode } as INode);
    return [
      permissions,
      padToWidth('1', 4, 'right'),
      padToWidth(String(entry.uid), 8),
      padToWidth(String(entry.gid), 8),
      padToWidth(String(entry.size), 8, 'right'),
      vsftpdDate(entry.mtime, now),
      entry.name,
    ].join(' ');
  }

  private anonymousAccount(strings: Readonly<Record<string, string | null>>): VsftpdAccount | null {
    return this.host.account(strings.ftp_username ?? 'ftp');
  }

  private sessionFor(
    username: string, flags: Readonly<Record<string, boolean>>,
    strings: Readonly<Record<string, string | null>>,
  ): FtpUserSession | null {
    if (isAnonymous(username)) {
      const account = this.anonymousAccount(strings);
      if (!account) return null;
      const root = strings.anon_root ?? account.home;
      return { fs: new ChrootedSftpFileSystem(this.fileSystemFor(account), root), cwd: '/' };
    }
    const account = this.host.account(username);
    if (!account) return null;
    const fs = this.fileSystemFor(account);
    return flags.chroot_local_user
      ? { fs: new ChrootedSftpFileSystem(fs, account.home), cwd: '/' }
      : { fs, cwd: account.home };
  }

  private fileSystemFor(account: VsftpdAccount): ISftpFileSystem {
    return this.fileSystemAs(account.uid, account.gid, account.username, account.home);
  }

  private fileSystemAs(uid: number, gid: number, username: string, home: string): ISftpFileSystem {
    const context = new SshUserContext(username, uid, gid, this.host.groupsOf(username), home);
    return new PermissionCheckingFSDecorator(new LinuxSftpFSAdapter(this.host.vfs, uid, gid), context);
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HALF_YEAR_MS = 60 * 60 * 24 * 182 * 1000;

function vsftpdDate(mtime: number, now: number): string {
  const date = new Date(mtime);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const day = `${MONTHS[date.getUTCMonth()]} ${pad(date.getUTCDate())}`;
  return mtime > now || now - mtime > HALF_YEAR_MS
    ? `${day}  ${date.getUTCFullYear()}`
    : `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

const PASSIVE_PORT_FLOOR = 1024;
const PASSIVE_PORT_CEILING = 65535;

function passiveRange(numbers: Readonly<Record<string, number>>): { min: number; max: number } {
  let min = PASSIVE_PORT_FLOOR;
  let max = PASSIVE_PORT_CEILING;
  if (numbers.pasv_min_port > min && numbers.pasv_min_port <= max) min = numbers.pasv_min_port;
  if (numbers.pasv_max_port >= min && numbers.pasv_max_port < max) max = numbers.pasv_max_port;
  return { min, max };
}

function commandEnabled(flags: Readonly<Record<string, boolean>>, verb: string): boolean {
  switch (verb) {
    case 'PORT': case 'EPRT': return flags.port_enable;
    case 'PASV': case 'EPSV': return flags.pasv_enable;
    case 'RETR': return flags.download_enable;
    case 'LIST': case 'NLST': case 'MLSD': return flags.dirlist_enable;
    default: return true;
  }
}

function permitsWrite(flags: Readonly<Record<string, boolean>>, anonymous: boolean, verb: FtpWriteVerb): boolean {
  if (!flags.write_enable) return false;
  if (!anonymous) return true;
  if (verb === 'STOR' || verb === 'STOU') return flags.anon_upload_enable;
  if (verb === 'MKD') return flags.anon_mkdir_write_enable;
  return flags.anon_other_write_enable;
}
